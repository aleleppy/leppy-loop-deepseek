import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseChecklist, selectTask } from './checklist.js'
import { branch as gitBranch, resolveRepoRoot } from './git.js'
import { sameIgnoredBaselineBridge, workerIgnoredBaselineBridgeIdentity } from './ignored-artifacts.js'
import { inspectLifecycleAuthority } from './lifecycle-authority.js'
import { isAuthenticatedPublicationRebase } from './publish.js'
import { runFile } from './process.js'
import {
  createEmbeddedRunStateProof, inspectRunStateProof, persistRunStateProof,
  separateRunStateProofMatches, type EmbeddedRunStateProof,
} from './run-state-proof.js'
import { acquireLock, atomicWriteJson } from './state.js'
import type { ActiveTaskAttempt, ChecklistTask, IgnoredBaselineBridgeAdmission, IgnoredBaselineBridgeIdentity, LifecycleAuthority, PendingTaskValidation, RunResult } from './types.js'

interface StoredRunState {
  schemaVersion: 1
  runId: string
  status: RunResult['status'] | 'running'
  repoRoot: string
  checklistRelative: string
  sourceHead: string
  branch: string
  worktree: string
  syncBranch: string
  currentTask?: number
  attempt: number
  taskAttempts: Record<string, number>
  completedTasks: number
  gateAttempts: Record<string, number>
  pullRequestUrl?: string
  publicationTargetCommit?: string
  publicationRemoteHead?: string
  lastError?: string
  lifecycleAuthority?: LifecycleAuthority
  failureStreak?: { taskKey: string; signature: string; count: number }
  activeTaskAttempt?: ActiveTaskAttempt
  pendingTaskValidation?: PendingTaskValidation
  stateProof?: EmbeddedRunStateProof
  autoRecoveryBlocked?: boolean
  dependencyBridgeActive?: boolean
  windowsArgvBridgeActive?: boolean
  ignoredBaselineBridge?: IgnoredBaselineBridgeAdmission
  updatedAt: string
}

/** Authenticated controller facts safe to use when issuing a human capability. */
export interface AuthenticatedController {
  runId: string
  status: StoredRunState['status']
  repoRoot: string
  checklistRelative: string
  sourceHead: string
  branch: string
  worktree: string
  syncBranch: string
  authorityDigest: string
  currentTask?: number
  attempt: number
  completedTasks: number
  updatedAt: string
  openTask?: ChecklistTask
  pullRequestUrl?: string
  publicationRebase?: boolean
  detail?: string
  lifecycleAuthority?: LifecycleAuthority
  activeTaskAttempt?: ActiveTaskAttempt
  pendingTaskValidation?: PendingTaskValidation
  autoRecoveryBlocked?: boolean
  dependencyBridgeActive?: boolean
  windowsArgvBridgeActive?: boolean
  ignoredBaselineBridge?: IgnoredBaselineBridgeAdmission
}

function taskIdentity(task: ChecklistTask): string {
  return createHash('sha256').update(JSON.stringify({ index: task.index, phase: task.phase, kind: task.kind, raw: task.raw })).digest('hex')
}

function validTaskAttempts(value: unknown): value is Record<string, number> {
  if (value === undefined) return true
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  return Object.entries(value).every(([key, count]) => /^[0-9a-f]{64}$/u.test(key)
    && typeof count === 'number' && Number.isSafeInteger(count) && count > 0)
}

function validFailureStreak(value: unknown): boolean {
  if (value === undefined) return true
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const streak = value as { taskKey?: unknown; signature?: unknown; count?: unknown }
  return typeof streak.taskKey === 'string' && /^[0-9a-f]{64}$/u.test(streak.taskKey)
    && typeof streak.signature === 'string' && /^[0-9a-f]{64}$/u.test(streak.signature)
    && typeof streak.count === 'number' && Number.isSafeInteger(streak.count) && streak.count > 0
}

function validIgnoredBaselineBridge(value: unknown): value is IgnoredBaselineBridgeIdentity | undefined {
  if (value === undefined) return true
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const bridge = value as Partial<IgnoredBaselineBridgeAdmission>
  return bridge.schemaVersion === 1 && (bridge.phase === 'prepared' || bridge.phase === 'consumed')
    && Number.isSafeInteger(bridge.authorityEpoch) && bridge.authorityEpoch! > 0
    && Number.isSafeInteger(bridge.authorityTransition) && bridge.authorityTransition! > 0
    && typeof bridge.requestDigest === 'string' && /^[0-9a-f]{64}$/u.test(bridge.requestDigest)
    && typeof bridge.conditionDigest === 'string' && /^[0-9a-f]{64}$/u.test(bridge.conditionDigest)
    && typeof bridge.activeAttemptDigest === 'string' && /^[0-9a-f]{64}$/u.test(bridge.activeAttemptDigest)
}

