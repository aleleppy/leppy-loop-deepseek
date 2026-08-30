import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { atomicWriteJson, createLeaseKey } from './state.js'
import { runFile } from './process.js'
import type { LifecycleAuthority } from './types.js'

const lifecycleAuthorityMutexes = new Map<string, Promise<void>>()

export async function acquireLifecycleAuthorityMutex(stateDir: string): Promise<() => void> {
  const key = resolve(stateDir)
  const previous = lifecycleAuthorityMutexes.get(key) ?? Promise.resolve()
  let releaseTicket!: () => void
  const ticket = new Promise<void>(resolveTicket => { releaseTicket = resolveTicket })
  const queued = previous.then(() => ticket)
  lifecycleAuthorityMutexes.set(key, queued)
  await previous
  let released = false
  return () => {
    if (released) return
    released = true
    releaseTicket()
    queueMicrotask(() => { if (lifecycleAuthorityMutexes.get(key) === queued) lifecycleAuthorityMutexes.delete(key) })
  }
}

interface LifecycleAuthorityReceipt {
  schemaVersion: 1
  runId: string
  sequence: number
  previousDigest: string | null
  authority: LifecycleAuthority
  hmac: string
}

interface LifecycleAuthorityHead {
  schemaVersion: 1
  runId: string
  sequence: number
  digest: string
  hmac: string
}

export interface AuthenticatedLifecycleAuthority {
  authority: LifecycleAuthority
  sequence: number
  digest: string
}

export type LifecycleAuthorityInspection =
  | { status: 'legacy' }
  | { status: 'invalid'; reason: string }
  | ({ status: 'valid'; chain: readonly LifecycleAuthority[] } & AuthenticatedLifecycleAuthority)

function receiptPayload(receipt: Omit<LifecycleAuthorityReceipt, 'hmac'>): string {
  return JSON.stringify(receipt)
}

function headPayload(head: Omit<LifecycleAuthorityHead, 'hmac'>): string {
  return JSON.stringify(head)
}

