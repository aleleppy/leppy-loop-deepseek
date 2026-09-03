import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  assertSourceReady, assertTaskCommit, branch as gitBranch, commitControllerChange,
  commitCount, commitSubject, createRunWorktree, discardUnstartedRunWorktree,
  head, ignoredPathDigest, ignoredPathSnapshot, isConventional, resolveRepoRoot,
  status as gitStatus, summarizeDiff, writeChecklistAndAmend,
} from './git.js'
import { lintChecklist, markTaskDone, markTaskOpen, parseChecklist, selectTask } from './checklist.js'
import { appendEvent, acquireLock, atomicWriteJson, createLeaseKey, inspectProcessIdentity, requireFoundProcessIdentity, statePath, verifyLease } from './state.js'
import type { ProcessIdentityInspection, SignedLease } from './state.js'
import { fingerprint, redact, scrubEnvironment } from './security.js'
import { assertOpaqueGateContainmentPlatform, OpaqueShellOrphanedError, runFile, runOpaqueShell, terminateProcessTreeAndWait } from './process.js'
import { physicalRelative } from './path.js'
import { createEmbeddedRunStateProof, ensureRunStateProofRequired, inspectRunStateProof, type EmbeddedRunStateProof } from './run-state-proof.js'
import { abortInterruptedPublicationRebase, isAuthenticatedPublicationRebase } from './publish.js'
import {
  acquireLifecycleAuthorityMutex, appendLifecycleAuthorityReceipt, inspectLifecycleAuthority,
  lifecycleAuthoritiesEqual, lifecycleAuthorityMatchesOrAdvances,
} from './lifecycle-authority.js'
import {
  INVALID_WORKTREE_TREE_REASON, dependencyReplacementTransactionPending, dependencyResolutionMiss,
  inspectWorktreeDependencies, provisionWorktreeDependencies,
} from './worktree-dependencies.js'
import { windowsQuotedExecutableFailure } from './windows-command.js'
import { containWindowsGateProcess, settleWindowsGateJob } from './windows-job.js'
import {
  quarantineWorkerNpmCache, recordWorkerNpmCacheBaseline, workerNpmCacheRecovery, workerNpmCacheTransactionPresent,
} from './worker-artifacts.js'
import {
  recordWorkerIgnoredPathBaseline, reconcileWorkerIgnoredPaths, sameIgnoredBaselineBridge,
  workerIgnoredBaselineBridgeIdentity,
} from './ignored-artifacts.js'
import { DIRECT_HUMAN_STOP_REASON } from './types.js'
import type {
  ActiveTaskAttempt, AuthenticatedGateEvidence, ChecklistTask, GateCacheTransaction, IgnoredBaselineBridgeAdmission, LeppyLoopOptions, LifecycleAuthority, ModelCapability, PendingTaskValidation, RunDependencies, RunEvent,
  PublicationConflict, RunEventType, RunProgress, RunResult, WorkerOutcome, WorkerRequest,
} from './types.js'

class SimulatedLocalGateControllerCrash extends Error {}
class SimulatedPublicationControllerCrash extends Error {}

const DEFAULTS = {
  maxIterations: 64,
  repairCycles: 3,
  publicationRepairCycles: 3,
  syncMaxSeconds: 120,
  workerTimeoutMs: 30 * 60_000,
  workerOutputLimitBytes: 192 * 1024,
  workerTranscriptLimitBytes: 8 * 1024 * 1024,
  workerPolicy: 'adaptive',
  openPullRequest: false,
} as const

interface GateRepairContext {
  schemaVersion: 1
  gateIndex: number
  closureIndex: number
  instruction: string
  additionalPaths?: string[]
}

interface RunState {
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
  gateCacheTransaction?: GateCacheTransaction
  gateEvidence?: AuthenticatedGateEvidence
  updatedAt: string
}

function digest(text: string): string { return createHash('sha256').update(text).digest('hex') }
function taskAttemptKey(task: ChecklistTask): string {
  return digest(JSON.stringify({ index: task.index, phase: task.phase, kind: task.kind, raw: task.raw }))
}
function nextTaskAttempt(state: RunState, task: ChecklistTask): number {
  const key = taskAttemptKey(task)
  const next = (state.taskAttempts[key] ?? 0) + 1
  state.taskAttempts[key] = next
  return next
}
function currentTaskAttempt(state: RunState, task: ChecklistTask): number {
  return state.taskAttempts[taskAttemptKey(task)] ?? 1
}
function workerFailureSignature(outcome: WorkerOutcome): string {
  return digest(JSON.stringify({
    status: outcome.status,
    error: outcome.error?.replace(/\b\d+(?:\.\d+)?(?:ms|s)?\b/giu, '#').slice(0, 4_096),
    report: outcome.report,
  }))
}
function recordWorkerFailure(state: RunState, task: ChecklistTask, outcome: WorkerOutcome): void {
  const taskKey = taskAttemptKey(task)
  const signature = workerFailureSignature(outcome)
  const count = state.failureStreak?.taskKey === taskKey && state.failureStreak.signature === signature
    ? state.failureStreak.count + 1
    : 1
  state.failureStreak = { taskKey, signature, count }
  state.autoRecoveryBlocked = outcome.report?.disposition === 'implementation-impossible'
}
function clearWorkerFailure(state: RunState): void {
  delete state.failureStreak
  delete state.autoRecoveryBlocked
}
function workerGateFingerprint(parsed: ReturnType<typeof parseChecklist>, task: ChecklistTask, fallback?: string): string | undefined {
  const gate = parsed.tasks.find(candidate => candidate.kind === 'gate' && candidate.mark !== 'x' && candidate.phase === task.phase)
  const command = gate?.metadata.gate ?? fallback
  if (!command) return undefined
  return fingerprint([process.platform === 'win32' ? 'cmd.exe' : '/bin/sh', command].join('\0'))
}
function safeSlug(value: string): string { return value.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'default' }
function commandArgument(value: string): string { return `"${value.replaceAll('"', '\\"')}"` }
function persistedChecklistSource(current: string, next: string): string {
  return current.includes('\r\n') ? next.replaceAll('\n', '\r\n') : next
}
async function assertChecklistAdoptionOnly(worktree: string, checklistRelative: string, signal: AbortSignal): Promise<void> {
  const checklist = checklistRelative.replaceAll('\\', '/')
  const [unstaged, staged, untracked] = await Promise.all([
    runFile('git', ['diff', '--name-only', '-z'], { cwd: worktree, signal }),
    runFile('git', ['diff', '--cached', '--name-only', '-z'], { cwd: worktree, signal }),
    runFile('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: worktree, signal }),
  ])
  const changed = [...unstaged.stdout.split('\0'), ...staged.stdout.split('\0'), ...untracked.stdout.split('\0')].filter(Boolean)
  if (changed.length === 0 || changed.some(path => path !== checklist)) {
    throw new Error('validated task pre-amend state contains changes beyond the controlling checklist')
  }
}

async function assertTaskCommitScope(worktree: string, baseHead: string, checklistRelative: string, allowedPaths: readonly string[], signal: AbortSignal): Promise<void> {
  const changed = (await runFile('git', ['diff', '--name-only', '-z', baseHead, 'HEAD'], { cwd: worktree, signal })).stdout.split('\0').filter(Boolean)
  const checklist = checklistRelative.replaceAll('\\', '/')
  const allowed = allowedPaths.map(path => path.replaceAll('\\', '/').replace(/\/$/u, ''))
  if (changed.length === 0) throw new Error('worker commit contains no task changes')
  for (const path of changed) {
    if (path === checklist || !allowed.some(scope => path === scope || path.startsWith(`${scope}/`))) {
      throw new Error(`worker commit changed path outside authenticated task scope: ${path}`)
    }
  }
}
function inside(root: string, path: string): boolean { const rel = relative(root, path); return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)) }
function existingAncestor(path: string): string {
  let current = resolve(path)
  while (!existsSync(current)) {
    const parent = dirname(current)
    if (parent === current) throw new Error(`no existing ancestor for ${path}`)
    current = parent
  }
  return current
}

interface PhaseGateReceipt {
  schemaVersion: 1
  runId: string
  taskIndex: number
  attempt: number
  commandFingerprint: string
  exitCode: number
  stdout: string
  stderr: string
  timestamp: string
  targetHead?: string
  checklistDigest?: string
}

function latestPhaseGateReceipt(stateDir: string, gateIndex: number): PhaseGateReceipt {
  const receiptsDir = join(stateDir, 'receipts')
  const match = existsSync(receiptsDir) ? readdirSync(receiptsDir)
    .map(name => ({ name, match: new RegExp(`^gate-${gateIndex}-(\\d+)\\.json$`, 'u').exec(name) }))
    .filter((entry): entry is { name: string; match: RegExpExecArray } => entry.match !== null)
    .sort((left, right) => Number(right.match[1]) - Number(left.match[1]))[0] : undefined
  if (!match) throw new Error('attempted gate has no durable receipt')
  const receipt = JSON.parse(readFileSync(join(receiptsDir, match.name), 'utf8')) as Partial<PhaseGateReceipt>
  if (receipt.schemaVersion !== 1 || typeof receipt.runId !== 'string' || typeof receipt.taskIndex !== 'number'
    || typeof receipt.attempt !== 'number' || typeof receipt.commandFingerprint !== 'string'
    || typeof receipt.exitCode !== 'number' || typeof receipt.stdout !== 'string'
    || typeof receipt.stderr !== 'string' || typeof receipt.timestamp !== 'string'
    || (receipt.targetHead !== undefined && (typeof receipt.targetHead !== 'string' || !/^[0-9a-f]{40}$/u.test(receipt.targetHead)))
    || (receipt.checklistDigest !== undefined && (typeof receipt.checklistDigest !== 'string' || !/^[0-9a-f]{64}$/u.test(receipt.checklistDigest)))) {
    throw new Error('attempted gate has an invalid durable receipt')
  }
  return receipt as PhaseGateReceipt
}

function gateFailureReason(receipt: Pick<PhaseGateReceipt, 'exitCode' | 'stdout' | 'stderr'>): string {
  const evidence = redact([receipt.stderr.trim(), receipt.stdout.trim()].filter(Boolean).join('\n')).slice(-16 * 1024)
  return `gate exited with code ${receipt.exitCode}${evidence ? `: ${evidence}` : ''}`
}

function latestGateFailureInstruction(stateDir: string, gateIndex: number): string {
  const receipt = latestPhaseGateReceipt(stateDir, gateIndex)
  return [
    `A prior controller gate for this phase failed with exit code ${receipt.exitCode}.`,
    'Repair the concrete failures below only inside the closure scope, then commit at most one correction.',
    `Gate stdout/stderr (bounded tail):\n${`${receipt.stdout}\n${receipt.stderr}`.slice(-24 * 1024)}`,
  ].join('\n')
}

function latestPublicationTargetCommit(stateDir: string): string | undefined {
  const receiptsDir = join(stateDir, 'receipts')
  if (!existsSync(receiptsDir)) return undefined
  for (const name of readdirSync(receiptsDir).filter(file => /^publication-gate-\d+\.json$/u.test(file)).sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))) {
    try {
      const receipt = JSON.parse(readFileSync(join(receiptsDir, name), 'utf8')) as { targetCommit?: unknown; exitCode?: unknown }
      if (receipt.exitCode === 0 && typeof receipt.targetCommit === 'string' && /^[0-9a-f]{40}$/u.test(receipt.targetCommit)) return receipt.targetCommit
    } catch { /* ignore malformed legacy receipts */ }
  }
  return undefined
}

function event(runId: string, type: RunEventType, phase: RunEvent['phase'], data: Record<string, unknown>, task?: ChecklistTask, attempt?: number): RunEvent {
  return { schemaVersion: 1, type, runId, timestamp: new Date().toISOString(), phase, ...(task ? { taskIndex: task.index } : {}), ...(attempt ? { attempt } : {}), data }
}

function applyLifecycleAuthority(state: RunState, next: LifecycleAuthority | undefined): void {
  if (!next) return
  if (!Number.isSafeInteger(next.transitions) || next.transitions < 1 || next.transitions > next.maxTransitions) throw new Error('invalid lifecycle authority transition count')
  if (next.expiresAt <= next.issuedAt || next.maxIterations < 1 || next.maxRepairCycles < 1 || next.maxTransitions < 1
    || (next.revokedAt !== undefined && next.revokedAt < next.issuedAt)) throw new Error('invalid lifecycle authority bounds')
  const current = state.lifecycleAuthority
  if (current && !lifecycleAuthorityMatchesOrAdvances(current, next)) {
    throw new Error('lifecycle authority does not match the authenticated run')
  }
  state.lifecycleAuthority = { ...next }
}

function reconcileDurableLifecycleAuthority(state: RunState, stateDir: string): void {
  const durable = inspectLifecycleAuthority(stateDir, state.runId)
  if (durable.status === 'invalid') throw new Error(`existing lifecycle authority is invalid: ${durable.reason}`)
  if (durable.status !== 'valid') return
  const current = state.lifecycleAuthority
  if (current && !durable.chain.some(authority => lifecycleAuthoritiesEqual(current, authority))) {
    throw new Error('durable lifecycle authority chain does not contain the authenticated run state')
  }
  state.lifecycleAuthority = { ...durable.authority }
}

function assertCompletedWorkerReport(outcome: WorkerOutcome, label: string, advisoryValidation = false): void {
  if (outcome.status !== 'completed') throw new Error(`${label} is not completed`)
  if (!outcome.report) {
    if (advisoryValidation) return
    throw new Error(`${label} completed without the required structured outcome report`)
  }
  if (outcome.report.status !== 'completed' || (!advisoryValidation && outcome.report.validation.status !== 'passed')) {
    throw new Error(`${label} reported ${outcome.report.status} with validation ${outcome.report.validation.status}`)
  }
}

async function discardTransientValidationCache(worktree: string, signal?: AbortSignal): Promise<void> {
  const cache = join(worktree, '.svelte-check')
  if (!existsSync(cache)) return
  const tracked = await runFile('git', ['ls-files', '-z', '--', '.svelte-check'], { cwd: worktree, signal })
  if (tracked.stdout.split('\0').some(Boolean)) return
  if (physicalRelative(worktree, cache) !== '.svelte-check') throw new Error('transient validation cache escapes the worktree')
  rmSync(cache, { recursive: true, force: true })
}

