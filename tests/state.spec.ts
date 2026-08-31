import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createEmbeddedRunStateProof, inspectRunStateProof, persistRunStateProof } from '../src/run-state-proof.js'
import type { RunStateProofInput } from '../src/run-state-proof.js'
import { acquireLock, createLeaseKey, requireFoundProcessIdentity, signLease, verifyLease } from '../src/state.js'
import type { ActiveTaskAttempt, PendingTaskValidation } from '../src/types.js'

describe('authenticated leases', () => {
  it('accepts an intact lease and rejects tampering/PID reuse identity changes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'leppy-lease-'))
    const key = createLeaseKey(dir)
    const lease = signLease({ schemaVersion: 1, runId: 'r', taskIndex: 2, attempt: 1, pid: 42, processStart: 'start-a', heartbeat: new Date().toISOString() }, key)
    expect(verifyLease(lease, key)).toBe(true)
    expect(verifyLease({ ...lease, payload: { ...lease.payload, processStart: 'start-b' } }, key)).toBe(false)
  })

  it('requires a real OS process identity before a worker host may sign its lease', () => {
    expect(requireFoundProcessIdentity({ status: 'found', identity: 'os-start' }, 'worker host')).toBe('os-start')
    expect(() => requireFoundProcessIdentity({ status: 'error', detail: 'transient probe failure' }, 'worker host')).toThrow('transient probe failure')
    expect(() => requireFoundProcessIdentity({ status: 'absent' }, 'worker host')).toThrow('definitively absent')
  })
})

function proofState(overrides: Partial<RunStateProofInput> = {}): RunStateProofInput {
  return {
    schemaVersion: 1,
    runId: 'proof-run',
    status: 'stalled',
    repoRoot: 'C:\\repo',
    checklistRelative: 'tasks.task.md',
    sourceHead: '1'.repeat(40),
    branch: 'leppy-loop/proof',
    worktree: 'C:\\repo-proof',
    syncBranch: 'main',
    currentTask: 3,
    attempt: 8,
    taskAttempts: {},
    completedTasks: 2,
    gateAttempts: {},
    updatedAt: '2026-08-30T00:00:00.000Z',
    ...overrides,
  }
}

const activeTaskAttempt: ActiveTaskAttempt = {
  schemaVersion: 1,
  taskKey: 'a'.repeat(64),
  taskIndex: 3,
  baseHead: '2'.repeat(40),
  checklistDigest: 'b'.repeat(64),
  ignoredPathsDigest: 'd'.repeat(64),
  attempt: 8,
  ignoredArtifactTransaction: {
    schemaVersion: 1, transactionId: '12345678-1234-4234-8234-123456789abc', baselineDigest: 'd'.repeat(64),
  },
}

const pendingTaskValidation: PendingTaskValidation = {
  schemaVersion: 1,
  taskKey: 'a'.repeat(64),
  taskIndex: 3,
  baseHead: '2'.repeat(40),
  commitHead: '3'.repeat(40),
  checklistDigest: 'b'.repeat(64),
  ignoredPathsDigest: 'd'.repeat(64),
  failureSignature: 'c'.repeat(64),
  createdAttempt: 8,
  verifierAttempts: 1,
  phase: 'pending',
}

describe('authenticated run state proof', () => {
  it.each([
    ['activeTaskAttempt', { activeTaskAttempt }],
    ['pendingTaskValidation', { pendingTaskValidation }],
  ] as const)('round-trips and rejects tampering of %s', (_label, fields) => {
    const dir = mkdtempSync(join(tmpdir(), 'leppy-run-proof-'))
    const key = createLeaseKey(dir)
    const state = proofState(fields)
    persistRunStateProof(dir, state, key)
    expect(inspectRunStateProof(dir, state, key)).toBe('current')

    const tampered = 'activeTaskAttempt' in fields
      ? proofState({ activeTaskAttempt: { ...fields.activeTaskAttempt, attempt: fields.activeTaskAttempt.attempt + 1 } })
      : proofState({ pendingTaskValidation: { ...fields.pendingTaskValidation, commitHead: '4'.repeat(40) } })
    expect(inspectRunStateProof(dir, tampered, key)).toBe('invalid')
  })

  it('authenticates one embedded run.json generation without ownership.hmac and rejects stale-proof tampering', () => {
    const dir = mkdtempSync(join(tmpdir(), 'leppy-run-embedded-proof-'))
    const key = createLeaseKey(dir)
    const state = proofState({ activeTaskAttempt })
    const generation = { ...state, stateProof: createEmbeddedRunStateProof(state, key) }
    writeFileSync(join(dir, 'run.json'), `${JSON.stringify(generation)}\n`)

    expect(existsSync(join(dir, 'ownership.hmac'))).toBe(false)
    const loaded = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')) as typeof generation
    expect(inspectRunStateProof(dir, loaded, key)).toBe('current')

    loaded.completedTasks += 1
    writeFileSync(join(dir, 'run.json'), `${JSON.stringify(loaded)}\n`)
    expect(inspectRunStateProof(dir, loaded, key)).toBe('invalid')
  })
})

describe('repository lock ownership', () => {
  it('rejects a live owner and permits a new owner only after token-bound release', async () => {
    const commonDir = mkdtempSync(join(tmpdir(), 'leppy-lock-live-'))
    const release = await acquireLock(commonDir, 'run-one')
    await expect(acquireLock(commonDir, 'run-two')).rejects.toThrow('owns repository lock')
    release()
    const releaseNext = await acquireLock(commonDir, 'run-two')
    releaseNext()
    expect(existsSync(join(commonDir, 'leppy-loop', 'active.lock'))).toBe(false)
  }, 30_000)

  it('reclaims a crash-stale lock whose recorded process no longer exists', async () => {
    const commonDir = mkdtempSync(join(tmpdir(), 'leppy-lock-stale-'))
    const lockDir = join(commonDir, 'leppy-loop')
    mkdirSync(lockDir, { recursive: true })
    writeFileSync(join(lockDir, 'active.lock'), `${JSON.stringify({
      schemaVersion: 1,
      runId: 'crashed-run',
      pid: 2_147_483_647,
      processStart: 'dead',
      token: 'stale-token',
      startedAt: '2026-08-27T00:00:00.000Z',
    })}\n`)
    const release = await acquireLock(commonDir, 'recovered-run')
    expect(existsSync(join(lockDir, 'active.lock'))).toBe(true)
    expect(existsSync(join(lockDir, 'active.reclaim'))).toBe(false)
    release()
  }, 30_000)

  it('reclaims an aged partial lock left between exclusive create and payload write', async () => {
    const commonDir = mkdtempSync(join(tmpdir(), 'leppy-lock-partial-'))
    const lockDir = join(commonDir, 'leppy-loop')
    const lockPath = join(lockDir, 'active.lock')
    mkdirSync(lockDir, { recursive: true })
    writeFileSync(lockPath, '{"schemaVersion":')
    const old = new Date(Date.now() - 60_000)
    utimesSync(lockPath, old, old)
    const release = await acquireLock(commonDir, 'recovered-partial-run')
    expect(existsSync(lockPath)).toBe(true)
    release()
  }, 30_000)
})
