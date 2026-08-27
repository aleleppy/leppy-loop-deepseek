import { randomUUID } from 'node:crypto'
import { isAbsolute, relative, resolve } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { CommandId } from '@deepseek-ai/dsh-commands/brand'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-credentials'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { JobId, JobOutcome } from '@deepseek-ai/dsh-jobs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { inspectAuthenticatedControllers, selectControllerForHumanIntent, selectControllerForPublication } from './controller-auth.js'
import type { AuthenticatedController } from './controller-auth.js'
import { resolveRepoRoot } from './git.js'
import { harnessRunDependencies } from './harness-runtime.js'
import { HumanGrantStore } from './human-grant.js'
import type { LeppyOperation, RecoveryAuthority } from './human-grant.js'
import { runLeppyLoop } from './runner.js'
import type { LeppyLoopOptions, RunDependencies, RunProgress, RunResult, WorkerPolicy } from './types.js'

declare module '@deepseek-ai/dsh-commands/types' {
  interface CommandSourceMap {
    'leppy-loop': { kind: 'plugin'; plugin: 'leppy-loop' }
  }
}

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    'leppy-loop': 'leppy-loop'
  }
}

const WORKER_POLICIES: WorkerPolicy[] = ['adaptive', 'selected', 'terra-high', 'sol-low']
const GRANT_MAX_ITERATIONS = 64
const GRANT_MAX_REPAIR_CYCLES = 3

export const name = 'leppy-loop-command'
export const inject = ['commands', 'tools', 'jobs', 'credentials', 'settings', 'llm', 'agentDefaultModel']

const START_PROMPT = `The human invoked the simple /leppy-loop interface and authorized one bounded local controller start.

Resolve the intended tracked Markdown checklist and authoritative Git base from the conversation and repository. Call leppy_loop_control exactly once with operation=start and the technical arguments. The tool consumes a session- and repository-bound one-shot human capability and returns a background job immediately. Do not wait for the controller, poll it, start another dsh process, emulate it with shell, use subagents, or edit any controller worktree. Ask one concise question only when the checklist or base is genuinely ambiguous.`

export interface LeppyLoopCommandHooks {
  run?: (options: LeppyLoopOptions, dependencies: RunDependencies) => Promise<RunResult>
  dependencies?: (ctx: Context, signal: AbortSignal) => RunDependencies
  inspectControllers?: (cwd: string) => Promise<AuthenticatedController[]>
}

export interface LeppyLoopControlArguments {
  operation: 'start' | 'continue' | 'status' | 'stop'
  tasks?: string
  syncBranch?: string
  runId?: string
  taskMatch?: string
  recovery?: 'resume' | 'retry-gate' | 'repair-gate'
  fetch?: boolean
  workerPolicy?: WorkerPolicy
}

export interface LeppyLoopControlResult {
  operation: string
  status: string
  runId?: string
  jobId?: string
  completedTasks?: number
  currentTask?: number
  attempt?: number
  task?: string
  branch?: string
}

interface JobRecord {
  id: JobId
  agent: Agent
  repoRoot: string
  runId: string
}

export interface LeppyLoopRuntime {
  grants: HumanGrantStore
  jobs: JobRecord[]
  registeredAgents: WeakSet<Agent>
  lifetime: AbortController
  hooks: LeppyLoopCommandHooks
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason
  return new Error(typeof signal.reason === 'string' ? signal.reason : 'Leppy Loop aborted')
}

function workspaceOptions(options: LeppyLoopOptions, cwd: string): LeppyLoopOptions {
  return { ...options, tasks: resolve(cwd, options.tasks) }
}

function resultText(result: RunResult): string {
  const facts = [
    `status=${result.status}`,
    `run=${result.runId}`,
    `completed=${result.completedTasks}`,
    ...(result.currentTask === undefined ? [] : [`currentTask=${result.currentTask}`]),
    ...(result.branch ? [`branch=${result.branch}`] : []),
    ...(result.pullRequestUrl ? [`pr=${result.pullRequestUrl}`] : []),
  ]
  if (result.diagnostics.length > 0) facts.push(`diagnostics=${result.diagnostics.map(item => `${item.line ?? '-'}:${item.code}:${item.message}`).join('; ')}`)
  return `Leppy Loop ${result.status}. ${facts.join(' | ')}`
}

