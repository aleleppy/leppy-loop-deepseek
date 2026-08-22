import { Command, Option } from 'commander'
import type { LeppyLoopOptions } from './types.js'

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
    .option('--recover-existing-wip', 'adopt the unique authenticated matching run')
    .option('--sync-max-seconds <seconds>', 'fetch timeout', positive('sync-max-seconds'), 120)
    .option('--worker-timeout <minutes>', 'worker timeout in minutes', positive('worker-timeout'), 30)
    .option('--worker-output-limit-kb <kb>', 'agent final-output byte limit in KiB', positive('worker-output-limit-kb'), 192)
    .option('--worker-transcript-limit-kb <kb>', 'JSON-RPC transcript byte limit in KiB', positive('worker-transcript-limit-kb'), 2048)
    .option('--artifacts-dir <path>', 'durable state root outside the run worktree')
    .option('--provider <id>', 'model provider; defaults to the Harness selection')
    .option('--model <id>', 'model; defaults to the Harness selection')
    .option('--effort <id>', 'reasoning effort; defaults to the Harness selection/model')
    .option('--fallback-model <id>', 'one availability-only fallback model')
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
    recoverExistingWip: Boolean(raw.recoverExistingWip),
    syncMaxSeconds: Number(raw.syncMaxSeconds),
    workerTimeoutMs: Number(raw.workerTimeout) * 60_000,
    workerOutputLimitBytes: Number(raw.workerOutputLimitKb) * 1024,
    workerTranscriptLimitBytes: Number(raw.workerTranscriptLimitKb) * 1024,
    ...(raw.artifactsDir ? { artifactsDir: String(raw.artifactsDir) } : {}),
    ...(raw.provider ? { provider: String(raw.provider) } : {}),
    ...(raw.model ? { model: String(raw.model) } : {}),
    ...(raw.effort ? { effort: String(raw.effort) } : {}),
    ...(raw.fallbackModel ? { fallbackModel: String(raw.fallbackModel) } : {}),
    fetch: raw.fetch !== false,
  }
}
