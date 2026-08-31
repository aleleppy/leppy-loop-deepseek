import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, realpathSync, readlinkSync, renameSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { ignoredPathSnapshot } from './git.js'
import { runFile } from './process.js'
import { scrubEnvironment } from './security.js'
import { atomicWriteJson } from './state.js'
import type { IgnoredArtifactTransactionRef } from './types.js'

const BASELINES = 'worker-ignored-path-baselines'
const RECOVERIES = 'worker-ignored-path-recovery'
const QUARANTINES = 'worker-ignored-path-quarantine'
const LEGACY_SUBSET_MAX_ENTRIES = 128
const LEGACY_SUBSET_THREE_ADDITIONS = 3
const LEGACY_SUBSET_THREE_CANDIDATES = 10_000
const LEGACY_SUBSET_FOUR_ADDITIONS = 4
const LEGACY_SUBSET_FOUR_ENTRY_ENVELOPE = 39
// The superseded 3-addition/10,000-candidate search could emit its terminal no-match
// detail only for at most 39 entries. Exhausting removals 1..4 for 39 entries costs
// 92,170 candidates, so this cap completely covers every state admitted by that
// exact capability bridge. Wider snapshots retain the predecessor's smaller bounds.
const LEGACY_SUBSET_FOUR_CANDIDATES = 100_000
const LEGACY_SUBSET_MAX_FINGERPRINT_BYTES = 128 * 1024
const LEGACY_SUBSET_MAX_HASHED_BYTES = 512 * 1024 * 1024
export const EMPTY_IGNORED_PATHS_DIGEST = createHash('sha256').update(JSON.stringify([])).digest('hex')
const LEGACY_BASELINE_MISSING_DETAIL = 'worker ignored artifact recovery lacks its authenticated pre-attempt baseline'
const LEGACY_SUBSET_THREE_ADDITION_DETAIL = 'worker ignored artifact recovery cannot prove its legacy non-empty baseline from current fingerprints'

/** One bounded capability transition from a superseded legacy recovery failure. */
export function workerIgnoredBaselineRecovery(detail: string | undefined): boolean {
  return detail === LEGACY_BASELINE_MISSING_DETAIL || detail === LEGACY_SUBSET_THREE_ADDITION_DETAIL
}

type Baseline = {
  schemaVersion: 1
  runId: string
  taskKey: string
  taskIndex: number
  attempt: number
  digest: string
  entries: readonly BaselineEntry[]
  basis: 'recorded' | 'authenticated-empty-digest' | 'authenticated-subset-digest'
  proof: string
}

type ArtifactIdentity = {
  dev: string
  ino: string
  nlink: string
  type: 'file' | 'link'
}

type BaselineEntry = {
  path: string
  fingerprint: string
  identity: ArtifactIdentity
}

type RecoveryEntry = {
  path: string
  fingerprint: string
  source: string
  quarantine: string
  identity: ArtifactIdentity
}

type Recovery = {
  schemaVersion: 1
  transactionId: string
  runId: string
  taskKey: string
  taskIndex: number
  attempt: number
  baselineDigest: string
  phase: 'prepared' | 'quarantined'
  quarantineRoot: string
  entries: readonly RecoveryEntry[]
  proof: string
}

function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

