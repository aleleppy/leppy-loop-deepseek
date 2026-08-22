import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createLeaseKey, signLease, verifyLease } from '../src/state.js'

describe('authenticated leases', () => {
  it('accepts an intact lease and rejects tampering/PID reuse identity changes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'leppy-lease-'))
    const key = createLeaseKey(dir)
    const lease = signLease({ schemaVersion: 1, runId: 'r', taskIndex: 2, attempt: 1, pid: 42, processStart: 'start-a', heartbeat: new Date().toISOString() }, key)
    expect(verifyLease(lease, key)).toBe(true)
    expect(verifyLease({ ...lease, payload: { ...lease.payload, processStart: 'start-b' } }, key)).toBe(false)
  })
})
