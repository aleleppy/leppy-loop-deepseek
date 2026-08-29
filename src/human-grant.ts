import { randomUUID } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { LifecycleAuthority } from './types.js'

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
  revokedAt?: number
  reauthorizedAt: number
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
      reauthorizedAt: issuedAt,
      inFlight: false,
    }
    this.grants.push(grant)
    if (this.grants.length > 64) this.grants.splice(0, this.grants.length - 64)
    return grant
  }

  hydrate(input: { agent: Agent; repoRoot: string; runId: string; authority: LifecycleAuthority }): HumanGrant {
    if (input.authority.sessionId !== String(input.agent.id)) throw new Error('durable lifecycle permit belongs to another session')
    if (input.authority.revokedAt !== undefined) throw new Error('durable lifecycle permit was revoked by direct human stop')
    if (this.now() > input.authority.expiresAt) throw new Error('durable lifecycle permit has expired')
    if (input.authority.transitions >= input.authority.maxTransitions) throw new Error(`human lifecycle transition budget exhausted at ${input.authority.maxTransitions}`)
    const existing = [...this.grants].reverse().find(grant => grant.sessionId === input.authority.sessionId
      && grant.repoRoot === input.repoRoot && grant.runId === input.runId && this.now() <= grant.expiresAt)
    if (existing) {
      existing.agent = input.agent
      return existing
    }
    const grant: HumanGrant = {
      id: randomUUID(), agent: input.agent, sessionId: input.authority.sessionId, repoRoot: input.repoRoot, runId: input.runId,
      allowPublication: input.authority.allowPublication, maxIterations: input.authority.maxIterations,
      maxRepairCycles: input.authority.maxRepairCycles, maxTransitions: input.authority.maxTransitions,
      transitions: input.authority.transitions, issuedAt: input.authority.issuedAt, expiresAt: input.authority.expiresAt,
      reauthorizedAt: input.authority.issuedAt, inFlight: false,
    }
    this.grants.push(grant)
    return grant
  }

  reauthorize(input: { agent: Agent; repoRoot: string; runId: string; authority: LifecycleAuthority; allowPublication: boolean }): HumanGrant {
    const grant = this.hydrate(input)
    if (!input.allowPublication) grant.allowPublication = false
    grant.agent = input.agent
    grant.reauthorizedAt = this.now()
    return grant
  }

  authority(grant: HumanGrant): LifecycleAuthority {
    return {
      sessionId: grant.sessionId, allowPublication: grant.allowPublication, maxIterations: grant.maxIterations,
      maxRepairCycles: grant.maxRepairCycles, maxTransitions: grant.maxTransitions, transitions: grant.transitions,
      issuedAt: grant.issuedAt, expiresAt: grant.expiresAt,
      ...(grant.revokedAt === undefined ? {} : { revokedAt: grant.revokedAt }),
    }
  }

  reserve(request: GrantRequest): GrantReservation {
    const sameSession = this.grants.filter(grant => grant.sessionId === String(request.agent.id))
    const sameRepo = sameSession.filter(grant => grant.repoRoot === request.repoRoot)
    const candidates = sameRepo.filter(grant => grant.runId === undefined || grant.runId === request.runId)
    const grant = [...candidates].reverse().find(candidate => candidate.revokedAt === undefined && this.now() <= candidate.expiresAt)
    if (!grant) {
      if (sameSession.length > 0 && sameRepo.length === 0) throw new Error('human lifecycle permit belongs to another repository')
      if (candidates.some(candidate => candidate.revokedAt !== undefined)) throw new Error('human lifecycle permit was revoked by direct human stop')
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
    return this.grants.filter(grant => grant.sessionId === String(agent.id) && grant.repoRoot === repoRoot
      && grant.revokedAt === undefined && this.now() <= grant.expiresAt && grant.transitions < grant.maxTransitions)
  }

  close(agent: Agent, repoRoot: string, runId: string): void {
    for (const grant of this.grants) {
      if (grant.sessionId === String(agent.id) && grant.repoRoot === repoRoot && grant.runId === runId) grant.revokedAt = this.now()
    }
  }
}
