import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { CommandId } from '@deepseek-ai/dsh-commands/brand'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-credentials'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { JobId, JobOutcome } from '@deepseek-ai/dsh-jobs'
import { BUNDLED_SKILL_RANK, type SkillCandidate, type SkillDefinition, type SkillProvider } from '@deepseek-ai/dsh-skill'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { inspectAuthenticatedControllers, migrateRunStateSecurityProof, selectControllerForStatus } from './controller-auth.js'
import type { AuthenticatedController } from './controller-auth.js'
import { resolveRepoRoot } from './git.js'
import { acquireLifecycleAuthorityMutex, appendLifecycleAuthorityReceipt, lifecycleStateDir } from './lifecycle-authority.js'
import { harnessRunDependencies } from './harness-runtime.js'
import { HumanGrantStore } from './human-grant.js'
import type { RecoveryAuthority } from './human-grant.js'
import { runLeppyLoop } from './runner.js'
import { DIRECT_HUMAN_STOP_REASON } from './types.js'
import { dependencyHydrationAvailable, dependencyResolutionMiss } from './worktree-dependencies.js'
import { windowsQuotedExecutableFailure } from './windows-command.js'
import { workerNpmCacheRecovery } from './worker-artifacts.js'
import type { LeppyLoopOptions, LifecycleAuthority, RunDependencies, RunProgress, RunResult, WorkerPolicy } from './types.js'

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
const GRANT_MAX_TRANSITIONS = 16

export const name = 'leppy-loop-command'
export const inject = ['commands', 'tools', 'jobs', 'credentials', 'settings', 'llm', 'agentDefaultModel', 'skills']

const LIFECYCLE_PROMPT = `The human invoked /leppy-loop and authorized one bounded Leppy lifecycle in this session and repository. The lifecycle permit survives controller transitions, so the human must not be asked to type separate continue, repair, or publish commands.

Use leppy_loop_control for exactly one next lifecycle transition now. Read-only status/preflight calls do not consume that transition. Always call operation=status before claiming that a controller job is running; only a returned live jobId proves that claim. Choose technical recovery and publication behavior from the authenticated controller state and the human's conversation. The permit authorizes branch push and pull-request creation unless the Host says it is local-only; it never authorizes merge, deployment, scope widening, or another run. For a new run, resolve the tracked checklist and authoritative Git base, call operation=preflight, and start only after it returns ready. You may correct only explicit path/Done metadata in the tracked source checklist to resolve reported preflight diagnostics, then rerun preflight. For an existing run, use only the exact Host-provided run/checklist/base facts and never edit its controller. You may set publicationTarget only to a live replacement base justified by repository history when the original publication base was removed. Return after the background job starts. Never emulate the controller with shell, subagents, generic background jobs, or direct worktree edits. Never invent or remember a leppy-loop-* job id across turns.`

const SKILL_PROVIDER_NAME = 'leppy-loop-operator'
const SKILL_BODY_URL = new URL('../skills/leppy-loop-operator/SKILL.md', import.meta.url)
const SKILL_RESOURCE_BASE = { kind: 'directory', path: fileURLToPath(new URL('../skills/leppy-loop-operator/', import.meta.url)) } as const
const SKILL_CANDIDATE: SkillCandidate = {
  name: 'leppy-loop-operator',
  description: 'Model-only guidance for operating an already human-authorized Leppy lifecycle, status, recovery, or publication.',
  invocation: { modelInvocable: true, userInvocable: false },
  provider: SKILL_PROVIDER_NAME,
  source: 'bundled',
  resourceBase: SKILL_RESOURCE_BASE,
  rank: BUNDLED_SKILL_RANK,
  locator: SKILL_BODY_URL,
}
const skillProvider: SkillProvider = {
  name: SKILL_PROVIDER_NAME,
  list: () => Promise.resolve([SKILL_CANDIDATE]),
  async get(): Promise<SkillDefinition> {
    return { ...SKILL_CANDIDATE, content: await readFile(SKILL_BODY_URL, 'utf8') }
  },
}

export interface LeppyLoopCommandHooks {
  run?: (options: LeppyLoopOptions, dependencies: RunDependencies) => Promise<RunResult>
  dependencies?: (ctx: Context, signal: AbortSignal) => RunDependencies
  inspectControllers?: (cwd: string) => Promise<AuthenticatedController[]>
  persistAuthority?: (repoRoot: string, runId: string, authority: LifecycleAuthority) => Promise<void>
}

