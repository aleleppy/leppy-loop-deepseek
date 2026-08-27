import { isAbsolute, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { CommandId } from '@deepseek-ai/dsh-commands/brand'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-credentials'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { harnessRunDependencies } from './harness-runtime.js'
import { parseLeppyLoopCommandInput } from './options.js'
import { runLeppyLoop } from './runner.js'
import type { LeppyLoopOptions, RunDependencies, RunProgress, RunResult, WorkerPolicy } from './types.js'

declare module '@deepseek-ai/dsh-commands/types' {
  interface CommandSourceMap {
    'leppy-loop': { kind: 'plugin'; plugin: 'leppy-loop' }
  }
}

const WORKER_POLICIES: WorkerPolicy[] = ['adaptive', 'selected', 'terra-high', 'sol-low']

export const name = 'leppy-loop-command'
export const inject = ['commands', 'tools', 'credentials', 'settings', 'llm', 'agentDefaultModel']

const AUTONOMOUS_PROMPT = `The human invoked /leppy-loop without arguments. Autonomously prepare and start Leppy Loop for the task implied by the conversation and repository state.

1. Inspect the session workspace and relevant conversation context.
2. Identify the intended tracked Markdown checklist. Prefer an explicitly discussed controller; otherwise inspect plausible *.task.md files and their open rows. A checklist is eligible only when it has at least one open executable row, every open ordinary row has a non-empty Done: contract and explicit repo-relative paths, and every open closure/gate satisfies its typed contract. A controller with zero open rows is already finished and must not be started or recovered. Treat status prose such as "pending", "blocked", or "requires review" without those contracts as an invalid legacy controller, not runnable work. Never edit the controller to make it eligible.
3. Determine the authoritative Git base ref from the current branch upstream, remote HEAD, or repository convention.
4. Determine a phase gate only when the checklist requires one and does not carry its own gate metadata.
5. Call leppy_loop_start exactly once with the resolved arguments. Do not launch another dsh process or emulate the controller with shell commands.
6. If the intended checklist is invalid, or more than one eligible checklist or base is genuinely plausible, ask the human one concise question instead of guessing or calling leppy_loop_start.
7. If the controller returns stalled, failed, or interrupted, never edit its source checkout or preserved worktree, never delegate a repair through subagent/workflow, and never publish or integrate around it. Report the exact run/receipt and stop. Availability recovery must launch a new worker only through exact-run Leppy recovery. A failed gate may be repaired only by a later direct human slash/CLI command carrying --repair-gate and the exact run ID.

Wait for leppy_loop_start to settle before reporting completion or recovery information.`

export interface LeppyLoopCommandHooks {
  run?: (options: LeppyLoopOptions, dependencies: RunDependencies) => Promise<RunResult>
  dependencies?: (ctx: Context, signal: AbortSignal) => RunDependencies
}

export interface LeppyLoopStartArguments {
  tasks: string
  syncBranch: string
  phaseGateCommand?: string
  taskMatch?: string
  recoverExistingWip?: boolean
  recoverRunId?: string
  dryRun?: boolean
  fetch?: boolean
  workerPolicy?: WorkerPolicy
}

export interface LeppyLoopStartResult {
  status: string
  runId: string
  completedTasks: number
  branch?: string
  worktree?: string
  stateDir?: string
  currentTask?: number
  pullRequestUrl?: string
  diagnostics: RunResult['diagnostics']
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason
  return new Error(typeof signal.reason === 'string' ? signal.reason : 'Leppy Loop command aborted')
}

function workspaceOptions(options: LeppyLoopOptions, cwd: string): LeppyLoopOptions {
  return {
    ...options,
    tasks: resolve(cwd, options.tasks),
    ...(options.artifactsDir
      ? { artifactsDir: isAbsolute(options.artifactsDir) ? options.artifactsDir : resolve(cwd, options.artifactsDir) }
      : {}),
  }
}

function resultText(result: RunResult): string {
  const facts = [
    `status=${result.status}`,
    `run=${result.runId}`,
    `completed=${result.completedTasks}`,
    ...(result.branch ? [`branch=${result.branch}`] : []),
    ...(result.worktree ? [`worktree=${result.worktree}`] : []),
    ...(result.stateDir ? [`state=${result.stateDir}`] : []),
    ...(result.currentTask === undefined ? [] : [`currentTask=${result.currentTask}`]),
    ...(result.pullRequestUrl ? [`pr=${result.pullRequestUrl}`] : []),
  ]
  if (result.preview) {
    facts.push(`selected=${result.preview.selectedLine ?? '<none>'}`)
  }
  if (result.diagnostics.length > 0) {
    facts.push(`diagnostics=${result.diagnostics.map(item => `${item.line ?? '-'}:${item.code}:${item.message}`).join('; ')}`)
  }
  return `Leppy Loop ${result.status}. ${facts.join(' | ')}`
}

function resultValue(result: RunResult): LeppyLoopStartResult {
  return {
    status: result.status,
    runId: result.runId,
    completedTasks: result.completedTasks,
    diagnostics: result.diagnostics,
    ...(result.branch ? { branch: result.branch } : {}),
    ...(result.worktree ? { worktree: result.worktree } : {}),
    ...(result.stateDir ? { stateDir: result.stateDir } : {}),
    ...(result.currentTask === undefined ? {} : { currentTask: result.currentTask }),
    ...(result.pullRequestUrl ? { pullRequestUrl: result.pullRequestUrl } : {}),
  }
}

function progressCommandId(progress: RunProgress): ReturnType<typeof CommandId> {
  return CommandId(`leppy-progress-${progress.runId}-${progress.taskIndex}-${progress.attempt}`)
}

function progressLabel(progress: RunProgress): string {
  const compact = progress.text.replace(/\s+/gu, ' ').trim()
  const bounded = compact.length > 180 ? `${compact.slice(0, 177)}...` : compact
  return `[${progress.completedTasks + 1}/${progress.totalTasks}] ${bounded}`
}

function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return [hours > 0 ? `${hours}h` : '', minutes > 0 || hours > 0 ? `${minutes}m` : '', `${seconds}s`]
    .filter(Boolean)
    .join(' ')
}

