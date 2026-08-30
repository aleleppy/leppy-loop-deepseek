import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface RunStateProofInput {
  schemaVersion: 1
  runId: string
  status: string
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
  failureStreak?: { taskKey: string; signature: string; count: number }
  autoRecoveryBlocked?: boolean
  dependencyBridgeActive?: boolean
  windowsArgvBridgeActive?: boolean
  updatedAt: string
}

const REQUIRED_FILE = 'run-state-auth-required.hmac'

function hmac(key: Buffer, value: string): string {
  return createHmac('sha256', key).update(value).digest('base64url')
}

function equalProof(actual: string, expected: string): boolean {
  const left = Buffer.from(actual)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}

export function legacyRunOwnershipPayload(state: RunStateProofInput): string {
  return JSON.stringify({
    runId: state.runId, repoRoot: state.repoRoot, checklistRelative: state.checklistRelative,
    branch: state.branch, worktree: state.worktree,
  })
}

export function runStateSecurityPayload(state: RunStateProofInput): string {
  return JSON.stringify({
    schemaVersion: state.schemaVersion, runId: state.runId, status: state.status,
    repoRoot: state.repoRoot, checklistRelative: state.checklistRelative, sourceHead: state.sourceHead,
    branch: state.branch, worktree: state.worktree, syncBranch: state.syncBranch,
    currentTask: state.currentTask, attempt: state.attempt, taskAttempts: state.taskAttempts,
    completedTasks: state.completedTasks, gateAttempts: state.gateAttempts,
    pullRequestUrl: state.pullRequestUrl, publicationTargetCommit: state.publicationTargetCommit,
    publicationRemoteHead: state.publicationRemoteHead, lastError: state.lastError,
    failureStreak: state.failureStreak, autoRecoveryBlocked: state.autoRecoveryBlocked,
    dependencyBridgeActive: state.dependencyBridgeActive, windowsArgvBridgeActive: state.windowsArgvBridgeActive,
    updatedAt: state.updatedAt,
  })
}

function requiredProof(runId: string, key: Buffer): string {
  return hmac(key, `run-state-auth-required\0${runId}`)
}

export function inspectRunStateProof(stateDir: string, state: RunStateProofInput, key: Buffer): 'legacy' | 'current' | 'invalid' {
  const proofPath = join(stateDir, 'ownership.hmac')
  if (!existsSync(proofPath)) return 'invalid'
  const actual = readFileSync(proofPath, 'utf8').trim()
  const requiredPath = join(stateDir, REQUIRED_FILE)
  if (!existsSync(requiredPath)) {
    return equalProof(actual, hmac(key, legacyRunOwnershipPayload(state))) ? 'legacy' : 'invalid'
  }
  const required = readFileSync(requiredPath, 'utf8').trim()
  if (!equalProof(required, requiredProof(state.runId, key))) return 'invalid'
  return equalProof(actual, hmac(key, runStateSecurityPayload(state))) ? 'current' : 'invalid'
}

function atomicWriteText(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  renameSync(temporary, path)
}

/** Persist a required full-state proof; after the marker exists legacy fallback is impossible. */
export function persistRunStateProof(stateDir: string, state: RunStateProofInput, key: Buffer): void {
  const requiredPath = join(stateDir, REQUIRED_FILE)
  const expectedRequired = requiredProof(state.runId, key)
  if (existsSync(requiredPath)) {
    if (!equalProof(readFileSync(requiredPath, 'utf8').trim(), expectedRequired)) throw new Error('run-state authentication marker is invalid')
  } else {
    writeFileSync(requiredPath, `${expectedRequired}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  }
  atomicWriteText(join(stateDir, 'ownership.hmac'), `${hmac(key, runStateSecurityPayload(state))}\n`)
}
