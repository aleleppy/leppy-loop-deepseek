import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import type { SpawnOptions } from 'node:child_process'

const execFileAsync = promisify(execFile)

export interface CommandResult {
  stdout: string
  stderr: string
  exitCode: number
}

export async function runFile(file: string, args: readonly string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; allowFailure?: boolean; signal?: AbortSignal | undefined } = {}): Promise<CommandResult> {
  try {
    const result = await execFileAsync(file, [...args], {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeoutMs,
      signal: options.signal,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      encoding: 'utf8',
    })
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 }
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string; code?: number | string }
    const exitCode = typeof failure.code === 'number' ? failure.code : 1
    if (!options.allowFailure) throw new Error(`${file} ${args.join(' ')} failed (${exitCode}): ${(failure.stderr ?? failure.message).trim()}`)
    return { stdout: failure.stdout ?? '', stderr: failure.stderr ?? failure.message, exitCode }
  }
}

function signalError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason
  return new Error(typeof signal.reason === 'string' ? signal.reason : 'command aborted')
}

function terminateProcessTree(pid: number, fallback: () => void): void {
  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      shell: false,
      stdio: 'ignore',
    })
    killer.once('error', fallback)
    return
  }
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    fallback()
  }
}

export async function runOpaqueShell(command: string, cwd: string, signal: AbortSignal, env?: NodeJS.ProcessEnv): Promise<CommandResult> {
  if (signal.aborted) throw signalError(signal)
  const file = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : '/bin/sh'
  const args = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command]
  return await new Promise((resolvePromise, reject) => {
    const options: SpawnOptions = {
      cwd,
      env,
      windowsHide: true,
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    }
    const child = spawn(file, args, options)
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout?.on('data', chunk => stdout.push(Buffer.from(chunk)))
    child.stderr?.on('data', chunk => stderr.push(Buffer.from(chunk)))
    const abort = (): void => {
      if (child.pid !== undefined) terminateProcessTree(child.pid, () => { child.kill('SIGTERM') })
      else child.kill('SIGTERM')
    }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    child.once('error', error => {
      signal.removeEventListener('abort', abort)
      reject(error)
    })
    child.once('close', code => {
      signal.removeEventListener('abort', abort)
      if (signal.aborted) {
        reject(signalError(signal))
        return
      }
      resolvePromise({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), exitCode: code ?? 1 })
    })
  })
}