/** Render controller progress as durable, model-invisible command cards in the chat. */
export function createChatProgressReporter(agent: CommandInvocation['agent']): (progress: RunProgress) => void {
  return progress => {
    const commandId = progressCommandId(progress)
    if (progress.type === 'task-start') {
      agent.session.append('command/run', {
        commandId,
        name: 'leppy-loop-task',
        args: ` ${progressLabel(progress)}\nleppy-elapsed-ms=${Math.floor(progress.elapsedMs)}`,
        source: { kind: 'plugin', plugin: 'leppy-loop' },
      })
      return
    }
    const position = `${progress.completedTasks}/${progress.totalTasks}`
    const elapsed = formatElapsed(progress.elapsedMs)
    agent.session.append('command/done', progress.type === 'task-done'
      ? { commandId, kind: 'success', text: `Task completed — ${position} — ${elapsed} elapsed.` }
      : { commandId, kind: 'error', text: `Task stopped — ${position} — ${elapsed} elapsed: ${progress.error ?? 'unknown error'}` })
  }
}

/** Start the controller from arguments selected by the model-facing orchestration turn. */
export async function executeLeppyLoopTool(
  ctx: Context,
  agent: CommandInvocation['agent'],
  args: LeppyLoopStartArguments,
  signal: AbortSignal,
  hooks: LeppyLoopCommandHooks = {},
): Promise<LeppyLoopStartResult> {
  const cwd = agent.session.header.cwd
  if (!cwd || !isAbsolute(cwd)) throw new Error('Leppy Loop requires an absolute session workspace cwd')
  const options = workspaceOptions({
    tasks: args.tasks,
    syncBranch: args.syncBranch,
    ...(args.phaseGateCommand ? { phaseGateCommand: args.phaseGateCommand } : {}),
    ...(args.taskMatch ? { taskMatch: args.taskMatch } : {}),
    recoverExistingWip: Boolean(args.recoverExistingWip || args.recoverRunId),
    ...(args.recoverRunId ? { recoverRunId: args.recoverRunId } : {}),
    dryRun: Boolean(args.dryRun),
    fetch: args.fetch !== false,
    workerPolicy: args.workerPolicy ?? 'adaptive',
    // Model-selected autonomous runs are always local. Remote publication is
    // available only through the direct, human-authored --open-pr command.
    openPullRequest: false,
  }, cwd)
  const dependencies = hooks.dependencies?.(ctx, signal) ?? {
    ...harnessRunDependencies(ctx, signal),
    onProgress: createChatProgressReporter(agent),
  }
  return resultValue(await (hooks.run ?? runLeppyLoop)(options, dependencies))
}

