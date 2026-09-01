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

/** Execute without text decoding when protocol bytes are authority-bearing. */
export async function runFileBuffer(file: string, args: readonly string[], options: {
  cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; signal?: AbortSignal | undefined
} = {}): Promise<Buffer> {
  return await new Promise((resolvePromise, reject) => {
    execFile(file, [...args], {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeoutMs,
      signal: options.signal,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      encoding: null,
    }, (error, stdout, stderr) => {
      const output = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout)
      if (!error) {
        resolvePromise(output)
        return
      }
      const diagnostic = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : stderr
      reject(new Error(`${file} ${args.join(' ')} failed: ${(diagnostic || error.message).trim()}`))
    })
  })
}

function signalError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason
  return new Error(typeof signal.reason === 'string' ? signal.reason : 'command aborted')
}

export function terminateProcessTreeAndWait(pid: number, fallback: () => void): Promise<void> {
  if (process.platform === 'win32') {
    return new Promise(resolvePromise => {
      const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        shell: false,
        stdio: 'ignore',
      })
      let settled = false
      const finish = (failed: boolean): void => {
        if (settled) return
        settled = true
        if (failed) fallback()
        resolvePromise()
      }
      killer.once('error', () => finish(true))
      killer.once('close', code => finish(code !== 0))
    })
  }
  return new Promise(resolvePromise => {
    try {
      process.kill(-pid, 'SIGTERM')
    } catch {
      fallback()
      resolvePromise()
      return
    }
    const force = setTimeout(() => {
      try { process.kill(-pid, 'SIGKILL') } catch { /* the process group already settled */ }
      resolvePromise()
    }, 2_000)
    force.unref()
  })
}

export function terminateProcessTree(pid: number, fallback: () => void): void {
  void terminateProcessTreeAndWait(pid, fallback)
}

export async function runFileTree(
  file: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; signal: AbortSignal },
): Promise<CommandResult> {
  if (options.signal.aborted) throw signalError(options.signal)
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(file, [...args], {
      cwd: options.cwd, env: options.env, windowsHide: true, shell: false,
      detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let outputBytes = 0
    let localFailure: Error | undefined
    let termination: Promise<void> | undefined
    let settled = false
    const abortTree = (reason?: Error): void => {
      if (reason) localFailure = reason
      if (child.pid !== undefined) termination = terminateProcessTreeAndWait(child.pid, () => { child.kill('SIGTERM') })
      else child.kill('SIGTERM')
    }
    const collect = (target: Buffer[], chunk: unknown): void => {
      const buffer = Buffer.from(chunk as Uint8Array)
      outputBytes += buffer.length
      if (outputBytes > 16 * 1024 * 1024) abortTree(new Error('command output exceeded 16 MiB'))
      else target.push(buffer)
    }
    child.stdout?.on('data', chunk => collect(stdout, chunk))
    child.stderr?.on('data', chunk => collect(stderr, chunk))
    const abort = (): void => abortTree(signalError(options.signal))
    options.signal.addEventListener('abort', abort, { once: true })
    const timeout = options.timeoutMs === undefined ? undefined : setTimeout(() => abortTree(new Error(`command timed out after ${options.timeoutMs}ms`)), options.timeoutMs)
    const cleanup = (): void => {
      options.signal.removeEventListener('abort', abort)
      if (timeout) clearTimeout(timeout)
    }
    child.once('error', async error => {
      if (settled) return
      settled = true
      cleanup()
      await termination
      reject(error)
    })
    child.once('close', async code => {
      if (settled) return
      settled = true
      cleanup()
      await termination
      if (localFailure) { reject(localFailure); return }
      if (options.signal.aborted) { reject(signalError(options.signal)); return }
      resolvePromise({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), exitCode: code ?? 1 })
    })
  })
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
    let termination: Promise<void> | undefined
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout?.on('data', chunk => stdout.push(Buffer.from(chunk)))
    child.stderr?.on('data', chunk => stderr.push(Buffer.from(chunk)))
    const abort = (): void => {
      if (child.pid !== undefined) termination = terminateProcessTreeAndWait(child.pid, () => { child.kill('SIGTERM') })
      else child.kill('SIGTERM')
    }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    child.once('error', async error => {
      signal.removeEventListener('abort', abort)
      await termination
      reject(error)
    })
    child.once('close', async code => {
      signal.removeEventListener('abort', abort)
      await termination
      if (signal.aborted) {
        reject(signalError(signal))
        return
      }
      resolvePromise({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), exitCode: code ?? 1 })
    })
  })
}