export interface LeppyLoopControlArguments {
  operation: 'preflight' | 'start' | 'continue' | 'status' | 'stop'
  tasks?: string
  syncBranch?: string
  runId?: string
  taskMatch?: string
  recovery?: 'resume' | 'retry-gate' | 'repair-gate'
  /** Internal direct-human status path; never exposed in the model schema. */
  internalHumanStatus?: boolean
  publish?: boolean
  publicationTarget?: string
  fetch?: boolean
  workerPolicy?: WorkerPolicy
}

export interface LeppyLoopControlResult {
  operation: string
  status: string
  runId?: string
  jobId?: string
  jobStatus?: string
  detail?: string
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
  activeRepositories: Set<string>
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
    ...(result.detail ? [`detail=${result.detail}`] : []),
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
        args: ` ${progressLabel(progress)}\nleppy-attempt=${progress.taskAttempt}\nleppy-elapsed-ms=${Math.floor(progress.elapsedMs)}`,
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

function visibleControllers(agent: Agent, controllers: readonly AuthenticatedController[], allowLegacy: boolean): AuthenticatedController[] {
  return controllers.filter(controller => controller.lifecycleAuthority?.sessionId === String(agent.id)
    || (allowLegacy && controller.lifecycleAuthority === undefined))
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

async function persistLifecycleAuthority(runtime: LeppyLoopRuntime, repoRoot: string, runId: string, authority: LifecycleAuthority): Promise<void> {
  if (runtime.hooks.persistAuthority) {
    await runtime.hooks.persistAuthority(repoRoot, runId, authority)
    return
  }
  const stateDir = await lifecycleStateDir(repoRoot, runId)
  const release = await acquireLifecycleAuthorityMutex(stateDir)
  try { appendLifecycleAuthorityReceipt(stateDir, runId, authority) }
  finally { release() }
}

function lifecycleAuthority(grant: ReturnType<HumanGrantStore['reserve']>['grant']): LifecycleAuthority {
  return {
    sessionId: grant.sessionId, allowPublication: grant.allowPublication, maxIterations: grant.maxIterations,
    maxRepairCycles: grant.maxRepairCycles, maxTransitions: grant.maxTransitions, transitions: grant.transitions,
    issuedAt: grant.issuedAt, expiresAt: grant.expiresAt,
    ...(grant.revokedAt === undefined ? {} : { revokedAt: grant.revokedAt }),
  }
}

function controllerOptions(
  args: LeppyLoopControlArguments,
  cwd: string,
  repoRoot: string,
  runId: string,
  grant: ReturnType<HumanGrantStore['reserve']>['grant'],
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
    openPullRequest: args.publish === true,
    ...(args.publish === true ? { publicationRepairCycles: grant.maxRepairCycles } : {}),
    ...(args.publicationTarget ? { publicationTarget: args.publicationTarget } : {}),
    repoRoot,
    lifecycleAuthority: lifecycleAuthority(grant),
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
  return { status: 'failed', detail: `run ${result.runId} ${result.status}${result.currentTask === undefined ? '' : ` at task ${result.currentTask}`}${result.detail ? `: ${result.detail}` : ''}`, output }
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

async function scheduleLifecycleFollowup(runtime: LeppyLoopRuntime, agent: Agent, cwd: string, repoRoot: string, runId: string): Promise<void> {
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const permit = [...runtime.grants.permits(agent, repoRoot)].reverse().find(candidate => candidate.runId === runId && !candidate.inFlight)
      if (!permit) return
      const controllers = await (runtime.hooks.inspectControllers ?? inspectAuthenticatedControllers)(cwd)
      const controller = controllers.find(candidate => candidate.runId === runId)
      if (!controller) return
      if (controller.pullRequestUrl) {
        runtime.grants.close(agent, repoRoot, runId)
        return
      }
      const recoverable = (controller.status === 'stalled' || controller.status === 'interrupted') && controller.autoRecoveryBlocked !== true
      const publicationDecision = controller.status === 'completed' && permit.allowPublication
      if ((!recoverable && !publicationDecision) || controller.openTask?.kind === 'human') return
      const intent: HumanIntent = {
        mode: 'lifecycle', allowPublication: permit.allowPublication,
        naturalLanguage: recoverable
          ? 'Continue the already authorized lifecycle autonomously from its exact durable failure. Do not ask for another slash command.'
          : 'The local lifecycle completed. Publish only if the human conversation requested delivery as a pull request; otherwise report local completion.',
      }
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: lifecyclePrompt(controller, intent) }],
        source: { kind: 'plugin', plugin: name },
      }))
      return
    } catch (error) {
      lastError = error
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)))
    }
  }
  throw lastError instanceof Error ? lastError : new Error('lifecycle follow-up handoff failed')
}