function entryExists(path: string): boolean {
  try { lstatSync(path); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function sign<T extends object>(unsigned: T, key: Buffer): T & { proof: string } {
  return { ...unsigned, proof: createHmac('sha256', key).update(JSON.stringify(unsigned)).digest('base64url') }
}

function validProof(value: Record<string, unknown>, key: Buffer): boolean {
  if (typeof value.proof !== 'string') return false
  const { proof, ...unsigned } = value
  const expected = Buffer.from(createHmac('sha256', key).update(JSON.stringify(unsigned)).digest('base64url'))
  const actual = Buffer.from(proof)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

function validFingerprint(value: unknown): value is string {
  return typeof value === 'string' && value.includes('\0') && !value.startsWith('\0')
}

function validIdentity(value: unknown): value is ArtifactIdentity {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<ArtifactIdentity>
  return (candidate.type === 'file' || candidate.type === 'link')
    && [candidate.dev, candidate.ino, candidate.nlink].every(item => typeof item === 'string' && /^\d+$/u.test(item))
}

function validBaseline(value: unknown, key: Buffer): value is Baseline {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const baseline = value as Partial<Baseline>
  return baseline.schemaVersion === 1 && typeof baseline.runId === 'string'
    && typeof baseline.taskKey === 'string' && /^[a-f0-9]{64}$/u.test(baseline.taskKey)
    && Number.isSafeInteger(baseline.taskIndex) && (baseline.taskIndex ?? -1) >= 0
    && Number.isSafeInteger(baseline.attempt) && (baseline.attempt ?? -1) > 0
    && typeof baseline.digest === 'string' && /^[a-f0-9]{64}$/u.test(baseline.digest)
    && Array.isArray(baseline.entries) && baseline.entries.length <= 100_000 && baseline.entries.every(validBaselineEntry)
    && baseline.entries.every((entry, index) => index === 0 || baseline.entries![index - 1]!.path < entry.path)
    && createHash('sha256').update(JSON.stringify(baseline.entries.map(entry => entry.fingerprint))).digest('hex') === baseline.digest
    && (baseline.basis === 'recorded' || baseline.basis === 'authenticated-empty-digest'
      || baseline.basis === 'authenticated-subset-digest')
    && validProof(value as Record<string, unknown>, key)
}

function validBaselineEntry(value: unknown): value is BaselineEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const entry = value as Partial<BaselineEntry>
  return typeof entry.path === 'string' && entry.path !== '' && validFingerprint(entry.fingerprint)
    && entry.path === entryPath(entry.fingerprint) && validIdentity(entry.identity)
}

function validRecoveryEntry(value: unknown): value is RecoveryEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const entry = value as Partial<RecoveryEntry>
  return typeof entry.path === 'string' && entry.path !== '' && validFingerprint(entry.fingerprint)
    && typeof entry.source === 'string' && typeof entry.quarantine === 'string' && validIdentity(entry.identity)
    && entry.identity.type === 'file' && entry.identity.nlink === '1'
}

function validRecovery(value: unknown, key: Buffer): value is Recovery {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const recovery = value as Partial<Recovery>
  return recovery.schemaVersion === 1 && typeof recovery.transactionId === 'string'
    && typeof recovery.runId === 'string' && typeof recovery.taskKey === 'string' && /^[a-f0-9]{64}$/u.test(recovery.taskKey)
    && Number.isSafeInteger(recovery.taskIndex) && (recovery.taskIndex ?? -1) >= 0
    && Number.isSafeInteger(recovery.attempt) && (recovery.attempt ?? -1) > 0
    && typeof recovery.baselineDigest === 'string' && /^[a-f0-9]{64}$/u.test(recovery.baselineDigest)
    && (recovery.phase === 'prepared' || recovery.phase === 'quarantined')
    && typeof recovery.quarantineRoot === 'string'
    && Array.isArray(recovery.entries) && recovery.entries.length > 0 && recovery.entries.length <= 100_000
    && recovery.entries.every(validRecoveryEntry) && validProof(value as Record<string, unknown>, key)
}

function readSigned<T>(path: string, key: Buffer, valid: (value: unknown, key: Buffer) => value is T, label: string): T | undefined {
  if (!entryExists(path)) return undefined
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!valid(parsed, key)) throw new Error(`${label} receipt is invalid`)
  return parsed
}

function baselinePath(stateDir: string, taskIndex: number, attempt: number): string {
  return join(stateDir, BASELINES, `${taskIndex}-${attempt}.json`)
}

function recoveryPath(stateDir: string, taskIndex: number, attempt: number): string {
  return join(stateDir, RECOVERIES, `${taskIndex}-${attempt}.json`)
}

function entryPath(fingerprint: string): string {
  return fingerprint.slice(0, fingerprint.indexOf('\0'))
}

function fingerprintDigest(entries: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex')
}