function validIgnoredArtifactTransaction(value: ActiveTaskAttempt['ignoredArtifactTransaction'] | unknown): boolean {
  if (value === undefined) return true
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const transaction = value as NonNullable<ActiveTaskAttempt['ignoredArtifactTransaction']>
  return transaction.schemaVersion === 1 && typeof transaction.transactionId === 'string'
    && /^[0-9a-f-]{36}$/u.test(transaction.transactionId)
    && typeof transaction.baselineDigest === 'string' && /^[0-9a-f]{64}$/u.test(transaction.baselineDigest)
}

function validActiveTaskAttempt(value: unknown): value is ActiveTaskAttempt | undefined {
  if (value === undefined) return true
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const attempt = value as Partial<ActiveTaskAttempt>
  const terminal = attempt.terminalOutcome
  const validTerminal = terminal === undefined || (terminal.schemaVersion === 1
    && (terminal.disposition === 'validation-unavailable' || terminal.disposition === 'failed-or-unknown')
    && typeof terminal.outcomeDigest === 'string' && /^[0-9a-f]{64}$/u.test(terminal.outcomeDigest))
  return (attempt.schemaVersion === 1 || attempt.schemaVersion === 2)
    && (attempt.schemaVersion === 2 ? validTerminal : terminal === undefined)
    && typeof attempt.taskKey === 'string' && /^[0-9a-f]{64}$/u.test(attempt.taskKey)
    && Number.isSafeInteger(attempt.taskIndex) && attempt.taskIndex! >= 0
    && typeof attempt.baseHead === 'string' && /^[0-9a-f]{40}$/u.test(attempt.baseHead)
    && typeof attempt.checklistDigest === 'string' && /^[0-9a-f]{64}$/u.test(attempt.checklistDigest)
    && typeof attempt.ignoredPathsDigest === 'string' && /^[0-9a-f]{64}$/u.test(attempt.ignoredPathsDigest)
    && Number.isSafeInteger(attempt.attempt) && attempt.attempt! > 0
    && validIgnoredArtifactTransaction(attempt.ignoredArtifactTransaction)
    && (attempt.ignoredArtifactTransaction === undefined
      || attempt.ignoredArtifactTransaction.baselineDigest === attempt.ignoredPathsDigest)
}

function validPendingTaskValidation(value: unknown): value is PendingTaskValidation | undefined {
  if (value === undefined) return true
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const pending = value as Partial<PendingTaskValidation>
  return pending.schemaVersion === 1 && typeof pending.taskKey === 'string' && /^[0-9a-f]{64}$/u.test(pending.taskKey)
    && Number.isSafeInteger(pending.taskIndex) && pending.taskIndex! >= 0
    && typeof pending.baseHead === 'string' && /^[0-9a-f]{40}$/u.test(pending.baseHead)
    && typeof pending.commitHead === 'string' && /^[0-9a-f]{40}$/u.test(pending.commitHead)
    && typeof pending.checklistDigest === 'string' && /^[0-9a-f]{64}$/u.test(pending.checklistDigest)
    && typeof pending.ignoredPathsDigest === 'string' && /^[0-9a-f]{64}$/u.test(pending.ignoredPathsDigest)
    && typeof pending.failureSignature === 'string' && /^[0-9a-f]{64}$/u.test(pending.failureSignature)
    && Number.isSafeInteger(pending.createdAttempt) && pending.createdAttempt! > 0
    && Number.isSafeInteger(pending.verifierAttempts) && pending.verifierAttempts! >= 0
    && (pending.phase === 'pending' || pending.phase === 'validated')
    && (pending.phase === 'pending'
      ? pending.validatedChecklistDigest === undefined && pending.validationEvidenceDigest === undefined
      : typeof pending.validatedChecklistDigest === 'string' && /^[0-9a-f]{64}$/u.test(pending.validatedChecklistDigest)
        && typeof pending.validationEvidenceDigest === 'string' && /^[0-9a-f]{64}$/u.test(pending.validationEvidenceDigest))
}

