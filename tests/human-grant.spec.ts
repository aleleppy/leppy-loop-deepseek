import type { Agent } from '@deepseek-ai/dsh-agent'
import { describe, expect, it } from 'vitest'
import { HumanGrantStore } from '../src/human-grant.js'
import type { LifecycleAuthority } from '../src/types.js'

function agent(id: string): Agent { return { id } as unknown as Agent }

function issue(store: HumanGrantStore, owner: Agent, overrides: Partial<Parameters<HumanGrantStore['issue']>[0]> = {}) {
  return store.issue({
    agent: owner, repoRoot: '/repo/a', allowPublication: true,
    maxIterations: 64, maxRepairCycles: 3, maxTransitions: 3,
    ...overrides,
  })
}

describe('HumanGrantStore lifecycle permits', () => {
  it('atomically binds one unbound lifecycle to its first run and reuses it after settlement', () => {
    const store = new HumanGrantStore()
    const owner = agent('owner')
    issue(store, owner)
    const first = store.reserve({ agent: owner, repoRoot: '/repo/a', runId: 'run-a', operation: 'start', publishRemote: false })
    expect(first.boundRun).toBe(true)
    expect(first.grant.runId).toBe('run-a')
    expect(() => store.reserve({ agent: owner, repoRoot: '/repo/a', runId: 'run-a', operation: 'continue', publishRemote: false })).toThrow('in flight')
    store.settle(first)
    const second = store.reserve({ agent: owner, repoRoot: '/repo/a', runId: 'run-a', operation: 'continue', publishRemote: true })
    expect(second.boundRun).toBe(false)
    expect(second.grant.transitions).toBe(2)
  })

  it('rejects cross-session, repository and run use', () => {
    const store = new HumanGrantStore()
    const alice = agent('alice')
    issue(store, alice, { runId: 'run-a' })
    expect(() => store.reserve({ agent: agent('bob'), repoRoot: '/repo/a', runId: 'run-a', operation: 'continue', publishRemote: false })).toThrow('no direct human')
    expect(() => store.reserve({ agent: alice, repoRoot: '/repo/b', runId: 'run-a', operation: 'continue', publishRemote: false })).toThrow('another repository')
    expect(() => store.reserve({ agent: alice, repoRoot: '/repo/a', runId: 'run-b', operation: 'continue', publishRemote: false })).toThrow('another run')
  })

  it('survives Agent object recreation and hydrates a persisted same-session authority', () => {
    const original = new HumanGrantStore()
    const firstAgent = agent('owner')
    const issued = issue(original, firstAgent, { runId: 'run-a' })
    const first = original.reserve({ agent: firstAgent, repoRoot: '/repo/a', runId: 'run-a', operation: 'continue', publishRemote: false })
    original.settle(first)
    const replacementAgent = agent('owner')
    const second = original.reserve({ agent: replacementAgent, repoRoot: '/repo/a', runId: 'run-a', operation: 'continue', publishRemote: false })
    expect(second.grant.transitions).toBe(2)
    original.settle(second)

    const restarted = new HumanGrantStore()
    restarted.hydrate({ agent: replacementAgent, repoRoot: '/repo/a', runId: 'run-a', authority: original.authority(issued) })
    const recovered = restarted.reserve({ agent: replacementAgent, repoRoot: '/repo/a', runId: 'run-a', operation: 'continue', publishRemote: false })
    expect(recovered.grant.transitions).toBe(3)
  })

  it('enforces cumulative transition budget without accepting replay', () => {
    const store = new HumanGrantStore()
    const owner = agent('owner')
    issue(store, owner, { runId: 'run-a', maxTransitions: 2 })
    for (let index = 0; index < 2; index += 1) {
      const reservation = store.reserve({ agent: owner, repoRoot: '/repo/a', runId: 'run-a', operation: 'continue', publishRemote: false })
      store.settle(reservation)
    }
    expect(() => store.reserve({ agent: owner, repoRoot: '/repo/a', runId: 'run-a', operation: 'continue', publishRemote: false })).toThrow('budget exhausted')
  })

  it('opens one new authenticated epoch only after a direct human reauthorizes an exhausted exact run', () => {
    let now = 100
    const store = new HumanGrantStore(() => now, 1_000)
    const owner = agent('owner')
    const grant = issue(store, owner, { runId: 'run-a', maxTransitions: 2 })
    for (let index = 0; index < 2; index += 1) {
      const reservation = store.reserve({ agent: owner, repoRoot: '/repo/a', runId: 'run-a', operation: 'continue', publishRemote: false })
      store.settle(reservation)
    }
    const exhausted = store.authority(grant)
    expect(exhausted).toMatchObject({ epoch: 1, transitions: 2, maxTransitions: 2 })
    now = 200
    const renewed = store.reauthorize({ agent: owner, repoRoot: '/repo/a', runId: 'run-a', authority: exhausted, allowPublication: true })
    expect(store.authority(renewed)).toMatchObject({ epoch: 2, transitions: 0, issuedAt: 200, expiresAt: 1_200 })
    const reservation = store.reserve({ agent: owner, repoRoot: '/repo/a', runId: 'run-a', operation: 'continue', publishRemote: false })
    expect(store.authority(reservation.grant)).toMatchObject({ epoch: 2, transitions: 1 })
  })

  it('rolls an exhausted legacy epoch after Host restart and rejects stale epoch replay', () => {
    let now = 100
    const original = new HumanGrantStore(() => now, 1_000)
    const owner = agent('owner')
    const grant = issue(original, owner, { runId: 'run-a', maxTransitions: 1, allowPublication: false })
    const first = original.reserve({ agent: owner, repoRoot: '/repo/a', runId: 'run-a', operation: 'continue', publishRemote: false })
    original.settle(first)
    const exhaustedLegacy: LifecycleAuthority = { ...original.authority(grant) }
    delete exhaustedLegacy.epoch

    now = 200
    const restarted = new HumanGrantStore(() => now, 1_000)
    const renewed = restarted.reauthorize({ agent: owner, repoRoot: '/repo/a', runId: 'run-a', authority: exhaustedLegacy, allowPublication: true })
    expect(restarted.authority(renewed)).toMatchObject({ epoch: 2, transitions: 0, allowPublication: false })
    expect(() => restarted.reauthorize({
      agent: owner, repoRoot: '/repo/a', runId: 'run-a', authority: exhaustedLegacy, allowPublication: false,
    })).toThrow('stale')
  })

  it('adopts a higher durable epoch over stale exhausted Host memory without carrying prior consumption forward', () => {
    let now = 100
    const store = new HumanGrantStore(() => now, 1_000)
    const owner = agent('owner')
    const grant = issue(store, owner, { runId: 'run-a', maxTransitions: 1 })
    const first = store.reserve({ agent: owner, repoRoot: '/repo/a', runId: 'run-a', operation: 'continue', publishRemote: false })
    store.settle(first)
    const durable: LifecycleAuthority = {
      ...store.authority(grant), epoch: 2, transitions: 0, issuedAt: 200, expiresAt: 1_200,
    }
    now = 201
    const hydrated = store.hydrate({ agent: owner, repoRoot: '/repo/a', runId: 'run-a', authority: durable })
    expect(store.authority(hydrated)).toMatchObject({ epoch: 2, transitions: 0 })
    const admitted = store.reserve({ agent: owner, repoRoot: '/repo/a', runId: 'run-a', operation: 'continue', publishRemote: false })
    expect(store.authority(admitted.grant)).toMatchObject({ epoch: 2, transitions: 1 })
  })

  it('prepares from a higher durable epoch without inheriting stale prior-epoch consumption', () => {
    let now = 100
    const store = new HumanGrantStore(() => now, 1_000)
    const owner = agent('owner')
    const grant = issue(store, owner, { runId: 'run-a', maxTransitions: 1 })
    const first = store.reserve({ agent: owner, repoRoot: '/repo/a', runId: 'run-a', operation: 'continue', publishRemote: false })
    store.settle(first)
    now = 201
    const renewed = store.reauthorize({
      agent: owner, repoRoot: '/repo/a', runId: 'run-a', allowPublication: true,
      authority: { ...store.authority(grant), epoch: 2, transitions: 0, issuedAt: 200, expiresAt: 1_200 },
    })
    expect(store.authority(renewed)).toMatchObject({ epoch: 2, transitions: 0 })
  })

  it('does not roll an exhausted budget while its final transition remains in flight', () => {
    const store = new HumanGrantStore()
    const owner = agent('owner')
    const grant = issue(store, owner, { runId: 'run-a', maxTransitions: 1 })
    store.reserve({ agent: owner, repoRoot: '/repo/a', runId: 'run-a', operation: 'continue', publishRemote: false })
    expect(() => store.reauthorize({
      agent: owner, repoRoot: '/repo/a', runId: 'run-a', authority: store.authority(grant), allowPublication: true,
    })).toThrow('in flight')
  })

  it('never resurrects a live publication downgrade from stale durable authority', () => {
    let now = 100
    const store = new HumanGrantStore(() => now, 1_000)
    const owner = agent('owner')
    const issued = issue(store, owner, { runId: 'run-a', allowPublication: true })
    const stale = store.authority(issued)
    now = 101
    const downgraded = store.reauthorize({
      agent: owner, repoRoot: '/repo/a', runId: 'run-a', authority: stale, allowPublication: false,
    })
    expect(downgraded.allowPublication).toBe(false)
    now = 102
    const replayed = store.reauthorize({
      agent: owner, repoRoot: '/repo/a', runId: 'run-a', authority: stale, allowPublication: true,
    })
    expect(replayed.allowPublication).toBe(false)
    expect(store.authority(replayed).allowPublication).toBe(false)
  })

  it('never lets a model upgrade a local-only lifecycle to publication', () => {
    const store = new HumanGrantStore()
    const owner = agent('owner')
    issue(store, owner, { runId: 'run-a', allowPublication: false })
    expect(() => store.reserve({ agent: owner, repoRoot: '/repo/a', runId: 'run-a', operation: 'continue', publishRemote: true })).toThrow('local-only')
  })

  it('restores only a side-effect-free admission reservation', () => {
    const store = new HumanGrantStore()
    const owner = agent('owner')
    issue(store, owner)
    const reservation = store.reserve({ agent: owner, repoRoot: '/repo/a', runId: 'run-a', operation: 'start', publishRemote: false })
    store.restore(reservation)
    expect(reservation.grant.runId).toBeUndefined()
    expect(reservation.grant.transitions).toBe(0)
  })

  it('lets a fresh direct-human command renew an expired durable permit without resetting its transition budget', () => {
    let now = 100
    const original = new HumanGrantStore(() => now, 10)
    const owner = agent('owner')
    const issued = issue(original, owner, { runId: 'run-a' })
    const used = original.reserve({ agent: owner, repoRoot: '/repo/a', runId: 'run-a', operation: 'continue', publishRemote: false })
    original.settle(used)
    const expired = original.authority(issued)
    now = 111

    const restarted = new HumanGrantStore(() => now, 10)
    const renewed = restarted.reauthorize({
      agent: owner, repoRoot: '/repo/a', runId: 'run-a', authority: expired, allowPublication: true,
    })
    expect(renewed).toMatchObject({ transitions: 1, issuedAt: 111, expiresAt: 121, reauthorizedAt: 111 })
    const resumed = restarted.reserve({ agent: owner, repoRoot: '/repo/a', runId: 'run-a', operation: 'continue', publishRemote: false })
    expect(resumed.grant.transitions).toBe(2)
  })

  it('expires in Host memory and closes on direct stop', () => {
    let now = 100
    const store = new HumanGrantStore(() => now, 10)
    const owner = agent('owner')
    issue(store, owner, { runId: 'run-a' })
    now = 111
    expect(() => store.reserve({ agent: owner, repoRoot: '/repo/a', runId: 'run-a', operation: 'continue', publishRemote: false })).toThrow('expired')
    now = 100
    const stopped = issue(store, owner, { runId: 'run-b' })
    store.close(owner, '/repo/a', 'run-b')
    expect(store.permits(owner, '/repo/a').some(grant => grant.runId === 'run-b')).toBe(false)
    expect(() => new HumanGrantStore(() => now).hydrate({
      agent: owner, repoRoot: '/repo/a', runId: 'run-b', authority: store.authority(stopped),
    })).toThrow('revoked by direct human stop')
  })
})