async function inferLegacyBaselineSubset(entries: readonly string[], expectedDigest: string): Promise<readonly string[]> {
  if (entries.length > LEGACY_SUBSET_MAX_ENTRIES) {
    throw new Error(`legacy ignored baseline inference exceeds ${LEGACY_SUBSET_MAX_ENTRIES} current entries`)
  }
  const fingerprintBytes = entries.reduce((total, entry) => total + Buffer.byteLength(entry, 'utf8'), 0)
  if (fingerprintBytes > LEGACY_SUBSET_MAX_FINGERPRINT_BYTES) {
    throw new Error(`legacy ignored baseline inference exceeds ${LEGACY_SUBSET_MAX_FINGERPRINT_BYTES} UTF-8 fingerprint bytes`)
  }
  if (fingerprintDigest(entries) === expectedDigest) return entries
  const expanded = entries.length <= LEGACY_SUBSET_FOUR_ENTRY_ENVELOPE
  const maxAdditions = expanded ? LEGACY_SUBSET_FOUR_ADDITIONS : LEGACY_SUBSET_THREE_ADDITIONS
  const maxCandidates = expanded ? LEGACY_SUBSET_FOUR_CANDIDATES : LEGACY_SUBSET_THREE_CANDIDATES
  let examined = 0
  let hashedBytes = 0
  let match: readonly string[] | undefined
  const removed = new Set<number>()
  const evaluate = async (): Promise<void> => {
    examined += 1
    if (examined > maxCandidates) {
      throw new Error(`legacy ignored baseline inference exceeds ${maxCandidates} authenticated candidates`)
    }
    const candidate = entries.filter((_entry, index) => !removed.has(index))
    const serialized = JSON.stringify(candidate)
    hashedBytes += Buffer.byteLength(serialized, 'utf8')
    if (hashedBytes > LEGACY_SUBSET_MAX_HASHED_BYTES) {
      throw new Error(`legacy ignored baseline inference exceeds ${LEGACY_SUBSET_MAX_HASHED_BYTES} cumulative hashed bytes`)
    }
    if (createHash('sha256').update(serialized).digest('hex') === expectedDigest) match = candidate
    if (examined % 128 === 0) await new Promise<void>(resolveYield => { setImmediate(resolveYield) })
  }
  const search = async (start: number, remaining: number): Promise<void> => {
    if (match) return
    if (remaining === 0) { await evaluate(); return }
    for (let index = start; index <= entries.length - remaining && !match; index += 1) {
      removed.add(index)
      await search(index + 1, remaining - 1)
      removed.delete(index)
    }
  }
  for (let additions = 1; additions <= Math.min(maxAdditions, entries.length) && !match; additions += 1) {
    await search(0, additions)
  }
  if (!match) {
    throw new Error(`worker ignored artifact recovery cannot prove its legacy non-empty baseline from current fingerprints within ${maxAdditions} additions and ${examined} candidates`)
  }
  return match
}

function fingerprintAt(path: string, absolute: string): string {
  const stat = lstatSync(absolute)
  if (stat.isSymbolicLink()) return `${path}\0link\0${readlinkSync(absolute)}`
  if (!stat.isFile()) return `${path}\0${stat.isDirectory() ? 'directory' : 'special'}\0${stat.mode}`
  return `${path}\0file\0${stat.size}\0${createHash('sha256').update(readFileSync(absolute)).digest('hex')}`
}

function identity(path: string): ArtifactIdentity {
  const stat = lstatSync(path, { bigint: true })
  const type = stat.isSymbolicLink() ? 'link' : stat.isFile() ? 'file' : undefined
  if (!type) throw new Error('worker ignored artifact quarantine accepts only files and symlinks')
  if (stat.nlink !== 1n) throw new Error('worker ignored artifact quarantine rejects hardlinked entries')
  return { dev: stat.dev.toString(10), ino: stat.ino.toString(10), nlink: stat.nlink.toString(10), type }
}

function sameIdentity(left: ArtifactIdentity, right: ArtifactIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.nlink === right.nlink && left.type === right.type
}

async function trackedPaths(worktree: string, paths: readonly string[]): Promise<Set<string>> {
  const tracked = new Set<string>()
  for (let offset = 0; offset < paths.length; offset += 100) {
    const chunk = paths.slice(offset, offset + 100)
    const result = await runFile('git', ['ls-files', '-z', '--', ...chunk.map(path => `:(literal)${path}`)], {
      cwd: worktree, env: scrubEnvironment(process.env), allowFailure: true,
    })
    if (result.exitCode !== 0) throw new Error(`cannot authenticate tracked ignored-path adoption: ${result.stderr}`)
    for (const path of result.stdout.split('\0').filter(Boolean)) tracked.add(path.replaceAll('\\', '/'))
  }
  return tracked
}

