import type { Agent } from '@deepseek-ai/dsh-agent'
import { describe, expect, it } from 'vitest'
import { HumanGrantStore } from '../src/human-grant.js'

function agent(id: string): Agent {
  return { id } as unknown as Agent
}

const base = {
  repoRoot: '/repo/a', runId: 'run-a', operation: 'continue' as const, recovery: 'resume' as const,
  publishRemote: false, maxIterations: 64, maxRepairCycles: 3,
}

describe('HumanGrantStore', () => {
  it('binds capabilities to the exact live session, repository and run', () => {
    const store = new HumanGrantStore()
    const alice = agent('alice')
    const bob = agent('bob')
    store.issue({ ...base, agent: alice })
    expect(() => store.consume({ ...base, agent: bob })).toThrow('another session')
    expect(() => store.consume({ agent: alice, repoRoot: '/repo/b', runId: 'run-a', operation: 'continue', recovery: 'resume' })).toThrow('another repository')
    expect(() => store.consume({ agent: alice, repoRoot: '/repo/a', runId: 'run-b', operation: 'continue', recovery: 'resume' })).toThrow('another run')
  })

  it('consumes once and rejects replay', () => {
    const store = new HumanGrantStore()
    const owner = agent('owner')
    store.issue({ ...base, agent: owner })
    const request = { agent: owner, repoRoot: '/repo/a', runId: 'run-a', operation: 'continue' as const, recovery: 'resume' as const }
    expect(store.consume(request).runId).toBe('run-a')
    expect(() => store.consume(request)).toThrow('already been consumed')
  })

  it('expires without trusting a model-provided flag', () => {
    let now = 100
    const store = new HumanGrantStore(() => now, 10)
    const owner = agent('owner')
    store.issue({ ...base, agent: owner })
    now = 111
    expect(() => store.consume({ agent: owner, repoRoot: '/repo/a', runId: 'run-a', operation: 'continue', recovery: 'resume' })).toThrow('expired')
  })
})
