import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { resolve } from 'node:path'

interface LifecycleAuthorityAnchorEntry {
  schemaVersion: 1
  stateDirDigest: string
  runId: string
  sequence: number
  digest: string
  hmac: string
}

export type LifecycleAuthorityAnchorResult =
  | { status: 'valid'; relation: 'created' | 'equal' | 'advanced' }
  | { status: 'invalid'; reason: string }

export type LifecycleAuthorityAnchorInspection =
  | { status: 'missing' | 'behind' | 'equal' }
  | { status: 'invalid'; reason: string }

function anchorRoot(): string {
  if (process.env.VITEST) return resolve(tmpdir(), `leppy-loop-test-authority-anchor-${process.pid}`)
  const explicit = process.env.LEPPY_LIFECYCLE_AUTHORITY_ANCHOR_ROOT
  if (explicit) return resolve(explicit)
  return resolve(process.env.DSH_HOME || resolve(homedir(), '.dsh'), 'security', 'leppy-loop-lifecycle-authority-v1')
}

function proof(key: Buffer, value: string): string {
  return createHmac('sha256', key).update(value).digest('base64url')
}

function equalProof(actual: string, expected: string): boolean {
  const left = Buffer.from(actual)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}

function payload(entry: Omit<LifecycleAuthorityAnchorEntry, 'hmac'>): string {
  return JSON.stringify(entry)
}

function anchorKey(root: string): Buffer | undefined {
  mkdirSync(root, { recursive: true })
  const path = resolve(root, 'anchor.key')
  if (!existsSync(path)) {
    try { writeFileSync(path, `${randomBytes(32).toString('base64')}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 }) }
    catch { /* A concurrent Host may have won initialization. */ }
  }
  try {
    const key = Buffer.from(readFileSync(path, 'utf8').trim(), 'base64')
    return key.length === 32 ? key : undefined
  } catch { return undefined }
}

function readAnchorKey(root: string): Buffer | undefined {
  try {
    const key = Buffer.from(readFileSync(resolve(root, 'anchor.key'), 'utf8').trim(), 'base64')
    return key.length === 32 ? key : undefined
  } catch { return undefined }
}

function anchorLocation(stateDir: string, runId: string): { stateDirDigest: string; directory: string } {
  const stateDirDigest = createHash('sha256').update(resolve(stateDir)).digest('hex')
  const id = createHash('sha256').update(`${stateDirDigest}\0${runId}`).digest('hex')
  return { stateDirDigest, directory: resolve(anchorRoot(), 'runs', id) }
}

/** Exposed for deterministic recovery tests and Host diagnostics; workers cannot access DSH_HOME. */
export function lifecycleAuthorityAnchorDirectory(stateDir: string, runId: string): string {
  return anchorLocation(stateDir, runId).directory
}

function readEntry(path: string, key: Buffer): LifecycleAuthorityAnchorEntry | undefined {
  try {
    const entry = JSON.parse(readFileSync(path, 'utf8')) as Partial<LifecycleAuthorityAnchorEntry>
    if (entry.schemaVersion !== 1 || typeof entry.stateDirDigest !== 'string' || !/^[0-9a-f]{64}$/u.test(entry.stateDirDigest)
      || typeof entry.runId !== 'string' || entry.runId.length === 0
      || !Number.isSafeInteger(entry.sequence) || entry.sequence! < 1
      || typeof entry.digest !== 'string' || !/^[0-9a-f]{64}$/u.test(entry.digest)
      || typeof entry.hmac !== 'string') return undefined
    const unsigned = {
      schemaVersion: 1 as const, stateDirDigest: entry.stateDirDigest, runId: entry.runId,
      sequence: entry.sequence!, digest: entry.digest,
    }
    if (!equalProof(entry.hmac, proof(key, payload(unsigned)))) return undefined
    return { ...unsigned, hmac: entry.hmac }
  } catch { return undefined }
}

export function inspectLifecycleAuthorityAnchor(
  stateDir: string,
  runId: string,
  sequence: number,
  digest: string,
): LifecycleAuthorityAnchorInspection {
  const root = anchorRoot()
  if (!existsSync(root) || !existsSync(resolve(root, 'anchor.key'))) return { status: 'missing' }
  const key = readAnchorKey(root)
  if (!key) return { status: 'invalid', reason: 'external lifecycle authority anchor key is invalid' }
  const { stateDirDigest, directory } = anchorLocation(stateDir, runId)
  if (!existsSync(directory)) return { status: 'missing' }
  const names = readdirSync(directory).filter(name => /^anchor-[0-9]{16}\.json$/u.test(name)).sort()
  const latestName = names.at(-1)
  if (!latestName) return { status: 'missing' }
  const previous = readEntry(resolve(directory, latestName), key)
  if (!previous) return { status: 'invalid', reason: 'external lifecycle authority anchor entry is invalid' }
  if (latestName !== `anchor-${String(previous.sequence).padStart(16, '0')}.json`
    || previous.stateDirDigest !== stateDirDigest || previous.runId !== runId) {
    return { status: 'invalid', reason: 'external lifecycle authority anchor identity does not match this run' }
  }
  if (previous.sequence > sequence || (previous.sequence === sequence && previous.digest !== digest)) {
    return { status: 'invalid', reason: 'external lifecycle authority anchor detected receipt-chain rollback or fork' }
  }
  return { status: previous.sequence === sequence ? 'equal' : 'behind' }
}

/**
 * Compare a fully authenticated run-local chain with an append-only Host-global high-water mark.
 * Workers are confined away from DSH_HOME; independent runs never share a replaceable registry file.
 */
export function reconcileLifecycleAuthorityAnchor(
  stateDir: string,
  runId: string,
  sequence: number,
  digest: string,
): LifecycleAuthorityAnchorResult {
  const inspected = inspectLifecycleAuthorityAnchor(stateDir, runId, sequence, digest)
  if (inspected.status === 'invalid') return inspected
  if (inspected.status === 'equal') return { status: 'valid', relation: 'equal' }
  const root = anchorRoot()
  const key = anchorKey(root)
  if (!key) return { status: 'invalid', reason: 'external lifecycle authority anchor key is missing or invalid' }
  const { stateDirDigest, directory } = anchorLocation(stateDir, runId)
  mkdirSync(directory, { recursive: true })
  const unsigned = { schemaVersion: 1 as const, stateDirDigest, runId, sequence, digest }
  const entry: LifecycleAuthorityAnchorEntry = { ...unsigned, hmac: proof(key, payload(unsigned)) }
  const path = resolve(directory, `anchor-${String(sequence).padStart(16, '0')}.json`)
  try {
    writeFileSync(path, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  } catch {
    const raced = readEntry(path, key)
    if (!raced || raced.stateDirDigest !== stateDirDigest || raced.runId !== runId
      || raced.sequence !== sequence || raced.digest !== digest) {
      return { status: 'invalid', reason: 'external lifecycle authority anchor concurrent advance forked' }
    }
  }
  const confirmed = inspectLifecycleAuthorityAnchor(stateDir, runId, sequence, digest)
  if (confirmed.status !== 'equal') {
    return confirmed.status === 'invalid'
      ? confirmed
      : { status: 'invalid', reason: 'external lifecycle authority anchor advance was not the durable high-water mark' }
  }
  return { status: 'valid', relation: inspected.status === 'behind' ? 'advanced' : 'created' }
}