async function assertBaselinePreserved(worktree: string, baseline: Baseline, currentEntries: readonly string[]): Promise<void> {
  const current = new Map(currentEntries.map(entry => [entryPath(entry), entry]))
  const missing: string[] = []
  for (const entry of baseline.entries) {
    const observed = current.get(entry.path)
    if (observed === undefined) missing.push(entry.path)
    else if (observed !== entry.fingerprint || !sameIdentity(identity(resolve(worktree, entry.path)), entry.identity)) {
      throw new Error(`pre-existing ignored artifact changed during worker attempt: ${entry.path}`)
    }
  }
  if (missing.length === 0) return
  const tracked = await trackedPaths(worktree, missing)
  const unresolved = missing.find(path => !tracked.has(path))
  if (unresolved) throw new Error(`pre-existing ignored artifact disappeared during worker attempt: ${unresolved}`)
}

function assertBinding(value: Baseline | Recovery, options: { runId: string; taskKey: string; taskIndex: number; attempt: number }): void {
  if (value.runId !== options.runId || value.taskKey !== options.taskKey
    || value.taskIndex !== options.taskIndex || value.attempt !== options.attempt) {
    throw new Error('worker ignored artifact provenance belongs to another run, task, or attempt')
  }
}

function transactionRef(recovery: Recovery): IgnoredArtifactTransactionRef {
  return {
    schemaVersion: 1, transactionId: recovery.transactionId,
    baselineDigest: recovery.baselineDigest,
  }
}

function assertTransactionRef(recovery: Recovery, expected: IgnoredArtifactTransactionRef): void {
  if (expected.schemaVersion !== 1 || expected.transactionId !== recovery.transactionId
    || expected.baselineDigest !== recovery.baselineDigest) {
    throw new Error('worker ignored recovery disagrees with authenticated transaction state')
  }
}

export async function recordWorkerIgnoredPathBaseline(options: {
  worktree: string
  stateDir: string
  runId: string
  taskKey: string
  taskIndex: number
  attempt: number
  key: Buffer
}): Promise<{ digest: string; entries: readonly string[] }> {
  const worktree = realpathSync(options.worktree)
  const stateDir = realpathSync(options.stateDir)
  if (inside(worktree, stateDir)) throw new Error('worker ignored baseline state must be outside the worktree')
  const path = baselinePath(stateDir, options.taskIndex, options.attempt)
  const existing = readSigned(path, options.key, validBaseline, 'worker ignored baseline')
  if (existing) {
    assertBinding(existing, options)
    const current = await ignoredPathSnapshot(worktree)
    if (current.digest !== existing.digest) throw new Error('worker ignored baseline no longer matches the pre-dispatch worktree')
    await assertBaselinePreserved(worktree, existing, current.entries)
    return { digest: existing.digest, entries: existing.entries.map(entry => entry.fingerprint) }
  }
  const snapshot = await ignoredPathSnapshot(worktree)
  const entries = snapshot.entries.map(fingerprint => {
    const relativePath = entryPath(fingerprint)
    return { path: relativePath, fingerprint, identity: identity(resolve(worktree, relativePath)) }
  })
  const receipt = sign({
    schemaVersion: 1 as const, runId: options.runId, taskKey: options.taskKey,
    taskIndex: options.taskIndex, attempt: options.attempt,
    digest: snapshot.digest, entries, basis: 'recorded' as const,
  }, options.key)
  atomicWriteJson(path, receipt)
  return snapshot
}

