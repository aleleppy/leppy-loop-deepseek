import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseChecklist, selectTask } from './checklist.js'
import { branch as gitBranch, resolveRepoRoot } from './git.js'
import { isAuthenticatedPublicationRebase } from './publish.js'
import { runFile } from './process.js'
import type { ChecklistTask, RunResult } from './types.js'

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
}

function ownershipPayload(state: StoredRunState): string {
  return JSON.stringify({
    runId: state.runId,
    repoRoot: state.repoRoot,
    checklistRelative: state.checklistRelative,
    branch: state.branch,
    worktree: state.worktree,
  })
}

function equalProof(actual: string, expected: string): boolean {
  const left = Buffer.from(actual)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}

function validTaskAttempts(value: unknown): value is Record<string, number> {
  if (value === undefined) return true
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  return Object.entries(value).every(([key, count]) => /^[0-9a-f]{64}$/u.test(key)
    && typeof count === 'number' && Number.isSafeInteger(count) && count > 0)
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
    if (!existsSync(statePath) || !existsSync(proofPath) || !existsSync(keyPath)) continue
    const state = parseStoredRun(statePath)
    if (!state || state.runId !== name) continue
    let storedRoot: string
    try { storedRoot = realpathSync(state.repoRoot) } catch { continue }
    if (storedRoot !== repoRoot || !existsSync(state.worktree)) continue
    const key = Buffer.from(readFileSync(keyPath, 'utf8').trim(), 'base64')
    const expected = createHmac('sha256', key).update(ownershipPayload(state)).digest('base64url')
    if (!equalProof(readFileSync(proofPath, 'utf8').trim(), expected)) continue
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
    const openTask = publicationRebase ? undefined : selectTask(parseChecklist(controllerSource, controllerPath))
    const worktreeHead = (await runFile('git', ['rev-parse', 'HEAD'], { cwd: state.worktree })).stdout.trim()
    const unmergedIndex = (await runFile('git', ['ls-files', '-u', '-z'], { cwd: state.worktree })).stdout
    const authorityDigest = createHash('sha256').update(JSON.stringify({
      runId: state.runId,
      repoRoot,
      checklistRelative: state.checklistRelative,
      checklistDigest: createHash('sha256').update(controllerSource).digest('hex'),
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