function startControllerJob(
  ctx: Context,
  runtime: LeppyLoopRuntime,
  agent: Agent,
  options: LeppyLoopOptions,
  repoRoot: string,
  runId: string,
  onSettled: () => void | Promise<void>,
): JobId {
  const existing = liveJobRecord(ctx, runtime, agent, repoRoot)
  if (existing) throw new Error(`Leppy controller job ${existing.id} is already active in this repository`)
  if (runtime.activeRepositories.has(repoRoot)) throw new Error('another Leppy controller job is already active in this repository')
  runtime.activeRepositories.add(repoRoot)
  const abort = new AbortController()
  const signal = AbortSignal.any([abort.signal, runtime.lifetime.signal])
  let id: JobId
  try {
    id = ctx.jobs.start({
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
      void done.finally(() => { runtime.activeRepositories.delete(repoRoot) }).then(onSettled, onSettled).catch(() => {})
      return {
        cancel: reason => { if (!abort.signal.aborted) abort.abort(new Error(reason ?? 'Leppy Loop stopped by the human')) },
        done,
      }
    },
    })
  } catch (error) {
    runtime.activeRepositories.delete(repoRoot)
    throw error
  }
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
    const inspect = runtime.hooks.inspectControllers ?? inspectAuthenticatedControllers
    const candidateJob = liveJobRecord(ctx, runtime, agent, repoRoot)
    const active = candidateJob && (args.runId === undefined || args.runId === candidateJob.runId) ? candidateJob : undefined
    if (active) {
      const job = ctx.jobs.get(active.id, agent)
      const selected = await inspect(cwd).then(
        controllers => controllers.find(candidate => candidate.runId === active.runId),
        () => undefined,
      )
      return {
        operation: 'status', status: job.status, jobStatus: job.status, runId: active.runId, jobId: String(active.id),
        ...((job as { detail?: string }).detail ? { detail: (job as { detail: string }).detail } : {}),
        ...(selected ? {
          completedTasks: selected.completedTasks, attempt: selected.attempt, branch: selected.branch,
          ...(selected.currentTask === undefined ? {} : { currentTask: selected.currentTask }),
          ...(selected.openTask ? { task: selected.openTask.text } : {}),
        } : {}),
      }
    }
    const controllers = visibleControllers(agent, await inspect(cwd), args.internalHumanStatus === true)
    const selected = args.runId
      ? controllers.find(candidate => candidate.runId === args.runId)
      : selectControllerForStatus(controllers)
    const durableStatus = selected?.status === 'running' ? 'orphaned' : selected?.status
    const durableDetail = selected?.status === 'running'
      ? 'Durable controller state says running, but no session-owned Host job exists. Recover with operation=continue; do not claim a background job is active.'
      : selected?.detail
    return selected ? {
      operation: 'status', status: durableStatus!, runId: selected.runId,
      completedTasks: selected.completedTasks, attempt: selected.attempt, branch: selected.branch,
      ...(durableDetail ? { detail: durableDetail } : {}),
      ...(selected.currentTask === undefined ? {} : { currentTask: selected.currentTask }),
      ...(selected.openTask ? { task: selected.openTask.text } : {}),
    } : { operation: 'status', status: 'not-found' }
  }

  if (args.operation === 'preflight') {
    validateTechnicalArguments(args, cwd, repoRoot)
    const signal = runtime.lifetime.signal
    const dependencies = runtime.hooks.dependencies?.(ctx, signal) ?? harnessRunDependencies(ctx, signal)
    const result = await (runtime.hooks.run ?? runLeppyLoop)({
      tasks: requireString(args.tasks, 'tasks'), syncBranch: requireString(args.syncBranch, 'syncBranch'),
      dryRun: true, fetch: args.fetch !== false, repoRoot,
      ...(args.taskMatch ? { taskMatch: args.taskMatch } : {}),
      ...(args.workerPolicy ? { workerPolicy: args.workerPolicy } : {}),
    }, dependencies)
    const invalid = result.diagnostics.some(item => item.severity === 'error')
    return {
      operation: 'preflight', status: invalid ? 'invalid' : 'ready', runId: result.runId,
      detail: result.diagnostics.length > 0
        ? result.diagnostics.map(item => `${item.line ?? '-'} ${item.code}: ${item.message}`).join('\n')
        : 'Checklist, canonical scopes, model selection, and authoritative base passed preflight.',
      ...(result.preview?.selectedLine ? { task: result.preview.selectedLine } : {}),
      ...(result.preview?.branch ? { branch: result.preview.branch } : {}),
    }
  }

  const runId = args.operation === 'start'
    ? randomUUID().replaceAll('-', '').slice(0, 12)
    : requireString(args.runId, 'runId')
  if (args.operation === 'continue' && !runtime.hooks.inspectControllers) await migrateRunStateSecurityProof(cwd, runId)
  const controller = args.operation === 'continue' ? await authenticatedController(runtime, cwd, runId) : undefined
  const record = args.operation === 'stop'
    ? liveJobRecord(ctx, runtime, agent, repoRoot)
    : undefined
  if (args.operation === 'stop' && (!record || record.runId !== runId)) throw new Error(`no active background controller job exists for run ${runId}`)
  validateTechnicalArguments(args, cwd, repoRoot, controller)
  if (args.operation === 'stop') {
    const stopPermit = runtime.grants.permits(agent, repoRoot).find(permit => permit.runId === runId)
    if (!stopPermit) throw new Error(`no live lifecycle authority exists for run ${runId}`)
    await persistLifecycleAuthority(runtime, repoRoot, runId, { ...runtime.grants.authority(stopPermit), revokedAt: Date.now() })
    runtime.grants.close(agent, repoRoot, runId)
    const outcome = ctx.jobs.kill(record!.id, agent, DIRECT_HUMAN_STOP_REASON)
    return { operation: 'stop', status: outcome === 'requested' ? 'stopping' : 'already-finished', runId, jobId: String(record!.id) }
  }

  const livePermits = runtime.grants.permits(agent, repoRoot).filter(permit => permit.runId === runId)
  const dependencyHydration = args.operation === 'continue' && controller !== undefined && dependencyHydrationAvailable(controller)
  const dependencyRepair = args.operation === 'continue' && controller !== undefined && dependencyResolutionMiss(controller.detail)
  const windowsArgvRepair = args.operation === 'continue' && controller?.autoRecoveryBlocked === true
    && controller.windowsArgvBridgeActive !== true && windowsQuotedExecutableFailure(controller.detail)
  const workerArtifactRepair = args.operation === 'continue' && workerNpmCacheRecovery(controller?.detail)
  if (args.operation === 'continue' && controller?.autoRecoveryBlocked === true
    && !dependencyRepair && !windowsArgvRepair && !workerArtifactRepair
    && !livePermits.some(permit => permit.reauthorizedAt > Date.parse(controller.updatedAt))) {
    throw new Error('automatic recovery circuit is open; a fresh direct human /leppy-loop authorization is required before another unchanged attempt')
  }
  if (args.operation === 'continue' && controller?.lifecycleAuthority && livePermits.length === 0) {
    runtime.grants.hydrate({ agent, repoRoot, runId, authority: controller.lifecycleAuthority })
  }
  const reservation = runtime.grants.reserve({
    agent, repoRoot, runId, operation: args.operation, publishRemote: args.publish === true,
  })
  const options: LeppyLoopOptions = {
    ...controllerOptions(args, cwd, repoRoot, runId, reservation.grant, controller),
    ...(dependencyHydration ? { dependencyHydrationRequired: true } : {}),
    ...(dependencyRepair && controller?.detail
      ? { dependencyRecoveryDigest: createHash('sha256').update(controller.detail).digest('hex') }
      : {}),
    ...(windowsArgvRepair && controller?.detail
      ? { windowsArgvRecoveryDigest: createHash('sha256').update(controller.detail).digest('hex') }
      : {}),
    ...(workerArtifactRepair && controller?.detail
      ? { workerArtifactRecoveryDigest: createHash('sha256').update(controller.detail).digest('hex') }
      : {}),
  }
  let authorityPersisted = false
  try {
    await persistLifecycleAuthority(runtime, repoRoot, runId, options.lifecycleAuthority!)
    authorityPersisted = true
    const jobId = startControllerJob(ctx, runtime, agent, options, repoRoot, runId, async () => {
      runtime.grants.settle(reservation)
      await scheduleLifecycleFollowup(runtime, agent, cwd, repoRoot, runId)
    })
    return { operation: args.operation, status: 'running', runId, jobId: String(jobId) }
  } catch (error) {
    if (authorityPersisted) runtime.grants.settle(reservation)
    else runtime.grants.restore(reservation)
    throw error
  }
}