/** Preserve only baseline-absent ignored files in authenticated private quarantine; never delete or adopt them. */
export async function reconcileWorkerIgnoredPaths(options: {
  worktree: string
  stateDir: string
  runId: string
  taskKey: string
  taskIndex: number
  attempt: number
  expectedBaselineDigest: string
  expectedTransaction?: IgnoredArtifactTransactionRef
  key: Buffer
  onTransactionPrepared?: (transaction: IgnoredArtifactTransactionRef) => Promise<void>
  afterLegacySnapshot?: () => Promise<void>
  afterLegacyBaselinePersisted?: () => Promise<void>
  afterReceiptPrepared?: () => Promise<void>
  afterEntryQuarantined?: (index: number) => Promise<void>
}): Promise<{ digest: string; quarantine?: string; paths: readonly string[]; resumed: boolean; basis: Baseline['basis'] }> {
  const worktree = realpathSync(options.worktree)
  const stateDir = realpathSync(options.stateDir)
  if (inside(worktree, stateDir)) throw new Error('worker ignored quarantine state must be outside the worktree')
  const baselineFile = baselinePath(stateDir, options.taskIndex, options.attempt)
  const receiptFile = recoveryPath(stateDir, options.taskIndex, options.attempt)
  let baseline = readSigned(baselineFile, options.key, validBaseline, 'worker ignored baseline')
  if (baseline?.basis === 'authenticated-subset-digest' && !options.expectedTransaction && !entryExists(receiptFile)) {
    assertBinding(baseline, options)
    if (baseline.digest !== options.expectedBaselineDigest) {
      throw new Error('worker ignored baseline digest disagrees with authenticated task state')
    }
    try {
      const current = await ignoredPathSnapshot(worktree)
      await assertBaselinePreserved(worktree, baseline, current.entries)
    } catch {
      baseline = undefined
    }
  }
  if (!baseline) {
    const current = await ignoredPathSnapshot(worktree)
    const fingerprints = options.expectedBaselineDigest === EMPTY_IGNORED_PATHS_DIGEST
      ? [] as readonly string[]
      : await inferLegacyBaselineSubset(current.entries, options.expectedBaselineDigest)
    await options.afterLegacySnapshot?.()
    const entries = fingerprints.map(fingerprint => {
      const path = entryPath(fingerprint)
      return { path, fingerprint, identity: identity(resolve(worktree, path)) }
    })
    const inferred = sign({
      schemaVersion: 1 as const, runId: options.runId, taskKey: options.taskKey,
      taskIndex: options.taskIndex, attempt: options.attempt,
      digest: options.expectedBaselineDigest, entries,
      basis: options.expectedBaselineDigest === EMPTY_IGNORED_PATHS_DIGEST
        ? 'authenticated-empty-digest' as const : 'authenticated-subset-digest' as const,
    }, options.key)
    const stable = await ignoredPathSnapshot(worktree)
    if (stable.entries.length !== current.entries.length
      || stable.entries.some((entry, index) => entry !== current.entries[index])) {
      throw new Error('ignored artifacts changed during legacy baseline inference')
    }
    await assertBaselinePreserved(worktree, inferred, stable.entries)
    baseline = inferred
    atomicWriteJson(baselineFile, baseline)
    await options.afterLegacyBaselinePersisted?.()
  }
  if (!baseline) throw new Error('worker ignored baseline could not be established')
  assertBinding(baseline, options)
  if (baseline.digest !== options.expectedBaselineDigest) throw new Error('worker ignored baseline digest disagrees with authenticated task state')

  let recovery = readSigned(receiptFile, options.key, validRecovery, 'worker ignored recovery')
  const resumed = recovery !== undefined
  if (options.expectedTransaction && !recovery) {
    throw new Error('authenticated worker ignored transaction receipt is missing')
  }
  if (recovery) {
    assertBinding(recovery, options)
    if (recovery.baselineDigest !== baseline.digest) throw new Error('worker ignored recovery baseline changed')
    if (options.expectedTransaction) assertTransactionRef(recovery, options.expectedTransaction)
  } else {
    const current = await ignoredPathSnapshot(worktree)
    await assertBaselinePreserved(worktree, baseline, current.entries)
    const baselinePaths = new Set(baseline.entries.map(entry => entry.path))
    const added = current.entries.filter(entry => !baselinePaths.has(entryPath(entry)))
    if (added.length === 0) return { digest: current.digest, paths: [], resumed: false, basis: baseline.basis }
    const transactionId = randomUUID()
    const quarantineRoot = join(stateDir, QUARANTINES, transactionId)
    mkdirSync(quarantineRoot, { recursive: true })
    const canonicalRoot = realpathSync(quarantineRoot)
    if (!inside(stateDir, canonicalRoot)) throw new Error('worker ignored quarantine root escapes private state')
    const entries = added.map(fingerprint => {
      const path = entryPath(fingerprint).replaceAll('\\', '/')
      if (path.startsWith('/') || path.split('/').some(segment => segment === '..' || segment === '')) {
        throw new Error(`worker ignored artifact path is invalid: ${path}`)
      }
      const source = resolve(worktree, path)
      if (!inside(worktree, source) || !samePath(realpathSync(dirname(source)), resolve(dirname(source)))) {
        throw new Error(`worker ignored artifact parent is not one physical in-worktree path: ${path}`)
      }
      if (fingerprintAt(path, source) !== fingerprint) throw new Error(`worker ignored artifact changed during reconciliation: ${path}`)
      const sourceIdentity = identity(source)
      if (sourceIdentity.type !== 'file') throw new Error(`worker ignored artifact quarantine rejects symlinks: ${path}`)
      const quarantine = resolve(canonicalRoot, path)
      if (!inside(canonicalRoot, quarantine)) throw new Error(`worker ignored quarantine path escapes private state: ${path}`)
      mkdirSync(dirname(quarantine), { recursive: true })
      const canonicalDestinationParent = realpathSync(dirname(quarantine))
      if (!samePath(canonicalDestinationParent, resolve(dirname(quarantine)))) {
        throw new Error(`worker ignored quarantine parent is not one physical path: ${path}`)
      }
      const destinationDevice = lstatSync(canonicalDestinationParent, { bigint: true }).dev.toString(10)
      if (sourceIdentity.dev !== destinationDevice) throw new Error('worker ignored artifact quarantine requires one filesystem')
      return { path, fingerprint, source, quarantine, identity: sourceIdentity }
    })
    recovery = sign({
      schemaVersion: 1 as const, transactionId, runId: options.runId, taskKey: options.taskKey,
      taskIndex: options.taskIndex, attempt: options.attempt, baselineDigest: baseline.digest,
      phase: 'prepared' as const, quarantineRoot: canonicalRoot, entries,
    }, options.key)
    atomicWriteJson(receiptFile, recovery)
  }
  const preparedTransaction = transactionRef(recovery)
  if (options.expectedTransaction) assertTransactionRef(recovery, options.expectedTransaction)
  else await options.onTransactionPrepared?.(preparedTransaction)
  if (!resumed) await options.afterReceiptPrepared?.()

  const quarantineRoot = resolve(recovery.quarantineRoot)
  if (!entryExists(quarantineRoot)) throw new Error('worker ignored recovery quarantine root disappeared')
  const canonicalQuarantineRoot = realpathSync(quarantineRoot)
  if (!samePath(canonicalQuarantineRoot, quarantineRoot) || !inside(stateDir, canonicalQuarantineRoot)) {
    throw new Error('worker ignored recovery quarantine root is not one physical private-state directory')
  }
  const preMoveSnapshot = await ignoredPathSnapshot(worktree)
  await assertBaselinePreserved(worktree, baseline, preMoveSnapshot.entries)
  const preMoveEntries = new Map(preMoveSnapshot.entries.map(entry => [entryPath(entry), entry]))
  const authenticatedPaths = new Set([
    ...baseline.entries.map(entry => entry.path),
    ...recovery.entries.map(entry => entry.path),
  ])
  const unauthenticatedAddition = preMoveSnapshot.entries.find(entry => !authenticatedPaths.has(entryPath(entry)))
  if (unauthenticatedAddition) {
    throw new Error(`unplanned ignored artifact appeared during quarantine recovery: ${entryPath(unauthenticatedAddition)}`)
  }
  const moveStates = recovery.entries.map(entry => {
    const source = resolve(entry.source)
    const quarantine = resolve(entry.quarantine)
    if (!inside(worktree, source) || !inside(canonicalQuarantineRoot, quarantine)
      || !samePath(source, resolve(worktree, entry.path))
      || !samePath(quarantine, resolve(canonicalQuarantineRoot, entry.path))) {
      throw new Error('worker ignored recovery receipt paths are invalid')
    }
    const sourceExists = entryExists(source)
    const quarantineExists = entryExists(quarantine)
    if (sourceExists === quarantineExists) throw new Error(`worker ignored recovery has ambiguous path state: ${entry.path}`)
    const sourceParent = resolve(dirname(source))
    const quarantineParent = resolve(dirname(quarantine))
    if (!entryExists(quarantineParent) || !samePath(realpathSync(quarantineParent), quarantineParent)
      || !inside(canonicalQuarantineRoot, quarantineParent)) {
      throw new Error(`worker ignored artifact quarantine parent identity changed: ${entry.path}`)
    }
    if (sourceExists) {
      if (!samePath(realpathSync(sourceParent), sourceParent)) {
        throw new Error(`worker ignored artifact source parent identity changed: ${entry.path}`)
      }
      if (preMoveEntries.get(entry.path) !== entry.fingerprint) {
        throw new Error(`worker ignored recovery source is no longer the authenticated ignored artifact: ${entry.path}`)
      }
      if (!sameIdentity(identity(source), entry.identity) || fingerprintAt(entry.path, source) !== entry.fingerprint) {
        throw new Error(`worker ignored artifact source identity changed: ${entry.path}`)
      }
      const destinationDevice = lstatSync(quarantineParent, { bigint: true }).dev.toString(10)
      if (entry.identity.dev !== destinationDevice) throw new Error('worker ignored artifact quarantine requires one filesystem')
    } else if (!sameIdentity(identity(quarantine), entry.identity) || fingerprintAt(entry.path, quarantine) !== entry.fingerprint) {
      throw new Error(`worker ignored artifact quarantine identity changed: ${entry.path}`)
    }
    return { entry, source, quarantine, sourceExists }
  })
  for (const [index, move] of moveStates.entries()) {
    const { entry, source, quarantine, sourceExists } = move
    if (sourceExists) {
      if (!entryExists(source) || entryExists(quarantine)
        || !samePath(realpathSync(dirname(source)), resolve(dirname(source)))
        || !samePath(realpathSync(dirname(quarantine)), resolve(dirname(quarantine)))
        || !sameIdentity(identity(source), entry.identity)
        || fingerprintAt(entry.path, source) !== entry.fingerprint) {
        throw new Error(`worker ignored artifact changed after complete preflight: ${entry.path}`)
      }
      renameSync(source, quarantine)
      await options.afterEntryQuarantined?.(index)
    }
    if (!sameIdentity(identity(quarantine), entry.identity) || fingerprintAt(entry.path, quarantine) !== entry.fingerprint) {
      throw new Error(`worker ignored artifact quarantine identity changed: ${entry.path}`)
    }
    if (entryExists(source)) throw new Error(`worker ignored artifact reappeared during quarantine: ${entry.path}`)
  }
  if (recovery.phase !== 'quarantined') {
    const unsigned = {
      schemaVersion: recovery.schemaVersion, transactionId: recovery.transactionId,
      runId: recovery.runId, taskKey: recovery.taskKey, taskIndex: recovery.taskIndex,
      attempt: recovery.attempt, baselineDigest: recovery.baselineDigest,
      phase: 'quarantined' as const, quarantineRoot: recovery.quarantineRoot, entries: recovery.entries,
    }
    recovery = sign(unsigned, options.key)
    atomicWriteJson(receiptFile, recovery)
  }
  const finalSnapshot = await ignoredPathSnapshot(worktree)
  await assertBaselinePreserved(worktree, baseline, finalSnapshot.entries)
  const baselinePaths = new Set(baseline.entries.map(entry => entry.path))
  const unexpected = finalSnapshot.entries.find(entry => !baselinePaths.has(entryPath(entry)))
  if (unexpected) throw new Error(`new ignored artifact appeared after authenticated quarantine: ${entryPath(unexpected)}`)
  return {
    digest: finalSnapshot.digest, quarantine: recovery.quarantineRoot,
    paths: recovery.entries.map(entry => entry.path), resumed, basis: baseline.basis,
  }
}
