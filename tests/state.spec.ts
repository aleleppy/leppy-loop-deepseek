import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { acquireLock, createLeaseKey, signLease, verifyLease } from '../src/state.js'

describe('authenticated leases', () => {
  it('accepts an intact lease and rejects tampering/PID reuse identity changes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'leppy-lease-'))
    const key = createLeaseKey(dir)
    const lease = signLease({ schemaVersion: 1, runId: 'r', taskIndex: 2, attempt: 1, pid: 42, processStart: 'start-a', heartbeat: new Date().toISOString() }, key)
    expect(verifyLease(lease, key)).toBe(true)
    expect(verifyLease({ ...lease, payload: { ...lease.payload, processStart: 'start-b' } }, key)).toBe(false)
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