function proof(key: Buffer, value: string): string {
  return createHmac('sha256', key).update(value).digest('base64url')
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function equalProof(actual: string, expected: string): boolean {
  const left = Buffer.from(actual)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}

function validAuthority(value: unknown): value is LifecycleAuthority {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const authority = value as Partial<LifecycleAuthority>
  return typeof authority.sessionId === 'string' && authority.sessionId.length > 0
    && typeof authority.allowPublication === 'boolean'
    && [authority.maxIterations, authority.maxRepairCycles, authority.maxTransitions, authority.transitions, authority.issuedAt, authority.expiresAt]
      .every(candidate => typeof candidate === 'number' && Number.isSafeInteger(candidate))
    && authority.maxIterations! > 0 && authority.maxRepairCycles! > 0 && authority.maxTransitions! > 0
    && authority.transitions! > 0 && authority.transitions! <= authority.maxTransitions!
    && authority.expiresAt! > authority.issuedAt!
    && (authority.revokedAt === undefined || (Number.isSafeInteger(authority.revokedAt) && authority.revokedAt >= authority.issuedAt!))
}

function immutableFactsMatch(left: LifecycleAuthority, right: LifecycleAuthority): boolean {
  return left.sessionId === right.sessionId
    && left.maxIterations === right.maxIterations
    && left.maxRepairCycles === right.maxRepairCycles
    && left.maxTransitions === right.maxTransitions
}

function permitWindowMatch(left: LifecycleAuthority, right: LifecycleAuthority): boolean {
  return left.issuedAt === right.issuedAt && left.expiresAt === right.expiresAt
}

export function lifecycleAuthoritiesEqual(left: LifecycleAuthority, right: LifecycleAuthority): boolean {
  return immutableFactsMatch(left, right) && permitWindowMatch(left, right)
    && left.allowPublication === right.allowPublication && left.transitions === right.transitions
    && left.revokedAt === right.revokedAt
}

function validSuccessor(previous: LifecycleAuthority, next: LifecycleAuthority): boolean {
  if (!immutableFactsMatch(previous, next) || previous.revokedAt !== undefined) return false
  const publicationDowngrade = previous.allowPublication && !next.allowPublication
  if (previous.allowPublication !== next.allowPublication && !publicationDowngrade) return false
  const revocation = previous.revokedAt === undefined && next.revokedAt !== undefined
  const transitionDelta = next.transitions - previous.transitions
  if (!permitWindowMatch(previous, next)) {
    const sameBoundedTtl = next.expiresAt - next.issuedAt === previous.expiresAt - previous.issuedAt
    return transitionDelta === 0 && !revocation && next.issuedAt > previous.issuedAt
      && next.expiresAt > previous.expiresAt && sameBoundedTtl
  }
  if (transitionDelta === 1) return !revocation
  if (transitionDelta === 0) return publicationDowngrade !== revocation
  return false
}

/** Run-state reconciliation may observe either the authenticated tail itself or one valid chain successor. */
export function lifecycleAuthorityMatchesOrAdvances(previous: LifecycleAuthority, next: LifecycleAuthority): boolean {
  return lifecycleAuthoritiesEqual(previous, next) || validSuccessor(previous, next)
}

function receiptNames(stateDir: string): string[] {
  const authorityDir = resolve(stateDir, 'lifecycle-authority')
  if (!existsSync(authorityDir)) return []
  return readdirSync(authorityDir).filter(name => /^authority-[0-9]{6}\.json$/u.test(name)).sort()
}

function invalid(reason: string): LifecycleAuthorityInspection {
  return { status: 'invalid', reason }
}

/** Inspect the complete receipt chain and its separately replaced authenticated monotonic head. */
export function inspectLifecycleAuthority(stateDir: string, runId: string): LifecycleAuthorityInspection {
  const names = receiptNames(stateDir)
  const keyPath = resolve(stateDir, 'lease.key')
  const headPath = resolve(stateDir, 'lifecycle-authority-head.json')
  const requiredPath = resolve(stateDir, 'lifecycle-authority-required.hmac')
  if (names.length === 0 && !existsSync(headPath) && !existsSync(requiredPath)) return { status: 'legacy' }
  if (!existsSync(keyPath) || !existsSync(headPath) || !existsSync(requiredPath)) return invalid('lifecycle authority key, required marker, or monotonic head is missing')
  let key: Buffer
  let head: LifecycleAuthorityHead
  try {
    key = Buffer.from(readFileSync(keyPath, 'utf8').trim(), 'base64')
    head = JSON.parse(readFileSync(headPath, 'utf8')) as LifecycleAuthorityHead
  } catch { return invalid('lifecycle authority head is unreadable') }
  if (head.schemaVersion !== 1 || head.runId !== runId || !Number.isSafeInteger(head.sequence) || head.sequence < 1
    || typeof head.digest !== 'string' || typeof head.hmac !== 'string') return invalid('lifecycle authority head shape is invalid')
  const unsignedHead = headPayload({ schemaVersion: 1, runId: head.runId, sequence: head.sequence, digest: head.digest })
  if (!equalProof(head.hmac, proof(key, unsignedHead))) return invalid('lifecycle authority head authentication failed')
  let requiredProof: string
  try { requiredProof = readFileSync(requiredPath, 'utf8').trim() } catch { return invalid('lifecycle authority required marker is unreadable') }
  if (!equalProof(requiredProof, proof(key, `lifecycle-authority-required\0${runId}`))) return invalid('lifecycle authority required marker authentication failed')
  if (names.length !== head.sequence) return invalid('lifecycle authority chain length does not match its monotonic head')

  let previous: AuthenticatedLifecycleAuthority | undefined
  const chain: LifecycleAuthority[] = []
  for (let index = 0; index < names.length; index += 1) {
    const name = names[index]!
    let receipt: LifecycleAuthorityReceipt
    try { receipt = JSON.parse(readFileSync(resolve(stateDir, 'lifecycle-authority', name), 'utf8')) as LifecycleAuthorityReceipt } catch { return invalid('lifecycle authority receipt is unreadable') }
    const sequence = index + 1
    if (receipt.schemaVersion !== 1 || receipt.runId !== runId || receipt.sequence !== sequence
      || name !== `authority-${String(sequence).padStart(6, '0')}.json`
      || !validAuthority(receipt.authority) || typeof receipt.hmac !== 'string') return invalid('lifecycle authority receipt shape or sequence is invalid')
    const unsignedReceipt = receiptPayload({
      schemaVersion: 1, runId: receipt.runId, sequence: receipt.sequence,
      previousDigest: receipt.previousDigest, authority: receipt.authority,
    })
    if (!equalProof(receipt.hmac, proof(key, unsignedReceipt))) return invalid('lifecycle authority receipt authentication failed')
    const currentDigest = digest(unsignedReceipt)
    if (receipt.previousDigest !== (previous?.digest ?? null)) return invalid('lifecycle authority receipt chain is broken')
    if (!previous) {
      if (receipt.authority.transitions !== 1 || receipt.authority.revokedAt !== undefined) return invalid('initial lifecycle authority receipt is invalid')
    } else if (!validSuccessor(previous.authority, receipt.authority)) return invalid('lifecycle authority successor is not monotonic')
    previous = { authority: receipt.authority, sequence, digest: currentDigest }
    chain.push({ ...receipt.authority })
  }
  if (!previous || head.sequence !== previous.sequence || head.digest !== previous.digest) return invalid('lifecycle authority head does not authenticate the current tail')
  return { status: 'valid', ...previous, chain }
}

export function readAuthenticatedLifecycleAuthority(stateDir: string, runId: string): AuthenticatedLifecycleAuthority | undefined {
  const inspected = inspectLifecycleAuthority(stateDir, runId)
  return inspected.status === 'valid' ? inspected : undefined
}

/** Advance the authenticated head before appending one immutable admission, downgrade, or revocation receipt. */
export function appendLifecycleAuthorityReceipt(stateDir: string, runId: string, authority: LifecycleAuthority): AuthenticatedLifecycleAuthority {
  if (!validAuthority(authority)) throw new Error('invalid lifecycle authority receipt')
  mkdirSync(resolve(stateDir, 'lifecycle-authority'), { recursive: true })
  const inspected = inspectLifecycleAuthority(stateDir, runId)
  if (inspected.status === 'invalid') throw new Error(`existing lifecycle authority is invalid: ${inspected.reason}`)
  const current = inspected.status === 'valid' ? inspected : undefined
  if (!current) {
    if (authority.transitions !== 1 || authority.revokedAt !== undefined) throw new Error('initial lifecycle authority receipt must admit transition one')
  } else if (!validSuccessor(current.authority, authority)) {
    if (!immutableFactsMatch(current.authority, authority)) throw new Error('lifecycle authority immutable facts changed')
    if (current.authority.revokedAt !== undefined) throw new Error('lifecycle authority was revoked by direct human stop')
    throw new Error('lifecycle authority transition is not monotonic')
  }

  const key = createLeaseKey(stateDir)
  if (!current) {
    writeFileSync(resolve(stateDir, 'lifecycle-authority-required.hmac'), `${proof(key, `lifecycle-authority-required\0${runId}`)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  }
  const sequence = (current?.sequence ?? 0) + 1
  const unsignedReceipt = {
    schemaVersion: 1 as const, runId, sequence, previousDigest: current?.digest ?? null, authority: { ...authority },
  }
  const serializedReceipt = receiptPayload(unsignedReceipt)
  const currentDigest = digest(serializedReceipt)
  const unsignedHead = { schemaVersion: 1 as const, runId, sequence, digest: currentDigest }
  const head: LifecycleAuthorityHead = { ...unsignedHead, hmac: proof(key, headPayload(unsignedHead)) }
  atomicWriteJson(resolve(stateDir, 'lifecycle-authority-head.json'), head)
  const receipt: LifecycleAuthorityReceipt = { ...unsignedReceipt, hmac: proof(key, serializedReceipt) }
  const path = resolve(stateDir, 'lifecycle-authority', `authority-${String(sequence).padStart(6, '0')}.json`)
  writeFileSync(path, `${JSON.stringify(receipt)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  return { authority: receipt.authority, sequence, digest: currentDigest }
}

export async function lifecycleStateDir(repoRoot: string, runId: string): Promise<string> {
  const commonRaw = (await runFile('git', ['rev-parse', '--git-common-dir'], { cwd: repoRoot })).stdout.trim()
  return resolve(repoRoot, commonRaw, 'leppy-loop', 'runs', runId)
}
