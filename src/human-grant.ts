import { randomUUID } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'

export type LeppyOperation = 'start' | 'continue' | 'stop'
export type RecoveryAuthority = 'none' | 'resume' | 'retry-gate' | 'repair-gate'

/** One Host-memory lifecycle authority minted by one direct human slash invocation. */
export interface HumanGrant {
  id: string
  agent: Agent
  sessionId: string
  repoRoot: string
  runId?: string
  allowPublication: boolean
  maxIterations: number
  maxRepairCycles: number
  maxTransitions: number
  transitions: number
  issuedAt: number
  expiresAt: number
  inFlight: boolean
}

export interface GrantRequest {
  agent: Agent
  repoRoot: string
  runId: string
  operation: 'start' | 'continue'
  publishRemote: boolean
}

export interface GrantReservation {
  grant: HumanGrant
  boundRun: boolean
}

/** Reusable, bounded lifecycle permits fenced to one live Agent, repository and run. */
export class HumanGrantStore {
  private readonly grants: HumanGrant[] = []

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs = 24 * 60 * 60_000,
  ) {}

  issue(input: {
    agent: Agent
    repoRoot: string
    runId?: string
    allowPublication: boolean
    maxIterations: number
    maxRepairCycles: number
    maxTransitions: number
  }): HumanGrant {
    const issuedAt = this.now()
    const grant: HumanGrant = {
      ...input,
      id: randomUUID(),
      sessionId: String(input.agent.id),
      transitions: 0,
      issuedAt,
      expiresAt: issuedAt + this.ttlMs,
      inFlight: false,
    }
    this.grants.push(grant)
    if (this.grants.length > 64) this.grants.splice(0, this.grants.length - 64)
    return grant
  }

  reserve(request: GrantRequest): GrantReservation {
    const sameSession = this.grants.filter(grant => grant.agent === request.agent && grant.sessionId === String(request.agent.id))
    const sameRepo = sameSession.filter(grant => grant.repoRoot === request.repoRoot)
    const candidates = sameRepo.filter(grant => grant.runId === undefined || grant.runId === request.runId)
    const grant = [...candidates].reverse().find(candidate => this.now() <= candidate.expiresAt)
    if (!grant) {
      if (sameSession.length > 0 && sameRepo.length === 0) throw new Error('human lifecycle permit belongs to another repository')
      if (sameRepo.length > 0) throw new Error('human lifecycle permit belongs to another run or has expired')
      throw new Error('no direct human lifecycle permit authorizes this Leppy run')
    }
    if (grant.inFlight) throw new Error('human lifecycle permit already has a controller transition in flight')
    if (grant.transitions >= grant.maxTransitions) throw new Error(`human lifecycle transition budget exhausted at ${grant.maxTransitions}`)
    if (request.publishRemote && !grant.allowPublication) throw new Error('human lifecycle permit is local-only and cannot publish remotely')
    if (request.operation === 'continue' && grant.runId === undefined) throw new Error('human lifecycle permit is not bound to an authenticated run')
    const boundRun = grant.runId === undefined
    if (boundRun) grant.runId = request.runId
    grant.inFlight = true
    grant.transitions += 1
    return { grant, boundRun }
  }

  settle(reservation: GrantReservation): void {
    if (!reservation.grant.inFlight) throw new Error('human lifecycle permit has no transition in flight')
    reservation.grant.inFlight = false
  }

  /** Roll back only a synchronous, side-effect-free job admission failure. */
  restore(reservation: GrantReservation): void {
    const grant = reservation.grant
    if (!grant.inFlight || grant.transitions < 1) throw new Error('human lifecycle permit is not reserved')
    grant.inFlight = false
    grant.transitions -= 1
    if (reservation.boundRun) delete grant.runId
  }

  permits(agent: Agent, repoRoot: string): readonly HumanGrant[] {
    return this.grants.filter(grant => grant.agent === agent && grant.sessionId === String(agent.id) && grant.repoRoot === repoRoot
      && this.now() <= grant.expiresAt && grant.transitions < grant.maxTransitions)
  }

  close(agent: Agent, repoRoot: string, runId: string): void {
    for (const grant of this.grants) {
      if (grant.agent === agent && grant.sessionId === String(agent.id) && grant.repoRoot === repoRoot && grant.runId === runId) grant.expiresAt = this.now() - 1
    }
  }
}