function workerScopeContains(scopes: readonly string[], candidate: string): boolean {
  const path = candidate.replaceAll('\\', '/').replace(/^\.\//u, '')
  return scopes.some(raw => {
    const scope = raw.replaceAll('\\', '/').replace(/\/$/u, '').replace(/^\.\//u, '')
    return scope === '.' || path === scope || path.startsWith(`${scope}/`)
  })
}

async function workerChangedPaths(worktree: string, signal?: AbortSignal): Promise<{ paths: string[]; records: string[] }> {
  const result = await runFile('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: worktree, signal })
  const raw = result.stdout.split('\0')
  const paths: string[] = []
  const records: string[] = []
  for (let index = 0; index < raw.length; index += 1) {
    const record = raw[index]
    if (!record) continue
    if (record.length < 4 || record[2] !== ' ') throw new Error(`invalid Git porcelain record: ${JSON.stringify(record)}`)
    const code = record.slice(0, 2)
    const path = record.slice(3)
    paths.push(path)
    records.push(`${code} ${path}`)
    if (code.includes('R') || code.includes('C')) {
      const source = raw[index + 1]
      if (!source) throw new Error(`Git porcelain rename/copy record lacks its source: ${JSON.stringify(record)}`)
      index += 1
      paths.push(source)
      records.push(`${code} ${source}`)
    }
  }
  return { paths: [...new Set(paths)].sort(), records }
}

async function discardOutOfScopeWorkerChanges(
  worktree: string, scopes: readonly string[], protectedPaths: readonly string[], signal?: AbortSignal,
): Promise<string[]> {
  const pending = await workerChangedPaths(worktree, signal)
  const unmerged = pending.records.filter(record => /^(?:DD|AU|UD|UA|DU|AA|UU) /u.test(record))
  if (unmerged.length > 0) throw new Error(`ordinary worker left an unmerged Git index: ${unmerged.join(' | ')}`)
  const protectedSet = new Set(protectedPaths.map(path => path.replaceAll('\\', '/').replace(/^\.\//u, '')))
  const protectedChanges = pending.paths.filter(path => protectedSet.has(path.replaceAll('\\', '/').replace(/^\.\//u, '')))
  if (protectedChanges.length > 0) throw new Error(`worker altered controller-owned Git paths: ${protectedChanges.join(', ')}`)
  const changed = pending.paths.filter(path => !workerScopeContains(scopes, path))
  if (changed.length > 4_096) throw new Error('out-of-scope validation cleanup exceeds 4096 paths')
  for (let index = 0; index < changed.length; index += 64) {
    await runFile('git', ['reset', '-q', 'HEAD', '--', ...changed.slice(index, index + 64)], { cwd: worktree, signal })
  }
  const trackedAtHead = changed.length === 0 ? [] : (await runFile(
    'git', ['ls-files', '-z', '--', ...changed], { cwd: worktree, signal },
  )).stdout.split('\0').filter(Boolean)
  for (let index = 0; index < trackedAtHead.length; index += 64) {
    await runFile('git', ['restore', '--source=HEAD', '--worktree', '--', ...trackedAtHead.slice(index, index + 64)], { cwd: worktree, signal })
  }
  const tracked = new Set(trackedAtHead)
  for (const path of changed.filter(path => !tracked.has(path))) {
    const candidate = resolve(worktree, path)
    if (!inside(worktree, candidate)) throw new Error(`out-of-scope validation artifact escapes the worktree: ${path}`)
    rmSync(candidate, { recursive: true, force: true })
    let parent = dirname(candidate)
    while (parent !== resolve(worktree) && inside(worktree, parent)) {
      try {
        rmdirSync(parent)
        parent = dirname(parent)
      } catch {
        break
      }
    }
  }
  return changed
}

function ignoredSnapshotEntries(snapshot: Awaited<ReturnType<typeof ignoredPathSnapshot>>): Map<string, string> {
  return new Map(snapshot.entries.map(entry => {
    const separator = entry.indexOf('\0')
    if (separator < 1) throw new Error('ignored artifact snapshot contains an invalid entry')
    return [entry.slice(0, separator), entry] as const
  }))
}

async function discardGateIgnoredSideEffects(
  worktree: string, baseline: Awaited<ReturnType<typeof ignoredPathSnapshot>>, signal?: AbortSignal,
): Promise<string[]> {
  const after = await ignoredPathSnapshot(worktree, signal)
  const beforeEntries = ignoredSnapshotEntries(baseline)
  const afterEntries = ignoredSnapshotEntries(after)
  const altered = [...beforeEntries].filter(([path, entry]) => afterEntries.get(path) !== entry).map(([path]) => path)
  if (altered.length > 0) throw new Error(`local gate changed pre-existing ignored artifacts: ${altered.join(', ')}`)
  const created = [...afterEntries.keys()].filter(path => !beforeEntries.has(path)).sort((left, right) => right.length - left.length)
  for (const path of created) {
    const candidate = resolve(worktree, path)
    if (!inside(worktree, candidate) || physicalRelative(worktree, candidate)?.replaceAll('\\', '/') !== path.replaceAll('\\', '/')) {
      throw new Error(`local gate ignored artifact escapes the worktree: ${path}`)
    }
    rmSync(candidate, { recursive: true, force: true })
    let parent = dirname(candidate)
    while (parent !== resolve(worktree) && inside(worktree, parent)) {
      try {
        rmdirSync(parent)
        parent = dirname(parent)
      } catch {
        break
      }
    }
  }
  const reconciled = await ignoredPathSnapshot(worktree, signal)
  if (reconciled.digest !== baseline.digest) throw new Error('local gate ignored artifact cleanup did not restore the authenticated baseline')
  return created
}

async function adoptCompletedWorkerChanges(
  worktree: string, previousHead: string, scopes: readonly string[], phase: string, signal?: AbortSignal,
): Promise<{ paths: string[]; amended: boolean } | undefined> {
  if ((await gitStatus(worktree)).trim() === '') return undefined
  const pending = await workerChangedPaths(worktree, signal)
  const unmerged = pending.records.filter(record => /^(?:DD|AU|UD|UA|DU|AA|UU) /u.test(record))
  if (unmerged.length > 0) throw new Error(`ordinary worker left an unmerged Git index: ${unmerged.join(' | ')}`)
  const paths = pending.paths
  if (paths.length === 0) throw new Error(`ordinary worker has dirty status without parsed paths: ${pending.records.join(' | ') || '(no records)'}`)
  if (paths.length > 4_096) throw new Error('ordinary worker adoption exceeds 4096 paths')
  const outside = paths.filter(path => !workerScopeContains(scopes, path))
  if (outside.length > 0) throw new Error(`ordinary worker left changes outside authenticated scope after cleanup: ${outside.join(', ')}`)
  const count = await commitCount(worktree, previousHead)
  for (let index = 0; index < paths.length; index += 64) {
    await runFile('git', ['add', '--', ...paths.slice(index, index + 64)], { cwd: worktree, signal })
  }
  if (count >= 1) await runFile('git', ['commit', '--amend', '--no-edit'], { cwd: worktree, signal })
  else await runFile('git', ['commit', '-m', `fix(leppy-loop): apply ${safeSlug(phase)} worker changes`], { cwd: worktree, signal })
  if ((await gitStatus(worktree)).trim() !== '') throw new Error('controller could not adopt completed ordinary worker changes into a clean tree')
  return { paths, amended: count >= 1 }
}

async function normalizeCompletedWorkerCommits(
  worktree: string, previousHead: string, checklistRelative: string, scopes: readonly string[], phase: string, signal: AbortSignal,
): Promise<{ count: number; normalized: boolean }> {
  const count = await commitCount(worktree, previousHead)
  if (count === 0) return { count, normalized: false }
  const changed = (await runFile('git', ['diff', '--name-only', '-z', previousHead, 'HEAD'], { cwd: worktree, signal })).stdout.split('\0').filter(Boolean)
  if (changed.length === 0) {
    await runFile('git', ['reset', '--hard', previousHead], { cwd: worktree, signal })
    return { count: 0, normalized: true }
  }
  await assertTaskCommitScope(worktree, previousHead, checklistRelative, scopes, signal)
  const conventional = isConventional(await commitSubject(worktree))
  if (count === 1 && conventional) return { count, normalized: false }
  await runFile('git', ['reset', '--soft', previousHead], { cwd: worktree, signal })
  await runFile('git', ['commit', '-m', `fix(leppy-loop): consolidate ${safeSlug(phase)} worker changes`], { cwd: worktree, signal })
  return { count: 1, normalized: true }
}

function taskProgress(
  state: RunState,
  task: ChecklistTask,
  totalTasks: number,
  type: RunProgress['type'],
  elapsedMs: number,
  error?: string,
  attempt = state.attempt,
  taskAttempt = currentTaskAttempt(state, task),
): RunProgress {
  return {
    type,
    runId: state.runId,
    taskIndex: task.index,
    attempt,
    taskAttempt,
    kind: task.kind,
    phase: task.phase,
    text: task.text,
    completedTasks: state.completedTasks,
    totalTasks,
    elapsedMs: Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0,
    ...(error ? { error } : {}),
  }
}

function policySelection(
  provider: string,
  policy: NonNullable<LeppyLoopOptions['workerPolicy']>,
  task: ChecklistTask,
  retry: boolean,
  catalog: readonly ModelCapability[],
): { model: string; effort: string } | undefined {
  if (provider !== 'openai-codex' || policy === 'selected') return undefined
  const desired = policy === 'terra-high'
    ? { model: 'gpt-5.6-terra', effort: 'high' }
    : policy === 'sol-low'
      ? { model: 'gpt-5.6-sol', effort: 'low' }
      : retry || task.kind === 'closure'
        ? { model: 'gpt-5.6-sol', effort: 'low' }
        : { model: 'gpt-5.6-terra', effort: 'high' }
  return catalog.some(entry => entry.id === desired.model) ? desired : undefined
}

function selectedModel(
  task: ChecklistTask,
  options: LeppyLoopOptions,
  fallback: { provider: string; model: string; effort?: string },
  catalog: readonly ModelCapability[],
  retry = false,
): { provider: string; model: string; effort?: string } {
  const provider = options.provider ?? fallback.provider
  const policy = policySelection(provider, options.workerPolicy ?? 'adaptive', task, retry, catalog)
  const effort = task.metadata.effort ?? options.effort ?? policy?.effort ?? fallback.effort
  return {
    provider,
    model: task.metadata.model ?? options.model ?? policy?.model ?? fallback.model,
    ...(effort ? { effort } : {}),
  }
}

function legacyCustomInstructions(root: string): string[] {
  const path = join(root, '.leppy-loop.json')
  if (!existsSync(path)) return []
  const body = readFileSync(path, 'utf8')
  if (Buffer.byteLength(body) > 64 * 1024) throw new Error('.leppy-loop.json exceeds 64 KiB')
  const parsed = JSON.parse(body) as unknown
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('.leppy-loop.json must contain an object')
  const custom = (parsed as { customInstructions?: unknown }).customInstructions
  if (custom === undefined || custom === '') return []
  if (typeof custom !== 'string') throw new Error('.leppy-loop.json customInstructions must be a string')
  if (Buffer.byteLength(custom) > 32 * 1024) throw new Error('.leppy-loop.json customInstructions exceeds 32 KiB')
  return [`Applicable tracked legacy instructions from .leppy-loop.json:\n${custom}`]
}

async function discoverInstructions(root: string, paths: readonly string[]): Promise<string[]> {
  const candidates = new Set<string>([join(root, 'AGENTS.md'), join(root, 'CLAUDE.md')])
  for (const scoped of paths) {
    let current = resolve(root, scoped)
    if (!existsSync(current) || !statSync(current).isDirectory()) current = dirname(current)
    while (inside(root, current)) {
      candidates.add(join(current, 'AGENTS.md'))
      candidates.add(join(current, 'CLAUDE.md'))
      if (current === root) break
      current = dirname(current)
    }
  }
  return [...candidates].filter(existsSync).map(path => {
    const body = readFileSync(path, 'utf8')
    if (Buffer.byteLength(body) > 64 * 1024) throw new Error(`instruction file exceeds 64 KiB: ${path}`)
    return `Applicable instructions from ${relative(root, path)}:\n${body}`
  })
}

function validateModelSelection(catalog: readonly ModelCapability[], model: string, effort?: string): void {
  const selected = catalog.find(entry => entry.id === model)
  if (!selected) throw new Error(`model ${JSON.stringify(model)} is absent from the selected provider catalog`)
  if (effort && selected.reasoningEfforts && !selected.reasoningEfforts.includes(effort)) throw new Error(`effort ${JSON.stringify(effort)} is unsupported by model ${JSON.stringify(model)}`)
}

function writeState(path: string, state: RunState): void {
  state.updatedAt = new Date().toISOString()
  const stateDir = dirname(path)
  const key = createLeaseKey(stateDir)
  const requiredPath = join(stateDir, 'run-state-auth-required.hmac')
  if (!existsSync(requiredPath) && existsSync(join(stateDir, 'ownership.hmac'))) {
    throw new Error('legacy run-state proof requires authenticated migration before runner mutation')
  }
  if (existsSync(requiredPath)) ensureRunStateProofRequired(stateDir, state.runId, key)
  state.stateProof = createEmbeddedRunStateProof(state, key)
  atomicWriteJson(path, state)
  if (!existsSync(requiredPath)) ensureRunStateProofRequired(stateDir, state.runId, key)
}

const GATE_VALIDATION_CACHE_PATHS = ['.svelte-check', '.svelte-kit/.svelte-check'] as const

function gateCacheTreeDigest(root: string): string {
  const records: string[] = []
  const queue: Array<{ absolute: string; relative: string }> = [{ absolute: root, relative: '' }]
  let files = 0
  let bytes = 0
  while (queue.length > 0) {
    const current = queue.pop()!
    const metadata = lstatSync(current.absolute)
    if (metadata.isSymbolicLink()) {
      records.push(`${current.relative}\0link\0${readlinkSync(current.absolute)}`)
      continue
    }
    if (metadata.isDirectory()) {
      records.push(`${current.relative}\0directory`)
      const children = readdirSync(current.absolute).sort().reverse()
      for (const child of children) queue.push({ absolute: join(current.absolute, child), relative: current.relative ? `${current.relative}/${child}` : child })
      continue
    }
    if (!metadata.isFile()) throw new Error(`validation cache contains an unsupported filesystem entry: ${current.relative || '.'}`)
    files += 1
    bytes += metadata.size
    if (files > 100_000 || bytes > 512 * 1024 * 1024) throw new Error('validation cache exceeds quarantine limits')
    const content = readFileSync(current.absolute)
    const after = lstatSync(current.absolute)
    if (metadata.dev !== after.dev || metadata.ino !== after.ino || metadata.size !== after.size || metadata.mtimeMs !== after.mtimeMs) {
      throw new Error(`validation cache changed while being authenticated: ${current.relative || '.'}`)
    }
    records.push(`${current.relative}\0file\0${metadata.mode}\0${createHash('sha256').update(content).digest('hex')}`)
  }
  return digest(records.join('\n'))
}

function pruneEmptyCacheParents(worktree: string, cache: string): void {
  let parent = dirname(cache)
  while (parent !== resolve(worktree) && inside(worktree, parent)) {
    try {
      rmdirSync(parent)
      parent = dirname(parent)
    } catch {
      break
    }
  }
}

async function assertUntrackedGateCache(worktree: string, path: string, signal?: AbortSignal): Promise<void> {
  const tracked = await runFile('git', ['ls-files', '-z', '--', path], { cwd: worktree, signal })
  if (tracked.stdout.split('\0').some(Boolean)) throw new Error(`validation cache contains tracked content: ${path}`)
  if (physicalRelative(worktree, join(worktree, path))?.replaceAll('\\', '/') !== path) {
    throw new Error(`validation cache escapes the worktree: ${path}`)
  }
}

function assertSafeDirectoryAncestors(root: string, target: string, label: string): void {
  const relativeTarget = relative(root, target)
  if (relativeTarget === '' || relativeTarget === '.') return
  if (relativeTarget === '..' || relativeTarget.startsWith(`..${sep}`) || isAbsolute(relativeTarget)) throw new Error(`${label} escapes its root`)
  let current = root
  const traversed: string[] = []
  for (const part of relativeTarget.split(sep)) {
    current = join(current, part)
    traversed.push(part)
    let metadata
    try {
      metadata = lstatSync(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()
      || physicalRelative(root, current)?.replaceAll('\\', '/') !== traversed.join('/')) {
      throw new Error(`${label} escapes its root`)
    }
  }
}

async function restoreAuthenticatedGateGitState(
  worktree: string, branch: string, rollbackHead: string, signal: AbortSignal, label: string,
): Promise<void> {
  await runFile('git', ['checkout', '--force', branch], { cwd: worktree, signal, timeoutMs: 30_000 })
  await runFile('git', ['reset', '--hard', rollbackHead], { cwd: worktree, signal, timeoutMs: 30_000 })
  if (await gitBranch(worktree) !== branch || await head(worktree) !== rollbackHead
    || (await gitStatus(worktree)).trim() !== '') throw new Error(`${label} did not restore the authenticated Git state`)
}

async function quarantineGateValidationCaches(
  statePathname: string, stateDir: string, state: RunState, task: ChecklistTask, signal?: AbortSignal,
  context: GateCacheTransaction['context'] = 'local', rollbackHead?: string, publicationTarget?: string,
  afterQuarantined?: () => void | Promise<void>,
): Promise<GateCacheTransaction> {
  assertOpaqueGateContainmentPlatform()
  if (state.gateCacheTransaction) throw new Error('validation-cache quarantine is already active')
  const entries: GateCacheTransaction['entries'] = []
  const absentPaths: string[] = []
  for (const [index, path] of GATE_VALIDATION_CACHE_PATHS.entries()) {
    const source = join(state.worktree, path)
    if (!existsSync(source)) {
      if (movableGateCacheSource(state.worktree, path)) throw new Error(`validation cache has an unsafe pre-existing ancestor: ${path}`)
      absentPaths.push(path)
      continue
    }
    await assertUntrackedGateCache(state.worktree, path, signal)
    entries.push({
      path,
      quarantineRelative: `gate-cache-quarantine/${task.index}-${state.attempt}/${index}`,
      digest: gateCacheTreeDigest(source),
    })
  }
  const rollbackIdentity = typeof rollbackHead === 'string' && /^[0-9a-f]{40,64}$/u.test(rollbackHead)
  const publicationIdentity = typeof publicationTarget === 'string' && publicationTarget.length > 0
    && publicationTarget.length <= 512 && !publicationTarget.includes('\0')
  if (!rollbackIdentity || ((context === 'publication') !== publicationIdentity)) {
    throw new Error('validation-cache quarantine rollback identity is invalid')
  }
  const transaction: GateCacheTransaction = {
    schemaVersion: 1, runId: state.runId, taskIndex: task.index, attempt: state.attempt, context,
    ...(rollbackHead ? { rollbackHead } : {}), ...(publicationTarget ? { publicationTarget } : {}),
    phase: 'prepared', absentPaths, generatedEntries: [], entries,
  }
  state.gateCacheTransaction = transaction
  writeState(statePathname, state)
  try {
    for (const entry of entries) {
      const source = join(state.worktree, entry.path)
      const destination = join(stateDir, entry.quarantineRelative)
      if (existsSync(destination)) throw new Error(`validation-cache quarantine destination already exists: ${entry.quarantineRelative}`)
      assertSafeDirectoryAncestors(stateDir, dirname(destination), 'validation-cache quarantine parent')
      mkdirSync(dirname(destination), { recursive: true })
      const destinationParentRelative = relative(stateDir, dirname(destination)).replaceAll('\\', '/')
      if (physicalRelative(stateDir, dirname(destination))?.replaceAll('\\', '/') !== destinationParentRelative) {
        throw new Error('validation-cache quarantine parent escapes private state')
      }
      if (statSync(dirname(source)).dev !== statSync(dirname(destination)).dev) throw new Error('validation-cache quarantine crosses filesystems')
      renameSync(source, destination)
      pruneEmptyCacheParents(state.worktree, source)
    }
    transaction.phase = 'quarantined'
    writeState(statePathname, state)
    transaction.ignoredBaseline = await ignoredPathSnapshot(state.worktree, signal)
    transaction.phase = 'ready'
    writeState(statePathname, state)
  } catch (error) {
    await restoreGateValidationCaches(statePathname, stateDir, state)
    throw error
  }
  await afterQuarantined?.()
  return transaction
}

async function runAuthenticatedGateShell(
  command: string, statePathname: string, stateDir: string, state: RunState, transaction: GateCacheTransaction,
  signal: AbortSignal, dependencies: RunDependencies, orphanAfterRelease = false,
): Promise<Awaited<ReturnType<typeof runOpaqueShell>>> {
  const permitRelative = `gate-process-permits/${transaction.taskIndex}-${transaction.attempt}-${randomUUID()}.permit`
  const permitPath = join(stateDir, permitRelative)
  assertSafeDirectoryAncestors(stateDir, dirname(permitPath), 'gate process permit parent')
  mkdirSync(dirname(permitPath), { recursive: true })
  const permitParentRelative = relative(stateDir, dirname(permitPath)).replaceAll('\\', '/')
  if (physicalRelative(stateDir, dirname(permitPath))?.replaceAll('\\', '/') !== permitParentRelative) {
    throw new Error('gate process permit parent escapes private state')
  }
  if (existsSync(permitPath)) throw new Error('gate process permit already exists')
  transaction.gateProcess = { phase: 'reserved', permitRelative }
  writeState(statePathname, state)
  if (dependencies.simulateLocalCrashAfterGateProcessReserved) {
    throw new OpaqueShellOrphanedError('simulated controller death after gate process reservation')
  }
  let bootstrapPid: number | undefined
  let windowsContainmentCreated = false
  const settleContainment = async (): Promise<void> => {
    if (bootstrapPid === undefined) return
    if (process.platform === 'win32') {
      if (!windowsContainmentCreated) return
      if (!settleWindowsGateJob(bootstrapPid)) throw new Error('authenticated gate process lost its Windows Job containment')
    } else {
      await terminateProcessTreeAndWait(bootstrapPid, () => {
        try { process.kill(bootstrapPid!, 'SIGTERM') } catch { /* process group already settled */ }
      })
    }
  }
  try {
    const result = await runOpaqueShell(command, state.worktree, signal, scrubEnvironment(process.env), {
      permitPath,
      onSpawn: async pid => {
        bootstrapPid = pid
        containWindowsGateProcess(pid)
        windowsContainmentCreated = process.platform === 'win32'
        const processStart = requireFoundProcessIdentity(
          await inspectProcessIdentity(pid), 'cannot authenticate gate process identity',
        )
        transaction.gateProcess = { phase: 'running', pid, processStart, permitRelative }
        writeState(statePathname, state)
      },
      ...(dependencies.afterGateProcessReleased ? { afterRelease: dependencies.afterGateProcessReleased } : {}),
      orphanAfterRelease,
    })
    await settleContainment()
    delete transaction.gateProcess
    rmSync(permitPath, { force: true })
    writeState(statePathname, state)
    return result
  } catch (error) {
    if (error instanceof OpaqueShellOrphanedError) throw error
    await settleContainment()
    delete transaction.gateProcess
    rmSync(permitPath, { force: true })
    writeState(statePathname, state)
    throw error
  }
}

async function settleAuthenticatedGateProcess(
  statePathname: string, stateDir: string, state: RunState,
): Promise<void> {
  const transaction = state.gateCacheTransaction
  const gateProcess = transaction?.gateProcess
  if (!transaction || !gateProcess) return
  if (!gateProcess.permitRelative.startsWith('gate-process-permits/') || gateProcess.permitRelative.includes('..')) {
    throw new Error('authenticated gate process permit identity is invalid')
  }
  if (gateProcess.phase === 'running') {
    if (!Number.isSafeInteger(gateProcess.pid) || gateProcess.pid <= 0 || gateProcess.processStart.length < 1) {
      throw new Error('authenticated gate process identity is invalid')
    }
    settleWindowsGateJob(gateProcess.pid)
    let inspection = await inspectProcessIdentity(gateProcess.pid)
    if (inspection.status === 'error') throw new Error(`gate process identity inspection failed: ${inspection.detail}`)
    if (inspection.status === 'found' && inspection.identity === gateProcess.processStart) {
      await terminateProcessTreeAndWait(gateProcess.pid, () => {
        try { process.kill(gateProcess.pid, 'SIGTERM') } catch { /* process already settled */ }
      })
      for (let check = 0; check < 20; check += 1) {
        inspection = await inspectProcessIdentity(gateProcess.pid)
        if (inspection.status === 'error') throw new Error(`gate process settlement inspection failed: ${inspection.detail}`)
        if (inspection.status === 'absent' || inspection.identity !== gateProcess.processStart) break
        await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
      }
      if (inspection.status === 'found' && inspection.identity === gateProcess.processStart) {
        throw new Error('authenticated gate process remained live after tree termination')
      }
    }
  } else if (gateProcess.phase !== 'reserved') {
    throw new Error('authenticated gate process phase is invalid')
  }
  const permit = join(stateDir, gateProcess.permitRelative)
  if (!inside(stateDir, permit)) throw new Error('gate process permit escapes private state')
  assertSafeDirectoryAncestors(stateDir, dirname(permit), 'gate process permit recovery parent')
  const permitParentRelative = relative(stateDir, dirname(permit)).replaceAll('\\', '/')
  if (physicalRelative(stateDir, dirname(permit))?.replaceAll('\\', '/') !== permitParentRelative) {
    throw new Error('gate process permit recovery parent escapes private state')
  }
  rmSync(permit, { force: true })
  delete transaction.gateProcess
  writeState(statePathname, state)
}

async function discardAttemptGeneratedGateCaches(worktree: string, signal?: AbortSignal): Promise<string[]> {
  const removed: string[] = []
  for (const path of GATE_VALIDATION_CACHE_PATHS) {
    const cache = join(worktree, path)
    if (!existsSync(cache)) continue
    await assertUntrackedGateCache(worktree, path, signal)
    rmSync(cache, { recursive: true, force: true })
    pruneEmptyCacheParents(worktree, cache)
    removed.push(path)
  }
  return removed
}

function movableGateCacheSource(worktree: string, path: string): { absolute: string; relative: string } | undefined {
  const parts = path.split('/')
  let current = worktree
  for (const [index, part] of parts.entries()) {
    current = join(current, part)
    let metadata
    try {
      metadata = lstatSync(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    if (metadata.isSymbolicLink()) return { absolute: current, relative: parts.slice(0, index + 1).join('/') }
    if (index < parts.length - 1 && !metadata.isDirectory()) return { absolute: current, relative: parts.slice(0, index + 1).join('/') }
  }
  return { absolute: join(worktree, path), relative: path }
}

async function restoreGateValidationCaches(
  statePathname: string, stateDir: string, state: RunState,
): Promise<string[]> {
  const transaction = state.gateCacheTransaction
  if (!transaction) return []
  const baselinePaths = [...transaction.entries.map(entry => entry.path), ...(transaction.absentPaths ?? [])].sort()
  const expectedPaths = [...GATE_VALIDATION_CACHE_PATHS].sort()
  const rollbackIdentity = typeof transaction.rollbackHead === 'string' && /^[0-9a-f]{40,64}$/u.test(transaction.rollbackHead)
  const publicationIdentity = typeof transaction.publicationTarget === 'string' && transaction.publicationTarget.length > 0
    && transaction.publicationTarget.length <= 512 && !transaction.publicationTarget.includes('\0')
  const validGeneratedEntries = Array.isArray(transaction.generatedEntries) && transaction.generatedEntries.every(entry =>
    GATE_VALIDATION_CACHE_PATHS.includes(entry.path as typeof GATE_VALIDATION_CACHE_PATHS[number])
      && (entry.sourcePath === entry.path || entry.path.startsWith(`${entry.sourcePath}/`))
      && entry.quarantineRelative.startsWith(`gate-cache-quarantine/${transaction.taskIndex}-${transaction.attempt}/generated-`))
  const validGateProcess = transaction.gateProcess === undefined
    || (transaction.gateProcess.permitRelative.startsWith('gate-process-permits/')
      && !transaction.gateProcess.permitRelative.includes('..')
      && (transaction.gateProcess.phase === 'reserved'
        || (transaction.gateProcess.phase === 'running' && Number.isSafeInteger(transaction.gateProcess.pid)
          && transaction.gateProcess.pid > 0 && transaction.gateProcess.processStart.length > 0)))
  const validIgnoredBaseline = transaction.phase === 'ready'
    ? transaction.ignoredBaseline !== undefined && Array.isArray(transaction.ignoredBaseline.entries)
      && /^[0-9a-f]{64}$/u.test(transaction.ignoredBaseline.digest)
      && digest(JSON.stringify(transaction.ignoredBaseline.entries)) === transaction.ignoredBaseline.digest
    : (transaction.phase === 'prepared' || transaction.phase === 'quarantined') && transaction.ignoredBaseline === undefined
  if (transaction.schemaVersion !== 1 || transaction.runId !== state.runId || transaction.attempt !== state.attempt
    || !Number.isSafeInteger(transaction.taskIndex) || !Array.isArray(transaction.entries)
    || !Array.isArray(transaction.absentPaths) || !validGeneratedEntries || !validIgnoredBaseline || !validGateProcess
    || JSON.stringify(baselinePaths) !== JSON.stringify(expectedPaths)
    || !rollbackIdentity || !['local', 'publication'].includes(transaction.context)
    || ((transaction.context === 'publication') !== publicationIdentity)) {
    throw new Error('validation-cache quarantine identity is invalid')
  }
  const restored: string[] = []
  for (const [index, entry] of transaction.entries.entries()) {
    if (!GATE_VALIDATION_CACHE_PATHS.includes(entry.path as typeof GATE_VALIDATION_CACHE_PATHS[number])
      || !entry.quarantineRelative.startsWith(`gate-cache-quarantine/${transaction.taskIndex}-${transaction.attempt}/`)) {
      throw new Error('validation-cache quarantine path is invalid')
    }
    const source = join(state.worktree, entry.path)
    const destination = join(stateDir, entry.quarantineRelative)
    const movable = movableGateCacheSource(state.worktree, entry.path)
    const destinationExists = existsSync(destination)
    if (movable && destinationExists) {
      let generatedRelative = entry.generatedQuarantineRelative
      let generatedDestination = generatedRelative ? join(stateDir, generatedRelative) : undefined
      if (!generatedDestination || existsSync(generatedDestination)) {
        generatedRelative = `gate-cache-quarantine/${transaction.taskIndex}-${transaction.attempt}/generated-${index}-${randomUUID()}`
        generatedDestination = join(stateDir, generatedRelative)
      }
      const authenticatedGeneratedRelative = generatedRelative!
      const authenticatedGeneratedDestination = generatedDestination!
      entry.generatedQuarantineRelative = authenticatedGeneratedRelative
      entry.generatedSourcePath = movable.relative
      writeState(statePathname, state)
      assertSafeDirectoryAncestors(stateDir, dirname(authenticatedGeneratedDestination), 'generated validation-cache quarantine parent')
      mkdirSync(dirname(authenticatedGeneratedDestination), { recursive: true })
      const generatedParentRelative = relative(stateDir, dirname(authenticatedGeneratedDestination)).replaceAll('\\', '/')
      if (physicalRelative(stateDir, dirname(authenticatedGeneratedDestination))?.replaceAll('\\', '/') !== generatedParentRelative) {
        throw new Error('generated validation-cache quarantine parent escapes private state')
      }
      if (statSync(dirname(movable.absolute)).dev !== statSync(dirname(authenticatedGeneratedDestination)).dev) throw new Error('generated validation-cache quarantine crosses filesystems')
      renameSync(movable.absolute, authenticatedGeneratedDestination)
      pruneEmptyCacheParents(state.worktree, movable.absolute)
    } else if (!movable && !destinationExists) {
      throw new Error(`validation-cache quarantine lost both copies: ${entry.path}`)
    } else if (movable && !destinationExists
      && (movable.relative !== entry.path || physicalRelative(state.worktree, source)?.replaceAll('\\', '/') !== entry.path)) {
      throw new Error(`validation-cache restored through an unsafe path: ${entry.path}`)
    }
    if (existsSync(destination)) {
      assertSafeDirectoryAncestors(state.worktree, dirname(source), `validation-cache restore parent for ${entry.path}`)
      mkdirSync(dirname(source), { recursive: true })
      const parentRelative = relative(state.worktree, dirname(source)).replaceAll('\\', '/')
      if (physicalRelative(state.worktree, dirname(source))?.replaceAll('\\', '/') !== parentRelative) {
        throw new Error(`validation-cache restore parent escapes the worktree: ${entry.path}`)
      }
      if (physicalRelative(stateDir, destination)?.replaceAll('\\', '/') !== entry.quarantineRelative) {
        throw new Error(`validation-cache quarantine source escapes private state: ${entry.path}`)
      }
      if (statSync(dirname(source)).dev !== statSync(dirname(destination)).dev) throw new Error('validation-cache restore crosses filesystems')
      renameSync(destination, source)
    }
    if (physicalRelative(state.worktree, source)?.replaceAll('\\', '/') !== entry.path
      || gateCacheTreeDigest(source) !== entry.digest) throw new Error(`validation-cache restore digest mismatch: ${entry.path}`)
    restored.push(entry.path)
  }
  for (const [index, path] of transaction.absentPaths.entries()) {
    const movable = movableGateCacheSource(state.worktree, path)
    if (!movable) continue
    const generatedRelative = `gate-cache-quarantine/${transaction.taskIndex}-${transaction.attempt}/generated-absent-${index}-${randomUUID()}`
    const generatedDestination = join(stateDir, generatedRelative)
    transaction.generatedEntries.push({ path, sourcePath: movable.relative, quarantineRelative: generatedRelative })
    writeState(statePathname, state)
    assertSafeDirectoryAncestors(stateDir, dirname(generatedDestination), 'generated absent-cache quarantine parent')
    mkdirSync(dirname(generatedDestination), { recursive: true })
    const generatedParentRelative = relative(stateDir, dirname(generatedDestination)).replaceAll('\\', '/')
    if (physicalRelative(stateDir, dirname(generatedDestination))?.replaceAll('\\', '/') !== generatedParentRelative) {
      throw new Error('generated absent-cache quarantine parent escapes private state')
    }
    if (statSync(dirname(movable.absolute)).dev !== statSync(dirname(generatedDestination)).dev) throw new Error('generated absent-cache quarantine crosses filesystems')
    renameSync(movable.absolute, generatedDestination)
    pruneEmptyCacheParents(state.worktree, movable.absolute)
  }
  delete state.gateCacheTransaction
  writeState(statePathname, state)
  return restored
}

interface LeaseSettlementOperations {
  inspect?: (pid: number) => Promise<ProcessIdentityInspection>
  wait?: () => Promise<void>
  maxChecks?: number
}

export async function awaitAuthenticatedLeaseSettlement(
  stateDir: string, runId: string, operations: LeaseSettlementOperations = {},
): Promise<void> {
  const leaseDir = join(stateDir, 'leases')
  if (!existsSync(leaseDir)) return
  const inspect = operations.inspect ?? inspectProcessIdentity
  const wait = operations.wait ?? (async () => await new Promise<void>(resolveWait => { setTimeout(resolveWait, 250) }))
  const maxChecks = operations.maxChecks ?? 40
  const key = createLeaseKey(stateDir)
  for (const name of readdirSync(leaseDir).filter(file => file.endsWith('.json'))) {
    const lease = JSON.parse(readFileSync(join(leaseDir, name), 'utf8')) as SignedLease
    if (!verifyLease(lease, key) || lease.payload.runId !== runId) continue
    let settled = false
    let lastInspection: ProcessIdentityInspection | undefined
    for (let check = 0; check < maxChecks; check += 1) {
      lastInspection = await inspect(lease.payload.pid)
      if (lastInspection.status === 'absent'
        || (lastInspection.status === 'found' && lastInspection.identity !== lease.payload.processStart)) {
        settled = true
        break
      }
      if (check + 1 < maxChecks) await wait()
    }
    if (!settled && lastInspection?.status === 'error') {
      throw new Error(`authenticated worker lease identity inspection failed closed: ${lastInspection.detail}`)
    }
    if (!settled) {
      throw new Error(`authenticated worker lease process remains live; recovery will not terminate a reusable PID: ${lease.payload.pid}`)
    }
  }
}

async function recoverState(base: string, repoRoot: string, checklistRelative: string, requestedRunId?: string): Promise<{ state: RunState; dir: string } | undefined> {
  if (!existsSync(base)) return undefined
  const matches: { state: RunState; dir: string }[] = []
  for (const name of readdirSync(base)) {
    const dir = join(base, name)
    const path = join(dir, 'run.json')
    const proof = join(dir, 'ownership.hmac')
    if (!existsSync(path)) continue
    const state = JSON.parse(readFileSync(path, 'utf8')) as RunState
    if (!state.stateProof && !existsSync(proof)) continue
    if (state.repoRoot !== repoRoot || state.checklistRelative !== checklistRelative) continue
    if (requestedRunId && state.runId !== requestedRunId) continue
    if (state.status === 'completed' && !requestedRunId) continue
    const key = createLeaseKey(dir)
    if (inspectRunStateProof(dir, state, key) !== 'current') continue
    matches.push({ state, dir })
  }
  let candidates = matches
  if (!requestedRunId && matches.length > 1) {
    const intentionallyRecoverable = matches.filter(entry => entry.state.status === 'stalled' || entry.state.status === 'interrupted')
    if (intentionallyRecoverable.length === 1) candidates = intentionallyRecoverable
    else throw new Error(`multiple authenticated matching runs exist; select one with --recover-run <id>: ${matches.map(entry => entry.state.runId).join(', ')}`)
  }
  const match = candidates[0]
  if (!match) return undefined
  if (!existsSync(match.state.worktree)) throw new Error('authenticated run worktree no longer exists')
  const attachedBranch = await gitBranch(match.state.worktree)
  const recoverySyncBranch = match.state.gateCacheTransaction?.context === 'publication'
    && typeof match.state.gateCacheTransaction.publicationTarget === 'string'
    ? match.state.gateCacheTransaction.publicationTarget
    : match.state.syncBranch
  if (attachedBranch !== match.state.branch && !match.state.gateCacheTransaction && !await isAuthenticatedPublicationRebase({
    runId: match.state.runId,
    repoRoot: match.state.repoRoot,
    worktree: match.state.worktree,
    branch: match.state.branch,
    syncBranch: recoverySyncBranch,
  }, new AbortController().signal)) throw new Error('authenticated run worktree or publication rebase no longer matches')
  return match
}

function dryRunResult(runId: string, task: ChecklistTask | undefined, diagnostics: RunResult['diagnostics'], repoRoot: string, tasks: string, model: { provider: string; model: string; effort?: string }, options: LeppyLoopOptions): RunResult {
  const slug = safeSlug(basename(tasks).replace(/\.task\.md$/i, ''))
  const branch = `leppy-loop/${slug}-${runId}`
  const worktree = resolve(dirname(repoRoot), `${basename(repoRoot)}-${slug}-${runId}`)
  const preview = {
    selectedLine: task?.raw ?? null,
    model,
    paths: task?.metadata.paths ?? [],
    branch,
    worktree,
    gate: options.phaseGateCommand ?? task?.metadata.gate ?? null,
    diagnostics,
  }
  return { runId, status: 'dry-run', branch, worktree, completedTasks: 0, ...(task ? { currentTask: task.index } : {}), diagnostics, preview }
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason
  return new Error(typeof signal.reason === 'string' ? signal.reason : 'interrupted')
}

export async function runLeppyLoop(input: LeppyLoopOptions, dependencies: RunDependencies = {}): Promise<RunResult> {
  const processAbort = new AbortController()
  const interrupt = (): void => processAbort.abort(new Error('interrupted'))
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', interrupt)
  const signal = dependencies.signal
    ? AbortSignal.any([dependencies.signal, processAbort.signal])
    : processAbort.signal
  try {
    if (signal.aborted) throw abortReason(signal)
    return await runLeppyLoopControlled(input, dependencies, signal)
  } finally {
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', interrupt)
  }
}

async function runLeppyLoopControlled(input: LeppyLoopOptions, dependencies: RunDependencies, signal: AbortSignal): Promise<RunResult> {
  const options = { ...DEFAULTS, ...input }
  if ((options.retryGate || options.repairGate) && (!options.recoverExistingWip || !options.recoverRunId)) throw new Error('--retry-gate/--repair-gate require --recover-existing-wip and an exact --recover-run')
  if ((options.repairPaths?.length ?? 0) > 0 && !options.repairGate) throw new Error('--repair-path requires --repair-gate')
  if (input.repairCycles !== undefined && !options.repairGate) throw new Error('--repair-cycles requires --repair-gate')
  if (!Number.isSafeInteger(options.repairCycles) || options.repairCycles < 1 || options.repairCycles > 8) throw new Error('--repair-cycles must be an integer from 1 to 8')
  if (!Number.isSafeInteger(options.publicationRepairCycles) || options.publicationRepairCycles < 1 || options.publicationRepairCycles > 8) throw new Error('publication repair cycles must be an integer from 1 to 8')
  const clock = dependencies.now ?? (() => new Date())
  const runId = dependencies.runId?.() ?? randomUUID().replaceAll('-', '').slice(0, 12)
  const requestedTasks = resolve(options.tasks)
  const repoRoot = realpathSync(options.repoRoot ?? await resolveRepoRoot(existingAncestor(dirname(requestedTasks)), signal))
  const tasksAbsolute = existsSync(requestedTasks) ? realpathSync(requestedTasks) : requestedTasks
  const checklistRelative = existsSync(tasksAbsolute)
    ? physicalRelative(repoRoot, tasksAbsolute)
    : inside(repoRoot, tasksAbsolute) ? relative(repoRoot, tasksAbsolute) : undefined
  if (checklistRelative === undefined) throw new Error('--tasks must be inside the source repository')
  if (!existsSync(tasksAbsolute) && !options.recoverExistingWip) throw new Error(`controlling checklist does not exist: ${tasksAbsolute}`)

  const commonRaw = (await runFile('git', ['rev-parse', '--git-common-dir'], { cwd: repoRoot, signal })).stdout.trim()
  const commonDir = realpathSync(resolve(repoRoot, commonRaw))
  const stateBase = resolve(options.artifactsDir ?? join(commonDir, 'leppy-loop', 'runs'))
  const recoveryPreview = options.recoverExistingWip ? await recoverState(stateBase, repoRoot, checklistRelative, options.recoverRunId) : undefined
  if (options.recoverExistingWip && !recoveryPreview) throw new Error('no authenticated matching run exists')
  if (!recoveryPreview) await assertSourceReady(repoRoot, checklistRelative, signal)
  const controllerPath = recoveryPreview ? join(recoveryPreview.state.worktree, checklistRelative) : tasksAbsolute
  const controllerRoot = recoveryPreview?.state.worktree ?? repoRoot

  const fallbackSelection = dependencies.defaultModel ? await dependencies.defaultModel() : { provider: options.provider ?? 'deepseek-official', model: options.model ?? 'deepseek-v4-flash', ...(options.effort ? { effort: options.effort } : {}) }
  const provider = options.provider ?? fallbackSelection.provider
  const catalog = dependencies.modelCatalog ? await dependencies.modelCatalog(provider) : [{ id: options.model ?? fallbackSelection.model }]
  const parsedSource = parseChecklist(controllerPath)
  const initialTask = selectTask(parsedSource, options.taskMatch)
  const previewModel = initialTask ? selectedModel(initialTask, options, fallbackSelection, catalog) : fallbackSelection
  const defaultEffort = previewModel.effort
  const diagnostics = lintChecklist(parsedSource, {
    repoRoot: controllerRoot, controllerPath, models: catalog, provider,
    defaultModel: previewModel.model,
    ...(defaultEffort ? { defaultEffort } : {}),
    ...(options.phaseGateCommand ? { phaseGateCommand: options.phaseGateCommand } : {}),
  })
  if (options.dryRun) return dryRunResult(runId, initialTask, diagnostics, repoRoot, checklistRelative, previewModel, options)
  if (diagnostics.some(item => item.severity === 'error')) throw new Error(`checklist lint failed:\n${diagnostics.map(item => `${item.line ?? '-'} ${item.code}: ${item.message}`).join('\n')}`)
  if (!dependencies.worker) throw new Error('runLeppyLoop requires a WorkerAdapter outside the Harness bundle')

  mkdirSync(stateBase, { recursive: true })
  let state: RunState
  let stateDir: string
  let releaseLock: (() => void) | undefined
  const recovered = options.recoverExistingWip ? await recoverState(stateBase, repoRoot, checklistRelative, options.recoverRunId) : undefined
  if (options.recoverExistingWip && !recovered) throw new Error('authenticated run disappeared during recovery')
  if (!recovered && !initialTask) throw new Error('checklist contains no open executable rows')
  let recoveryError: string | undefined
  let npmCacheQuarantined = false
  if (recovered) {
    state = recovered.state
    stateDir = recovered.dir
    const recoveredRunId = state.runId
    releaseLock = await acquireLock(commonDir, recoveredRunId)
    try {
      const lockedRecovery = await recoverState(stateBase, repoRoot, checklistRelative, recoveredRunId)
      if (!lockedRecovery || lockedRecovery.dir !== stateDir) throw new Error('authenticated run changed while waiting for its repository lock')
      state = lockedRecovery.state
      recoveryError = state.lastError
      state.taskAttempts ??= {}
      reconcileDurableLifecycleAuthority(state, stateDir)
      applyLifecycleAuthority(state, options.lifecycleAuthority)
      if (dependencies.awaitAuthenticatedLeaseSettlement) await dependencies.awaitAuthenticatedLeaseSettlement(stateDir, state.runId)
      else await awaitAuthenticatedLeaseSettlement(stateDir, state.runId)
      if (state.gateCacheTransaction) {
        await settleAuthenticatedGateProcess(join(stateDir, 'run.json'), stateDir, state)
        const cacheTransaction = state.gateCacheTransaction
        if (cacheTransaction.context === 'publication') {
          if (dependencies.simulatePublicationCrashRollbackFailure) throw new Error('simulated publication crash rollback failure')
          await abortInterruptedPublicationRebase({
            runId: state.runId, repoRoot: state.repoRoot, worktree: state.worktree, branch: state.branch, syncBranch: cacheTransaction.publicationTarget!,
          }, signal)
        }
        await restoreAuthenticatedGateGitState(state.worktree, state.branch, cacheTransaction.rollbackHead!, signal, `${cacheTransaction.context} gate crash rollback`)
        const restoredIgnored = cacheTransaction.phase === 'ready'
          ? await discardGateIgnoredSideEffects(state.worktree, cacheTransaction.ignoredBaseline!, signal)
          : []
        const restoredCaches = await restoreGateValidationCaches(join(stateDir, 'run.json'), stateDir, state)
        appendEvent(join(stateDir, 'events.jsonl'), event(state.runId, 'recovery-done', 'recovery', {
          workerArtifact: 'gate-validation-cache-quarantine', paths: restoredCaches, ignoredPaths: restoredIgnored, crashRecovery: true,
          context: cacheTransaction.context,
        }))
      }
      const previousStatus = state.status
      state.status = 'running'
      delete state.lastError
      writeState(join(stateDir, 'run.json'), state)
      appendEvent(join(stateDir, 'events.jsonl'), event(state.runId, 'recovery-start', 'recovery', { worktree: state.worktree, previousStatus }))
      appendEvent(join(stateDir, 'events.jsonl'), event(state.runId, 'recovery-done', 'recovery', { taskIndex: state.currentTask ?? null }))
    } catch (error) {
      releaseLock()
      throw error
    }
  } else {
    releaseLock = await acquireLock(commonDir, runId)
    try {
      const setup = await createRunWorktree(repoRoot, checklistRelative, options.syncBranch, runId, options.fetch ?? true, options.syncMaxSeconds, signal)
      const baseTask = selectTask(parseChecklist(join(setup.worktree, checklistRelative)), options.taskMatch)
      if (!baseTask) {
        await discardUnstartedRunWorktree(repoRoot, setup.worktree, setup.branch)
        throw new Error('authoritative base checklist contains no open executable rows')
      }
      stateDir = statePath(stateBase, runId)
      mkdirSync(stateDir, { recursive: true })
      state = {
        schemaVersion: 1, runId, status: 'running', repoRoot, checklistRelative, sourceHead: setup.sourceHead,
        branch: setup.branch, worktree: setup.worktree, syncBranch: options.syncBranch, attempt: 0,
        taskAttempts: {}, completedTasks: 0, gateAttempts: {},
        ...(options.lifecycleAuthority ? { lifecycleAuthority: options.lifecycleAuthority } : {}),
        updatedAt: clock().toISOString(),
      }
      applyLifecycleAuthority(state, options.lifecycleAuthority)
      createLeaseKey(stateDir)
      writeState(join(stateDir, 'run.json'), state)
      writeFileSync(join(stateDir, 'runner.pid'), `${process.pid}\n`, 'utf8')
      appendEvent(join(stateDir, 'events.jsonl'), event(runId, 'run-start', 'setup', { branch: state.branch, worktree: state.worktree, sourceHead: state.sourceHead }))
    } catch (error) {
      releaseLock()
      throw error
    }
  }

  try {
    const observedIgnoredBaselineBridge = workerIgnoredBaselineBridgeIdentity(recoveryError, state.activeTaskAttempt)
    if (options.ignoredBaselineRecovery) {
      if (!recovered || !sameIgnoredBaselineBridge(observedIgnoredBaselineBridge, options.ignoredBaselineRecovery)
        || !sameIgnoredBaselineBridge(state.ignoredBaselineBridge, options.ignoredBaselineRecovery)
        || state.ignoredBaselineBridge?.phase !== 'prepared') {
        throw new Error('the authenticated ignored-baseline recovery condition changed or lacks its prepared admission marker')
      }
      state.ignoredBaselineBridge = { ...state.ignoredBaselineBridge, phase: 'consumed' }
      writeState(join(stateDir, 'run.json'), state)
      appendEvent(join(stateDir, 'events.jsonl'), event(state.runId, 'recovery-done', 'recovery', { ignoredBaselineBridge: 'consumed' }))
    } else if (observedIgnoredBaselineBridge) {
      throw new Error('legacy ignored-baseline recovery requires lock-protected activation of the exact authenticated terminal and active attempt')
    }
    if (options.windowsArgvRecoveryDigest) {
      const observedDigest = recoveryError ? createHash('sha256').update(recoveryError).digest('hex') : undefined
      if (observedDigest !== options.windowsArgvRecoveryDigest || !windowsQuotedExecutableFailure(recoveryError)
        || state.windowsArgvBridgeActive === true) {
        throw new Error('the authenticated Windows argv recovery condition changed before lock-protected activation')
      }
      state.windowsArgvBridgeActive = true
      clearWorkerFailure(state)
      writeState(join(stateDir, 'run.json'), state)
      appendEvent(join(stateDir, 'events.jsonl'), event(state.runId, 'recovery-done', 'recovery', { windowsStructuredArgv: 'activated' }))
    }
    const repairingWorkerNpmCache = workerNpmCacheRecovery(recoveryError)
    if (options.workerArtifactRecoveryDigest) {
      const observedDigest = recoveryError ? digest(recoveryError) : undefined
      if (observedDigest !== options.workerArtifactRecoveryDigest || !repairingWorkerNpmCache) {
        throw new Error('the authenticated worker npm cache recovery error changed before lock-protected quarantine')
      }
    }
    if (repairingWorkerNpmCache && !options.workerArtifactRecoveryDigest) {
      throw new Error('worker npm cache recovery requires the exact authenticated error digest')
    }
    const workerNpmCacheReceipt = workerNpmCacheTransactionPresent(stateDir)
    const activeAttemptCache = recovered && state.activeTaskAttempt !== undefined && existsSync(join(state.worktree, '.npm-cache'))
    if (repairingWorkerNpmCache || workerNpmCacheReceipt || activeAttemptCache) {
      if (!recovered || !state.lifecycleAuthority || !options.recoverRunId || options.recoverRunId !== state.runId) {
        throw new Error('worker npm cache recovery requires the exact authenticated existing run')
      }
      if (!workerNpmCacheReceipt && (!Number.isSafeInteger(state.currentTask) || (state.currentTask ?? -1) < 0)) {
        throw new Error('new worker npm cache recovery requires an authenticated current task')
      }
      const activeCacheAttempt = activeAttemptCache ? state.activeTaskAttempt : undefined
      const quarantined = await quarantineWorkerNpmCache({
        worktree: state.worktree,
        stateDir,
        runId: state.runId,
        ...(!workerNpmCacheReceipt ? {
          taskIndex: activeCacheAttempt?.taskIndex ?? state.currentTask!,
          attempt: activeCacheAttempt?.attempt ?? state.attempt,
        } : {}),
        ...(!workerNpmCacheReceipt ? {
          recoveryErrorDigest: activeCacheAttempt
            ? digest(`active-attempt-artifact\0${activeCacheAttempt.taskKey}\0${activeCacheAttempt.attempt}`)
            : digest(recoveryError!),
        } : {}),
        allowLegacyDigest: options.workerArtifactRecoveryDigest !== undefined && !activeCacheAttempt,
        key: createLeaseKey(stateDir),
      })
      npmCacheQuarantined = true
      appendEvent(join(stateDir, 'events.jsonl'), event(state.runId, 'recovery-done', 'recovery', {
        workerArtifact: '.npm-cache', transactionId: quarantined.transactionId,
        resumed: quarantined.resumed, basis: quarantined.basis,
      }))
    }
    const initialDependencyState = inspectWorktreeDependencies(state.repoRoot, state.worktree)
    const repairingDependencyMiss = dependencyResolutionMiss(recoveryError)
    const dependencyStagingRoot = join(stateDir, 'dependency-staging')
    const pendingDependencyReplacement = dependencyReplacementTransactionPending(dependencyStagingRoot)
    const invalidDependencyTree = initialDependencyState.status === 'unavailable'
      && initialDependencyState.reason === INVALID_WORKTREE_TREE_REASON
    const automaticDependencyRepair = repairingDependencyMiss || pendingDependencyReplacement || invalidDependencyTree
    const dependencyProvision = initialDependencyState.status === 'copyable' || initialDependencyState.status === 'installable'
      || initialDependencyState.status === 'local' || automaticDependencyRepair
      ? await provisionWorktreeDependencies(state.repoRoot, state.worktree, {
        stagingRoot: dependencyStagingRoot, signal,
        ...(automaticDependencyRepair ? { replaceInvalidTarget: true } : {}),
        ...(dependencies.installNpmDependencies ? { installNpm: dependencies.installNpmDependencies } : {}),
      })
      : initialDependencyState
    if (dependencyProvision.status === 'unavailable' && (state.dependencyBridgeActive === true || automaticDependencyRepair)) {
      const prior = repairingDependencyMiss ? `; prior dependency error: ${recoveryError!.slice(-2_048)}` : ''
      throw new Error(`dependencies are not usable after automatic repair: ${dependencyProvision.reason}${prior}`)
    }
    if (dependencyProvision.status === 'local' || dependencyProvision.status === 'copied') {
      state.dependencyBridgeActive = true
      if (repairingDependencyMiss) clearWorkerFailure(state)
      writeState(join(stateDir, 'run.json'), state)
      if (repairingDependencyMiss) {
        appendEvent(join(stateDir, 'events.jsonl'), event(state.runId, 'recovery-done', 'recovery', {
          dependencyHydration: dependencyProvision.status, lockfile: dependencyProvision.lockfile,
        }))
      }
    }
  } catch (error) {
    const priorDependencyError = dependencyResolutionMiss(recoveryError) ? `; prior dependency error: ${recoveryError!.slice(-2_048)}` : ''
    const detail = redact(`pre-worker setup failed: ${error instanceof Error ? error.message : String(error)}${priorDependencyError}`)
    state.status = 'stalled'
    state.lastError = detail
    state.autoRecoveryBlocked = true
    try {
      writeState(join(stateDir, 'run.json'), state)
      appendEvent(join(stateDir, 'events.jsonl'), event(state.runId, 'stall', 'setup', { error: detail }))
    } finally {
      releaseLock()
    }
    return {
      runId: state.runId, status: 'stalled', branch: state.branch, worktree: state.worktree, stateDir,
      completedTasks: state.completedTasks, ...(state.currentTask !== undefined ? { currentTask: state.currentTask } : {}),
      diagnostics, detail,
    }
  }

  const eventsPath = join(stateDir, 'events.jsonl')
  const gateRepairPath = join(stateDir, 'gate-repair.json')
  let gateRepairContext: GateRepairContext | undefined
  try {
    gateRepairContext = existsSync(gateRepairPath)
      ? JSON.parse(readFileSync(gateRepairPath, 'utf8')) as GateRepairContext
      : undefined
  } catch (error) {
    releaseLock()
    throw error
  }
  const actionAuthority = (allowPublicationDowngrade: boolean): LifecycleAuthority | undefined => {
    const durable = inspectLifecycleAuthority(stateDir, state.runId)
    if (durable.status === 'invalid') throw new Error(`existing lifecycle authority is invalid: ${durable.reason}`)
    const current = state.lifecycleAuthority
    if (durable.status !== 'valid') {
      if (current?.revokedAt !== undefined) throw new Error(DIRECT_HUMAN_STOP_REASON)
      return current
    }
    if (!current || !durable.chain.some(authority => lifecycleAuthoritiesEqual(current, authority))) {
      throw new Error('durable lifecycle authority chain does not contain the live run state')
    }
    if (lifecycleAuthoritiesEqual(current, durable.authority)) {
      if (current.revokedAt !== undefined) throw new Error(DIRECT_HUMAN_STOP_REASON)
      return current
    }
    if (durable.authority.revokedAt !== undefined) throw new Error(DIRECT_HUMAN_STOP_REASON)
    if (allowPublicationDowngrade && current.allowPublication && !durable.authority.allowPublication) {
      state.lifecycleAuthority = { ...durable.authority }
      writeState(join(stateDir, 'run.json'), state)
      return state.lifecycleAuthority
    }
    throw new Error('lifecycle authority advanced before privileged action admission')
  }
  const runAuthorizedWorker = async (request: WorkerRequest): Promise<WorkerOutcome> => {
    const release = await acquireLifecycleAuthorityMutex(stateDir)
    let admitted: Promise<WorkerOutcome>
    try {
      actionAuthority(false)
      admitted = dependencies.worker!.run(request, signal)
    } finally {
      // Stop persists revocation before aborting the job, so never hold admission authority while awaiting the worker.
      release()
    }
    return await admitted
  }
  const runAuthorizedRemoteMutation = async <T>(mutation: () => Promise<T>): Promise<T> => {
    const release = await acquireLifecycleAuthorityMutex(stateDir)
    try {
      const authority = actionAuthority(false)
      if (authority && !authority.allowPublication) throw new Error('authenticated lifecycle authority does not permit publication')
      return await mutation()
    } finally { release() }
  }
  const publicationAuthorized = async (): Promise<boolean> => {
    const release = await acquireLifecycleAuthorityMutex(stateDir)
    try {
      const authority = actionAuthority(true)
      return options.openPullRequest && authority?.allowPublication !== false
    } finally { release() }
  }
  let activeProgress: { task: ChecklistTask; totalTasks: number; attempt: number; taskAttempt: number; startedAtMs: number } | undefined
  let retryGateAuthorized = Boolean(options.retryGate || options.repairGate)
  let repairCyclesRemaining = options.repairCycles
  let repairCyclesUsed = 0
  const settleProgress = async (type: 'task-done' | 'task-failed', error?: string): Promise<void> => {
    const active = activeProgress
    if (!active) return
    activeProgress = undefined
    const elapsedMs = clock().getTime() - active.startedAtMs
    await dependencies.onProgress?.(taskProgress(state, active.task, active.totalTasks, type, elapsedMs, error, active.attempt, active.taskAttempt))
  }
  let publicationRepairsUsed = 0
  let publicationChecklistDigest: string | undefined
  let publicationOriginalHead: string | undefined
  let publicationValidationReceipt: string | undefined
  let publicationGate: { task: ChecklistTask; command: string } | undefined
  const repairPublicationConflict = async (conflict: PublicationConflict): Promise<void> => {
    if (publicationRepairsUsed >= options.publicationRepairCycles) throw new Error(`publication conflict repair cycle limit exhausted after ${publicationRepairsUsed} workers`)
    if (!publicationChecklistDigest || !publicationGate) throw new Error('publication conflict repair lacks a frozen checklist and final gate')
    const checklistPath = join(state.worktree, checklistRelative)
    const rebaseStepChecklistDigest = digest(readFileSync(checklistPath, 'utf8'))
    const priorTargetCommit = state.publicationTargetCommit ?? latestPublicationTargetCommit(stateDir) ?? state.sourceHead
    const publicationRequest = {
      runId: state.runId, repoRoot: state.repoRoot, worktree: state.worktree, branch: state.branch,
      syncBranch: options.publicationTarget ?? state.syncBranch,
      originalSyncBranch: state.syncBranch,
      ...(priorTargetCommit ? { priorTargetCommit } : {}),
      ...(state.publicationRemoteHead ? { priorRemoteHead: state.publicationRemoteHead } : {}),
    }
    if (!await isAuthenticatedPublicationRebase(publicationRequest, signal)) throw new Error('publication conflict worker requires the authenticated live rebase')
    const normalizeConflictPath = (path: string): string => {
      const absolute = resolve(state.worktree, path)
      const scoped = existsSync(absolute)
        ? physicalRelative(state.worktree, absolute)
        : inside(state.worktree, absolute) ? relative(state.worktree, absolute) : undefined
      if (!scoped || scoped === checklistRelative) throw new Error(`publication conflict path escapes worker scope: ${path}`)
      return scoped
    }
    const requestedPaths = conflict.paths.map(normalizeConflictPath)
    const liveRaw = (await runFile('git', ['diff', '--name-only', '--diff-filter=U', '-z'], { cwd: state.worktree, signal })).stdout
    const livePaths = liveRaw.split('\0').filter(Boolean).map(normalizeConflictPath)
    const requestedSet = [...new Set(requestedPaths)].sort()
    const liveSet = [...new Set(livePaths)].sort()
    if (requestedSet.length !== requestedPaths.length || JSON.stringify(requestedSet) !== JSON.stringify(liveSet)) throw new Error('publication conflict scope does not exactly match Git unmerged paths')
    const allowedPaths = liveSet
    publicationRepairsUsed += 1
    state.attempt += 1
    const task: ChecklistTask = {
      index: 10_000 + publicationRepairsUsed,
      line: 0,
      phase: 'Publication rebase repair',
      mark: '?',
      kind: 'task',
      text: `Resolve authenticated publication rebase conflict (${publicationRepairsUsed}/${options.publicationRepairCycles})`,
      raw: `Publication rebase conflict repair | paths=${allowedPaths.join(',')}`,
      metadata: {
        done: 'Resolve every conflict marker in the exact allowed files while preserving completed feature behavior and compatible authoritative-base changes; do not stage or commit.',
        paths: allowedPaths,
      },
    }
    const taskAttempt = nextTaskAttempt(state, task)
    writeState(join(stateDir, 'run.json'), state)
    const model = selectedModel(task, options, fallbackSelection, catalog, true)
    validateModelSelection(catalog, model.model, model.effort)
    const previousHead = await head(state.worktree)
    const gateCommand = publicationGate.command
    const request: WorkerRequest = {
      runId: state.runId,
      task,
      attempt: state.attempt,
      worktree: state.worktree,
      repoRoot: state.repoRoot,
      checklistPath: checklistRelative,
      allowedPaths,
      mode: 'publication-conflict',
      model: model.model,
      provider: model.provider,
      ...(model.effort ? { effort: model.effort } : {}),
      timeoutMs: options.workerTimeoutMs,
      outputLimitBytes: options.workerOutputLimitBytes,
      transcriptLimitBytes: options.workerTranscriptLimitBytes,
      stateDir,
      ...(gateCommand ? { gateFingerprint: fingerprint([process.platform === 'win32' ? 'cmd.exe' : '/bin/sh', gateCommand].join('\0')) } : {}),
      instructions: [
        ...legacyCustomInstructions(state.worktree),
        ...await discoverInstructions(state.worktree, allowedPaths),
        `The controller is in an authenticated Git rebase stopped by conflicts. Resolve only these unmerged paths: ${allowedPaths.join(', ')}.`,
        `Preserve both the completed Leppy work and compatible changes from the authoritative base. Conflict detail: ${redact(conflict.detail)}`,
        'Do not run git, stage, commit, rebase, merge, push, gh, gates, or edit the checklist. Resolve only file contents and return; the controller owns the index and rebase continuation.',
      ],
    }
    appendEvent(eventsPath, event(state.runId, 'recovery-start', 'publish', { publicationConflict: true, cycle: publicationRepairsUsed, paths: allowedPaths }, task, state.attempt))
    await dependencies.onProgress?.(taskProgress(state, task, state.completedTasks, 'task-start', 0, undefined, state.attempt, taskAttempt))
    const startedAt = clock().getTime()
    const outcome = await runAuthorizedWorker(request)
    if (signal.aborted) throw abortReason(signal)
    if (digest(readFileSync(checklistPath, 'utf8')) !== rebaseStepChecklistDigest) throw new Error('publication repair worker altered the controlling checklist')
    if (outcome.status !== 'completed') throw new Error(`publication conflict worker ${outcome.status}: ${outcome.error ?? 'no error detail'}`)
    assertCompletedWorkerReport(outcome, 'publication conflict worker')
    if (await head(state.worktree) !== previousHead) throw new Error('publication conflict worker changed HEAD')
    if (!await isAuthenticatedPublicationRebase(publicationRequest, signal)) throw new Error('publication conflict worker changed the authenticated rebase identity')
    appendEvent(eventsPath, event(state.runId, 'recovery-done', 'publish', { publicationConflict: true, cycle: publicationRepairsUsed, resolvedPaths: allowedPaths }, task, state.attempt))
    await dependencies.onProgress?.(taskProgress(state, task, state.completedTasks, 'task-done', clock().getTime() - startedAt, undefined, state.attempt, taskAttempt))
  }
  const restorePrePublicationHead = async (): Promise<void> => {
    if (!publicationOriginalHead) throw new Error('publication rollback lacks the authenticated original HEAD')
    await restoreAuthenticatedGateGitState(state.worktree, state.branch, publicationOriginalHead, signal, 'publication rollback')
  }
  const validatePublicationBase = async (targetCommit: string): Promise<{ receipt: string; validatedHead: string }> => {
    if (!publicationChecklistDigest || !publicationOriginalHead || !publicationGate) throw new Error('publication requires a frozen completed checklist and final gate')
    const currentDigest = digest(readFileSync(join(state.worktree, checklistRelative), 'utf8'))
      if (currentDigest !== publicationChecklistDigest) throw new Error('rebase altered the controlling checklist')
      const currentHead = await head(state.worktree)
      const based = await runFile('git', ['merge-base', '--is-ancestor', targetCommit, currentHead], { cwd: state.worktree, signal, allowFailure: true })
      if (based.exitCode !== 0) throw new Error('rebased HEAD does not contain the exact publication target commit')
      const { task: gate, command } = publicationGate
      state.attempt += 1
      const key = `${gate.index}:${fingerprint(command)}`
      const statePathname = join(stateDir, 'run.json')
      const cacheTransaction = await quarantineGateValidationCaches(statePathname, stateDir, state, gate, signal, 'publication', publicationOriginalHead, options.publicationTarget ?? state.syncBranch, dependencies.afterGateCachesQuarantined)
      state.gateAttempts[key] = (state.gateAttempts[key] ?? 0) + 1
      writeState(statePathname, state)
      appendEvent(eventsPath, event(state.runId, 'gate-start', 'publish', { commandFingerprint: fingerprint(command), publicationValidation: true, targetCommit }, gate, state.attempt))
      const publicationIgnoredBaseline = cacheTransaction.ignoredBaseline!
        const result = await runAuthenticatedGateShell(command, statePathname, stateDir, state, cacheTransaction, signal, dependencies)
        await dependencies.afterGateCommandSettled?.()
        if (dependencies.simulatePublicationCrashAfterGate) throw new SimulatedPublicationControllerCrash('simulated publication controller crash')
        await discardAttemptGeneratedGateCaches(state.worktree, signal)
        const publicationIgnoredCreated = await discardGateIgnoredSideEffects(state.worktree, publicationIgnoredBaseline, signal)
        const validationReceipt = createHash('sha256').update(JSON.stringify({
        runId: state.runId,
        head: currentHead,
        targetCommit,
        checklistDigest: publicationChecklistDigest,
        gateFingerprint: fingerprint(command),
        nonce: randomUUID(),
      })).digest('hex')
      const receipt = { schemaVersion: 1, runId: state.runId, taskIndex: gate.index, attempt: state.attempt, commandFingerprint: fingerprint(command), exitCode: result.exitCode, stdout: redact(result.stdout), stderr: redact(result.stderr), timestamp: new Date().toISOString(), publicationValidation: true, targetCommit, validationReceipt }
      mkdirSync(join(stateDir, 'receipts'), { recursive: true })
      atomicWriteJson(join(stateDir, 'receipts', `publication-gate-${state.attempt}.json`), receipt)
      if (publicationIgnoredCreated.length > 0) throw new Error(`post-rebase publication gate created ignored artifacts: ${publicationIgnoredCreated.join(', ')}`)
      if (result.exitCode !== 0) throw new Error(`post-rebase publication gate failed (${result.exitCode}): ${redact(result.stderr || result.stdout)}`)
      if (await head(state.worktree) !== currentHead) throw new Error('post-rebase publication gate changed the validated HEAD')
      if ((await gitStatus(state.worktree)).trim() !== '') throw new Error('post-rebase publication gate left a dirty worktree')
      if (digest(readFileSync(join(state.worktree, checklistRelative), 'utf8')) !== publicationChecklistDigest) throw new Error('post-rebase publication gate altered the controlling checklist')
      if (cacheTransaction) await restoreGateValidationCaches(statePathname, stateDir, state)
      publicationValidationReceipt = validationReceipt
      state.publicationTargetCommit = targetCommit
      writeState(join(stateDir, 'run.json'), state)
      appendEvent(eventsPath, event(state.runId, 'gate-end', 'publish', { exitCode: 0, publicationValidation: true, targetCommit }, gate, state.attempt))
      return { receipt: validationReceipt, validatedHead: currentHead }
  }
  const reopenRepairClosure = async (): Promise<void> => {
    if (repairCyclesRemaining < 1) throw new Error('gate repair cycle limit exhausted')
    const parsed = parseChecklist(join(state.worktree, checklistRelative))
    const gate = state.currentTask === undefined ? undefined : parsed.tasks.find(task => task.index === state.currentTask)
    if (!gate || gate.kind !== 'gate' || gate.mark === 'x') throw new Error('--repair-gate requires the current row to be an open failed gate')
    if (!Object.keys(state.gateAttempts).some(key => key.startsWith(`${gate.index}:`) && (state.gateAttempts[key] ?? 0) > 0)) throw new Error('--repair-gate requires a recorded failed gate attempt')
    const closure = parsed.tasks.filter(task => task.phase === gate.phase && task.index < gate.index && task.kind === 'closure').at(-1)
    if (!closure || closure.mark !== 'x') throw new Error('--repair-gate requires the preceding phase closure to be completed')
    if ((await gitStatus(state.worktree)).trim() !== '') throw new Error('--repair-gate refuses a dirty worktree; discard unauthorized edits or recover the existing worker WIP first')
    const requestedPaths = [...new Set([...(gateRepairContext?.additionalPaths ?? []), ...(options.repairPaths ?? [])])]
    const additionalPaths = requestedPaths.map(candidate => {
      if (candidate.includes('\0') || isAbsolute(candidate)) throw new Error('--repair-path must be repo-relative')
      const absolute = resolve(state.worktree, candidate)
      const scoped = existsSync(absolute) ? physicalRelative(state.worktree, absolute) : undefined
      if (!scoped || scoped === checklistRelative) throw new Error(`--repair-path must name an existing path inside the preserved worktree: ${candidate}`)
      return scoped
    })
    repairCyclesRemaining -= 1
    repairCyclesUsed += 1
    retryGateAuthorized = true
    gateRepairContext = { schemaVersion: 1, gateIndex: gate.index, closureIndex: closure.index, instruction: latestGateFailureInstruction(stateDir, gate.index), additionalPaths }
    writeFileSync(join(state.worktree, checklistRelative), markTaskOpen(parsed, closure), 'utf8')
    await commitControllerChange(state.worktree, [checklistRelative], `chore(leppy-loop): reopen ${safeSlug(gate.phase)} repair closure`)
    state.completedTasks = Math.max(0, state.completedTasks - 1)
    state.currentTask = closure.index
    writeState(join(stateDir, 'run.json'), state)
    atomicWriteJson(gateRepairPath, gateRepairContext)
    appendEvent(eventsPath, event(state.runId, 'recovery-done', 'recovery', {
      taskIndex: closure.index, gateRepair: true, gateIndex: gate.index, additionalPaths,
      repairCycle: repairCyclesUsed, repairCycleLimit: options.repairCycles,
    }))
  }
  const reconcileValidatedPendingTask = async (parsed: ReturnType<typeof parseChecklist>): Promise<boolean> => {
    const pending = state.pendingTaskValidation
    if (!pending || pending.phase !== 'validated') return false
    const checklistPath = join(state.worktree, checklistRelative)
    const eventTask = parsed.tasks.find(candidate => candidate.index === pending.taskIndex)
    if (await ignoredPathDigest(state.worktree, signal) !== pending.ignoredPathsDigest) {
      throw new Error('validated task ignored artifact set changed before controller adoption')
    }
    const liveHead = await head(state.worktree)
    if (liveHead === pending.commitHead) {
      const checklistDigest = digest(parsed.source)
      let completed: string
      if (checklistDigest === pending.checklistDigest) {
        const pendingTask = parsed.tasks.find(candidate => candidate.index === pending.taskIndex)
        if (!pendingTask || pendingTask.mark === 'x' || taskAttemptKey(pendingTask) !== pending.taskKey) {
          throw new Error('validated task identity changed before controller adoption')
        }
        completed = markTaskDone(parsed, pendingTask)
        if (digest(persistedChecklistSource(parsed.source, completed)) !== pending.validatedChecklistDigest) throw new Error('validated task adoption digest changed')
      } else if (checklistDigest === pending.validatedChecklistDigest) {
        await assertChecklistAdoptionOnly(state.worktree, checklistRelative, signal)
        completed = parsed.source
      } else {
        throw new Error('validated task checklist changed before controller adoption')
      }
      await writeChecklistAndAmend(state.worktree, checklistRelative, completed, 'chore(leppy-loop): complete verified task')
    }
    const adoptedHead = await head(state.worktree)
    await assertTaskCommit(state.worktree, pending.baseHead, state.branch)
    if (digest(readFileSync(checklistPath, 'utf8')) !== pending.validatedChecklistDigest) {
      throw new Error('validated task checklist adoption is incomplete')
    }
    if (adoptedHead !== pending.commitHead) {
      const changed = (await runFile('git', ['diff', '--name-only', '-z', pending.commitHead, adoptedHead], { cwd: state.worktree, signal })).stdout.split('\0').filter(Boolean)
      if (changed.length !== 1 || changed[0] !== checklistRelative.replaceAll('\\', '/')) {
        throw new Error('validated task adoption changed files beyond the controlling checklist')
      }
    }
    state.completedTasks += 1
    clearWorkerFailure(state)
    delete state.lastError
    delete state.activeTaskAttempt
    delete state.pendingTaskValidation
    writeState(join(stateDir, 'run.json'), state)
    writeFileSync(join(stateDir, `diff-${pending.taskIndex}.txt`), await summarizeDiff(state.worktree, pending.baseHead), 'utf8')
    appendEvent(eventsPath, event(state.runId, 'done', 'worker', {
      verification: { commitHead: pending.commitHead, evidenceDigest: pending.validationEvidenceDigest },
    }, eventTask, state.attempt))
    await settleProgress('task-done')
    return true
  }
  try {
    if (options.repairGate) await reopenRepairClosure()
    for (let iteration = 0; iteration < options.maxIterations; iteration += 1) {
      if (signal.aborted) throw abortReason(signal)
      const recoveryPublicationRequest = {
        runId: state.runId, repoRoot: state.repoRoot, worktree: state.worktree, branch: state.branch, syncBranch: state.syncBranch,
      }
      if (options.openPullRequest && !state.pullRequestUrl) await abortInterruptedPublicationRebase(recoveryPublicationRequest, signal)
      const priorTargetCommit = state.publicationTargetCommit ?? latestPublicationTargetCommit(stateDir) ?? state.sourceHead
      const publicationRequest = {
        ...recoveryPublicationRequest,
        syncBranch: options.publicationTarget ?? state.syncBranch,
        originalSyncBranch: state.syncBranch,
        ...(priorTargetCommit ? { priorTargetCommit } : {}),
        ...(state.publicationRemoteHead ? { priorRemoteHead: state.publicationRemoteHead } : {}),
      }
      const checklistPath = join(state.worktree, checklistRelative)
      const parsed = parseChecklist(checklistPath)
      const legacyPending = state.pendingTaskValidation
      if (legacyPending?.phase === 'pending') {
        const pendingTask = parsed.tasks.find(candidate => candidate.index === legacyPending.taskIndex)
        if (!pendingTask || pendingTask.mark === 'x' || taskAttemptKey(pendingTask) !== legacyPending.taskKey
          || digest(parsed.source) !== legacyPending.checklistDigest) {
          throw new Error('legacy pending task identity changed before advisory adoption')
        }
        if (await ignoredPathDigest(state.worktree, signal) !== legacyPending.ignoredPathsDigest) {
          throw new Error('legacy pending task ignored artifact set changed before advisory adoption')
        }
        if (await head(state.worktree) !== legacyPending.commitHead) throw new Error('legacy pending task HEAD changed before advisory adoption')
        await assertTaskCommit(state.worktree, legacyPending.baseHead, state.branch)
        await assertTaskCommitScope(state.worktree, legacyPending.baseHead, checklistRelative, pendingTask.metadata.paths, signal)
        const marked = markTaskDone(parsed, pendingTask)
        state.pendingTaskValidation = {
          ...legacyPending,
          phase: 'validated',
          validatedChecklistDigest: digest(persistedChecklistSource(parsed.source, marked)),
          validationEvidenceDigest: digest('ordinary validation is advisory; legacy candidate adopted by Git invariants'),
        }
        writeState(join(stateDir, 'run.json'), state)
        appendEvent(eventsPath, event(state.runId, 'recovery-done', 'recovery', {
          workerArtifact: 'legacy-pending-task', automatic: true, verification: 'advisory',
        }, pendingTask, state.attempt))
      }
      if (await reconcileValidatedPendingTask(parsed)) continue
      const task = selectTask(parsed, options.taskMatch)
      if (!task) {
        delete state.currentTask
        if (options.openPullRequest && !state.pullRequestUrl && await publicationAuthorized()) {
          if (!dependencies.publishPullRequest) throw new Error('pull request publication is unavailable in this composition')
          appendEvent(eventsPath, event(state.runId, 'publish-start', 'publish', { branch: state.branch, syncBranch: state.syncBranch, publicationTarget: options.publicationTarget ?? state.syncBranch }))
          try {
            publicationChecklistDigest = digest(parsed.source)
            publicationOriginalHead = await head(state.worktree)
            const finalGate = [...parsed.tasks].reverse().find(candidate => candidate.kind === 'gate' && candidate.mark === 'x')
            const finalGateCommand = finalGate?.metadata.gate ?? options.phaseGateCommand
            if (!finalGate || !finalGateCommand) throw new Error('publication requires a completed final gate with an authenticated command')
            publicationGate = { task: finalGate, command: finalGateCommand }
            publicationValidationReceipt = undefined
            const published = await dependencies.publishPullRequest(publicationRequest, signal, {
              repairConflict: repairPublicationConflict,
              validateBeforePush: validatePublicationBase,
              authorizeRemoteMutation: runAuthorizedRemoteMutation,
              recordRemoteHead: async remoteHead => {
                if (remoteHead) state.publicationRemoteHead = remoteHead
                else delete state.publicationRemoteHead
                writeState(join(stateDir, 'run.json'), state)
              },
            })
            if (published.reconciledExisting && !publicationValidationReceipt) await validatePublicationBase(priorTargetCommit)
            if (!publicationValidationReceipt || (!published.reconciledExisting && published.validationReceipt !== publicationValidationReceipt)) {
              throw new Error('publisher did not consume the controller-owned final-gate receipt')
            }
            state.pullRequestUrl = published.url
            writeState(join(stateDir, 'run.json'), state)
            appendEvent(eventsPath, event(state.runId, 'publish-done', 'publish', { url: state.pullRequestUrl }))
          } catch (error) {
            if (error instanceof SimulatedPublicationControllerCrash) throw error
            let failure = error instanceof Error ? error.message : String(error)
            let publicationRollbackSucceeded = false
            if (publicationOriginalHead) {
              try {
                await restorePrePublicationHead()
                publicationRollbackSucceeded = true
              } catch (rollbackError) {
                failure = `${failure}; publication rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
              }
            }
            if (state.gateCacheTransaction && publicationRollbackSucceeded) {
              try {
                if (state.gateCacheTransaction.phase === 'ready') {
                  await discardGateIgnoredSideEffects(state.worktree, state.gateCacheTransaction.ignoredBaseline!, signal)
                }
                await restoreGateValidationCaches(join(stateDir, 'run.json'), stateDir, state)
              }
              catch (cacheRestoreError) { failure = `${failure}; validation-cache restore failed: ${cacheRestoreError instanceof Error ? cacheRestoreError.message : String(cacheRestoreError)}` }
            }
            const message = redact(failure).slice(-16 * 1024)
            state.status = 'stalled'
            state.lastError = message
            writeState(join(stateDir, 'run.json'), state)
            appendEvent(eventsPath, event(state.runId, 'stall', 'publish', { reason: message }))
            atomicWriteJson(join(stateDir, 'resume.json'), {
              schemaVersion: 1,
              runId: state.runId,
              reason: message,
              command: '/leppy-loop',
            })
            return { runId: state.runId, status: 'stalled', branch: state.branch, worktree: state.worktree, stateDir, completedTasks: state.completedTasks, diagnostics, detail: message }
          }
        }
        state.status = 'completed'
        writeState(join(stateDir, 'run.json'), state)
        appendEvent(eventsPath, event(state.runId, 'run-end', 'complete', { status: 'completed', completedTasks: state.completedTasks, pullRequestUrl: state.pullRequestUrl ?? null }))
        return { runId: state.runId, status: 'completed', branch: state.branch, worktree: state.worktree, stateDir, completedTasks: state.completedTasks, diagnostics, ...(state.pullRequestUrl ? { pullRequestUrl: state.pullRequestUrl } : {}) }
      }
      if (retryGateAuthorized && task.kind !== 'gate' && task.index !== gateRepairContext?.closureIndex) throw new Error('--retry-gate can only authorize the recovered failed gate or its controller-reopened repair closure')
      if (task.kind !== 'gate' && task.kind !== 'human') {
        const recoveryScopes = task.index === gateRepairContext?.closureIndex
          ? [...new Set([...task.metadata.paths, ...(gateRepairContext.additionalPaths ?? [])])]
          : task.metadata.paths
        const restored = await discardOutOfScopeWorkerChanges(state.worktree, recoveryScopes, [checklistRelative], signal)
        if (restored.length > 0) {
          appendEvent(eventsPath, event(state.runId, 'recovery-done', 'recovery', {
            workerArtifact: 'out-of-scope-validation-side-effects', paths: restored, automatic: true,
          }, task, state.attempt))
        }
      }
      const selectedTaskKey = taskAttemptKey(task)
      const selectedChecklistDigest = digest(parsed.source)
      const pendingIdentity = state.pendingTaskValidation ?? state.activeTaskAttempt
      if (pendingIdentity && (task.kind !== 'task' || pendingIdentity.taskIndex !== task.index
        || pendingIdentity.taskKey !== selectedTaskKey || pendingIdentity.checklistDigest !== selectedChecklistDigest)) {
        throw new Error('authenticated pending task identity no longer matches the controlling checklist')
      }
      const reconcileIgnoredAttempt = async (active: ActiveTaskAttempt): Promise<string> => {
        const reconciled = await reconcileWorkerIgnoredPaths({
          worktree: state.worktree, stateDir, runId: state.runId,
          taskKey: active.taskKey, taskIndex: active.taskIndex, attempt: active.attempt,
          expectedBaselineDigest: active.ignoredPathsDigest, legacyBaseHead: active.baseHead,
          ...(active.ignoredArtifactTransaction ? { expectedTransaction: active.ignoredArtifactTransaction } : {}),
          key: createLeaseKey(stateDir),
          onTransactionPrepared: async transaction => {
            const current = state.activeTaskAttempt
            if (!current || current.taskKey !== active.taskKey || current.taskIndex !== active.taskIndex
              || current.attempt !== active.attempt || current.ignoredPathsDigest !== active.ignoredPathsDigest) {
              throw new Error('worker ignored transaction lost its authenticated active attempt')
            }
            current.ignoredArtifactTransaction = transaction
            writeState(join(stateDir, 'run.json'), state)
          },
        })
        if (reconciled.paths.length > 0) {
          appendEvent(eventsPath, event(state.runId, 'recovery-done', 'recovery', {
            workerArtifact: 'ignored-paths', paths: reconciled.paths,
            quarantine: reconciled.quarantine ?? null, basis: reconciled.basis,
            resumed: reconciled.resumed, automatic: true,
          }, task, active.attempt))
        }
        return reconciled.digest
      }
      if (state.activeTaskAttempt) {
        const active = state.activeTaskAttempt
        const reconciledIgnoredDigest = await reconcileIgnoredAttempt(active)
        const liveHead = await head(state.worktree)
        if (liveHead === active.baseHead) {
          delete state.activeTaskAttempt
        } else {
          await adoptCompletedWorkerChanges(state.worktree, active.baseHead, task.metadata.paths, task.phase, signal)
          await normalizeCompletedWorkerCommits(
            state.worktree, active.baseHead, checklistRelative, task.metadata.paths, task.phase, signal,
          )
          await assertTaskCommit(state.worktree, active.baseHead, state.branch)
          await assertTaskCommitScope(state.worktree, active.baseHead, checklistRelative, task.metadata.paths, signal)
          const adoptedHead = await head(state.worktree)
          const marked = markTaskDone(parsed, task)
          state.pendingTaskValidation = {
            schemaVersion: 1, taskKey: active.taskKey, taskIndex: active.taskIndex,
            baseHead: active.baseHead, commitHead: adoptedHead, checklistDigest: active.checklistDigest,
            ignoredPathsDigest: reconciledIgnoredDigest,
            failureSignature: digest(`recovered-active-attempt\0${active.attempt}\0${adoptedHead}`),
            createdAttempt: active.attempt, verifierAttempts: 0, phase: 'validated',
            validatedChecklistDigest: digest(persistedChecklistSource(parsed.source, marked)),
            validationEvidenceDigest: digest('ordinary validation is advisory; recovered active commit adopted by Git invariants'),
          }
          delete state.activeTaskAttempt
        }
        writeState(join(stateDir, 'run.json'), state)
        if (state.pendingTaskValidation?.phase === 'validated') continue
      }
      const retryingRecoveredTask = Boolean(recovered && state.currentTask === task.index)
      const literalMatch = options.taskMatch
      const remainingTasks = parsed.tasks.filter(candidate =>
        candidate.mark !== 'x' && (literalMatch === undefined || candidate.raw.includes(literalMatch)))
      const totalTasks = state.completedTasks + remainingTasks.length
      state.currentTask = task.index
      state.attempt += 1
      const taskAttempt = nextTaskAttempt(state, task)
      writeState(join(stateDir, 'run.json'), state)
      const progressStartedAtMs = clock().getTime()
      await dependencies.onProgress?.(taskProgress(state, task, totalTasks, 'task-start', 0, undefined, state.attempt, taskAttempt))
      activeProgress = { task, totalTasks, attempt: state.attempt, taskAttempt, startedAtMs: progressStartedAtMs }
      if (task.kind === 'human') {
        const reason = 'human checkpoint requires direct approval; mark this row complete in the preserved worktree, then recover the same run'
        appendEvent(eventsPath, event(state.runId, 'stall', 'human', { reason, worktree: state.worktree }, task, state.attempt))
        state.status = 'stalled'
        state.lastError = reason
        writeState(join(stateDir, 'run.json'), state)
        atomicWriteJson(join(stateDir, 'resume.json'), { runId: state.runId, taskIndex: task.index, attempt: state.attempt, status: 'human', worktree: state.worktree, command: `/leppy-loop --tasks ${commandArgument(checklistRelative)} --sync-branch ${commandArgument(state.syncBranch)} --recover-existing-wip --recover-run ${commandArgument(state.runId)}` })
        await settleProgress('task-failed', reason)
        return { runId: state.runId, status: 'stalled', branch: state.branch, worktree: state.worktree, stateDir, completedTasks: state.completedTasks, currentTask: task.index, diagnostics, detail: reason }
      }
      if (task.kind === 'gate') {
        const command = task.metadata.gate ?? options.phaseGateCommand!
        const key = `${task.index}:${fingerprint(command)}`
        const priorTaskGateKey = Object.keys(state.gateAttempts).find(candidate => candidate.startsWith(`${task.index}:`) && (state.gateAttempts[candidate] ?? 0) > 0)
        if (priorTaskGateKey && priorTaskGateKey !== key) throw new Error('recovered gate command fingerprint differs from its recorded attempt')
        const priorGateAttempts = state.gateAttempts[key] ?? 0
        const completeLocalGate = async (receipt: PhaseGateReceipt, advisoryReason?: string): Promise<void> => {
          if (receipt.runId !== state.runId || receipt.taskIndex !== task.index || receipt.commandFingerprint !== fingerprint(command)) {
            throw new Error('attempted gate durable receipt does not match the authenticated run, task, and command')
          }
          if (await gitBranch(state.worktree) !== state.branch) throw new Error('gate adoption branch differs from the authenticated run branch')
          if ((await gitStatus(state.worktree)).trim() !== '') throw new Error('gate adoption requires a clean worktree and index')
          const currentHead = await head(state.worktree)
          const currentChecklistDigest = digest(parsed.source)
          const evidence = state.gateEvidence
          if (!evidence || evidence.schemaVersion !== 1 || evidence.taskIndex !== task.index
            || evidence.attempt !== receipt.attempt || evidence.gateAttempt !== (state.gateAttempts[key] ?? 0)
            || evidence.commandFingerprint !== receipt.commandFingerprint
            || evidence.receiptDigest !== digest(JSON.stringify(receipt))
            || evidence.targetHead !== currentHead || evidence.targetHead !== receipt.targetHead
            || evidence.checklistDigest !== currentChecklistDigest || evidence.checklistDigest !== receipt.checklistDigest
            || evidence.exitCode !== receipt.exitCode) {
            throw new Error('gate receipt does not match authenticated controller evidence')
          }
          const completed = markTaskDone(parsed, task)
          const receiptRelative = join('.leppy-loop-receipts', `gate-${task.index}.json`)
          const recordedReceipt = advisoryReason ? {
            ...receipt, advisory: true, advisoryReason, gateAttempts: state.gateAttempts[key] ?? 0,
            repairCyclesUsed, repairCycleLimit: options.repairCycles,
          } : receipt
          mkdirSync(dirname(join(state.worktree, receiptRelative)), { recursive: true })
          writeFileSync(join(state.worktree, receiptRelative), `${JSON.stringify(recordedReceipt, null, 2)}\n`, 'utf8')
          writeFileSync(checklistPath, completed, 'utf8')
          await commitControllerChange(
            state.worktree,
            [checklistRelative, receiptRelative],
            `chore(leppy-loop): record ${safeSlug(task.phase)} gate${advisoryReason ? ' advisory' : ''}`,
          )
          state.completedTasks += 1
          delete state.lastError
          writeState(join(stateDir, 'run.json'), state)
          rmSync(join(stateDir, 'resume.json'), { force: true })
          appendEvent(eventsPath, event(state.runId, 'gate-end', 'gate', {
            exitCode: receipt.exitCode,
            ...(advisoryReason ? { advisory: true, reason: advisoryReason, gateAttempts: state.gateAttempts[key] ?? 0 } : {}),
          }, task, state.attempt))
          await settleProgress('task-done')
        }
        if (retryGateAuthorized && priorGateAttempts === 0) throw new Error('--retry-gate requires a recorded failed attempt for the current gate fingerprint')
        if (priorGateAttempts > 0 && !retryGateAuthorized) {
          const evidence = state.gateEvidence
          if (evidence?.taskIndex === task.index && evidence.gateAttempt === priorGateAttempts
            && evidence.commandFingerprint === fingerprint(command)) {
            const priorReceipt = latestPhaseGateReceipt(stateDir, task.index)
            await completeLocalGate(priorReceipt, priorReceipt.exitCode === 0 ? undefined : gateFailureReason(priorReceipt))
            continue
          }
          if (recovered) repairCyclesRemaining = 0
        }
        retryGateAuthorized = false
        const targetHead = await head(state.worktree)
        const checklistDigest = digest(parsed.source)
        const statePathname = join(stateDir, 'run.json')
        const cacheTransaction = await quarantineGateValidationCaches(statePathname, stateDir, state, task, signal, 'local', targetHead, undefined, dependencies.afterGateCachesQuarantined)
        state.gateAttempts[key] = priorGateAttempts + 1
        writeState(statePathname, state)
        let gate!: Awaited<ReturnType<typeof runOpaqueShell>>
        let simulatedProcessDeath = false
        let gateProcessingError: unknown
        try {
          const ignoredBaseline = cacheTransaction.ignoredBaseline!
          appendEvent(eventsPath, event(state.runId, 'gate-start', 'gate', { commandFingerprint: fingerprint(command), ...(priorGateAttempts > 0 ? { retry: true } : {}) }, task, state.attempt))
          gate = await runAuthenticatedGateShell(
            command, statePathname, stateDir, state, cacheTransaction, signal, dependencies,
            dependencies.simulateLocalCrashWithLiveGate === true,
          )
          await dependencies.afterGateCommandSettled?.()
          if (dependencies.simulateLocalCrashAfterGate) {
            simulatedProcessDeath = true
            throw new SimulatedLocalGateControllerCrash('simulated local gate controller crash')
          }
          if (signal.aborted) throw abortReason(signal)
          if (await gitBranch(state.worktree) !== state.branch) throw new Error('local gate changed the authenticated run branch')
          const restored = await discardOutOfScopeWorkerChanges(state.worktree, [], [checklistRelative], signal)
          if (restored.length > 0) appendEvent(eventsPath, event(state.runId, 'recovery-done', 'recovery', {
            workerArtifact: 'local-gate-side-effects', paths: restored, automatic: true,
          }, task, state.attempt))
          const generatedCaches = await discardAttemptGeneratedGateCaches(state.worktree, signal)
            if (generatedCaches.length > 0) appendEvent(eventsPath, event(state.runId, 'recovery-done', 'recovery', {
            workerArtifact: 'transient-validation-cache', paths: generatedCaches, automatic: true,
          }, task, state.attempt))
          const restoredIgnored = await discardGateIgnoredSideEffects(state.worktree, ignoredBaseline, signal)
          if (restoredIgnored.length > 0) appendEvent(eventsPath, event(state.runId, 'recovery-done', 'recovery', {
            workerArtifact: 'local-gate-ignored-side-effects', paths: restoredIgnored, automatic: true,
          }, task, state.attempt))
          if (await head(state.worktree) !== targetHead) throw new Error('local gate created or changed commits')
          if (digest(readFileSync(checklistPath, 'utf8')) !== checklistDigest) throw new Error('local gate changed the controlling checklist')
        } catch (error) {
          if (error instanceof OpaqueShellOrphanedError) simulatedProcessDeath = true
          gateProcessingError = error
        }
        if (simulatedProcessDeath) throw gateProcessingError
        await restoreAuthenticatedGateGitState(state.worktree, state.branch, cacheTransaction.rollbackHead!, signal, 'local gate rollback')
        await discardGateIgnoredSideEffects(state.worktree, cacheTransaction.ignoredBaseline!, signal)
        await restoreGateValidationCaches(statePathname, stateDir, state)
        if (gateProcessingError) throw gateProcessingError
        const receipt: PhaseGateReceipt = { schemaVersion: 1, runId: state.runId, taskIndex: task.index, attempt: state.attempt, commandFingerprint: fingerprint(command), exitCode: gate.exitCode, stdout: redact(gate.stdout), stderr: redact(gate.stderr), timestamp: new Date().toISOString(), targetHead, checklistDigest }
        const gateReceiptPath = join(stateDir, 'receipts', `gate-${task.index}-${state.attempt}.json`)
        mkdirSync(dirname(gateReceiptPath), { recursive: true })
        atomicWriteJson(gateReceiptPath, receipt)
        state.gateEvidence = {
          schemaVersion: 1, taskIndex: task.index, attempt: state.attempt,
          gateAttempt: state.gateAttempts[key]!, commandFingerprint: fingerprint(command),
          receiptDigest: digest(JSON.stringify(receipt)), targetHead, checklistDigest, exitCode: gate.exitCode,
        }
        writeState(join(stateDir, 'run.json'), state)
        await dependencies.afterGateEvidencePersisted?.(gateReceiptPath)
        if (gate.exitCode !== 0) {
          const reason = gateFailureReason(receipt)
          appendEvent(eventsPath, event(state.runId, 'gate-failed', 'gate', {
            exitCode: gate.exitCode, repairCyclesUsed, repairCyclesRemaining,
          }, task, state.attempt))
          const repairableClosure = parsed.tasks.filter(candidate => candidate.phase === task.phase && candidate.index < task.index && candidate.kind === 'closure').at(-1)
          if (repairCyclesRemaining > 0 && repairableClosure?.mark === 'x') {
            await settleProgress('task-failed', reason)
            await reopenRepairClosure()
            continue
          }
          await completeLocalGate(receipt, reason)
          continue
        }
        await completeLocalGate(receipt)
        continue
      }

      const allowedPaths = task.index === gateRepairContext?.closureIndex
        ? [...new Set([...task.metadata.paths, ...(gateRepairContext.additionalPaths ?? [])])]
        : task.metadata.paths
      const model = selectedModel(task, options, fallbackSelection, catalog, retryingRecoveredTask)
      validateModelSelection(catalog, model.model, model.effort)
      const controllerHash = digest(readFileSync(checklistPath, 'utf8'))
      const previousHead = state.pendingTaskValidation?.baseHead ?? await head(state.worktree)
      const dependencyBridge = inspectWorktreeDependencies(state.repoRoot, state.worktree)
      const instructions = [
        ...legacyCustomInstructions(state.worktree),
        ...await discoverInstructions(state.worktree, allowedPaths),
        ...(dependencyBridge.status === 'local' ? [
          `The controller copied and verified an isolated node_modules against ${dependencyBridge.lockfile}. Use repository package scripts or bare local tools; do not install packages. leppy_exec resolves bare executable names local-first from the authenticated root node_modules/.bin and selects Windows shims. Package managers permit only explicit run/test scripts. Never use npx, dlx, corepack/alternate package frontends, package-manager cache overrides, or create an in-worktree cache. If validation reports a missing .svelte-kit/tsconfig.json, run the bare local command svelte-kit sync once before retrying; never run broad npm prepare for that condition. Do not run npm run refresh-reflector unless the Done contract explicitly requires regeneration and BACKEND_URL is already available. Otherwise never repeat an unchanged nonzero command: record its evidence and use engineering judgment; unavailable validation alone does not block completion. Validation commands may touch generated files outside task scope; record that once and return because the controller restores those out-of-scope side effects. Do not report blocked solely because you cannot restore them yourself.`,
        ] : []),
        ...(npmCacheQuarantined ? [
          'The controller moved the prior wholly-untracked .npm-cache into its private authenticated quarantine. Do not recreate it; invoke bare local tools through leppy_exec.',
        ] : []),
        ...(task.index === gateRepairContext?.closureIndex ? [
          gateRepairContext.instruction,
          ...(gateRepairContext.additionalPaths?.length ? [`Direct human authorized these additional repair scopes: ${gateRepairContext.additionalPaths.join(', ')}`] : []),
          'For repository-root commands, omit cwd in leppy_exec (cwd "." is also normalized to the root). Use the repository generation command when a gate reports stale generated artifacts.',
        ] : []),
      ]
      const effectiveGateFingerprint = workerGateFingerprint(parsed, task, options.phaseGateCommand)
      const request: WorkerRequest = {
        runId: state.runId, task, attempt: state.attempt, worktree: state.worktree, repoRoot: state.repoRoot,
        checklistPath: checklistRelative, allowedPaths,
        model: model.model, provider: model.provider, ...(model.effort ? { effort: model.effort } : {}),
        timeoutMs: options.workerTimeoutMs, outputLimitBytes: options.workerOutputLimitBytes,
        transcriptLimitBytes: options.workerTranscriptLimitBytes, stateDir,
        ...(effectiveGateFingerprint ? { gateFingerprint: effectiveGateFingerprint } : {}),
        instructions,
      }
      const runWorkerWithCleanup = async (workerRequest: WorkerRequest): Promise<WorkerOutcome> => {
        let workerOutcome: WorkerOutcome | undefined
        let workerError: unknown
        try {
          workerOutcome = await runAuthorizedWorker(workerRequest)
        } catch (error) {
          workerError = error
        }
        if (!signal.aborted) {
          if (await gitBranch(workerRequest.worktree) !== state.branch) throw new Error('ordinary worker changed the run branch')
          if (!existsSync(checklistPath) || digest(readFileSync(checklistPath, 'utf8')) !== controllerHash) {
            throw new Error('worker altered the controlling checklist')
          }
          await discardTransientValidationCache(workerRequest.worktree, signal)
          if (workerRequest.mode !== 'verification') {
            const restored = await discardOutOfScopeWorkerChanges(workerRequest.worktree, workerRequest.allowedPaths, [checklistRelative], signal)
            if (restored.length > 0) {
              appendEvent(eventsPath, event(state.runId, 'recovery-done', 'recovery', {
                workerArtifact: 'out-of-scope-validation-side-effects', paths: restored, automatic: true,
              }, workerRequest.task, workerRequest.attempt))
            }
          }
        }
        if (workerError !== undefined) throw workerError
        if (!workerOutcome) throw new Error('worker returned no outcome')
        return workerOutcome
      }
      const reconcileGeneratedWorkerCache = async (attempt: number, baselineAbsent: boolean, workerOutcome: WorkerOutcome): Promise<void> => {
        if (!baselineAbsent || !existsSync(join(state.worktree, '.npm-cache'))) return
        const quarantined = await quarantineWorkerNpmCache({
          worktree: state.worktree, stateDir, runId: state.runId,
          taskIndex: task.index, attempt,
          recoveryErrorDigest: workerFailureSignature(workerOutcome),
          allowLegacyDigest: false, key: createLeaseKey(stateDir),
        })
        npmCacheQuarantined = true
        appendEvent(eventsPath, event(state.runId, 'recovery-done', 'recovery', {
          workerArtifact: '.npm-cache', transactionId: quarantined.transactionId,
          resumed: quarantined.resumed, basis: quarantined.basis, automatic: true,
        }, task, attempt))
      }
      let outcomeAttempt = state.attempt
      let outcome: WorkerOutcome
      const persistReturnedTaskOutcome = (returned: WorkerOutcome, attempt: number): void => {
        const active = state.activeTaskAttempt
        if (!active || active.attempt !== attempt) return
        const validationUnavailable = returned.status === 'unavailable'
          || (returned.status !== 'completed' && returned.report !== undefined && returned.report.validation.status !== 'passed')
        active.terminalOutcome = {
          schemaVersion: 1,
          disposition: validationUnavailable ? 'validation-unavailable' : 'failed-or-unknown',
          outcomeDigest: digest(JSON.stringify({ status: returned.status, error: returned.error ?? null, report: returned.report ?? null })),
        }
        writeState(join(stateDir, 'run.json'), state)
      }
      if (task.kind === 'task') {
          const ignoredBaseline = await recordWorkerIgnoredPathBaseline({
            worktree: state.worktree, stateDir, runId: state.runId,
            taskKey: selectedTaskKey, taskIndex: task.index, attempt: state.attempt,
            key: createLeaseKey(stateDir),
          })
          state.activeTaskAttempt = {
            schemaVersion: 2, taskKey: selectedTaskKey, taskIndex: task.index,
            baseHead: previousHead, checklistDigest: controllerHash,
            ignoredPathsDigest: ignoredBaseline.digest, attempt: state.attempt,
          }
          writeState(join(stateDir, 'run.json'), state)
        }
        const workerCacheBaseline = recordWorkerNpmCacheBaseline({
          worktree: state.worktree, stateDir, runId: state.runId,
          taskIndex: task.index, attempt: state.attempt, key: createLeaseKey(stateDir),
        })
        appendEvent(eventsPath, event(state.runId, 'start', task.kind === 'closure' ? 'closure' : 'worker', { model: model.model, effort: model.effort ?? null, paths: allowedPaths }, task, state.attempt))
        if (signal.aborted) throw abortReason(signal)
        outcome = await runWorkerWithCleanup(request)
        persistReturnedTaskOutcome(outcome, state.attempt)
        await reconcileGeneratedWorkerCache(state.attempt, workerCacheBaseline.cacheState === 'absent', outcome)
        if (state.activeTaskAttempt) await reconcileIgnoredAttempt(state.activeTaskAttempt)
      for (let recoveryRound = 0;
          outcome.status !== 'completed' && outcome.status !== 'interrupted' && outcome.report === undefined
          && recoveryRound < options.repairCycles; recoveryRound += 1) {
          const materialAlreadyProduced = await commitCount(state.worktree, previousHead) > 0
            || (await gitStatus(state.worktree)).trim() !== ''
          if (outcome.status === 'failed' && materialAlreadyProduced) break
          const retryModel = recoveryRound === 0 && outcome.status === 'unavailable' && options.fallbackModel
            ? { ...model, model: options.fallbackModel }
            : selectedModel(task, options, fallbackSelection, catalog, true)
          validateModelSelection(catalog, retryModel.model, retryModel.effort)
          if (signal.aborted) throw abortReason(signal)
          const priorFailure = redact(outcome.error ?? outcome.status).slice(-4 * 1024)
          outcomeAttempt += 1
          state.attempt = outcomeAttempt
          if (state.activeTaskAttempt) {
            const retryIgnoredBaseline = await recordWorkerIgnoredPathBaseline({
              worktree: state.worktree, stateDir, runId: state.runId,
              taskKey: state.activeTaskAttempt.taskKey, taskIndex: state.activeTaskAttempt.taskIndex,
              attempt: outcomeAttempt, key: createLeaseKey(stateDir),
            })
            state.activeTaskAttempt = {
              ...state.activeTaskAttempt, attempt: outcomeAttempt,
              ignoredPathsDigest: retryIgnoredBaseline.digest,
            }
            delete state.activeTaskAttempt.ignoredArtifactTransaction
            delete state.activeTaskAttempt.terminalOutcome
          }
          writeState(join(stateDir, 'run.json'), state)
          const retryRequest: WorkerRequest = {
            ...request,
            model: retryModel.model,
            attempt: outcomeAttempt,
            instructions: [
              ...request.instructions,
              `A prior worker ended without completing this same line: ${priorFailure}. Continue from the current worktree and decide what remains. Git ceremony and ordinary validation are advisory; the controller will clean out-of-scope generator effects and adopt valid in-scope changes. Report blocked only for a concrete unresolved implementation, scope, or authority impossibility.`,
            ],
            ...(retryModel.effort ? { effort: retryModel.effort } : {}),
          }
          if (!retryModel.effort) delete retryRequest.effort
          const retryCacheBaseline = recordWorkerNpmCacheBaseline({
            worktree: state.worktree, stateDir, runId: state.runId,
            taskIndex: task.index, attempt: outcomeAttempt, key: createLeaseKey(stateDir),
          })
          appendEvent(eventsPath, event(state.runId, 'start', task.kind === 'closure' ? 'closure' : 'worker', {
            model: retryModel.model, effort: retryModel.effort ?? null, paths: allowedPaths,
            retry: 'ordinary-recovery', recoveryRound: recoveryRound + 1,
          }, task, outcomeAttempt))
          outcome = await runWorkerWithCleanup(retryRequest)
          persistReturnedTaskOutcome(outcome, outcomeAttempt)
          await reconcileGeneratedWorkerCache(outcomeAttempt, retryCacheBaseline.cacheState === 'absent', outcome)
          if (state.activeTaskAttempt) await reconcileIgnoredAttempt(state.activeTaskAttempt)
          if (digest(readFileSync(checklistPath, 'utf8')) !== controllerHash) throw new Error('worker altered the controlling checklist')
        }
      if (signal.aborted) throw abortReason(signal)
      if (digest(readFileSync(checklistPath, 'utf8')) !== controllerHash) throw new Error('worker altered the controlling checklist')
      const ordinaryMaterial = await commitCount(state.worktree, previousHead) > 0
        || (await gitStatus(state.worktree)).trim() !== ''
      const advisoryDisposition = state.pendingTaskValidation === undefined
        && outcome.status !== 'completed'
        && outcome.report?.disposition !== 'implementation-impossible'
        && (outcome.report !== undefined || (outcome.status === 'failed' && ordinaryMaterial))
      if (advisoryDisposition) {
        const advisoryValidation = outcome.report?.validation ?? {
          status: 'not-run' as const,
          evidence: outcome.error ?? 'ordinary worker ended after producing scoped work',
        }
        const priorSummary = outcome.report?.summary ?? outcome.error ?? outcome.status
        outcome = {
          status: 'completed',
          output: outcome.output,
          ...(outcome.transcriptPath ? { transcriptPath: outcome.transcriptPath } : {}),
          report: {
            status: 'completed',
            summary: `Advisory worker disposition accepted after bounded recovery: ${priorSummary}`,
            validation: advisoryValidation,
          },
        }
        appendEvent(eventsPath, event(state.runId, 'recovery-done', 'recovery', {
          workerArtifact: 'advisory-worker-disposition', automatic: true,
          validation: advisoryValidation,
        }, task, outcomeAttempt))
      }
      if (outcomeAttempt !== state.attempt) {
        state.attempt = outcomeAttempt
        writeState(join(stateDir, 'run.json'), state)
      }
      if (outcome.status !== 'completed') {
        if (!state.pendingTaskValidation) delete state.activeTaskAttempt
        recordWorkerFailure(state, task, outcome)
        const type = outcome.status === 'timeout' ? 'timeout' : 'stall'
        const failureDetail = redact([
          outcome.error ?? outcome.status,
          outcome.report ? `validation ${outcome.report.validation.status}: ${outcome.report.validation.evidence}` : undefined,
        ].filter(Boolean).join('; ')).slice(-16 * 1024)
        appendEvent(eventsPath, event(state.runId, type, task.kind === 'closure' ? 'closure' : 'worker', {
          status: outcome.status, error: failureDetail,
          failureStreak: state.failureStreak?.count ?? 1, autoRecoveryBlocked: state.autoRecoveryBlocked === true,
          pendingTaskValidation: state.pendingTaskValidation !== undefined,
        }, task, outcomeAttempt))
        state.status = outcome.status === 'interrupted' ? 'interrupted' : 'stalled'
        state.lastError = failureDetail
        writeState(join(stateDir, 'run.json'), state)
        atomicWriteJson(join(stateDir, 'resume.json'), { runId: state.runId, taskIndex: task.index, attempt: state.attempt, status: outcome.status, worktree: state.worktree, command: `/leppy-loop --tasks ${commandArgument(checklistRelative)} --sync-branch ${commandArgument(state.syncBranch)} --recover-existing-wip --recover-run ${commandArgument(state.runId)}` })
        await settleProgress('task-failed', failureDetail)
        return { runId: state.runId, status: state.status, branch: state.branch, worktree: state.worktree, stateDir, completedTasks: state.completedTasks, currentTask: task.index, diagnostics }
      }
      assertCompletedWorkerReport(outcome, task.kind === 'closure' ? 'closure worker' : 'task worker', true)
      if (await gitBranch(state.worktree) !== state.branch) throw new Error('ordinary worker changed the run branch')
      const adopted = await adoptCompletedWorkerChanges(state.worktree, previousHead, allowedPaths, task.phase, signal)
      if (adopted) {
        appendEvent(eventsPath, event(state.runId, 'recovery-done', 'recovery', {
          workerArtifact: 'completed-worker-changes', paths: adopted.paths, amended: adopted.amended, automatic: true,
        }, task, outcomeAttempt))
      }
      const normalized = await normalizeCompletedWorkerCommits(
        state.worktree, previousHead, checklistRelative, allowedPaths, task.phase, signal,
      )
      const ordinaryCommits = normalized.count
      if (ordinaryCommits === 1) await assertTaskCommit(state.worktree, previousHead, state.branch)
      if (normalized.normalized) {
        appendEvent(eventsPath, event(state.runId, 'recovery-done', 'recovery', {
          workerArtifact: 'worker-commit-ceremony', automatic: true,
        }, task, outcomeAttempt))
      }
      if ((await gitStatus(state.worktree)).trim() !== '') throw new Error('ordinary worker must leave a clean tree after controller adoption')
      const verifiedAlreadySatisfied = task.kind === 'task' && ordinaryCommits === 0
      clearWorkerFailure(state)
      delete state.lastError
      delete state.activeTaskAttempt
      const marked = markTaskDone(parsed, task)
      const newCommits = await commitCount(state.worktree, previousHead)
      if (newCommits === 1) await writeChecklistAndAmend(state.worktree, checklistRelative, marked, 'chore(leppy-loop): complete task')
      else {
        writeFileSync(checklistPath, marked, 'utf8')
        await commitControllerChange(state.worktree, [checklistRelative], `chore(leppy-loop): close ${safeSlug(task.phase)}`)
      }
      state.completedTasks += 1
      writeState(join(stateDir, 'run.json'), state)
      writeFileSync(join(stateDir, `diff-${task.index}.txt`), await summarizeDiff(state.worktree, previousHead), 'utf8')
      appendEvent(eventsPath, event(state.runId, 'done', task.kind === 'closure' ? 'closure' : 'worker', {
        commit: await head(state.worktree),
        outcome: outcome.report,
        ...(verifiedAlreadySatisfied ? { verifiedAlreadySatisfied: true } : {}),
      }, task, outcomeAttempt))
      await settleProgress('task-done')
    }
    const reason = 'max iterations reached'
    appendEvent(eventsPath, event(state.runId, 'stall', 'complete', { reason }))
    state.status = 'stalled'; state.lastError = reason; writeState(join(stateDir, 'run.json'), state)
    return { runId: state.runId, status: 'stalled', branch: state.branch, worktree: state.worktree, stateDir, completedTasks: state.completedTasks, ...(state.currentTask !== undefined ? { currentTask: state.currentTask } : {}), diagnostics, detail: reason }
  } catch (error) {
    let message = redact(error instanceof Error ? error.message : String(error)).slice(-16 * 1024)
    if (message.includes(DIRECT_HUMAN_STOP_REASON) && state.lifecycleAuthority && state.lifecycleAuthority.revokedAt === undefined) {
      const revoked = { ...state.lifecycleAuthority, revokedAt: clock().getTime() }
      try {
        const durable = inspectLifecycleAuthority(stateDir, state.runId)
        if (durable.status === 'valid' && durable.authority.revokedAt !== undefined) state.lifecycleAuthority = durable.authority
        else {
          appendLifecycleAuthorityReceipt(stateDir, state.runId, revoked)
          state.lifecycleAuthority = revoked
        }
      } catch (revocationError) {
        message = `${message}; durable lifecycle revocation failed: ${revocationError instanceof Error ? revocationError.message : String(revocationError)}`.slice(-16 * 1024)
        state.status = 'failed'
      }
    }
    if (state.status === 'running') state.status = signal.aborted || message.includes(DIRECT_HUMAN_STOP_REASON) ? 'interrupted' : 'failed'
    state.lastError = message
    writeState(join(stateDir, 'run.json'), state)
    appendEvent(eventsPath, event(state.runId, 'run-end', 'complete', { status: state.status, error: message }))
    try {
      await settleProgress('task-failed', message)
    } catch {
      // Preserve the controller failure even if the best-effort progress card cannot settle.
    }
    throw error
  } finally {
    releaseLock?.()
  }
}
