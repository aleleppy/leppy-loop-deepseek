import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { createReadStream, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readlinkSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { ignoredPathSnapshot } from './git.js'
import { runFile, runFileBuffer } from './process.js'
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
const LEGACY_PROMOTION_MAX_CONTENT_BYTES = 512 * 1024 * 1024
const LEGACY_BASE_IGNORE_MAX_FILES = 128
const LEGACY_BASE_IGNORE_MAX_BYTES = 1024 * 1024

function canonicalGitPath(path: string, label: string): string {
  if (process.platform === 'win32' && path.includes('\\')) {
    throw new Error(`${label} contains a Windows-noncanonical backslash path`)
  }
  return path
}

function binaryNulRecords(output: Buffer, label: string): string[] {
  const records: string[] = []
  let start = 0
  for (let index = 0; index <= output.length; index += 1) {
    if (index < output.length && output[index] !== 0) continue
    if (index > start) {
      const bytes = output.subarray(start, index)
      const decoded = bytes.toString('utf8')
      if (!Buffer.from(decoded, 'utf8').equals(bytes)) throw new Error(`${label} contains a non-UTF-8 path`)
      records.push(decoded)
    }
    start = index + 1
  }
  return records
}

export const EMPTY_IGNORED_PATHS_DIGEST = createHash('sha256').update(JSON.stringify([])).digest('hex')
const LEGACY_BASELINE_MISSING_DETAIL = 'worker ignored artifact recovery lacks its authenticated pre-attempt baseline'
const LEGACY_SUBSET_THREE_ADDITION_DETAIL = 'worker ignored artifact recovery cannot prove its legacy non-empty baseline from current fingerprints'
const LEGACY_SUBSET_FOUR_DETAIL = new RegExp(`^${LEGACY_SUBSET_THREE_ADDITION_DETAIL} within 4 additions and ([0-9]+) candidates$`, 'u')
const LEGACY_TRACKED_PROMOTION_DETAIL = new RegExp(`^${LEGACY_SUBSET_THREE_ADDITION_DETAIL} after exact newly tracked promotion inference within 4 additions and ([0-9]+) candidates$`, 'u')
const LEGACY_SUBSET_FOUR_TERMINAL_CANDIDATES = new Set(Array.from({ length: 40 }, (_value, entries) => {
  let total = 0
  let combinations = 1
  for (let additions = 1; additions <= Math.min(4, entries); additions += 1) {
    combinations = combinations * (entries - additions + 1) / additions
    total += combinations
  }
  return total
}))

/** One bounded capability transition from a superseded legacy recovery failure. */
export function workerIgnoredBaselineRecovery(detail: string | undefined): boolean {
  const normalized = detail?.trim()
  if (normalized === LEGACY_BASELINE_MISSING_DETAIL || normalized === LEGACY_SUBSET_THREE_ADDITION_DETAIL) return true
  const fourAddition = normalized?.match(LEGACY_SUBSET_FOUR_DETAIL)
    ?? normalized?.match(LEGACY_TRACKED_PROMOTION_DETAIL)
  if (!fourAddition) return false
  const candidates = Number(fourAddition[1])
  return Number.isSafeInteger(candidates) && fourAddition[1] === String(candidates)
    && LEGACY_SUBSET_FOUR_TERMINAL_CANDIDATES.has(candidates)
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

async function inferLegacyBaselineSubset(
  entries: readonly string[], expectedDigest: string,
  inference: 'ignored-only' | 'tracked-promotion' | 'base-ignore' = 'ignored-only',
): Promise<readonly string[]> {
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
    const capability = inference === 'base-ignore'
      ? ' after exact tracked-promotion and base-ignore inference'
      : inference === 'tracked-promotion' ? ' after exact newly tracked promotion inference' : ''
    throw new Error(`worker ignored artifact recovery cannot prove its legacy non-empty baseline from current fingerprints${capability} within ${maxAdditions} additions and ${examined} candidates`)
  }
  return match
}

async function boundedFingerprintAt(path: string, absolute: string, budget: { bytes: number }): Promise<string> {
  const stat = lstatSync(absolute)
  if (stat.isSymbolicLink()) return `${path}\0link\0${readlinkSync(absolute)}`
  if (!stat.isFile()) return `${path}\0${stat.isDirectory() ? 'directory' : 'special'}\0${stat.mode}`
  const before = budget.bytes
  budget.bytes += stat.size
  if (budget.bytes > LEGACY_PROMOTION_MAX_CONTENT_BYTES) {
    throw new Error('worker ignored artifact fingerprinting exceeds 512 MiB of file content')
  }
  const hash = createHash('sha256')
  let bytes = 0
  for await (const chunk of createReadStream(absolute)) {
    const buffer = Buffer.from(chunk)
    bytes += buffer.length
    if (before + bytes > LEGACY_PROMOTION_MAX_CONTENT_BYTES) {
      throw new Error('worker ignored artifact fingerprinting exceeds 512 MiB of file content')
    }
    hash.update(buffer)
  }
  if (bytes !== stat.size) throw new Error(`newly tracked ignored-path candidate changed while hashing: ${path}`)
  return `${path}\0file\0${stat.size}\0${hash.digest('hex')}`
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

async function boundedLegacyCandidateFingerprints(worktree: string, paths: readonly string[]): Promise<readonly string[]> {
  const budget = { bytes: 0 }
  const fingerprints: string[] = []
  for (const path of paths) {
    if (path.startsWith('/') || path.split('/').some(segment => segment === '..' || segment === '')) {
      throw new Error(`legacy ignored-path candidate is invalid: ${path}`)
    }
    const absolute = resolve(worktree, path)
    if (!inside(worktree, absolute)) throw new Error(`legacy ignored-path candidate escapes worktree: ${path}`)
    fingerprints.push(await boundedFingerprintAt(path, absolute, budget))
  }
  return fingerprints
}

async function newlyTrackedIgnoredFingerprints(worktree: string, baseHead: string): Promise<readonly string[]> {
  if (!/^[0-9a-f]{40,64}$/u.test(baseHead)) throw new Error('legacy ignored promotion base HEAD is invalid')
  const addedResult = await runFileBuffer('git', [
    'diff', '--name-only', '--diff-filter=A', '-z', `${baseHead}..HEAD`, '--',
  ], { cwd: worktree, env: scrubEnvironment(process.env) })
  const added = [...new Set(binaryNulRecords(addedResult, 'legacy ignored promotion tree')
    .map(path => canonicalGitPath(path, 'legacy ignored promotion tree')))].sort()
  if (added.length > LEGACY_SUBSET_MAX_ENTRIES) {
    throw new Error(`legacy ignored promotion inference exceeds ${LEGACY_SUBSET_MAX_ENTRIES} newly tracked paths`)
  }
  const ignored: string[] = []
  for (const path of added) {
    const result = await runFile('git', [
      'check-ignore', '--no-index', '--', path,
    ], { cwd: worktree, env: scrubEnvironment(process.env), allowFailure: true })
    if (result.exitCode !== 0 && result.exitCode !== 1) {
      throw new Error(`cannot authenticate newly tracked ignored-path candidate: ${result.stderr}`)
    }
    if (result.exitCode === 0) ignored.push(path)
  }
  return await boundedLegacyCandidateFingerprints(worktree, ignored)
}

async function baseIgnoredCurrentUntrackedFingerprints(worktree: string, baseHead: string): Promise<readonly string[]> {
  if (!/^[0-9a-f]{40,64}$/u.test(baseHead)) throw new Error('legacy base-ignore HEAD is invalid')
  const untrackedResult = await runFileBuffer('git', [
    'ls-files', '--others', '--exclude-standard', '-z', '--', '.',
    ':(exclude,glob)**/node_modules/**', ':(exclude,glob).npm-cache/**', ':(exclude,glob)**/.npm-cache/**',
  ], { cwd: worktree, env: scrubEnvironment(process.env) })
  const untracked = [...new Set(binaryNulRecords(untrackedResult, 'legacy base-ignore untracked state')
    .map(path => canonicalGitPath(path, 'legacy base-ignore untracked state')))].sort()
  if (untracked.length > LEGACY_SUBSET_MAX_ENTRIES) {
    throw new Error(`legacy base-ignore inference exceeds ${LEGACY_SUBSET_MAX_ENTRIES} current untracked paths`)
  }
  const ignoreList = await runFileBuffer('git', [
    'ls-tree', '-r', '-z', baseHead,
  ], { cwd: worktree, env: scrubEnvironment(process.env) })
  const ignoreEntries: Array<{ objectId: string; path: string }> = []
  for (const record of binaryNulRecords(ignoreList, 'legacy base-ignore tree')) {
    const separator = record.indexOf('\t')
    if (separator < 0) throw new Error('legacy base-ignore tree record is malformed')
    const metadata = record.slice(0, separator).match(/^([0-9]{6}) (blob|tree|commit) ([0-9a-f]{40,64})$/u)
    if (!metadata) throw new Error('legacy base-ignore tree metadata is malformed')
    const path = canonicalGitPath(record.slice(separator + 1), 'legacy base-ignore tree')
    if (path !== '.gitignore' && !path.endsWith('/.gitignore')) continue
    if (metadata[1] !== '100644' && metadata[1] !== '100755') continue
    if (metadata[2] !== 'blob') throw new Error(`legacy base-ignore regular entry is not a blob: ${path}`)
    ignoreEntries.push({ objectId: metadata[3]!, path })
  }
  ignoreEntries.sort((left, right) => left.path.localeCompare(right.path))
  if (ignoreEntries.length > LEGACY_BASE_IGNORE_MAX_FILES) {
    throw new Error(`legacy base-ignore inference exceeds ${LEGACY_BASE_IGNORE_MAX_FILES} ignore files`)
  }
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'leppy-base-ignore-')))
  const baseEnvironment = {
    ...scrubEnvironment(process.env), GIT_INDEX_FILE: join(scratch, 'base.index'),
  }
  try {
    await runFile('git', ['read-tree', baseHead], { cwd: worktree, env: baseEnvironment })
    let ignoreBytes = 0
    for (const entry of ignoreEntries) {
      const { path } = entry
      if (path.startsWith('/') || path.split('/').some(segment => segment === '..' || segment === '')
        || (path !== '.gitignore' && !path.endsWith('/.gitignore'))) {
        throw new Error(`legacy base-ignore path is invalid: ${path}`)
      }
      const attributes = await runFile('git', [
        'check-attr', '-z', '--cached', 'filter', 'working-tree-encoding', 'ident', '--', path,
      ], { cwd: worktree, env: baseEnvironment })
      const attributeFields = attributes.stdout.split('\0').filter(Boolean)
      if (attributeFields.length % 3 !== 0) throw new Error(`legacy base-ignore attributes are malformed: ${path}`)
      for (let index = 0; index < attributeFields.length; index += 3) {
        const value = attributeFields[index + 2]
        if (value !== 'unspecified' && value !== 'unset') {
          throw new Error(`legacy base-ignore entry uses a checkout-transforming attribute: ${path}`)
        }
      }
      const source = await runFileBuffer('git', ['cat-file', 'blob', entry.objectId], {
        cwd: worktree, env: scrubEnvironment(process.env),
      })
      ignoreBytes += source.length
      if (ignoreBytes > LEGACY_BASE_IGNORE_MAX_BYTES) {
        throw new Error('legacy base-ignore inference exceeds 1 MiB of ignore rules')
      }
      const target = resolve(scratch, path)
      if (!inside(scratch, target)) throw new Error(`legacy base-ignore path escapes scratch root: ${path}`)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, source)
    }
    const baseIgnored: string[] = []
    for (const path of untracked) {
      const result = await runFile('git', [
        `--work-tree=${scratch}`, 'check-ignore', '--no-index', '--', path,
      ], { cwd: worktree, env: baseEnvironment, allowFailure: true })
      if (result.exitCode !== 0 && result.exitCode !== 1) {
        throw new Error(`cannot authenticate base-ignored candidate: ${result.stderr}`)
      }
      if (result.exitCode === 0) baseIgnored.push(path)
    }
    return await boundedLegacyCandidateFingerprints(worktree, baseIgnored)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