function progressCommandId(progress: RunProgress): ReturnType<typeof CommandId> {
  return CommandId(`leppy-progress-${progress.runId}-${progress.taskIndex}-${progress.attempt}`)
}

function progressLabel(progress: RunProgress): string {
  const compact = progress.text.replace(/\s+/gu, ' ').trim()
  const bounded = compact.length > 240 ? `${compact.slice(0, 237)}...` : compact
  return `[${progress.completedTasks + 1}/${progress.totalTasks}] ${bounded}`
}

function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return [hours > 0 ? `${hours}h` : '', minutes > 0 || hours > 0 ? `${minutes}m` : '', `${seconds}s`].filter(Boolean).join(' ')
}

/** Render controller progress as durable, model-invisible command cards in the chat. */
export function createChatProgressReporter(agent: CommandInvocation['agent']): (progress: RunProgress) => void {
  return progress => {
    const commandId = progressCommandId(progress)
    if (progress.type === 'task-start') {
      agent.session.append('command/run', {
        commandId,
        name: 'leppy-loop-task',
        args: ` ${progressLabel(progress)}\nleppy-attempt=${progress.attempt}\nleppy-elapsed-ms=${Math.floor(progress.elapsedMs)}`,
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

function requireWorkspace(agent: Agent): string {
  const cwd = agent.session.header.cwd
  if (!cwd || !isAbsolute(cwd)) throw new Error('Leppy Loop requires an absolute session workspace cwd')
  return cwd
}

function requireString(value: string | undefined, name: string): string {
  if (!value) throw new Error(`leppy_loop_control requires ${name} for this operation`)
  return value
}

function recoveryOf(args: LeppyLoopControlArguments): RecoveryAuthority {
  if (args.operation === 'start') return 'none'
  if (args.operation === 'continue') return args.recovery ?? 'resume'
  return 'none'
}

async function authenticatedController(runtime: LeppyLoopRuntime, cwd: string, runId: string): Promise<AuthenticatedController> {
  const controllers = await (runtime.hooks.inspectControllers ?? inspectAuthenticatedControllers)(cwd)
  const controller = controllers.find(candidate => candidate.runId === runId)
  if (!controller) throw new Error(`run ${runId} is not an authenticated controller in this repository`)
  return controller
}

function validateTechnicalArguments(
  args: LeppyLoopControlArguments,
  cwd: string,
  repoRoot: string,
  controller?: AuthenticatedController,
): void {
  if (args.operation === 'stop') return
  const tasks = requireString(args.tasks, 'tasks')
  const syncBranch = requireString(args.syncBranch, 'syncBranch')
  if (controller) {
    if (resolve(cwd, tasks) !== resolve(repoRoot, controller.checklistRelative)) throw new Error('tool checklist does not match the human-authorized run')
    if (syncBranch !== controller.syncBranch) throw new Error('tool base does not match the human-authorized run')
  }
}

function controllerOptions(
  args: LeppyLoopControlArguments,
  cwd: string,
  repoRoot: string,
  runId: string,
  grant: ReturnType<HumanGrantStore['consume']>,
  controller?: AuthenticatedController,
): LeppyLoopOptions {
  const tasks = requireString(args.tasks, 'tasks')
  const syncBranch = requireString(args.syncBranch, 'syncBranch')
  if (controller) {
    if (resolve(cwd, tasks) !== resolve(repoRoot, controller.checklistRelative)) throw new Error('tool checklist does not match the human-authorized run')
    if (syncBranch !== controller.syncBranch) throw new Error('tool base does not match the human-authorized run')
  }
  const recovery = recoveryOf(args)
  const options: LeppyLoopOptions = {
    tasks,
    syncBranch,
    ...(args.taskMatch ? { taskMatch: args.taskMatch } : {}),
    fetch: args.fetch !== false,
    workerPolicy: args.workerPolicy ?? 'adaptive',
    maxIterations: grant.maxIterations,
    openPullRequest: grant.publishRemote,
    ...(grant.publishRemote ? { publicationRepairCycles: grant.maxRepairCycles } : {}),
    repoRoot,
  }
  if (args.operation === 'continue') {
    options.recoverExistingWip = true
    options.recoverRunId = runId
    options.retryGate = recovery === 'retry-gate'
    options.repairGate = recovery === 'repair-gate'
    if (recovery === 'repair-gate') {
      options.repairCycles = grant.maxRepairCycles
    }
  }
  return workspaceOptions(options, cwd)
}

function jobOutcome(result: RunResult, signal: AbortSignal): JobOutcome {
  const output = resultText(result)
  if (signal.aborted || result.status === 'interrupted') return { status: 'killed', detail: `run ${result.runId} interrupted`, output }
  if (result.status === 'completed' || result.status === 'dry-run') return { status: 'completed', detail: `run ${result.runId} ${result.status}`, output }
  return { status: 'failed', detail: `run ${result.runId} ${result.status}${result.currentTask === undefined ? '' : ` at task ${result.currentTask}`}`, output }
}

function liveJobRecord(ctx: Context, runtime: LeppyLoopRuntime, agent: Agent, repoRoot: string): JobRecord | undefined {
  return [...runtime.jobs].reverse().find(record => {
    if (record.agent !== agent || record.repoRoot !== repoRoot) return false
    try {
      const status = ctx.jobs.get(record.id, agent).status
      return status === 'running' || status === 'stopping'
    } catch {
      return false
    }
  })
}

function startControllerJob(
  ctx: Context,
  runtime: LeppyLoopRuntime,
  agent: Agent,
  options: LeppyLoopOptions,
  repoRoot: string,
  runId: string,
): JobId {
  const existing = liveJobRecord(ctx, runtime, agent, repoRoot)
  if (existing) throw new Error(`Leppy controller job ${existing.id} is already active in this repository`)
  const abort = new AbortController()
  const signal = AbortSignal.any([abort.signal, runtime.lifetime.signal])
  const id = ctx.jobs.start({
    kind: 'leppy-loop',
    label: `Controller ${runId} — ${relative(repoRoot, options.tasks)}`,
    owner: agent,
    outputLimitBytes: 64 * 1024,
    run: () => {
      const dependencies = runtime.hooks.dependencies?.(ctx, signal) ?? {
        ...harnessRunDependencies(ctx, signal),
        runId: () => runId,
        onProgress: createChatProgressReporter(agent),
      }
      if (!dependencies.runId) dependencies.runId = () => runId
      if (!dependencies.onProgress) dependencies.onProgress = createChatProgressReporter(agent)
      const done = (runtime.hooks.run ?? runLeppyLoop)(options, dependencies).then(
        result => jobOutcome(result, signal),
        (error: unknown): JobOutcome => signal.aborted
          ? { status: 'killed', detail: `run ${runId} interrupted`, output: `Leppy Loop interrupted. run=${runId}` }
          : { status: 'failed', detail: error instanceof Error ? error.message : String(error), output: `Leppy Loop failed. run=${runId} | error=${error instanceof Error ? error.message : String(error)}` },
      )
      return {
        cancel: reason => { if (!abort.signal.aborted) abort.abort(new Error(reason ?? 'Leppy Loop stopped by the human')) },
        done,
      }
    },
  })
  runtime.jobs.push({ id, agent, repoRoot, runId })
  return id
}

/** Execute the scoped grant-consuming controller tool. */
export async function executeLeppyLoopControl(
  ctx: Context,
  runtime: LeppyLoopRuntime,
  agent: Agent,
  args: LeppyLoopControlArguments,
): Promise<LeppyLoopControlResult> {
  const cwd = requireWorkspace(agent)
  const repoRoot = resolve(await resolveRepoRoot(cwd))
  if (args.operation === 'status') {
    const controllers = await (runtime.hooks.inspectControllers ?? inspectAuthenticatedControllers)(cwd)
    const selected = args.runId
      ? controllers.find(candidate => candidate.runId === args.runId)
      : selectControllerForHumanIntent(controllers) ?? selectControllerForPublication(controllers)
    return selected ? {
      operation: 'status', status: selected.status, runId: selected.runId,
      completedTasks: selected.completedTasks, attempt: selected.attempt, branch: selected.branch,
      ...(selected.currentTask === undefined ? {} : { currentTask: selected.currentTask }),
      ...(selected.openTask ? { task: selected.openTask.text } : {}),
    } : { operation: 'status', status: 'not-found' }
  }

  const runId = args.operation === 'start'
    ? randomUUID().replaceAll('-', '').slice(0, 12)
    : requireString(args.runId, 'runId')
  const controller = args.operation === 'continue' ? await authenticatedController(runtime, cwd, runId) : undefined
  const record = args.operation === 'stop'
    ? liveJobRecord(ctx, runtime, agent, repoRoot)
    : undefined
  if (args.operation === 'stop' && (!record || record.runId !== runId)) throw new Error(`no active background controller job exists for run ${runId}`)
  validateTechnicalArguments(args, cwd, repoRoot, controller)
  const recovery = recoveryOf(args)
  const grant = runtime.grants.consume({
    agent, repoRoot, operation: args.operation, recovery,
    ...(args.operation === 'start' ? {} : { runId }),
    ...(controller ? { controllerDigest: controller.authorityDigest } : {}),
  })

  if (args.operation === 'stop') {
    const outcome = ctx.jobs.kill(record!.id, agent, 'Stopped through direct human Leppy intent')
    return { operation: 'stop', status: outcome === 'requested' ? 'stopping' : 'already-finished', runId, jobId: String(record!.id) }
  }

  const options = controllerOptions(args, cwd, repoRoot, runId, grant, controller)
  try {
    const jobId = startControllerJob(ctx, runtime, agent, options, repoRoot, runId)
    return { operation: args.operation, status: 'running', runId, jobId: String(jobId) }
  } catch (error) {
    runtime.grants.restore(grant)
    throw error
  }
}

function normalizeIntent(raw: string): string {
  return raw.normalize('NFD').replace(/[\u0300-\u036f]/gu, '').trim().toLowerCase().replace(/\s+/gu, ' ')
}

interface HumanIntent {
  operation: LeppyOperation | 'status'
  recovery: RecoveryAuthority
  publishRemote: boolean
  publicationOnly: boolean
}

function parseHumanIntent(raw: string): HumanIntent {
  const input = normalizeIntent(raw)
  if (input.startsWith('--')) throw new Error('technical flags are private; use only /leppy-loop, continuar, parar, status, or explicit publication intent')
  if (input === '' || ['start', 'iniciar', 'comecar'].includes(input)) return { operation: 'start', recovery: 'none', publishRemote: false, publicationOnly: false }
  if (['status', 'estado'].includes(input)) return { operation: 'status', recovery: 'none', publishRemote: false, publicationOnly: false }
  if (['parar', 'pare', 'stop', 'cancelar', 'cancele'].includes(input)) return { operation: 'stop', recovery: 'none', publishRemote: false, publicationOnly: false }
  if (['reparar gate', 'repare gate', 'corrigir gate', 'consertar gate', 'repair gate'].includes(input)) return { operation: 'continue', recovery: 'repair-gate', publishRemote: false, publicationOnly: false }
  if (['retry gate', 'repetir gate', 'tentar gate novamente', 'tentar novamente'].includes(input)) return { operation: 'continue', recovery: 'retry-gate', publishRemote: false, publicationOnly: false }
  if (['continuar', 'continue', 'retomar', 'retome', 'resume'].includes(input)) return { operation: 'continue', recovery: 'resume', publishRemote: false, publicationOnly: false }
  if (['publicar', 'abrir pr', 'abre um pr', 'publish', 'open pr'].includes(input)) {
    return { operation: 'continue', recovery: 'resume', publishRemote: true, publicationOnly: true }
  }
  if (['continuar e publicar quando tudo passar', 'continue and publish when everything passes'].includes(input)) {
    return { operation: 'continue', recovery: 'resume', publishRemote: true, publicationOnly: false }
  }
  if (['iniciar e publicar quando tudo passar', 'start and publish when everything passes'].includes(input)) {
    return { operation: 'start', recovery: 'none', publishRemote: true, publicationOnly: false }
  }
  throw new Error('unrecognized Leppy intent; use start, continuar, parar, status, reparar gate, publicar, or explicit publish-when-passing intent')
}

function continuePrompt(controller: AuthenticatedController, recovery: RecoveryAuthority, publishRemote: boolean, publicationOnly = false): string {
  return `The human directly authorized ${publicationOnly ? 'remote publication of one completed Leppy controller' : `one bounded Leppy controller continuation${publishRemote ? ' and remote publication only after every row and gate passes' : ' with local-only completion'}`}.

The Host authenticated and selected these exact controller facts:
- operation: continue
- recovery: ${recovery}
- runId: ${controller.runId}
- checklist: ${controller.checklistRelative}
- authoritative base: ${controller.syncBranch}
- status: ${controller.status}
- completedTasks: ${controller.completedTasks}
- currentTask: ${controller.openTask?.index ?? controller.currentTask ?? 'unknown'}
- attempt: ${controller.attempt}
- open row: ${controller.openTask?.text ?? 'unknown'}

Call leppy_loop_control exactly once with those technical facts. The tool validates and consumes the session/repository/run-bound one-shot human capability, then returns a background job immediately. Do not wait or poll, do not use shell or subagents to bypass a stall, and never edit the source checkout or preserved worktree.`
}

function toolDefinition(ctx: Context, runtime: LeppyLoopRuntime) {
  return defineTool({
    name: 'leppy_loop_control',
    description: 'Private controller interface enabled by a direct human /leppy-loop intent. Resolve technical controller facts, then start, continue, inspect, or stop only through the matching one-shot capability.',
    parameters: {
      operation: { type: 'string', enum: ['start', 'continue', 'status', 'stop'], required: true },
      tasks: { type: 'string', description: 'Resolved tracked checklist path for start/continue.' },
      syncBranch: { type: 'string', description: 'Resolved authoritative Git base for start/continue.' },
      runId: { type: 'string', description: 'Exact authenticated run for continue/status/stop.' },
      taskMatch: { type: 'string', description: 'Optional literal row selector for a new run.' },
      recovery: { type: 'string', enum: ['resume', 'retry-gate', 'repair-gate'], description: 'Exact recovery operation authorized by the human capability.' },
      fetch: { type: 'boolean', description: 'Fetch once before a new run; defaults true.' },
      workerPolicy: { type: 'string', enum: WORKER_POLICIES },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          operation: { type: 'string', required: true }, status: { type: 'string', required: true },
          runId: { type: 'string' }, jobId: { type: 'string' }, completedTasks: { type: 'number' },
          currentTask: { type: 'number' }, attempt: { type: 'number' }, task: { type: 'string' }, branch: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      if (!exec.agent) throw new Error('leppy_loop_control requires an agent-backed session')
      return await executeLeppyLoopControl(ctx, runtime, exec.agent, args)
    },
  })
}

function ensureScopedTool(ctx: Context, runtime: LeppyLoopRuntime, agent: Agent): void {
  if (runtime.registeredAgents.has(agent)) return
  agent.ctx.tools.register(toolDefinition(ctx, runtime))
  runtime.registeredAgents.add(agent)
}

/** Execute the simple human command; long-running work always transfers to ctx.jobs. */
export async function executeLeppyLoopCommand(
  ctx: Context,
  invocation: CommandInvocation,
  runtime: LeppyLoopRuntime,
): Promise<CommandResult> {
  try {
    if (invocation.signal.aborted) throw abortError(invocation.signal)
    const cwd = requireWorkspace(invocation.agent)
    const repoRoot = resolve(await resolveRepoRoot(cwd, invocation.signal))
    const intent = parseHumanIntent(invocation.rawInput)
    if (intent.operation === 'status') {
      const value = await executeLeppyLoopControl(ctx, runtime, invocation.agent, { operation: 'status' })
      return { kind: 'success', text: value.status === 'not-found'
        ? 'No authenticated Leppy controller with open work was found in this repository.'
        : `Leppy Loop ${value.status}. run=${value.runId} | completed=${value.completedTasks} | currentTask=${value.currentTask} | attempt=${value.attempt} | task=${value.task}` }
    }

    if (intent.operation === 'start') {
      runtime.grants.issue({
        agent: invocation.agent, repoRoot, operation: 'start', recovery: 'none', publishRemote: intent.publishRemote,
        maxIterations: GRANT_MAX_ITERATIONS, maxRepairCycles: GRANT_MAX_REPAIR_CYCLES,
      })
      ensureScopedTool(ctx, runtime, invocation.agent)
      invocation.agent.followup(createUserMessage({
        content: [{ type: 'text', text: START_PROMPT }],
        source: { kind: 'plugin', plugin: name },
      }))
      return { kind: 'success', text: 'Leppy Loop intent accepted. The AI will resolve the controller and hand it to a background job.' }
    }

    if (intent.operation === 'stop') {
      const record = liveJobRecord(ctx, runtime, invocation.agent, repoRoot)
      if (!record) return { kind: 'error', text: 'No active Leppy background controller was found in this session and repository.' }
      runtime.grants.issue({
        agent: invocation.agent, repoRoot, runId: record.runId, operation: 'stop', recovery: 'none',
        publishRemote: false, maxIterations: 1, maxRepairCycles: 1,
      })
      ensureScopedTool(ctx, runtime, invocation.agent)
      const value = await executeLeppyLoopControl(ctx, runtime, invocation.agent, { operation: 'stop', runId: record.runId })
      return { kind: 'success', text: `Leppy Loop stop requested. run=${record.runId} | job=${value.jobId} | status=${value.status}` }
    }

    const controllers = await (runtime.hooks.inspectControllers ?? inspectAuthenticatedControllers)(cwd)
    const selected = intent.publicationOnly
      ? selectControllerForPublication(controllers)
      : selectControllerForHumanIntent(controllers)
    if (!selected) return { kind: 'error', text: intent.publicationOnly
      ? 'No authenticated completed Leppy controller was found for publication in this repository.'
      : 'No authenticated Leppy controller with open work was found in this repository.' }
    runtime.grants.issue({
      agent: invocation.agent, repoRoot, runId: selected.runId, controllerDigest: selected.authorityDigest,
      operation: 'continue', recovery: intent.recovery,
      publishRemote: intent.publishRemote, maxIterations: GRANT_MAX_ITERATIONS, maxRepairCycles: GRANT_MAX_REPAIR_CYCLES,
    })
    ensureScopedTool(ctx, runtime, invocation.agent)

    invocation.agent.followup(createUserMessage({
      content: [{ type: 'text', text: continuePrompt(selected, intent.recovery, intent.publishRemote, intent.publicationOnly) }],
      source: { kind: 'plugin', plugin: name },
    }))
    return { kind: 'success', text: `Leppy Loop continuation authorized for run ${selected.runId}. The AI will start the controller as a background job.` }
  } catch (error) {
    if (invocation.signal.aborted) throw abortError(invocation.signal)
    return { kind: 'error', text: `Leppy Loop could not accept the intent: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/** Register the simple slash surface; the scoped private tool appears only after direct human intent. */
export function apply(ctx: Context): void {
  const runtime: LeppyLoopRuntime = {
    grants: new HumanGrantStore(), jobs: [], registeredAgents: new WeakSet(), lifetime: new AbortController(), hooks: {},
  }
  ctx.commands.register({
    name: 'leppy-loop',
    description: 'start, continue, stop, or inspect a Leppy controller',
    input: { hint: '[continuar|parar|status|publicar|continuar e publicar quando tudo passar]' },
    handler: invocation => executeLeppyLoopCommand(ctx, invocation, runtime),
  })
  ctx.effect(() => () => {
    runtime.lifetime.abort(new Error('Leppy Loop plugin disposed'))
  }, 'leppy-loop-command lifetime')
}
