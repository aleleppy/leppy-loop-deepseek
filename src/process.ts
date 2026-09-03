import { execFile, spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
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

export function assertOpaqueGateContainmentPlatform(platform: NodeJS.Platform = process.platform): void {
  if (platform !== 'win32' && platform !== 'linux') {
    throw new Error(`opaque gate process containment is unavailable on ${platform}`)
  }
}

export class OpaqueShellOrphanedError extends Error {}

export interface OpaqueShellLifecycle {
  permitPath: string
  onSpawn: (pid: number) => Promise<void>
  afterRelease?: () => void | Promise<void>
  orphanAfterRelease?: boolean
}

const KOFFI_REQUIRE_PATH = createRequire(import.meta.url).resolve('koffi')
const OPAQUE_SHELL_BOOTSTRAP = `
const fs=require('node:fs');
const cp=require('node:child_process');
const permit=process.argv[1];
const file=process.argv[2];
const args=JSON.parse(Buffer.from(process.argv[3],'base64url').toString('utf8'));
const koffiPath=process.argv[4];
let settling=false;
if(process.platform==='linux'){
  try{
    const koffi=require(koffiPath);
    const prctl=koffi.load(null).func('int prctl(int, ulong, ulong, ulong, ulong)');
    if(prctl(36,1,0,0,0)!==0)throw new Error('prctl failed');
  }catch(error){console.error(error);process.exit(1);}
}
const descendants=()=>{
  if(process.platform!=='linux')return [];
  const parents=new Map();
  for(const name of fs.readdirSync('/proc')){
    if(!/^\\d+$/.test(name))continue;
    try{const match=/^PPid:\\s+(\\d+)$/m.exec(fs.readFileSync('/proc/'+name+'/status','utf8'));if(match)parents.set(Number(name),Number(match[1]));}catch{}
  }
  const found=new Set([process.pid]);
  let changed=true;
  while(changed){changed=false;for(const [pid,ppid] of parents){if(found.has(ppid)&&!found.has(pid)){found.add(pid);changed=true;}}}
  found.delete(process.pid);
  return [...found];
};
const settle=async code=>{
  if(settling)return;
  settling=true;
  for(let round=0;round<10;round++){
    const pids=descendants();
    for(const pid of pids){try{process.kill(pid,round===0?'SIGTERM':'SIGKILL');}catch{}}
    if(pids.length===0&&round>0)break;
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  process.exit(code);
};
process.on('SIGTERM',()=>{void settle(143);});
const deadline=Date.now()+60000;
const wait=()=>{
  if(!fs.existsSync(permit)){if(Date.now()>=deadline){void settle(2);return;}setTimeout(wait,10);return;}
  try{fs.unlinkSync(permit);}catch{}
  const child=cp.spawn(file,args,{windowsHide:true,shell:false,detached:false,stdio:'inherit'});
  child.once('error',error=>{console.error(error);void settle(1);});
  child.once('close',code=>{void settle(code??1);});
};
wait();
`

export async function runOpaqueShell(
  command: string, cwd: string, signal: AbortSignal, env?: NodeJS.ProcessEnv, lifecycle?: OpaqueShellLifecycle,
): Promise<CommandResult> {
  if (signal.aborted) throw signalError(signal)
  const shellFile = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : '/bin/sh'
  const shellArgs = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command]
  const file = lifecycle ? process.execPath : shellFile
  const args = lifecycle
    ? ['-e', OPAQUE_SHELL_BOOTSTRAP, lifecycle.permitPath, shellFile, Buffer.from(JSON.stringify(shellArgs)).toString('base64url'), KOFFI_REQUIRE_PATH]
    : shellArgs
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
    let settled = false
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout?.on('data', chunk => stdout.push(Buffer.from(chunk)))
    child.stderr?.on('data', chunk => stderr.push(Buffer.from(chunk)))
    const abort = (): void => {
      if (child.pid !== undefined) termination = terminateProcessTreeAndWait(child.pid, () => { child.kill('SIGTERM') })
      else child.kill('SIGTERM')
    }
    const cleanup = (): void => signal.removeEventListener('abort', abort)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
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
      if (signal.aborted) {
        reject(signalError(signal))
        return
      }
      resolvePromise({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), exitCode: code ?? 1 })
    })
    if (lifecycle) void (async () => {
      try {
        if (child.pid === undefined) throw new Error('opaque shell bootstrap lacks a process ID')
        await lifecycle.onSpawn(child.pid)
        writeFileSync(lifecycle.permitPath, 'run\n', { flag: 'wx' })
        await lifecycle.afterRelease?.()
        if (lifecycle.orphanAfterRelease && !settled) {
          settled = true
          cleanup()
          reject(new OpaqueShellOrphanedError('simulated controller death left an authenticated gate process alive'))
        }
      } catch (error) {
        if (settled) return
        settled = true
        cleanup()
        abort()
        await termination
        reject(error)
      }
    })()
  })
}
