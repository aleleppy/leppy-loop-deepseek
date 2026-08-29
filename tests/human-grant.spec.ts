import type { Agent } from '@deepseek-ai/dsh-agent'
import { describe, expect, it } from 'vitest'
import { HumanGrantStore } from '../src/human-grant.js'

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