function validLifecycleAuthority(value: unknown): value is LifecycleAuthority | undefined {
  if (value === undefined) return true
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const authority = value as Partial<LifecycleAuthority>
  return typeof authority.sessionId === 'string'
    && typeof authority.allowPublication === 'boolean'
    && (authority.epoch === undefined || (Number.isSafeInteger(authority.epoch) && authority.epoch > 0))
    && [authority.maxIterations, authority.maxRepairCycles, authority.maxTransitions, authority.transitions, authority.issuedAt, authority.expiresAt]
      .every(candidate => typeof candidate === 'number' && Number.isSafeInteger(candidate))
    && authority.maxIterations! > 0 && authority.maxRepairCycles! > 0 && authority.maxTransitions! > 0
    && authority.transitions! > 0 && authority.transitions! <= authority.maxTransitions!
    && authority.expiresAt! > authority.issuedAt!
    && (authority.revokedAt === undefined || (Number.isSafeInteger(authority.revokedAt) && authority.revokedAt >= authority.issuedAt!))
}

function parseStoredRun(path: string): StoredRunState | undefined {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<StoredRunState>
    if (value.schemaVersion !== 1
      || typeof value.runId !== 'string'
      || typeof value.repoRoot !== 'string'
      || typeof value.checklistRelative !== 'string'
      || typeof value.sourceHead !== 'string'
      || typeof value.branch !== 'string'
      || typeof value.worktree !== 'string'
      || typeof value.syncBranch !== 'string'
      || typeof value.attempt !== 'number'
      || typeof value.completedTasks !== 'number'
      || !validTaskAttempts(value.taskAttempts)
      || !validLifecycleAuthority(value.lifecycleAuthority)
      || !validFailureStreak(value.failureStreak)
      || !validActiveTaskAttempt(value.activeTaskAttempt)
      || !validPendingTaskValidation(value.pendingTaskValidation)
      || (value.activeTaskAttempt !== undefined && value.pendingTaskValidation !== undefined)
      || (value.autoRecoveryBlocked !== undefined && typeof value.autoRecoveryBlocked !== 'boolean')
      || (value.dependencyBridgeActive !== undefined && typeof value.dependencyBridgeActive !== 'boolean')
      || (value.windowsArgvBridgeActive !== undefined && typeof value.windowsArgvBridgeActive !== 'boolean')
      || !validIgnoredBaselineBridge(value.ignoredBaselineBridge)
      || typeof value.updatedAt !== 'string'
      || (value.lastError !== undefined && typeof value.lastError !== 'string')
      || (value.publicationTargetCommit !== undefined && (typeof value.publicationTargetCommit !== 'string' || !/^[0-9a-f]{40}$/u.test(value.publicationTargetCommit)))
      || (value.publicationRemoteHead !== undefined && (typeof value.publicationRemoteHead !== 'string' || !/^[0-9a-f]{40}$/u.test(value.publicationRemoteHead)))
      || typeof value.status !== 'string'
      || typeof value.gateAttempts !== 'object'
      || value.gateAttempts === null) return undefined
    return { ...value, taskAttempts: value.taskAttempts ?? {} } as StoredRunState
  } catch {
    return undefined
  }
}

/** One-time lock-protected migration from the stable legacy ownership proof to full security-state authentication. */
export async function migrateRunStateSecurityProof(cwd: string, runId: string): Promise<void> {
  const repoRoot = realpathSync(await resolveRepoRoot(cwd))
  const commonRaw = (await runFile('git', ['rev-parse', '--git-common-dir'], { cwd: repoRoot })).stdout.trim()
  const commonDir = resolve(repoRoot, commonRaw)
  const stateDir = join(commonDir, 'leppy-loop', 'runs', runId)
  const statePath = join(stateDir, 'run.json')
  const proofPath = join(stateDir, 'ownership.hmac')
  const keyPath = join(stateDir, 'lease.key')
  if (!existsSync(statePath) || !existsSync(proofPath) || !existsSync(keyPath)) return
  const release = await acquireLock(commonDir, `state-proof-${runId}`)
  try {
    let state = parseStoredRun(statePath)
    if (!state || state.runId !== runId || realpathSync(state.repoRoot) !== repoRoot || !existsSync(state.worktree)) return
    const key = Buffer.from(readFileSync(keyPath, 'utf8').trim(), 'base64')
    const status = inspectRunStateProof(stateDir, state, key)
    if (status === 'current') {
      if (!state.stateProof) {
        state = { ...state, stateProof: createEmbeddedRunStateProof(state, key) }
        atomicWriteJson(statePath, state)
      }
      return
    }
    const target = { ...state }
    delete target.lastError
    delete target.failureStreak
    delete target.activeTaskAttempt
    delete target.pendingTaskValidation
    delete target.stateProof
    delete target.autoRecoveryBlocked
    delete target.dependencyBridgeActive
    delete target.windowsArgvBridgeActive
    delete target.ignoredBaselineBridge
    if (status === 'invalid' && !separateRunStateProofMatches(stateDir, target, key)) {
      throw new Error(`run ${runId} has an invalid ownership proof`)
    }
    if (status !== 'legacy' && status !== 'migration-pending' && status !== 'invalid') {
      throw new Error(`run ${runId} has an unsupported ownership proof state`)
    }
    persistRunStateProof(stateDir, target, key)
    target.stateProof = createEmbeddedRunStateProof(target, key)
    atomicWriteJson(statePath, target)
  } finally {
    release()
  }
}

