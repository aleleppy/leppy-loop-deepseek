import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ActiveTaskAttempt, PendingTaskValidation } from './types.js'

export interface EmbeddedRunStateProof {
  schemaVersion: 1
  algorithm: 'hmac-sha256'
  value: string
}

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
  activeTaskAttempt?: ActiveTaskAttempt
  pendingTaskValidation?: PendingTaskValidation
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
    failureStreak: state.failureStreak, activeTaskAttempt: state.activeTaskAttempt,
    pendingTaskValidation: state.pendingTaskValidation, autoRecoveryBlocked: state.autoRecoveryBlocked,
    dependencyBridgeActive: state.dependencyBridgeActive, windowsArgvBridgeActive: state.windowsArgvBridgeActive,
    updatedAt: state.updatedAt,
  })
}

function requiredProof(runId: string, key: Buffer): string {
  return hmac(key, `run-state-auth-required\0${runId}`)
}

export function createEmbeddedRunStateProof(state: RunStateProofInput, key: Buffer): EmbeddedRunStateProof {
  return { schemaVersion: 1, algorithm: 'hmac-sha256', value: hmac(key, runStateSecurityPayload(state)) }
}

function validEmbeddedProof(value: unknown): value is EmbeddedRunStateProof {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const proof = value as Partial<EmbeddedRunStateProof>
  return proof.schemaVersion === 1 && proof.algorithm === 'hmac-sha256' && typeof proof.value === 'string'
    && /^[A-Za-z0-9_-]{43}$/u.test(proof.value)
}

export function inspectRunStateProof(stateDir: string, state: RunStateProofInput, key: Buffer): 'legacy' | 'migration-pending' | 'current' | 'invalid' {
  const requiredPath = join(stateDir, REQUIRED_FILE)
  if (existsSync(requiredPath)) {
    const required = readFileSync(requiredPath, 'utf8').trim()
    if (!equalProof(required, requiredProof(state.runId, key))) return 'invalid'
  }
  const embedded = (state as RunStateProofInput & { stateProof?: unknown }).stateProof
  if (embedded !== undefined) {
    return validEmbeddedProof(embedded) && equalProof(embedded.value, hmac(key, runStateSecurityPayload(state))) ? 'current' : 'invalid'
  }
  const proofPath = join(stateDir, 'ownership.hmac')
  if (!existsSync(proofPath)) return 'invalid'
  const actual = readFileSync(proofPath, 'utf8').trim()
  if (!existsSync(requiredPath)) {
    return equalProof(actual, hmac(key, legacyRunOwnershipPayload(state))) ? 'legacy' : 'invalid'
  }
  if (equalProof(actual, hmac(key, runStateSecurityPayload(state)))) return 'current'
  return equalProof(actual, hmac(key, legacyRunOwnershipPayload(state))) ? 'migration-pending' : 'invalid'
}

/** Match the separately prepared full-state target used to resume a proof migration. */
export function separateRunStateProofMatches(stateDir: string, state: RunStateProofInput, key: Buffer): boolean {
  const requiredPath = join(stateDir, REQUIRED_FILE)
  const proofPath = join(stateDir, 'ownership.hmac')
  if (!existsSync(requiredPath) || !existsSync(proofPath)) return false
  if (!equalProof(readFileSync(requiredPath, 'utf8').trim(), requiredProof(state.runId, key))) return false
  return equalProof(readFileSync(proofPath, 'utf8').trim(), hmac(key, runStateSecurityPayload(state)))
}

function atomicWriteText(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  renameSync(temporary, path)
}

export function ensureRunStateProofRequired(stateDir: string, runId: string, key: Buffer): void {
  const requiredPath = join(stateDir, REQUIRED_FILE)
  const expectedRequired = requiredProof(runId, key)
  if (existsSync(requiredPath)) {
    if (!equalProof(readFileSync(requiredPath, 'utf8').trim(), expectedRequired)) throw new Error('run-state authentication marker is invalid')
  } else {
    atomicWriteText(requiredPath, `${expectedRequired}\n`)
  }
}

/** Persist a legacy separate full-state proof; new runner state embeds this proof atomically. */
export function persistRunStateProof(stateDir: string, state: RunStateProofInput, key: Buffer): void {
  ensureRunStateProofRequired(stateDir, state.runId, key)
  atomicWriteText(join(stateDir, 'ownership.hmac'), `${hmac(key, runStateSecurityPayload(state))}\n`)
}
