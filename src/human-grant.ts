import { randomUUID } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'

export type LeppyOperation = 'start' | 'continue' | 'stop'
export type RecoveryAuthority = 'none' | 'resume' | 'retry-gate' | 'repair-gate'

/** Authority minted only from a direct human slash-command invocation. */
export interface HumanGrant {
  id: string
  agent: Agent
  sessionId: string
  repoRoot: string
  runId?: string
  controllerDigest?: string
  operation: LeppyOperation
  recovery: RecoveryAuthority
  publishRemote: boolean
  maxIterations: number
  maxRepairCycles: number
  issuedAt: number
  expiresAt: number
  consumedAt?: number
}

export interface GrantRequest {
  agent: Agent
  repoRoot: string
  runId?: string
  controllerDigest?: string
  operation: LeppyOperation
  recovery: RecoveryAuthority
}

/** In-memory, one-shot capabilities bound to one live agent, repository, run and operation. */
export class HumanGrantStore {
  private readonly grants: HumanGrant[] = []

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs = 5 * 60_000,
  ) {}

  issue(input: Omit<HumanGrant, 'id' | 'issuedAt' | 'expiresAt' | 'consumedAt' | 'sessionId'>): HumanGrant {
    const issuedAt = this.now()
    const grant: HumanGrant = {
      ...input,
      id: randomUUID(),
      sessionId: String(input.agent.id),
      issuedAt,
      expiresAt: issuedAt + this.ttlMs,
    }
    this.grants.push(grant)
    if (this.grants.length > 64) this.grants.splice(0, this.grants.length - 64)
    return grant
  }

  consume(request: GrantRequest): HumanGrant {
    const candidates = this.grants.filter(grant => grant.operation === request.operation
      && grant.recovery === request.recovery
      && grant.repoRoot === request.repoRoot
      && grant.runId === request.runId)
    const owned = candidates.filter(grant => grant.agent === request.agent && grant.sessionId === String(request.agent.id))
    const snapshot = owned.filter(grant => grant.controllerDigest === request.controllerDigest)
    const exact = snapshot.find(grant => grant.consumedAt === undefined)
    if (!exact) {
      if (owned.length > 0 && snapshot.length === 0) throw new Error('authenticated controller changed after human authorization')
      if (snapshot.length > 0) throw new Error('human capability has already been consumed')
      if (candidates.length > 0) throw new Error('human capability belongs to another session')
      const sameSession = this.grants.filter(grant => grant.agent === request.agent && grant.sessionId === String(request.agent.id))
      if (sameSession.some(grant => grant.repoRoot !== request.repoRoot)) throw new Error('human capability belongs to another repository')
      if (sameSession.some(grant => grant.runId !== request.runId)) throw new Error('human capability belongs to another run')
      throw new Error(`no direct human capability authorizes Leppy operation ${request.operation}`)
    }
    if (this.now() > exact.expiresAt) throw new Error('human capability expired')
    exact.consumedAt = this.now()
    return exact
  }

  /** Roll back a synchronous, side-effect-free job admission failure. */
  restore(grant: HumanGrant): void {
    const exact = this.grants.find(candidate => candidate === grant)
    if (!exact || exact.consumedAt === undefined) throw new Error('human capability is not reserved')
    delete exact.consumedAt
  }
}