/** Consume one exact legacy ignored-baseline capability before a controller job can start. */
export async function activateIgnoredBaselineBridge(
  cwd: string, runId: string, expected: IgnoredBaselineBridgeIdentity, authority: LifecycleAuthority,
  requestDigest: string,
): Promise<void> {
  if (!/^[0-9a-f]{64}$/u.test(requestDigest)) throw new Error('ignored-baseline admission request digest is invalid')
  const authorityEpoch = authority.epoch ?? 1
  const authorityTransition = authority.transitions
  if (!Number.isSafeInteger(authorityEpoch) || authorityEpoch <= 0
    || !Number.isSafeInteger(authorityTransition) || authorityTransition <= 0) {
    throw new Error('ignored-baseline admission requires a positive lifecycle transition identity')
  }
  const repoRoot = realpathSync(await resolveRepoRoot(cwd))
  const commonRaw = (await runFile('git', ['rev-parse', '--git-common-dir'], { cwd: repoRoot })).stdout.trim()
  const commonDir = resolve(repoRoot, commonRaw)
  const stateDir = join(commonDir, 'leppy-loop', 'runs', runId)
  const statePath = join(stateDir, 'run.json')
  const keyPath = join(stateDir, 'lease.key')
  const release = await acquireLock(commonDir, `ignored-baseline-bridge-${runId}`)
  try {
    const state = parseStoredRun(statePath)
    if (!state || state.runId !== runId || realpathSync(state.repoRoot) !== repoRoot || !existsSync(keyPath)) {
      throw new Error('cannot activate ignored-baseline bridge for an unauthenticated run')
    }
    const key = Buffer.from(readFileSync(keyPath, 'utf8').trim(), 'base64')
    if (inspectRunStateProof(stateDir, state, key) !== 'current') {
      throw new Error('cannot activate ignored-baseline bridge with a non-current run-state proof')
    }
    const observed = workerIgnoredBaselineBridgeIdentity(state.lastError, state.activeTaskAttempt)
    if (!sameIgnoredBaselineBridge(observed, expected)) {
      throw new Error('the authenticated ignored-baseline recovery condition changed before job admission')
    }
    if (sameIgnoredBaselineBridge(state.ignoredBaselineBridge, expected)) {
      if (state.ignoredBaselineBridge?.phase === 'prepared'
        && state.ignoredBaselineBridge.authorityEpoch === authorityEpoch
        && state.ignoredBaselineBridge.authorityTransition === authorityTransition
        && state.ignoredBaselineBridge.requestDigest === requestDigest) return
      if (state.ignoredBaselineBridge?.phase === 'consumed') {
        throw new Error('the authenticated ignored-baseline recovery condition was already consumed')
      }
      throw new Error('the prepared ignored-baseline admission is bound to a different lifecycle transition')
    }
    state.ignoredBaselineBridge = {
      ...expected, phase: 'prepared', authorityEpoch, authorityTransition, requestDigest,
    }
    state.updatedAt = new Date().toISOString()
    state.stateProof = createEmbeddedRunStateProof(state, key)
    atomicWriteJson(statePath, state)
  } finally {
    release()
  }
}

