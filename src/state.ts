import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { RunEvent } from './types.js'
import { redact } from './security.js'
import { runFile } from './process.js'

export interface LeasePayload {
  schemaVersion: 1
  runId: string
  taskIndex: number
  attempt: number
  pid: number
  processStart: string
  heartbeat: string
}

export interface SignedLease { payload: LeasePayload; signature: string }

interface RepositoryLockPayload {
  schemaVersion: 1
  runId: string
  pid: number
  processStart: string
  token: string
  startedAt: string
}

export function atomicWriteJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(temporary, `${JSON.stringify(redact(value), null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
  renameSync(temporary, path)
}

export function appendEvent(path: string, event: RunEvent, knownSecrets: readonly string[] = []): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(redact(event, knownSecrets))}\n`, { encoding: 'utf8', flag: 'a' })
}

interface LockObservation {
  raw: string
  mtimeMs: number
  payload?: RepositoryLockPayload
}

function readLock(path: string): LockObservation | undefined {
  let raw: string
  let mtimeMs: number
  try {
    raw = readFileSync(path, 'utf8')
    mtimeMs = statSync(path).mtimeMs
  } catch { return undefined }
  try {
    const value = JSON.parse(raw) as Partial<RepositoryLockPayload>
    const payload = value.schemaVersion === 1
      && typeof value.runId === 'string'
      && Number.isSafeInteger(value.pid) && (value.pid ?? 0) > 0
      && typeof value.processStart === 'string'
      && typeof value.token === 'string'
      && typeof value.startedAt === 'string'
      ? value as RepositoryLockPayload
      : undefined
    return { raw, mtimeMs, ...(payload ? { payload } : {}) }
  } catch { return { raw, mtimeMs } }
}

function processExists(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

async function lockOwnerIsLive(lock: LockObservation | undefined): Promise<boolean> {
  const owner = lock?.payload
  if (!owner) {
    if (!lock || Date.now() - lock.mtimeMs < 30_000) return true
    try {
      const legacy = JSON.parse(lock.raw) as { pid?: unknown }
      return typeof legacy.pid === 'number' && processExists(legacy.pid)
    } catch { return false }
  }
  const identity = await processIdentity(owner.pid)
  if (identity !== undefined) return identity === owner.processStart
  return processExists(owner.pid)
}

function writeExclusiveLock(path: string, payload: RepositoryLockPayload): void {
  const descriptor = openSync(path, 'wx')
  try { writeFileSync(descriptor, `${JSON.stringify(payload)}\n`) }
  catch (error) { rmSync(path, { force: true }); throw error }
  finally { closeSync(descriptor) }
}

export async function acquireLock(commonDir: string, runId: string): Promise<() => void> {
  const lockDir = join(commonDir, 'leppy-loop')
  mkdirSync(lockDir, { recursive: true })
  const path = join(lockDir, 'active.lock')
  const reclaimPath = join(lockDir, 'active.reclaim')
  const processStart = await processIdentity(process.pid) ?? String(Date.now() - Math.floor(process.uptime() * 1000))
  const payload: RepositoryLockPayload = {
    schemaVersion: 1,
    runId,
    pid: process.pid,
    processStart,
    token: randomBytes(16).toString('hex'),
    startedAt: new Date().toISOString(),
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const reclaim = readLock(reclaimPath)
    if (reclaim) {
      if (await lockOwnerIsLive(reclaim)) throw new Error(`another Leppy Loop is reclaiming repository lock ${path}`)
      if (readLock(reclaimPath)?.raw === reclaim.raw) rmSync(reclaimPath, { force: true })
      continue
    }
    try {
      writeExclusiveLock(path, payload)
      return () => {
        const current = readLock(path)?.payload
        if (current?.token === payload.token) rmSync(path, { force: true })
      }
    } catch {
      const observed = readLock(path)
      if (!observed || await lockOwnerIsLive(observed)) throw new Error(`another Leppy Loop owns repository lock ${path}`)
      try { writeExclusiveLock(reclaimPath, payload) } catch { continue }
      try {
        const current = readLock(path)
        if (!current || current.raw !== observed.raw) continue
        rmSync(path, { force: true })
        writeExclusiveLock(path, payload)
        return () => {
          const held = readLock(path)?.payload
          if (held?.token === payload.token) rmSync(path, { force: true })
        }
      } finally {
        const held = readLock(reclaimPath)?.payload
        if (held?.token === payload.token) rmSync(reclaimPath, { force: true })
      }
    }
  }
  throw new Error(`another Leppy Loop owns repository lock ${path}`)
}

export function createLeaseKey(stateDir: string): Buffer {
  const path = join(stateDir, 'lease.key')
  if (existsSync(path)) return Buffer.from(readFileSync(path, 'utf8').trim(), 'base64')
  const key = randomBytes(32)
  writeFileSync(path, key.toString('base64'), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  return key
}

function canonicalPayload(payload: LeasePayload): string {
  return JSON.stringify(payload)
}

export function signLease(payload: LeasePayload, key: Buffer): SignedLease {
  return { payload, signature: createHmac('sha256', key).update(canonicalPayload(payload)).digest('base64url') }
}

export function verifyLease(lease: SignedLease, key: Buffer): boolean {
  const expected = Buffer.from(createHmac('sha256', key).update(canonicalPayload(lease.payload)).digest('base64url'))
  const actual = Buffer.from(lease.signature)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export async function processIdentity(pid: number): Promise<string | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      return stat.split(' ')[21]
    } catch { return undefined }
  }
  if (process.platform === 'win32') {
    const script = `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`
    const result = await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { allowFailure: true })
    return result.exitCode === 0 ? result.stdout.trim() : undefined
  }
  const result = await runFile('ps', ['-o', 'lstart=', '-p', String(pid)], { allowFailure: true })
  return result.exitCode === 0 ? result.stdout.trim() : undefined
}

export function statePath(base: string, runId: string): string {
  return resolve(base, runId)
}