/** Execute one user-owned Web command, delegating bare or natural-language invocation to the model. */
export async function executeLeppyLoopCommand(
  ctx: Context,
  invocation: CommandInvocation,
  lifetimeSignal?: AbortSignal,
  hooks: LeppyLoopCommandHooks = {},
): Promise<CommandResult> {
  const signal = lifetimeSignal
    ? AbortSignal.any([invocation.signal, lifetimeSignal])
    : invocation.signal
  try {
    if (signal.aborted) throw abortError(signal)
    const cwd = invocation.agent.session.header.cwd
    if (!cwd) return { kind: 'error', text: 'Leppy Loop requires a session with a workspace cwd.' }
    if (!isAbsolute(cwd)) return { kind: 'error', text: 'Leppy Loop refused the non-absolute session workspace cwd.' }
    const input = invocation.rawInput.trim()
    if (!input.startsWith('--')) {
      const prompt = input === ''
        ? AUTONOMOUS_PROMPT
        : `${AUTONOMOUS_PROMPT}\n\nThe human added this natural-language instruction to the slash command:\n${JSON.stringify(input)}`
      invocation.agent.followup(createUserMessage({
        content: [{ type: 'text', text: prompt }],
        source: { kind: 'plugin', plugin: name },
      }))
      return { kind: 'success', text: 'Leppy Loop delegated to the AI. It will inspect the workspace and start the controller, or ask one question if the target is ambiguous.' }
    }
    const options = workspaceOptions(parseLeppyLoopCommandInput(invocation.rawInput), cwd)
    const dependencies = hooks.dependencies?.(ctx, signal) ?? {
      ...harnessRunDependencies(ctx, signal),
      onProgress: createChatProgressReporter(invocation.agent),
    }
    const result = await (hooks.run ?? runLeppyLoop)(options, dependencies)
    const text = resultText(result)
    return result.status === 'completed' || result.status === 'dry-run'
      ? { kind: 'success', text }
      : { kind: 'error', text }
  } catch (error) {
    if (signal.aborted) throw abortError(signal)
    const message = error instanceof Error ? error.message : String(error)
    return { kind: 'error', text: `Leppy Loop could not start: ${message}` }
  }
}

/** Register `/leppy-loop` in every interactive command adapter in this profile. */
export function apply(ctx: Context): void {
  const lifetime = new AbortController()
  ctx.tools.register(defineTool({
    name: 'leppy_loop_start',
    description: 'Start Leppy Loop after resolving the intended tracked checklist and authoritative Git base. Use this instead of launching dsh or emulating the controller.',
    parameters: {
      tasks: { type: 'string', description: 'Checklist path relative to the session workspace.', required: true },
      syncBranch: { type: 'string', description: 'Authoritative Git base ref, usually the current upstream.', required: true },
      phaseGateCommand: { type: 'string', description: 'Opaque phase gate command only when the checklist requires one without inline gate metadata.' },
      taskMatch: { type: 'string', description: 'Optional literal selector for one open checklist row.' },
      recoverExistingWip: { type: 'boolean', description: 'Resume an authenticated matching run.' },
      recoverRunId: { type: 'string', description: 'Select an exact authenticated run, including a completed selective run that still has open checklist rows.' },
      dryRun: { type: 'boolean', description: 'Validate and preview without starting a worker.' },
      fetch: { type: 'boolean', description: 'Fetch once before resolving the base; defaults to true.' },
      workerPolicy: { type: 'string', enum: WORKER_POLICIES, description: 'Worker cost policy; defaults to adaptive (Terra high for normal tasks, Sol low for closures and recovered attempts).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true },
          runId: { type: 'string', required: true },
          completedTasks: { type: 'number', required: true },
          branch: { type: 'string' },
          worktree: { type: 'string' },
          stateDir: { type: 'string' },
          currentTask: { type: 'number' },
          pullRequestUrl: { type: 'string' },
          diagnostics: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                severity: { type: 'string', required: true },
                code: { type: 'string', required: true },
                message: { type: 'string', required: true },
                line: { type: 'number' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      if (!exec.agent) throw new Error('leppy_loop_start requires an agent-backed session')
      const signal = AbortSignal.any([exec.signal, lifetime.signal])
      return await executeLeppyLoopTool(ctx, exec.agent, args, signal)
    },
  }))
  ctx.commands.register({
    name: 'leppy-loop',
    description: 'let the AI resolve and run a tracked checklist',
    input: { hint: '[--tasks <path> --sync-branch <ref> [options]]' },
    handler: invocation => executeLeppyLoopCommand(ctx, invocation, lifetime.signal),
  })
  ctx.effect(() => () => {
    lifetime.abort(new Error('Leppy Loop plugin disposed'))
  }, 'leppy-loop-command lifetime')
}