async function legacyRecoverySnapshot(worktree: string, baseHead: string | undefined): Promise<{ entries: readonly string[]; digest: string }> {
  const ignored = await ignoredPathSnapshot(worktree)
  const deignored = baseHead ? await baseIgnoredCurrentUntrackedFingerprints(worktree, baseHead) : []
  const entries = [...ignored.entries, ...deignored].sort()
  return { entries, digest: createHash('sha256').update(JSON.stringify(entries)).digest('hex') }
}

async function trackedPaths(worktree: string, paths: readonly string[]): Promise<Set<string>> {
  const tracked = new Set<string>()
  for (let offset = 0; offset < paths.length; offset += 100) {
    const chunk = paths.slice(offset, offset + 100)
    const result = await runFileBuffer('git', ['ls-files', '-z', '--', ...chunk.map(path => `:(literal)${path}`)], {
      cwd: worktree, env: scrubEnvironment(process.env),
    })
    for (const path of binaryNulRecords(result, 'tracked ignored-path adoption')) {
      tracked.add(canonicalGitPath(path, 'tracked ignored-path adoption'))
    }
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
  if (baseline.basis === 'authenticated-subset-digest') {
    const missingSet = new Set(missing)
    const budget = { bytes: 0 }
    for (const entry of baseline.entries) {
      if (!missingSet.has(entry.path)) continue
      const absolute = resolve(worktree, entry.path)
      if (await boundedFingerprintAt(entry.path, absolute, budget) !== entry.fingerprint
        || !sameIdentity(identity(absolute), entry.identity)) {
        throw new Error(`inferred legacy ignored artifact changed outside ignored baseline: ${entry.path}`)
      }
    }
    return
  }
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
  /** Authenticated pre-attempt HEAD; only exact newly tracked ignored paths may augment legacy inference. */
  legacyBaseHead?: string
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
    const promoted = options.expectedBaselineDigest !== EMPTY_IGNORED_PATHS_DIGEST && options.legacyBaseHead
      ? await newlyTrackedIgnoredFingerprints(worktree, options.legacyBaseHead)
      : []
    const deignored = options.expectedBaselineDigest !== EMPTY_IGNORED_PATHS_DIGEST && options.legacyBaseHead
      ? await baseIgnoredCurrentUntrackedFingerprints(worktree, options.legacyBaseHead)
      : []
    const candidates = [...current.entries, ...promoted, ...deignored].sort()
    const fingerprints = options.expectedBaselineDigest === EMPTY_IGNORED_PATHS_DIGEST
      ? [] as readonly string[]
      : await inferLegacyBaselineSubset(candidates, options.expectedBaselineDigest, 'base-ignore')
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
    const stablePromoted = options.expectedBaselineDigest !== EMPTY_IGNORED_PATHS_DIGEST && options.legacyBaseHead
      ? await newlyTrackedIgnoredFingerprints(worktree, options.legacyBaseHead)
      : []
    const stableDeignored = options.expectedBaselineDigest !== EMPTY_IGNORED_PATHS_DIGEST && options.legacyBaseHead
      ? await baseIgnoredCurrentUntrackedFingerprints(worktree, options.legacyBaseHead)
      : []
    const stableCandidates = [...stable.entries, ...stablePromoted, ...stableDeignored].sort()
    if (stableCandidates.length !== candidates.length
      || stableCandidates.some((entry, index) => entry !== candidates[index])) {
      throw new Error('ignored artifacts, tracked promotions, or base-ignored paths changed during legacy baseline inference')
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
    const current = await legacyRecoverySnapshot(worktree, options.legacyBaseHead)
    await assertBaselinePreserved(worktree, baseline, current.entries)
    const baselinePaths = new Set(baseline.entries.map(entry => entry.path))
    const added = current.entries.filter(entry => !baselinePaths.has(entryPath(entry)))
    if (added.length === 0) return { digest: current.digest, paths: [], resumed: false, basis: baseline.basis }
    const transactionId = randomUUID()
    const quarantineRoot = join(stateDir, QUARANTINES, transactionId)
    mkdirSync(quarantineRoot, { recursive: true })
    const canonicalRoot = realpathSync(quarantineRoot)
    if (!inside(stateDir, canonicalRoot)) throw new Error('worker ignored quarantine root escapes private state')
    const entries: Array<{ path: string; fingerprint: string; source: string; quarantine: string; identity: ArtifactIdentity }> = []
    const reconciliationBudget = { bytes: 0 }
    for (const fingerprint of added) {
      const path = canonicalGitPath(entryPath(fingerprint), 'worker ignored quarantine entry')
      if (path.startsWith('/') || path.split('/').some(segment => segment === '..' || segment === '')) {
        throw new Error(`worker ignored artifact path is invalid: ${path}`)
      }
      const source = resolve(worktree, path)
      if (!inside(worktree, source) || !samePath(realpathSync(dirname(source)), resolve(dirname(source)))) {
        throw new Error(`worker ignored artifact parent is not one physical in-worktree path: ${path}`)
      }
      if (await boundedFingerprintAt(path, source, reconciliationBudget) !== fingerprint) {
        throw new Error(`worker ignored artifact changed during reconciliation: ${path}`)
      }
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
      entries.push({ path, fingerprint, source, quarantine, identity: sourceIdentity })
    }
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
  const preMoveSnapshot = await legacyRecoverySnapshot(worktree, options.legacyBaseHead)
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
  const moveStates: Array<{ entry: Recovery['entries'][number]; source: string; quarantine: string; sourceExists: boolean }> = []
  const preflightSourceBudget = { bytes: 0 }
  const preflightQuarantineBudget = { bytes: 0 }
  for (const entry of recovery.entries) {
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
      if (!sameIdentity(identity(source), entry.identity)
        || await boundedFingerprintAt(entry.path, source, preflightSourceBudget) !== entry.fingerprint) {
        throw new Error(`worker ignored artifact source identity changed: ${entry.path}`)
      }
      const destinationDevice = lstatSync(quarantineParent, { bigint: true }).dev.toString(10)
      if (entry.identity.dev !== destinationDevice) throw new Error('worker ignored artifact quarantine requires one filesystem')
    } else if (!sameIdentity(identity(quarantine), entry.identity)
      || await boundedFingerprintAt(entry.path, quarantine, preflightQuarantineBudget) !== entry.fingerprint) {
      throw new Error(`worker ignored artifact quarantine identity changed: ${entry.path}`)
    }
    moveStates.push({ entry, source, quarantine, sourceExists })
  }
  const moveSourceBudget = { bytes: 0 }
  const finalQuarantineBudget = { bytes: 0 }
  for (const [index, move] of moveStates.entries()) {
    const { entry, source, quarantine, sourceExists } = move
    if (sourceExists) {
      if (!entryExists(source) || entryExists(quarantine)
        || !samePath(realpathSync(dirname(source)), resolve(dirname(source)))
        || !samePath(realpathSync(dirname(quarantine)), resolve(dirname(quarantine)))
        || !sameIdentity(identity(source), entry.identity)) {
        throw new Error(`worker ignored artifact changed after complete preflight: ${entry.path}`)
      }
      if (await boundedFingerprintAt(entry.path, source, moveSourceBudget) !== entry.fingerprint) {
        throw new Error(`worker ignored artifact changed after complete preflight: ${entry.path}`)
      }
      renameSync(source, quarantine)
      await options.afterEntryQuarantined?.(index)
    }
    if (!sameIdentity(identity(quarantine), entry.identity)
      || await boundedFingerprintAt(entry.path, quarantine, finalQuarantineBudget) !== entry.fingerprint) {
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
  const finalSnapshot = await legacyRecoverySnapshot(worktree, options.legacyBaseHead)
  await assertBaselinePreserved(worktree, baseline, finalSnapshot.entries)
  const baselinePaths = new Set(baseline.entries.map(entry => entry.path))
  const unexpected = finalSnapshot.entries.find(entry => !baselinePaths.has(entryPath(entry)))
  if (unexpected) throw new Error(`new ignored artifact appeared after authenticated quarantine: ${entryPath(unexpected)}`)
  return {
    digest: finalSnapshot.digest, quarantine: recovery.quarantineRoot,
    paths: recovery.entries.map(entry => entry.path), resumed, basis: baseline.basis,
  }
}
