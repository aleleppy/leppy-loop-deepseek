import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
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

export function acquireLock(commonDir: string, runId: string): () => void {
  const lockDir = join(commonDir, 'leppy-loop')
  mkdirSync(lockDir, { recursive: true })
  const path = join(lockDir, 'active.lock')
  let descriptor: number
  try {
    descriptor = openSync(path, 'wx')
  } catch {
    throw new Error(`another Leppy Loop owns repository lock ${path}`)
  }
  writeFileSync(descriptor, `${JSON.stringify({ runId, pid: process.pid, startedAt: new Date().toISOString() })}\n`)
  closeSync(descriptor)
  return () => { rmSync(path, { force: true }) }
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