/** Inspect HMAC-owned runs without adopting, terminating, or mutating their worktrees. */
export async function inspectAuthenticatedControllers(cwd: string): Promise<AuthenticatedController[]> {
  const repoRoot = realpathSync(await resolveRepoRoot(cwd))
  const commonRaw = (await runFile('git', ['rev-parse', '--git-common-dir'], { cwd: repoRoot })).stdout.trim()
  const stateBase = resolve(repoRoot, commonRaw, 'leppy-loop', 'runs')
  if (!existsSync(stateBase)) return []

  const controllers: AuthenticatedController[] = []
  for (const name of readdirSync(stateBase)) {
    const stateDir = join(stateBase, name)
    const statePath = join(stateDir, 'run.json')
    const proofPath = join(stateDir, 'ownership.hmac')
    const keyPath = join(stateDir, 'lease.key')
    if (!existsSync(statePath) || !existsSync(keyPath)) continue
    const state = parseStoredRun(statePath)
    if (!state || state.runId !== name || (!state.stateProof && !existsSync(proofPath))) continue
    let storedRoot: string
    try { storedRoot = realpathSync(state.repoRoot) } catch { continue }
    if (storedRoot !== repoRoot || !existsSync(state.worktree)) continue
    const key = Buffer.from(readFileSync(keyPath, 'utf8').trim(), 'base64')
    const proofStatus = inspectRunStateProof(stateDir, state, key)
    if (proofStatus === 'invalid' || proofStatus === 'migration-pending') continue
    const lifecycleReceipt = inspectLifecycleAuthority(stateDir, state.runId)
    if (lifecycleReceipt.status === 'invalid' || (state.lifecycleAuthority !== undefined && lifecycleReceipt.status !== 'valid')) continue
    const lifecycleAuthority = lifecycleReceipt.status === 'valid' ? lifecycleReceipt.authority : undefined
    const attachedBranch = await gitBranch(state.worktree)
    const publicationRebase = attachedBranch !== state.branch && await isAuthenticatedPublicationRebase({
      runId: state.runId,
      repoRoot: state.repoRoot,
      worktree: state.worktree,
      branch: state.branch,
      syncBranch: state.syncBranch,
    }, new AbortController().signal)
    if (attachedBranch !== state.branch && !publicationRebase) continue
    const controllerPath = join(state.worktree, state.checklistRelative)
    if (!existsSync(controllerPath)) continue
    let controllerSource = readFileSync(controllerPath, 'utf8')
    if (publicationRebase) {
      const original = await runFile('git', ['show', `refs/heads/${state.branch}:${state.checklistRelative.replaceAll('\\', '/')}`], { cwd: state.worktree, allowFailure: true })
      if (original.exitCode !== 0) continue
      controllerSource = original.stdout
      if (selectTask(parseChecklist(controllerSource, controllerPath))) continue
    }
    const parsedController = parseChecklist(controllerSource, controllerPath)
    const currentOpenTask = state.currentTask === undefined
      ? undefined
      : parsedController.tasks.find(task => task.index === state.currentTask && task.mark !== 'x')
    const openTask = publicationRebase ? undefined : currentOpenTask ?? selectTask(parsedController)
    const worktreeHead = (await runFile('git', ['rev-parse', 'HEAD'], { cwd: state.worktree })).stdout.trim()
    const checklistDigest = createHash('sha256').update(controllerSource).digest('hex')
    if (state.activeTaskAttempt && (!openTask || state.currentTask !== state.activeTaskAttempt.taskIndex
      || openTask.index !== state.activeTaskAttempt.taskIndex || taskIdentity(openTask) !== state.activeTaskAttempt.taskKey
      || state.activeTaskAttempt.checklistDigest !== checklistDigest)) continue
    if (state.pendingTaskValidation) {
      const pending = state.pendingTaskValidation
      const originalOpenIdentity = openTask && state.currentTask === pending.taskIndex
        && openTask.index === pending.taskIndex && taskIdentity(openTask) === pending.taskKey
      if (pending.phase === 'pending' && (!originalOpenIdentity
        || pending.checklistDigest !== checklistDigest || pending.commitHead !== worktreeHead)) continue
      if (pending.phase === 'validated' && worktreeHead === pending.commitHead) {
        if (checklistDigest !== pending.validatedChecklistDigest
          && (checklistDigest !== pending.checklistDigest || !originalOpenIdentity)) continue
      }
      if (pending.phase === 'validated' && worktreeHead !== pending.commitHead
        && checklistDigest !== pending.validatedChecklistDigest) continue
    }
    const unmergedIndex = (await runFile('git', ['ls-files', '-u', '-z'], { cwd: state.worktree })).stdout
    const authorityDigest = createHash('sha256').update(JSON.stringify({
      runId: state.runId,
      repoRoot,
      checklistRelative: state.checklistRelative,
      checklistDigest,
      sourceHead: state.sourceHead,
      worktreeHead,
      unmergedIndexDigest: createHash('sha256').update(unmergedIndex).digest('hex'),
      branch: state.branch,
      worktree: resolve(state.worktree),
      syncBranch: state.syncBranch,
      status: state.status,
      currentTask: state.currentTask,
      attempt: state.attempt,
      taskAttempts: state.taskAttempts,
      completedTasks: state.completedTasks,
      gateAttempts: state.gateAttempts,
      publicationTargetCommit: state.publicationTargetCommit,
      publicationRemoteHead: state.publicationRemoteHead,
      pullRequestUrl: state.pullRequestUrl,
      lastError: state.lastError,
      lifecycleAuthorityDigest: lifecycleReceipt.status === 'valid' ? lifecycleReceipt.digest : undefined,
      lifecycleAuthority,
      failureStreak: state.failureStreak,
      activeTaskAttempt: state.activeTaskAttempt,
      pendingTaskValidation: state.pendingTaskValidation,
      autoRecoveryBlocked: state.autoRecoveryBlocked,
      dependencyBridgeActive: state.dependencyBridgeActive,
      windowsArgvBridgeActive: state.windowsArgvBridgeActive,
      ignoredBaselineBridge: state.ignoredBaselineBridge,
    })).digest('hex')
    controllers.push({
      runId: state.runId,
      status: state.status,
      repoRoot,
      checklistRelative: state.checklistRelative,
      sourceHead: state.sourceHead,
      branch: state.branch,
      worktree: state.worktree,
      syncBranch: state.syncBranch,
      authorityDigest,
      ...(state.currentTask === undefined ? {} : { currentTask: state.currentTask }),
      attempt: state.attempt,
      completedTasks: state.completedTasks,
      updatedAt: state.updatedAt,
      ...(openTask ? { openTask } : {}),
      ...(state.pullRequestUrl ? { pullRequestUrl: state.pullRequestUrl } : {}),
      ...(state.lastError ? { detail: state.lastError } : {}),
      ...(lifecycleAuthority ? { lifecycleAuthority } : {}),
      ...(state.activeTaskAttempt ? { activeTaskAttempt: state.activeTaskAttempt } : {}),
      ...(state.pendingTaskValidation ? { pendingTaskValidation: state.pendingTaskValidation } : {}),
      ...(state.autoRecoveryBlocked === undefined ? {} : { autoRecoveryBlocked: state.autoRecoveryBlocked }),
      ...(state.dependencyBridgeActive === undefined ? {} : { dependencyBridgeActive: state.dependencyBridgeActive }),
      ...(state.windowsArgvBridgeActive === undefined ? {} : { windowsArgvBridgeActive: state.windowsArgvBridgeActive }),
      ...(state.ignoredBaselineBridge ? { ignoredBaselineBridge: state.ignoredBaselineBridge } : {}),
      ...(publicationRebase ? { publicationRebase: true } : {}),
    })
  }
  return controllers.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
}

/** Select the most recently updated authenticated controller regardless of its workflow phase. */
export function selectControllerForStatus(controllers: readonly AuthenticatedController[]): AuthenticatedController | undefined {
  return [...controllers].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0]
}

/** Select the most recently updated authenticated controller that still has work. */
export function selectControllerForHumanIntent(controllers: readonly AuthenticatedController[]): AuthenticatedController | undefined {
  return controllers.find(controller => controller.openTask !== undefined
    && ['running', 'stalled', 'interrupted', 'failed', 'completed'].includes(controller.status))
}

/** Select the newest authenticated completed or publication-stalled controller with no open work. */
export function selectControllerForPublication(controllers: readonly AuthenticatedController[]): AuthenticatedController | undefined {
  return [...controllers]
    .filter(controller => ['completed', 'stalled'].includes(controller.status) && controller.openTask === undefined)
    .sort((left, right) => {
      const recoveryPriority = Number(Boolean(right.publicationRebase)) - Number(Boolean(left.publicationRebase))
      return recoveryPriority || Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
    })[0]
}
