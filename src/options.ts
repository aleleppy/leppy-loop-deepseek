import { Command, Option } from 'commander'
import type { LeppyLoopOptions, WorkerPolicy } from './types.js'

const WORKER_POLICIES: WorkerPolicy[] = ['adaptive', 'selected', 'terra-high', 'sol-low']

const positive = (name: string) => (value: string): number => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be positive`)
  return parsed
}

export function leppyCommand(): Command {
  return new Command()
    .name('dsh --profile leppy-loop')
    .description('Run one checklist item per isolated DeepSeek Harness session.')
    .requiredOption('--tasks <path>', 'tracked Markdown checklist')
    .requiredOption('--sync-branch <ref>', 'authoritative Git base ref')
    .option('--phase-gate-command <command>', 'opaque platform-shell command run by the controller')
    .option('--dry-run', 'lint and print the single selected line without starting a worker')
    .option('--max-iterations <count>', 'maximum worker/gate initializations', positive('max-iterations'), 64)
    .option('--task-match <literal>', 'select only a line containing this literal substring')
    .option('--recover-existing-wip', 'adopt an authenticated matching run')
    .option('--recover-run <id>', 'select or continue one exact authenticated run')
    .option('--retry-gate', 'direct-human authorization to retry the failed gate of an exact recovered run')
    .option('--repair-gate', 'reopen the preceding closure in a fresh worker before retrying an exact failed gate')
    .option('--repair-path <paths...>', 'direct-human additional repo-relative scopes for the reopened repair closure')
    .option('--repair-cycles <count>', 'bounded repair closure and gate cycles in one direct invocation', positive('repair-cycles'))
    .option('--sync-max-seconds <seconds>', 'fetch timeout', positive('sync-max-seconds'), 120)
    .option('--worker-timeout <minutes>', 'worker timeout in minutes', positive('worker-timeout'), 30)
    .option('--worker-output-limit-kb <kb>', 'agent final-output byte limit in KiB', positive('worker-output-limit-kb'), 192)
    .option('--worker-transcript-limit-kb <kb>', 'JSON-RPC transcript byte limit in KiB', positive('worker-transcript-limit-kb'), 8192)
    .option('--artifacts-dir <path>', 'durable state root outside the run worktree')
    .option('--provider <id>', 'model provider; defaults to the Harness selection')
    .option('--model <id>', 'model; overrides the worker policy')
    .option('--effort <id>', 'reasoning effort; overrides the worker policy')
    .addOption(new Option('--worker-policy <policy>', 'worker cost policy').choices(WORKER_POLICIES).default('adaptive'))
    .option('--fallback-model <id>', 'one availability-only fallback model')
    .addOption(new Option('--open-pr', 'push the completed branch and create or find its GitHub pull request').default(false))
    .addOption(new Option('--no-open-pr', 'leave the completed branch local without publishing'))
    .addOption(new Option('--fetch', 'fetch once before creating the worktree').default(true))
    .addOption(new Option('--no-fetch', 'do not fetch before resolving the base'))
}

export function optionsFromCommand(command: Command): LeppyLoopOptions {
  const raw = command.opts() as Record<string, unknown>
  return {
    tasks: String(raw.tasks),
    syncBranch: String(raw.syncBranch),
    ...(raw.phaseGateCommand ? { phaseGateCommand: String(raw.phaseGateCommand) } : {}),
    dryRun: Boolean(raw.dryRun),
    maxIterations: Number(raw.maxIterations),
    ...(raw.taskMatch ? { taskMatch: String(raw.taskMatch) } : {}),
    recoverExistingWip: Boolean(raw.recoverExistingWip || raw.recoverRun),
    ...(raw.recoverRun ? { recoverRunId: String(raw.recoverRun) } : {}),
    retryGate: Boolean(raw.retryGate),
    repairGate: Boolean(raw.repairGate),
    ...(Array.isArray(raw.repairPath) ? { repairPaths: raw.repairPath.map(String) } : {}),
    ...(raw.repairCycles ? { repairCycles: Number(raw.repairCycles) } : {}),
    syncMaxSeconds: Number(raw.syncMaxSeconds),
    workerTimeoutMs: Number(raw.workerTimeout) * 60_000,
    workerOutputLimitBytes: Number(raw.workerOutputLimitKb) * 1024,
    workerTranscriptLimitBytes: Number(raw.workerTranscriptLimitKb) * 1024,
    ...(raw.artifactsDir ? { artifactsDir: String(raw.artifactsDir) } : {}),
    ...(raw.provider ? { provider: String(raw.provider) } : {}),
    ...(raw.model ? { model: String(raw.model) } : {}),
    ...(raw.effort ? { effort: String(raw.effort) } : {}),
    workerPolicy: String(raw.workerPolicy) as WorkerPolicy,
    ...(raw.fallbackModel ? { fallbackModel: String(raw.fallbackModel) } : {}),
    openPullRequest: raw.openPr === true,
    fetch: raw.fetch !== false,
  }
}

export const LEPPY_LOOP_COMMAND_USAGE = '/leppy-loop --tasks <path> --sync-branch <ref> [options]'

/** Split command input without shell expansion or evaluation. */
export function tokenizeLeppyLoopCommandInput(input: string): string[] {
  const tokens: string[] = []
  let token = ''
  let started = false
  let quote: "'" | '"' | undefined
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]!
    if (quote) {
      if (character === quote) {
        quote = undefined
        started = true
        continue
      }
      if (character === '\\' && quote === '"' && input[index + 1] === '"') {
        token += '"'
        index += 1
        started = true
        continue
      }
      token += character
      started = true
      continue
    }
    if (character === "'" || character === '"') {
      quote = character
      started = true
      continue
    }
    if (/\s/u.test(character)) {
      if (started) {
        tokens.push(token)
        token = ''
        started = false
      }
      continue
    }
    if (character === '\\') {
      const next = input[index + 1]
      if (next === "'" || next === '"') {
        token += next
        index += 1
        started = true
        continue
      }
    }
    token += character
    started = true
  }
  if (quote) throw new Error(`unterminated ${quote} quote. Usage: ${LEPPY_LOOP_COMMAND_USAGE}`)
  if (started) tokens.push(token)
  return tokens
}

/** Parse the exact bytes following `/leppy-loop` into controller options. */
export function parseLeppyLoopCommandInput(input: string): LeppyLoopOptions {
  const command = leppyCommand()
  command
    .name('/leppy-loop')
    .exitOverride()
    .configureOutput({ writeOut: () => {}, writeErr: () => {} })
  try {
    command.parse(tokenizeLeppyLoopCommandInput(input), { from: 'user' })
    return optionsFromCommand(command)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`${message}. Usage: ${LEPPY_LOOP_COMMAND_USAGE}`)
  }
}
