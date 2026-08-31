import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { lifecycleAuthorityAnchorDirectory, reconcileLifecycleAuthorityAnchor } from '../src/lifecycle-authority-anchor.js'
import { appendLifecycleAuthorityReceipt, inspectLifecycleAuthority, readAuthenticatedLifecycleAuthority } from '../src/lifecycle-authority.js'
import type { LifecycleAuthority } from '../src/types.js'

function stateDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'leppy-authority-'))
  mkdirSync(root, { recursive: true })
  return root
}

function authority(overrides: Partial<LifecycleAuthority> = {}): LifecycleAuthority {
  return {
    sessionId: 'session-a', allowPublication: false, maxIterations: 64, maxRepairCycles: 3,
    maxTransitions: 16, transitions: 1, issuedAt: 1_000, expiresAt: 86_401_000,
    ...overrides,
  }
}

describe('append-only lifecycle authority receipts', () => {
  it('rejects a chain that tries to begin after epoch one', () => {
    const dir = stateDir()
    expect(() => appendLifecycleAuthorityReceipt(dir, 'run-a', authority({ epoch: 2 }))).toThrow('epoch one transition one')
  })

  it('authenticates monotonic admissions and chooses the newest complete receipt chain', () => {
    const dir = stateDir()
    appendLifecycleAuthorityReceipt(dir, 'run-a', authority())
    appendLifecycleAuthorityReceipt(dir, 'run-a', authority({ transitions: 2 }))
    expect(readAuthenticatedLifecycleAuthority(dir, 'run-a')).toMatchObject({
      sequence: 2, authority: { sessionId: 'session-a', transitions: 2, allowPublication: false },
    })
  })

  it.each([
    ['epoch', 2], ['sessionId', 'session-b'], ['allowPublication', true], ['maxIterations', 65],
    ['maxRepairCycles', 4], ['maxTransitions', 17], ['transitions', 2],
    ['issuedAt', 999], ['expiresAt', 86_401_001], ['revokedAt', 2_000],
  ] as const)('fails closed when signed authority field %s is tampered', (field, replacement) => {
    const dir = stateDir()
    appendLifecycleAuthorityReceipt(dir, 'run-a', authority())
    const path = join(dir, 'lifecycle-authority', 'authority-000001.json')
    const receipt = JSON.parse(readFileSync(path, 'utf8')) as { authority: Record<string, unknown> }
    receipt.authority[field] = replacement
    writeFileSync(path, `${JSON.stringify(receipt)}\n`)
    expect(readAuthenticatedLifecycleAuthority(dir, 'run-a')).toBeUndefined()
  })

  it('rejects stale receipt replay, gaps and immutable authority changes', () => {
    const dir = stateDir()
    appendLifecycleAuthorityReceipt(dir, 'run-a', authority())
    const stale = readFileSync(join(dir, 'lifecycle-authority', 'authority-000001.json'), 'utf8')
    appendLifecycleAuthorityReceipt(dir, 'run-a', authority({ transitions: 2 }))
    writeFileSync(join(dir, 'lifecycle-authority', 'authority-000003.json'), stale)
    expect(readAuthenticatedLifecycleAuthority(dir, 'run-a')).toBeUndefined()

    const clean = stateDir()
    appendLifecycleAuthorityReceipt(clean, 'run-a', authority())
    expect(() => appendLifecycleAuthorityReceipt(clean, 'run-a', authority({ maxIterations: 65, transitions: 2 }))).toThrow('immutable facts changed')
  })

  it('rejects tail deletion for admission, publication downgrade, and revocation', () => {
    const cases: Array<(dir: string) => void> = [
      dir => {
        appendLifecycleAuthorityReceipt(dir, 'run-a', authority())
        appendLifecycleAuthorityReceipt(dir, 'run-a', authority({ transitions: 2 }))
      },
      dir => {
        appendLifecycleAuthorityReceipt(dir, 'run-a', authority({ allowPublication: true }))
        appendLifecycleAuthorityReceipt(dir, 'run-a', authority({ allowPublication: false }))
      },
      dir => {
        appendLifecycleAuthorityReceipt(dir, 'run-a', authority())
        appendLifecycleAuthorityReceipt(dir, 'run-a', authority({ revokedAt: 2_000 }))
      },
    ]
    for (const build of cases) {
      const dir = stateDir()
      build(dir)
      unlinkSync(join(dir, 'lifecycle-authority', 'authority-000002.json'))
      expect(inspectLifecycleAuthority(dir, 'run-a')).toMatchObject({ status: 'invalid', reason: expect.stringContaining('length') })
    }
  })

  it('reconstructs a missing local head only from the exact external high-water anchor', () => {
    const dir = stateDir()
    appendLifecycleAuthorityReceipt(dir, 'run-a', authority())
    appendLifecycleAuthorityReceipt(dir, 'run-a', authority({ transitions: 2 }))
    const headPath = join(dir, 'lifecycle-authority-head.json')
    unlinkSync(headPath)
    expect(inspectLifecycleAuthority(dir, 'run-a')).toMatchObject({ status: 'valid', sequence: 2 })
    expect(existsSync(headPath)).toBe(true)
  })

  it('never lets repeated headless mature-chain inspection create its own trust anchor', () => {
    const dir = stateDir()
    appendLifecycleAuthorityReceipt(dir, 'run-a', authority())
    appendLifecycleAuthorityReceipt(dir, 'run-a', authority({ transitions: 2 }))
    const anchorDir = lifecycleAuthorityAnchorDirectory(dir, 'run-a')
    rmSync(anchorDir, { recursive: true, force: true })
    unlinkSync(join(dir, 'lifecycle-authority-head.json'))
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(inspectLifecycleAuthority(dir, 'run-a')).toMatchObject({
        status: 'invalid', reason: expect.stringContaining('pre-existing external high-water'),
      })
      expect(existsSync(anchorDir)).toBe(false)
    }
  })

  it('accepts a direct-human renewal with the exact same TTL and transition delta zero', () => {
    const dir = stateDir()
    appendLifecycleAuthorityReceipt(dir, 'run-a', authority())
    appendLifecycleAuthorityReceipt(dir, 'run-a', authority({
      issuedAt: 90_000_000, expiresAt: 176_400_000,
    }))
    expect(readAuthenticatedLifecycleAuthority(dir, 'run-a')).toMatchObject({
      sequence: 2,
      authority: { transitions: 1, issuedAt: 90_000_000, expiresAt: 176_400_000, allowPublication: false },
    })
  })

  it('accepts a same-TTL renewal combined with a monotonic publication downgrade', () => {
    const dir = stateDir()
    appendLifecycleAuthorityReceipt(dir, 'run-a', authority({ allowPublication: true }))
    appendLifecycleAuthorityReceipt(dir, 'run-a', authority({
      allowPublication: false, issuedAt: 90_000_000, expiresAt: 176_400_000,
    }))
    expect(readAuthenticatedLifecycleAuthority(dir, 'run-a')).toMatchObject({
      sequence: 2,
      authority: { transitions: 1, issuedAt: 90_000_000, expiresAt: 176_400_000, allowPublication: false },
    })
  })

  it('accepts the next transition only against the renewed permit window', () => {
    const dir = stateDir()
    appendLifecycleAuthorityReceipt(dir, 'run-a', authority())
    const renewed = authority({ issuedAt: 90_000_000, expiresAt: 176_400_000 })
    appendLifecycleAuthorityReceipt(dir, 'run-a', renewed)
    appendLifecycleAuthorityReceipt(dir, 'run-a', { ...renewed, transitions: 2 })
    expect(readAuthenticatedLifecycleAuthority(dir, 'run-a')).toMatchObject({
      sequence: 3,
      authority: { transitions: 2, issuedAt: 90_000_000, expiresAt: 176_400_000 },
    })
  })

  it.each([
    ['widens', 90_000_000, 176_400_001],
    ['shortens', 90_000_000, 176_399_999],
    ['moves issuedAt backward', 999, 86_401_001],
    ['moves expiresAt backward', 1_001, 86_400_999],
  ] as const)('rejects a renewal that %s', (_label, issuedAt, expiresAt) => {
    const dir = stateDir()
    appendLifecycleAuthorityReceipt(dir, 'run-a', authority())
    expect(() => appendLifecycleAuthorityReceipt(dir, 'run-a', authority({ issuedAt, expiresAt }))).toThrow('not monotonic')
  })

  it('rejects a renewal that consumes a transition simultaneously', () => {
    const dir = stateDir()
    appendLifecycleAuthorityReceipt(dir, 'run-a', authority())
    expect(() => appendLifecycleAuthorityReceipt(dir, 'run-a', authority({
      transitions: 2, issuedAt: 90_000_000, expiresAt: 176_400_000,
    }))).toThrow('not monotonic')
  })

  it('rejects a publication upgrade hidden inside a renewal', () => {
    const dir = stateDir()
    appendLifecycleAuthorityReceipt(dir, 'run-a', authority({ allowPublication: false }))
    expect(() => appendLifecycleAuthorityReceipt(dir, 'run-a', authority({
      allowPublication: true, issuedAt: 90_000_000, expiresAt: 176_400_000,
    }))).toThrow('not monotonic')
  })

  it.each([
    ['sessionId', { sessionId: 'session-b' }],
    ['maxIterations', { maxIterations: 65 }],
    ['maxRepairCycles', { maxRepairCycles: 4 }],
    ['maxTransitions', { maxTransitions: 17 }],
  ] as const)('rejects a renewal that mutates immutable %s', (_label, mutation) => {
    const dir = stateDir()
    appendLifecycleAuthorityReceipt(dir, 'run-a', authority())
    expect(() => appendLifecycleAuthorityReceipt(dir, 'run-a', authority({
      ...mutation, issuedAt: 90_000_000, expiresAt: 176_400_000,
    }))).toThrow('immutable facts changed')
  })

  it('rejects renewal after direct-human revocation', () => {
    const dir = stateDir()
    appendLifecycleAuthorityReceipt(dir, 'run-a', authority())
    appendLifecycleAuthorityReceipt(dir, 'run-a', authority({ revokedAt: 2_000 }))
    expect(() => appendLifecycleAuthorityReceipt(dir, 'run-a', authority({
      issuedAt: 90_000_000, expiresAt: 176_400_000,
    }))).toThrow('revoked by direct human stop')
  })

  it('records one bounded budget epoch rollover only after the authenticated prior epoch is exhausted', () => {
    const dir = stateDir()
    const exhausted = authority({ transitions: 16 })
    for (let transitions = 1; transitions <= exhausted.transitions; transitions += 1) {
      appendLifecycleAuthorityReceipt(dir, 'run-a', authority({ transitions }))
    }
    const renewed = authority({ epoch: 2, transitions: 0, issuedAt: 90_000_000, expiresAt: 176_400_000 })
    appendLifecycleAuthorityReceipt(dir, 'run-a', renewed)
    appendLifecycleAuthorityReceipt(dir, 'run-a', { ...renewed, transitions: 1 })
    expect(readAuthenticatedLifecycleAuthority(dir, 'run-a')).toMatchObject({
      sequence: 18, authority: { epoch: 2, transitions: 1, issuedAt: 90_000_000, expiresAt: 176_400_000 },
    })
  })

  it.each([
    ['before exhaustion', authority({ transitions: 15 }), authority({ epoch: 2, transitions: 0, issuedAt: 90_000_000, expiresAt: 176_400_000 })],
    ['with a skipped epoch', authority({ transitions: 16 }), authority({ epoch: 3, transitions: 0, issuedAt: 90_000_000, expiresAt: 176_400_000 })],
    ['with inherited consumption', authority({ transitions: 16 }), authority({ epoch: 2, transitions: 1, issuedAt: 90_000_000, expiresAt: 176_400_000 })],
  ] as const)('rejects budget epoch rollover %s', (_label, before, after) => {
    const dir = stateDir()
    for (let transitions = 1; transitions <= before.transitions; transitions += 1) {
      appendLifecycleAuthorityReceipt(dir, 'run-a', authority({ transitions }))
    }
    expect(() => appendLifecycleAuthorityReceipt(dir, 'run-a', after)).toThrow('not monotonic')
  })

  it('repairs one fully authenticated receipt persisted before its monotonic head', () => {
    const dir = stateDir()
    expect(() => appendLifecycleAuthorityReceipt(dir, 'run-a', authority(), {
      afterReceipt: () => { throw new Error('crash after receipt') },
    })).toThrow('crash after receipt')
    expect(readAuthenticatedLifecycleAuthority(dir, 'run-a')).toMatchObject({ sequence: 1, authority: { transitions: 1 } })
    appendLifecycleAuthorityReceipt(dir, 'run-a', authority({ transitions: 2 }))
    expect(() => appendLifecycleAuthorityReceipt(dir, 'run-a', authority({ transitions: 3 }), {
      afterReceipt: () => { throw new Error('crash after receipt') },
    })).toThrow('crash after receipt')
    expect(readAuthenticatedLifecycleAuthority(dir, 'run-a')).toMatchObject({ sequence: 3, authority: { transitions: 3 } })
  })

  it('rejects coordinated restoration of an older valid local head and receipt prefix', () => {
    const dir = stateDir()
    appendLifecycleAuthorityReceipt(dir, 'run-a', authority())
    const oldHead = readFileSync(join(dir, 'lifecycle-authority-head.json'), 'utf8')
    appendLifecycleAuthorityReceipt(dir, 'run-a', authority({ transitions: 2 }))
    writeFileSync(join(dir, 'lifecycle-authority-head.json'), oldHead)
    unlinkSync(join(dir, 'lifecycle-authority', 'authority-000002.json'))
    expect(inspectLifecycleAuthority(dir, 'run-a')).toMatchObject({
      status: 'invalid', reason: expect.stringContaining('external lifecycle authority anchor detected receipt-chain rollback'),
    })
  })

  it('makes each run anchor append-only and rejects a same-sequence fork', () => {
    const dir = stateDir()
    expect(reconcileLifecycleAuthorityAnchor(dir, 'run-anchor', 1, 'a'.repeat(64))).toMatchObject({ status: 'valid', relation: 'created' })
    expect(reconcileLifecycleAuthorityAnchor(dir, 'run-anchor', 1, 'a'.repeat(64))).toMatchObject({ status: 'valid', relation: 'equal' })
    expect(reconcileLifecycleAuthorityAnchor(dir, 'run-anchor', 1, 'b'.repeat(64))).toMatchObject({
      status: 'invalid', reason: expect.stringContaining('rollback or fork'),
    })
    expect(reconcileLifecycleAuthorityAnchor(dir, 'run-anchor', 2, 'c'.repeat(64))).toMatchObject({ status: 'valid', relation: 'advanced' })
    expect(reconcileLifecycleAuthorityAnchor(dir, 'run-anchor', 1, 'a'.repeat(64))).toMatchObject({
      status: 'invalid', reason: expect.stringContaining('rollback or fork'),
    })
  })

  it('records a bounded direct-human TTL renewal and then admits the next transition', () => {
    const dir = stateDir()
    appendLifecycleAuthorityReceipt(dir, 'run-a', authority({ allowPublication: true, transitions: 1 }))
    const renewed = authority({ allowPublication: false, transitions: 1, issuedAt: 90_000_000, expiresAt: 176_400_000 })
    appendLifecycleAuthorityReceipt(dir, 'run-a', renewed)
    appendLifecycleAuthorityReceipt(dir, 'run-a', { ...renewed, transitions: 2 })
    expect(readAuthenticatedLifecycleAuthority(dir, 'run-a')).toMatchObject({
      sequence: 3, authority: { transitions: 2, issuedAt: 90_000_000, expiresAt: 176_400_000, allowPublication: false },
    })
  })

  it('rejects renewal that changes TTL bounds or consumes a transition simultaneously', () => {
    const duration = 86_400_000
    const changedTtl = stateDir()
    appendLifecycleAuthorityReceipt(changedTtl, 'run-a', authority())
    expect(() => appendLifecycleAuthorityReceipt(changedTtl, 'run-a', authority({
      issuedAt: 90_000_000, expiresAt: 90_000_000 + duration + 1,
    }))).toThrow('not monotonic')

    const transition = stateDir()
    appendLifecycleAuthorityReceipt(transition, 'run-a', authority())
    expect(() => appendLifecycleAuthorityReceipt(transition, 'run-a', authority({
      transitions: 2, issuedAt: 90_000_000, expiresAt: 90_000_000 + duration,
    }))).toThrow('not monotonic')
  })

  it('permits only a monotonic publication downgrade within the same authority chain', () => {
    const dir = stateDir()
    appendLifecycleAuthorityReceipt(dir, 'run-a', authority({ allowPublication: true }))
    appendLifecycleAuthorityReceipt(dir, 'run-a', authority({ allowPublication: false }))
    expect(readAuthenticatedLifecycleAuthority(dir, 'run-a')).toMatchObject({ authority: { allowPublication: false, transitions: 1 } })
    expect(() => appendLifecycleAuthorityReceipt(dir, 'run-a', authority({ allowPublication: true, transitions: 2 }))).toThrow('monotonic')
  })

  it('records direct-human revocation without consuming another transition and forbids later admission', () => {
    const dir = stateDir()
    appendLifecycleAuthorityReceipt(dir, 'run-a', authority())
    appendLifecycleAuthorityReceipt(dir, 'run-a', authority({ revokedAt: 2_000 }))
    expect(readAuthenticatedLifecycleAuthority(dir, 'run-a')).toMatchObject({ authority: { transitions: 1, revokedAt: 2_000 } })
    expect(() => appendLifecycleAuthorityReceipt(dir, 'run-a', authority({ transitions: 2 }))).toThrow('revoked')
  })
})