function normalizeIntent(raw: string): string {
  return raw.normalize('NFD').replace(/[\u0300-\u036f]/gu, '').trim().toLowerCase().replace(/\s+/gu, ' ')
}

interface HumanIntent {
  mode: 'lifecycle' | 'status' | 'stop'
  allowPublication: boolean
  naturalLanguage: string
}

function parseHumanIntent(raw: string): HumanIntent {
  const input = normalizeIntent(raw)
  if (input.startsWith('--')) throw new Error('technical flags are private; describe the desired lifecycle in natural language')
  if (['status', 'estado'].includes(input)) return { mode: 'status', allowPublication: false, naturalLanguage: input }
  if (['parar', 'pare', 'stop', 'cancelar', 'cancele'].includes(input)) return { mode: 'stop', allowPublication: false, naturalLanguage: input }
  const publicationTerm = /(?:publi\w*|\bpr\b|pull request|push|remot\w*)/u
  const negativePublication = /(?:\bnao\b|\bnunca\b|\bsem\b|\bevit\w*|\bdo not\b|\bdon't\b|\bnever\b|\bwithout\b|\bavoid\w*).{0,48}(?:publi\w*|\bpr\b|pull request|push|remot\w*)/u
  const localOnly = negativePublication.test(input)
    || /(?:local only|(?:somente|apenas|so) local|keep (?:it )?local)/u.test(input)
    || (/(?:recus|deny|forbid)/u.test(input) && publicationTerm.test(input))
  return { mode: 'lifecycle', allowPublication: !localOnly, naturalLanguage: raw.trim().slice(0, 4 * 1024) }
}

function lifecyclePrompt(controller: AuthenticatedController | undefined, intent: HumanIntent): string {
  const authority = intent.allowPublication ? 'The lifecycle may push its owned branch and create or reconcile a pull request.' : 'The human explicitly made this lifecycle local-only; publish must be false.'
  const facts = controller ? `
The Host authenticated and bound the lifecycle to these exact controller facts:
- operation: continue
- runId: ${controller.runId}
- checklist: ${controller.checklistRelative}
- authoritative work base: ${controller.syncBranch}
- status: ${controller.status}
- completedTasks: ${controller.completedTasks}
- currentTask: ${controller.openTask?.index ?? controller.currentTask ?? 'none'}
- attempt: ${controller.attempt}
- open row: ${controller.openTask?.text ?? 'none'}
- durable detail: ${controller.detail ?? 'none'}
- automatic recovery blocked: ${controller.autoRecoveryBlocked === true ? 'yes; do not loop without changed conditions or direct human intervention' : 'no'}
- recorded PR: ${controller.pullRequestUrl ?? 'none'}
` : '\nNo authenticated controller exists yet. Resolve one tracked checklist and its authoritative Git base, then start exactly one new run.\n'
  return `${LIFECYCLE_PROMPT}

Direct human intent attached to the slash command: ${JSON.stringify(intent.naturalLanguage || '(no suffix; use the surrounding conversation)')}
${authority}
${facts}`
}

function toolDefinition(ctx: Context, runtime: LeppyLoopRuntime) {
  return defineTool({
    name: 'leppy_loop_control',
    description: 'Durable Leppy controller interface. Use status before any availability claim; never infer a job id or use subagents/generic jobs. Start needs a fresh /leppy-loop permit; continue uses only the same session-bound persisted lifecycle authority.',
    parameters: {
      operation: { type: 'string', enum: ['preflight', 'start', 'continue', 'status'], required: true },
      tasks: { type: 'string', description: 'Resolved tracked checklist path for start/continue.' },
      syncBranch: { type: 'string', description: 'Resolved authoritative Git base for start/continue.' },
      runId: { type: 'string', description: 'Exact authenticated run for continue/status/stop.' },
      taskMatch: { type: 'string', description: 'Optional literal row selector for a new run.' },
      recovery: { type: 'string', enum: ['resume', 'retry-gate', 'repair-gate'], description: 'Technical recovery transition selected inside the bounded lifecycle.' },
      publish: { type: 'boolean', description: 'Whether this transition should reconcile or create the lifecycle pull request; denied by a local-only permit.' },
      publicationTarget: { type: 'string', description: 'Optional live remote/base replacement for publication only when the original base was removed and incorporated.' },
      fetch: { type: 'boolean', description: 'Fetch once before a new run; defaults true.' },
      workerPolicy: { type: 'string', enum: WORKER_POLICIES },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          operation: { type: 'string', required: true }, status: { type: 'string', required: true },
          runId: { type: 'string' }, jobId: { type: 'string' }, jobStatus: { type: 'string' }, detail: { type: 'string' }, completedTasks: { type: 'number' },
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
    if (intent.mode === 'status') {
      const value = await executeLeppyLoopControl(ctx, runtime, invocation.agent, { operation: 'status', internalHumanStatus: true })
      if (value.status === 'not-found') return { kind: 'error', text: 'No authenticated Leppy controller was found in this repository.' }
      const facts = [
        `run=${value.runId}`,
        ...(value.jobId ? [`job=${value.jobId}`] : []),
        ...(value.completedTasks === undefined ? [] : [`completed=${value.completedTasks}`]),
        ...(value.currentTask === undefined ? [] : [`currentTask=${value.currentTask}`]),
        ...(value.attempt === undefined ? [] : [`attempt=${value.attempt}`]),
        ...(value.task ? [`task=${value.task}`] : []),
        ...(value.detail ? [`detail=${value.detail}`] : []),
      ]
      return { kind: 'success', text: `Leppy Loop ${value.status}. ${facts.join(' | ')}` }
    }

    if (intent.mode === 'stop') {
      const record = liveJobRecord(ctx, runtime, invocation.agent, repoRoot)
      if (!record) return { kind: 'error', text: 'No active Leppy background controller was found in this session and repository.' }
      const value = await executeLeppyLoopControl(ctx, runtime, invocation.agent, { operation: 'stop', runId: record.runId })
      return { kind: 'success', text: `Leppy Loop stop requested. run=${record.runId} | job=${value.jobId} | status=${value.status}` }
    }

    const controllers = visibleControllers(invocation.agent, await (runtime.hooks.inspectControllers ?? inspectAuthenticatedControllers)(cwd), true)
    const latest = selectControllerForStatus(controllers)
    const explicitlyNew = /\b(?:novo|nova|new|iniciar|start)\b/u.test(normalizeIntent(intent.naturalLanguage))
    const selected = explicitlyNew || (latest?.status === 'completed' && latest.pullRequestUrl) ? undefined : latest
    const grant = selected?.lifecycleAuthority
      ? runtime.grants.reauthorize({
          agent: invocation.agent, repoRoot, runId: selected.runId,
          authority: selected.lifecycleAuthority, allowPublication: intent.allowPublication,
        })
      : runtime.grants.issue({
          agent: invocation.agent, repoRoot, ...(selected ? { runId: selected.runId } : {}),
          allowPublication: intent.allowPublication,
          maxIterations: GRANT_MAX_ITERATIONS, maxRepairCycles: GRANT_MAX_REPAIR_CYCLES, maxTransitions: GRANT_MAX_TRANSITIONS,
        })
    if (selected?.lifecycleAuthority) {
      await persistLifecycleAuthority(runtime, repoRoot, selected.runId, runtime.grants.authority(grant))
    }
    const effectiveIntent = { ...intent, allowPublication: grant.allowPublication }
    invocation.agent.followup(createUserMessage({
      content: [{ type: 'text', text: lifecyclePrompt(selected, effectiveIntent) }],
      source: { kind: 'plugin', plugin: name },
    }))
    return { kind: 'success', text: `Leppy Loop lifecycle authorized${selected ? ` for run ${selected.runId}` : ' for one new run'}. The AI will manage bounded continuation, repair, and publication without more phase commands.` }
  } catch (error) {
    if (invocation.signal.aborted) throw abortError(invocation.signal)
    return { kind: 'error', text: `Leppy Loop could not accept the intent: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/** Register the simple slash surface; the scoped private tool appears only after direct human intent. */
export function apply(ctx: Context): void {
  const runtime: LeppyLoopRuntime = {
    grants: new HumanGrantStore(), jobs: [], activeRepositories: new Set(), registeredAgents: new WeakSet(), lifetime: new AbortController(), hooks: {},
  }
  ctx.tools.register(toolDefinition(ctx, runtime))
  ctx.skills.registerProvider(() => skillProvider)
  ctx.commands.register({
    name: 'leppy-loop',
    description: 'authorize one bounded Leppy lifecycle from natural-language intent',
    input: { hint: '[natural-language intent|status|parar]' },
    handler: invocation => executeLeppyLoopCommand(ctx, invocation, runtime),
  })
  ctx.effect(() => () => {
    runtime.lifetime.abort(new Error('Leppy Loop plugin disposed'))
  }, 'leppy-loop-command lifetime')
}
