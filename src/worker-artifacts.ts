import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { runFile } from './process.js'
import { scrubEnvironment } from './security.js'
import { atomicWriteJson } from './state.js'

const RECEIPT = 'worker-npm-cache-recovery.json'
const BASELINES = 'worker-artifact-baselines'

type ArtifactIdentity = { dev: string; ino: string; type: 'directory' }
type NpmCacheReceipt = {
  schemaVersion: 1
  transactionId: string
  runId: string
  taskIndex: number
  attempt: number
  phase: 'prepared' | 'quarantined'
  basis: 'baseline-absent' | 'legacy-error-digest'
  source: string
  quarantine: string
  sourceIdentity: ArtifactIdentity
  recoveryErrorDigest: string
  proof: string
}
type NpmCacheBaseline = {
  schemaVersion: 1
  runId: string
  taskIndex: number
  attempt: number
  cacheState: 'absent' | 'present'
  cacheIdentity?: ArtifactIdentity
  proof: string
}

function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

function entryExists(path: string): boolean {
  try { lstatSync(path); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function device(path: string): string {
  return lstatSync(path, { bigint: true }).dev.toString(10)
}

function identity(path: string): ArtifactIdentity {
  const stat = lstatSync(path, { bigint: true })
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('authenticated .npm-cache recovery requires one physical directory')
  return { dev: stat.dev.toString(10), ino: stat.ino.toString(10), type: 'directory' }
}

export function sameArtifactIdentity(left: ArtifactIdentity, right: ArtifactIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.type === right.type
}

function validIdentity(value: unknown): value is ArtifactIdentity {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<ArtifactIdentity>
  return candidate.type === 'directory' && typeof candidate.dev === 'string' && /^\d+$/u.test(candidate.dev)
    && typeof candidate.ino === 'string' && /^\d+$/u.test(candidate.ino)
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

function validReceipt(value: unknown, key: Buffer): value is NpmCacheReceipt {
  if (!value || typeof value !== 'object') return false
  const receipt = value as Partial<NpmCacheReceipt>
  return receipt.schemaVersion === 1 && typeof receipt.transactionId === 'string' && typeof receipt.runId === 'string'
    && Number.isSafeInteger(receipt.taskIndex) && (receipt.taskIndex ?? -1) >= 0
    && Number.isSafeInteger(receipt.attempt) && (receipt.attempt ?? -1) >= 0
    && (receipt.phase === 'prepared' || receipt.phase === 'quarantined')
    && (receipt.basis === 'baseline-absent' || receipt.basis === 'legacy-error-digest')
    && typeof receipt.source === 'string' && typeof receipt.quarantine === 'string'
    && validIdentity(receipt.sourceIdentity) && typeof receipt.recoveryErrorDigest === 'string'
    && /^[a-f0-9]{64}$/u.test(receipt.recoveryErrorDigest)
    && validProof(value as Record<string, unknown>, key)
}

function readReceipt(path: string, key: Buffer): NpmCacheReceipt | undefined {
  if (!entryExists(path)) return undefined
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!validReceipt(parsed, key)) throw new Error('worker npm cache recovery receipt is invalid')
  return parsed
}

function baselinePath(stateDir: string, taskIndex: number, attempt: number): string {
  return join(stateDir, BASELINES, `${taskIndex}-${attempt}.json`)
}

function validBaseline(value: unknown, key: Buffer): value is NpmCacheBaseline {
  if (!value || typeof value !== 'object') return false
  const baseline = value as Partial<NpmCacheBaseline>
  return baseline.schemaVersion === 1 && typeof baseline.runId === 'string'
    && Number.isSafeInteger(baseline.taskIndex) && (baseline.taskIndex ?? -1) >= 0
    && Number.isSafeInteger(baseline.attempt) && (baseline.attempt ?? -1) >= 0
    && (baseline.cacheState === 'absent' || baseline.cacheState === 'present')
    && (baseline.cacheState === 'absent' ? baseline.cacheIdentity === undefined : validIdentity(baseline.cacheIdentity))
    && validProof(value as Record<string, unknown>, key)
}

function readBaseline(stateDir: string, taskIndex: number, attempt: number, key: Buffer): NpmCacheBaseline | undefined {
  const path = baselinePath(stateDir, taskIndex, attempt)
  if (!entryExists(path)) return undefined
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!validBaseline(parsed, key)) throw new Error('worker artifact baseline receipt is invalid')
  return parsed
}

export function recordWorkerNpmCacheBaseline(options: {
  worktree: string
  stateDir: string
  runId: string
  taskIndex: number
  attempt: number
  key: Buffer
}): NpmCacheBaseline {
  const worktree = realpathSync(options.worktree)
  const stateDir = realpathSync(options.stateDir)
  if (inside(worktree, stateDir)) throw new Error('worker artifact baseline must be outside the worktree')
  const existing = readBaseline(stateDir, options.taskIndex, options.attempt, options.key)
  if (existing) {
    if (existing.runId !== options.runId || existing.taskIndex !== options.taskIndex || existing.attempt !== options.attempt) {
      throw new Error('worker artifact baseline belongs to another run or attempt')
    }
    return existing
  }
  const source = join(worktree, '.npm-cache')
  const cacheState: NpmCacheBaseline['cacheState'] = entryExists(source) ? 'present' : 'absent'
  const receipt = sign({
    schemaVersion: 1 as const,
    runId: options.runId,
    taskIndex: options.taskIndex,
    attempt: options.attempt,
    cacheState,
    ...(cacheState === 'present' ? { cacheIdentity: identity(source) } : {}),
  }, options.key)
  atomicWriteJson(baselinePath(stateDir, options.taskIndex, options.attempt), receipt)
  return receipt
}

async function git(worktree: string, args: readonly string[]): Promise<string> {
  const result = await runFile('git', args, { cwd: worktree, env: scrubEnvironment(process.env), allowFailure: true })
  if (result.exitCode !== 0) throw new Error(`cannot authenticate .npm-cache state: ${result.stderr}`)
  return result.stdout
}

async function proveEntirelyUntracked(worktree: string): Promise<void> {
  const tracked = await git(worktree, ['ls-files', '-z', '--', '.npm-cache'])
  const staged = await git(worktree, ['diff', '--cached', '--name-only', '-z', '--', '.npm-cache'])
  const unstaged = await git(worktree, ['diff', '--name-only', '-z', '--', '.npm-cache'])
  if (tracked || staged || unstaged) throw new Error('.npm-cache contains tracked or staged work and cannot be quarantined')
  const status = await git(worktree, ['status', '--porcelain=v1', '-z', '--untracked-files=normal', '--', '.npm-cache'])
  const entries = status.split('\0').filter(Boolean)
  if (entries.length !== 1 || !entries[0]!.startsWith('?? ')) throw new Error('.npm-cache is not one wholly untracked artifact directory')
  const path = entries[0]!.slice(3).replaceAll('\\', '/').replace(/\/$/u, '')
  if (path !== '.npm-cache') throw new Error(`unexpected untracked cache path: ${path}`)
}

export function workerNpmCacheRecovery(detail: string | undefined): boolean {
  return typeof detail === 'string'
    && /\bnpx\b/iu.test(detail)
    && /(?:^|[^a-z0-9._-])\.npm-cache(?:[\\/]|\b)/iu.test(detail)
    && /(?:leppy_commit|outside[^\r\n]{0,80}(?:scope|escopo))/iu.test(detail)
}

export function workerNpmCacheTransactionPresent(stateDir: string): boolean {
  return entryExists(join(stateDir, RECEIPT))
}

/** Move a proven worker-generated cache aside under the authenticated repository lock; never delete or restore it. */
export async function quarantineWorkerNpmCache(options: {
  worktree: string
  stateDir: string
  runId: string
  taskIndex?: number
  attempt?: number
  recoveryErrorDigest?: string
  allowLegacyDigest: boolean
  key: Buffer
  afterReceiptPrepared?: () => Promise<void>
  afterQuarantinePublish?: () => Promise<void>
  stateDeviceOverride?: string
}): Promise<{ quarantine: string; transactionId: string; resumed: boolean; basis: NpmCacheReceipt['basis'] }> {
  const worktree = realpathSync(options.worktree)
  const stateDir = realpathSync(options.stateDir)
  if (inside(worktree, stateDir)) throw new Error('worker artifact quarantine must be outside the worktree')
  const source = join(worktree, '.npm-cache')
  const receiptPath = join(stateDir, RECEIPT)
  let receipt = readReceipt(receiptPath, options.key)
  const resumed = receipt !== undefined
  let preparedNow = false

  if (receipt && receipt.runId !== options.runId) throw new Error('worker npm cache recovery receipt belongs to another run')
  if (receipt?.phase === 'quarantined') {
    if (entryExists(source)) throw new Error('a new .npm-cache appeared after the authenticated quarantine')
    if (!entryExists(receipt.quarantine) || !sameArtifactIdentity(identity(receipt.quarantine), receipt.sourceIdentity)) {
      throw new Error('the authenticated .npm-cache quarantine identity changed')
    }
    return { quarantine: receipt.quarantine, transactionId: receipt.transactionId, resumed, basis: receipt.basis }
  }

  if (!receipt) {
    if (!Number.isSafeInteger(options.taskIndex) || (options.taskIndex ?? -1) < 0
      || !Number.isSafeInteger(options.attempt) || (options.attempt ?? -1) < 0) {
      throw new Error('new worker npm cache recovery requires authenticated task and attempt provenance')
    }
    const taskIndex = options.taskIndex!
    const attempt = options.attempt!
    if (!options.recoveryErrorDigest || !/^[a-f0-9]{64}$/u.test(options.recoveryErrorDigest)) {
      throw new Error('new worker npm cache recovery requires an authenticated error digest')
    }
    const baseline = readBaseline(stateDir, taskIndex, attempt, options.key)
    if (baseline && (baseline.runId !== options.runId || baseline.taskIndex !== taskIndex || baseline.attempt !== attempt)) {
      throw new Error('worker artifact baseline belongs to another run or attempt')
    }
    if (baseline?.cacheState === 'present') throw new Error('signed pre-attempt baseline proves .npm-cache was already present')
    const baselineAbsent = baseline?.cacheState === 'absent'
    if (!baselineAbsent && !options.allowLegacyDigest) throw new Error('worker npm cache recovery lacks a pre-attempt absence receipt')
    if (!entryExists(source)) throw new Error('authenticated .npm-cache recovery target disappeared')
    await proveEntirelyUntracked(worktree)
    const sourceIdentity = identity(source)
    const transactionId = randomUUID()
    const quarantine = join(stateDir, 'worker-artifact-quarantine', `${transactionId}-npm-cache`)
    mkdirSync(dirname(quarantine), { recursive: true })
    const canonicalQuarantineParent = realpathSync(dirname(quarantine))
    if (!inside(stateDir, canonicalQuarantineParent)) throw new Error('worker npm cache quarantine parent escapes artifact state')
    const destinationDevice = options.stateDeviceOverride ?? device(canonicalQuarantineParent)
    if (!/^\d+$/u.test(destinationDevice) || sourceIdentity.dev !== destinationDevice) {
      throw new Error('worker npm cache quarantine requires source and artifact state on the same filesystem')
    }
    receipt = sign({
      schemaVersion: 1 as const,
      transactionId,
      runId: options.runId,
      taskIndex,
      attempt,
      phase: 'prepared' as const,
      basis: baselineAbsent ? 'baseline-absent' as const : 'legacy-error-digest' as const,
      source,
      quarantine,
      sourceIdentity,
      recoveryErrorDigest: options.recoveryErrorDigest,
    }, options.key)
    atomicWriteJson(receiptPath, receipt)
    preparedNow = true
  }
  if (preparedNow) await options.afterReceiptPrepared?.()

  const canonicalQuarantineParent = realpathSync(dirname(receipt.quarantine))
  if (!inside(stateDir, canonicalQuarantineParent) || resolve(receipt.source) !== source) {
    throw new Error('worker npm cache recovery receipt paths are invalid')
  }
  const sourceExists = entryExists(source)
  const quarantineExists = entryExists(receipt.quarantine)
  if (sourceExists === quarantineExists) throw new Error('worker npm cache recovery transaction has an ambiguous filesystem state')
  if (sourceExists) {
    if (!sameArtifactIdentity(identity(source), receipt.sourceIdentity)) throw new Error('worker npm cache recovery source identity changed')
    renameSync(source, receipt.quarantine)
    await options.afterQuarantinePublish?.()
  }
  if (!entryExists(receipt.quarantine) || !sameArtifactIdentity(identity(receipt.quarantine), receipt.sourceIdentity)) {
    throw new Error('worker npm cache quarantine publication identity changed')
  }
  if (entryExists(source)) throw new Error('a new .npm-cache appeared before quarantine completion')
  receipt = sign({
    schemaVersion: receipt.schemaVersion,
    transactionId: receipt.transactionId,
    runId: receipt.runId,
    taskIndex: receipt.taskIndex,
    attempt: receipt.attempt,
    phase: 'quarantined' as const,
    basis: receipt.basis,
    source: receipt.source,
    quarantine: receipt.quarantine,
    sourceIdentity: receipt.sourceIdentity,
    recoveryErrorDigest: receipt.recoveryErrorDigest,
  }, options.key)
  atomicWriteJson(receiptPath, receipt)
  return { quarantine: receipt.quarantine, transactionId: receipt.transactionId, resumed, basis: receipt.basis }
}
