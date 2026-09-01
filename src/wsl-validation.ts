import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes, type Hash } from 'node:crypto'
import { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readSync, realpathSync, rmSync, unlinkSync, writeFileSync, writeSync, type Stats } from 'node:fs'
import { tmpdir } from 'node:os'
import { StringDecoder } from 'node:string_decoder'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { terminateProcessTreeAndWait } from './process.js'
import type { WorkerMode } from './types.js'

export const WINDOWS_NAMED_PIPE_UNAVAILABLE = 'LEPPY_WINDOWS_NAMED_PIPE_UNAVAILABLE'
export const WSL_VALIDATION_UNAVAILABLE = 'LEPPY_WSL_VALIDATION_UNAVAILABLE'

export interface WslValidationProfile {
  kind: 'wsl2'
  distribution: string
  envFile?: string
  envAllowlist: string[]
  envPrefixes?: string[]
  envAliases?: Record<string, string>
  prepareBins?: string[]
  prepareScripts?: string[]
  seedPaths?: string[]
  webServerTimeoutMs?: number
  playwrightConfig?: string
}

export interface WslValidationResult {
  exitCode: number
  stdout: string
  stderr: string
}

interface CommandResult extends WslValidationResult {
  signal?: NodeJS.Signals
}

const PROFILE_KEYS = new Set(['kind', 'distribution', 'envFile', 'envAllowlist', 'envPrefixes', 'envAliases', 'prepareBins', 'prepareScripts', 'seedPaths', 'webServerTimeoutMs', 'playwrightConfig'])
const BIN_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/u
const SCRIPT_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/u
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/u
const ENV_PREFIX = /^[A-Z][A-Z0-9_]{0,30}_$/u
const PLAYWRIGHT_CONFIG = /^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.config\.(?:[cm]?[jt]s)$/u
const DISTRIBUTION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const MAX_OUTPUT_BYTES = 256 * 1024

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

function safeRepoRelativePath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 1_024 && !isAbsolute(value)
    && !value.includes('\0') && !value.split(/[\\/]/u).some(segment => segment === '..' || segment === '')
}

export function readStableRegularText(root: string, path: string, label: string, maxBytes: number): string {
  const canonicalRoot = realpathSync(root)
  const candidate = resolve(path)
  if (!inside(canonicalRoot, candidate)) throw new Error(`${label} escapes its configured root`)
  const observed = lstatSync(candidate)
  if (!observed.isFile() || observed.isSymbolicLink() || observed.nlink !== 1 || observed.size > maxBytes) {
    throw new Error(`${label} must be one private regular file no larger than ${maxBytes} bytes`)
  }
  if (!inside(canonicalRoot, realpathSync(candidate))) throw new Error(`${label} escapes through a junction or symbolic link`)
  const fd = openSync(candidate, 'r')
  try {
    const opened = fstatSync(fd)
    if (!opened.isFile() || opened.dev !== observed.dev || opened.ino !== observed.ino || opened.size !== observed.size || opened.nlink !== 1) {
      throw new Error(`${label} identity changed while opening`)
    }
    const body = readFileSync(fd, 'utf8')
    const after = fstatSync(fd)
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs
      || after.ctimeMs !== opened.ctimeMs || after.nlink !== 1) {
      throw new Error(`${label} changed while reading`)
    }
    return body
  } finally {
    closeSync(fd)
  }
}

function profileFromFile(path: string, label: string): WslValidationProfile | undefined {
  let body: string
  try {
    body = readStableRegularText(dirname(path), path, label, 64 * 1024)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const parsed = JSON.parse(body) as unknown
  const profileValue = record(parsed)?.validationExecutor
  if (profileValue === undefined) return undefined
  const profile = record(profileValue)
  if (!profile) throw new Error(`${label} validationExecutor must be an object`)
  const unknown = Object.keys(profile).filter(key => !PROFILE_KEYS.has(key))
  if (unknown.length) throw new Error(`${label} validationExecutor has unknown keys: ${unknown.sort().join(', ')}`)
  if (profile.kind !== 'wsl2') throw new Error(`${label} validationExecutor.kind must be "wsl2"`)
  if (typeof profile.distribution !== 'string' || !DISTRIBUTION.test(profile.distribution)) {
    throw new Error(`${label} validationExecutor.distribution is invalid`)
  }
  if (profile.envFile !== undefined && !safeRepoRelativePath(profile.envFile)) {
    throw new Error(`${label} validationExecutor.envFile must be repo-relative`)
  }
  if (!Array.isArray(profile.envAllowlist) || profile.envAllowlist.length > 32
    || !profile.envAllowlist.every(name => typeof name === 'string' && ENV_NAME.test(name))) {
    throw new Error(`${label} validationExecutor.envAllowlist must contain at most 32 canonical environment names`)
  }
  const envAllowlist = profile.envAllowlist as string[]
  if (new Set(envAllowlist).size !== envAllowlist.length) {
    throw new Error(`${label} validationExecutor.envAllowlist contains duplicates`)
  }
  if (profile.envPrefixes !== undefined && (!Array.isArray(profile.envPrefixes) || profile.envPrefixes.length > 8
    || !profile.envPrefixes.every(prefix => typeof prefix === 'string' && ENV_PREFIX.test(prefix))
    || new Set(profile.envPrefixes).size !== profile.envPrefixes.length)) {
    throw new Error(`${label} validationExecutor.envPrefixes must contain at most 8 unique canonical prefixes`)
  }
  const envPrefixes = profile.envPrefixes ? profile.envPrefixes as string[] : []
  if ((envAllowlist.length || envPrefixes.length) && profile.envFile === undefined) {
    throw new Error(`${label} validationExecutor.envFile is required when environment names are allowed`)
  }
  const envAliases = profile.envAliases === undefined ? undefined : record(profile.envAliases)
  if (profile.envAliases !== undefined && (!envAliases || Object.keys(envAliases).length > 16
    || !Object.entries(envAliases).every(([target, source]) => ENV_NAME.test(target) && typeof source === 'string'
      && ENV_NAME.test(source) && (envAllowlist.includes(source) || envPrefixes.some(prefix => source.startsWith(prefix)))
      && !envAllowlist.includes(target) && !envPrefixes.some(prefix => target.startsWith(prefix))))) {
    throw new Error(`${label} validationExecutor.envAliases must map at most 16 new canonical names from envAllowlist names`)
  }
  if (profile.prepareBins !== undefined && (!Array.isArray(profile.prepareBins) || profile.prepareBins.length > 8
    || !profile.prepareBins.every(name => typeof name === 'string' && BIN_NAME.test(name))
    || new Set(profile.prepareBins).size !== profile.prepareBins.length)) {
    throw new Error(`${label} validationExecutor.prepareBins must contain at most 8 unique bare binary names`)
  }
  if (profile.prepareScripts !== undefined && (!Array.isArray(profile.prepareScripts) || profile.prepareScripts.length > 8
    || !profile.prepareScripts.every(name => typeof name === 'string' && SCRIPT_NAME.test(name))
    || new Set(profile.prepareScripts).size !== profile.prepareScripts.length)) {
    throw new Error(`${label} validationExecutor.prepareScripts must contain at most 8 unique package script names`)
  }
  if (profile.seedPaths !== undefined && (!Array.isArray(profile.seedPaths) || profile.seedPaths.length > 8
    || !profile.seedPaths.every(path => safeRepoRelativePath(path)
      && path.split(/[\\/]/u).every(segment => !segment.startsWith('.') && segment.toLowerCase() !== 'node_modules'))
    || new Set(profile.seedPaths).size !== profile.seedPaths.length)) {
    throw new Error(`${label} validationExecutor.seedPaths must contain at most 8 unique safe repo-relative paths`)
  }
  if (profile.webServerTimeoutMs !== undefined && (!Number.isSafeInteger(profile.webServerTimeoutMs)
    || (profile.webServerTimeoutMs as number) < 180_000 || (profile.webServerTimeoutMs as number) > 900_000)) {
    throw new Error(`${label} validationExecutor.webServerTimeoutMs must be an integer from 180000 to 900000`)
  }
  if (profile.playwrightConfig !== undefined && (typeof profile.playwrightConfig !== 'string' || !PLAYWRIGHT_CONFIG.test(profile.playwrightConfig))) {
    throw new Error(`${label} validationExecutor.playwrightConfig must be a bounded repo-relative *.config.{js,mjs,cjs,ts,mts,cts} path`)
  }
  if (profile.webServerTimeoutMs !== undefined && profile.playwrightConfig === undefined) {
    throw new Error(`${label} validationExecutor.playwrightConfig is required with webServerTimeoutMs`)
  }
  return {
    kind: 'wsl2', distribution: profile.distribution,
    ...(profile.envFile === undefined ? {} : { envFile: profile.envFile }),
    envAllowlist: [...envAllowlist],
    ...(envPrefixes.length ? { envPrefixes: [...envPrefixes] } : {}),
    ...(envAliases && Object.keys(envAliases).length ? { envAliases: Object.fromEntries(Object.entries(envAliases) as Array<[string, string]>) } : {}),
    ...(profile.prepareBins?.length ? { prepareBins: [...profile.prepareBins] } : {}),
    ...(profile.prepareScripts?.length ? { prepareScripts: [...profile.prepareScripts] } : {}),
    ...(profile.seedPaths?.length ? { seedPaths: [...profile.seedPaths] } : {}),
    ...(typeof profile.webServerTimeoutMs === 'number' ? { webServerTimeoutMs: profile.webServerTimeoutMs } : {}),
    ...(typeof profile.playwrightConfig === 'string' ? { playwrightConfig: profile.playwrightConfig } : {}),
  }
}

export function loadWslValidationProfile(root: string, repoRoot = root): WslValidationProfile | undefined {
  const local = profileFromFile(resolve(repoRoot, '.leppy-loop.local.json'), '.leppy-loop.local.json')
  if (local && existsSync(resolve(repoRoot, '.git'))) {
    const tracked = spawnSync('git', ['-C', repoRoot, 'ls-files', '--error-unmatch', '--', '.leppy-loop.local.json'], {
      env: wslHostEnvironment(process.env), windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (tracked.status === 0) throw new Error('.leppy-loop.local.json must remain untracked Host authority; use tracked .leppy-loop.json instead')
    if (tracked.status !== 1) throw new Error(`cannot authenticate Host-local validation profile as untracked: ${tracked.stderr.trim()}`)
  }
  return local ?? profileFromFile(resolve(root, '.leppy-loop.json'), '.leppy-loop.json')
}

export function isPlaywrightExecutable(command: string): boolean {
  return /^playwright(?:\.cmd|\.exe)?$/iu.test(basename(command))
}

export function canonicalPlaywrightArgs(args: readonly string[]): string[] {
  if (args.length === 0 || args[0] !== 'test') throw new Error('WSL validation only permits playwright test')
  if (args.length > 64) throw new Error('Playwright validation has too many arguments')
  for (const argument of args) {
    if (!argument || Buffer.byteLength(argument) > 1_024 || /[\0\r\n]/u.test(argument)) {
      throw new Error('Playwright validation argument is empty or exceeds its bound')
    }
  }
  const denied = new Set(['--debug', '--headed', '--ui', '--ui-host', '--update-snapshots', '--update-source-method', '-u', '--list', '--pass-with-no-tests'])
  if (args.some(argument => denied.has(argument.split('=', 1)[0] ?? ''))) {
    throw new Error('interactive, discovery-only, and snapshot-update Playwright modes are denied')
  }
  const canonical = [...args]
  if (!canonical.some(argument => argument === '--workers' || argument.startsWith('--workers='))) canonical.push('--workers=1')
  if (!canonical.some(argument => argument === '--reporter' || argument.startsWith('--reporter='))) canonical.push('--reporter=line')
  return canonical
}

export function validationRouting(mode: WorkerMode, command: string, profile: WslValidationProfile | undefined): 'sandbox' | 'capsule' | 'named-pipe-unavailable' {
  if (process.platform !== 'win32' || !isPlaywrightExecutable(command)) return 'sandbox'
  if (mode !== 'verification') return 'named-pipe-unavailable'
  return profile ? 'capsule' : 'named-pipe-unavailable'
}

function parseDotEnv(body: string): Map<string, string> {
  const values = new Map<string, string>()
  for (const rawLine of body.split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(line)
    if (!match) continue
    const name = match[1]
    let value = match[2]
    if (name === undefined || value === undefined) continue
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      const quote = value[0]
      value = value.slice(1, -1)
      if (quote === '"') value = value.replace(/\\n/gu, '\n').replace(/\\r/gu, '\r').replace(/\\"/gu, '"').replace(/\\\\/gu, '\\')
    } else {
      value = value.replace(/\s+#.*$/u, '').trim()
    }
    values.set(name, value)
  }
  return values
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

function seedAncestorPaths(paths: readonly string[]): string[] {
  const ancestors = new Set<string>()
  for (const path of paths) {
    const segments = path.split(/[\\/]/u)
    for (let index = 1; index <= segments.length; index += 1) ancestors.add(segments.slice(0, index).join('/'))
  }
  return [...ancestors]
}

export function assertSeedDestinationTopology(batchOutput: string, objectSpecs?: readonly string[]): void {
  if (objectSpecs === undefined) {
    const unsafe = batchOutput.split('\0').filter(Boolean).filter(entry => !/^0?40000 tree [0-9a-f]{40}\t/u.test(entry))
    if (unsafe.length) throw new Error(`${WSL_VALIDATION_UNAVAILABLE}: candidate seed destination has a tracked non-directory ancestor: ${unsafe.slice(0, 8).join(', ')}`)
    return
  }
  const observations = batchOutput.split(/\r?\n/u)
  if (observations.at(-1) === '') observations.pop()
  const unsafe = objectSpecs.filter((spec, index) => observations[index] !== 'tree' && observations[index] !== `${spec} missing`)
  if (observations.length !== objectSpecs.length || unsafe.length) {
    const detail = observations.length !== objectSpecs.length ? 'incomplete topology receipt' : unsafe.slice(0, 8).join(', ')
    throw new Error(`${WSL_VALIDATION_UNAVAILABLE}: candidate seed destination has a tracked non-directory ancestor: ${detail}`)
  }
}

export function assertCapsuleOverlaysUntracked(trackedOutput: string): void {
  const tracked = trackedOutput.split('\0').filter(Boolean)
  if (tracked.length) throw new Error(`${WSL_VALIDATION_UNAVAILABLE}: capsule overlays overlap authenticated tracked paths: ${tracked.slice(0, 8).join(', ')}`)
}

function copyStableSeedFile(source: string, target: string, observed: Stats, manifestPath: string, hash: Hash): void {
  const sourceFd = openSync(source, 'r')
  let targetFd: number | undefined
  try {
    const opened = fstatSync(sourceFd)
    if (!opened.isFile() || opened.dev !== observed.dev || opened.ino !== observed.ino || opened.size !== observed.size || opened.nlink !== 1) {
      throw new Error(`${WSL_VALIDATION_UNAVAILABLE}: seed file identity changed while staging`)
    }
    targetFd = openSync(target, 'wx', observed.mode & 0o777)
    hash.update(`${manifestPath}\0${opened.size}\0`)
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    let position = 0
    while (position < opened.size) {
      const count = readSync(sourceFd, buffer, 0, Math.min(buffer.length, opened.size - position), position)
      if (count === 0) throw new Error(`${WSL_VALIDATION_UNAVAILABLE}: seed file truncated while staging`)
      hash.update(buffer.subarray(0, count))
      let written = 0
      while (written < count) written += writeSync(targetFd, buffer, written, count - written)
      position += count
    }
    const after = fstatSync(sourceFd)
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs
      || after.ctimeMs !== opened.ctimeMs || after.nlink !== 1) {
      throw new Error(`${WSL_VALIDATION_UNAVAILABLE}: seed file changed while staging`)
    }
  } catch (error) {
    if (targetFd !== undefined) closeSync(targetFd)
    targetFd = undefined
    try { unlinkSync(target) } catch {
      // The target may not have been created; preserve the authoritative staging error.
    }
    throw error
  } finally {
    closeSync(sourceFd)
    if (targetFd !== undefined) closeSync(targetFd)
  }
}

export function stageSeedPaths(main: string, profile: WslValidationProfile, destination: string): { digest: string; paths: string[] } {
  const canonicalMain = realpathSync(main)
  const hash = createHash('sha256')
  let files = 0
  let bytes = 0
  const paths: string[] = []
  const copy = (source: string, target: string): void => {
    const stat = lstatSync(source)
    if (stat.isSymbolicLink()) throw new Error(`${WSL_VALIDATION_UNAVAILABLE}: seedPaths cannot contain symbolic links or junctions`)
    if (!inside(canonicalMain, realpathSync(source))) throw new Error(`${WSL_VALIDATION_UNAVAILABLE}: seedPaths escaped the main worktree`)
    if (stat.isDirectory()) {
      const entries = readdirSync(source).sort()
      mkdirSync(target, { recursive: true })
      for (const entry of entries) copy(resolve(source, entry), resolve(target, entry))
      const after = lstatSync(source)
      if (!after.isDirectory() || after.dev !== stat.dev || after.ino !== stat.ino || after.mtimeMs !== stat.mtimeMs
        || readdirSync(source).sort().join('\0') !== entries.join('\0')) {
        throw new Error(`${WSL_VALIDATION_UNAVAILABLE}: seed directory changed while staging`)
      }
      return
    }
    if (!stat.isFile()) throw new Error(`${WSL_VALIDATION_UNAVAILABLE}: seedPaths accept only regular files and directories`)
    if (stat.nlink !== 1) throw new Error(`${WSL_VALIDATION_UNAVAILABLE}: seedPaths cannot contain hardlinks`)
    files += 1
    bytes += stat.size
    if (files > 10_000 || bytes > 256 * 1024 * 1024) throw new Error(`${WSL_VALIDATION_UNAVAILABLE}: seedPaths exceed the 10000-file or 256-MiB budget`)
    mkdirSync(dirname(target), { recursive: true })
    const manifestPath = relative(canonicalMain, source).replaceAll('\\', '/')
    paths.push(manifestPath)
    copyStableSeedFile(source, target, stat, manifestPath, hash)
  }
  for (const relativePath of profile.seedPaths ?? []) copy(resolve(canonicalMain, relativePath), resolve(destination, relativePath))
  return { digest: hash.digest('hex'), paths }
}

function allowlistedEnvironment(profile: WslValidationProfile, main: string): { body: string; exports: string; secrets: string[] } {
  if (!profile.envFile) return { body: '', exports: '', secrets: [] }
  const candidate = resolve(main, profile.envFile)
  const values = parseDotEnv(readStableRegularText(main, candidate, `${WSL_VALIDATION_UNAVAILABLE}: envFile`, 64 * 1024))
  const allowedNames = new Set(profile.envAllowlist.filter(name => values.has(name)))
  for (const name of values.keys()) if (profile.envPrefixes?.some(prefix => name.startsWith(prefix))) allowedNames.add(name)
  const provided = new Map([...allowedNames].map(name => [name, values.get(name) ?? '']))
  for (const [target, source] of Object.entries(profile.envAliases ?? {})) {
    const value = values.get(source)
    if (value !== undefined) provided.set(target, value)
  }
  return {
    body: [...provided].map(([name, value]) => `${name}=${JSON.stringify(value)}\n`).join(''),
    exports: [...provided].map(([name, value]) => `export ${name}=${shellSingleQuote(value)}\n`).join(''),
    secrets: [...provided.values()].filter(Boolean),
  }
}

export function redactEnvironmentValues(text: string, secrets: readonly string[]): string {
  let redacted = text
  for (const secret of [...new Set(secrets)].sort((left, right) => right.length - left.length)) redacted = redacted.replaceAll(secret, '[REDACTED]')
  return redacted
}

function appendBounded(chunks: Buffer[], chunk: Buffer): void {
  chunks.push(chunk)
  let total = chunks.reduce((sum, item) => sum + item.length, 0)
  while (total > MAX_OUTPUT_BYTES && chunks.length > 1) total -= chunks.shift()?.length ?? 0
  const only = chunks[0]
  if (total > MAX_OUTPUT_BYTES && chunks.length === 1 && only) chunks[0] = only.subarray(only.length - MAX_OUTPUT_BYTES)
}

class BoundedRedactedCollector {
  private readonly chunks: Buffer[] = []
  private readonly decoder = new StringDecoder('utf8')
  private readonly secrets: string[]
  private readonly keepChars: number
  private pending = ''

  constructor(secrets: readonly string[]) {
    this.secrets = [...new Set(secrets.filter(Boolean))].sort((left, right) => right.length - left.length)
    this.keepChars = Math.max(0, ...this.secrets.map(secret => secret.length - 1))
  }

  append(chunk: Buffer): void {
    this.pending += this.decoder.write(chunk)
    let cutoff = Math.max(0, this.pending.length - this.keepChars)
    let changed = true
    while (changed && cutoff > 0) {
      changed = false
      for (const secret of this.secrets) {
        let index = this.pending.indexOf(secret, Math.max(0, cutoff - secret.length + 1))
        while (index >= 0 && index < cutoff) {
          if (index + secret.length > cutoff) {
            cutoff = index
            changed = true
            break
          }
          index = this.pending.indexOf(secret, index + 1)
        }
        if (changed) break
      }
    }
    if (cutoff === 0) return
    appendBounded(this.chunks, Buffer.from(redactEnvironmentValues(this.pending.slice(0, cutoff), this.secrets)))
    this.pending = this.pending.slice(cutoff)
  }

  finish(): string {
    this.pending += this.decoder.end()
    appendBounded(this.chunks, Buffer.from(redactEnvironmentValues(this.pending, this.secrets)))
    this.pending = ''
    let output = Buffer.concat(this.chunks).toString('utf8')
    while (Buffer.byteLength(output) > MAX_OUTPUT_BYTES) output = output.slice(1)
    return output
  }
}

export function collectBoundedRedacted(chunks: readonly Buffer[], secrets: readonly string[]): string {
  const collector = new BoundedRedactedCollector(secrets)
  for (const chunk of chunks) collector.append(chunk)
  return collector.finish()
}

export function wslHostEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = new Set(['PATH', 'Path', 'PATHEXT', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'COMSPEC'])
  return { ...Object.fromEntries(Object.entries(base).filter(([name, value]) => allowed.has(name) && value !== undefined)), WSLENV: '' }
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error(typeof signal.reason === 'string' ? signal.reason : 'WSL validation aborted')
}

async function run(command: string, args: readonly string[], options: { cwd?: string; signal?: AbortSignal; redactions?: readonly string[]; stdin?: string } = {}): Promise<CommandResult> {
  if (options.signal?.aborted) throw abortError(options.signal)
  return await new Promise<CommandResult>((resolveResult, reject) => {
    const child = spawn(command, [...args], { cwd: options.cwd, env: wslHostEnvironment(process.env), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    const stdout = new BoundedRedactedCollector(options.redactions ?? [])
    const stderr = new BoundedRedactedCollector(options.redactions ?? [])
    let abortFailure: Error | undefined
    let termination: Promise<void> | undefined
    let forceTimer: NodeJS.Timeout | undefined
    let settled = false
    child.stdout.on('data', (chunk: Buffer) => stdout.append(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.append(chunk))
    child.stdin?.on('error', () => undefined)
    child.stdin?.end(options.stdin ?? '')
    const cleanup = (): void => {
      options.signal?.removeEventListener('abort', abort)
      if (forceTimer) clearTimeout(forceTimer)
    }
    const abort = (): void => {
      if (settled || !options.signal) return
      abortFailure = abortError(options.signal)
      if (child.pid !== undefined) termination = terminateProcessTreeAndWait(child.pid, () => { child.kill('SIGTERM') })
      else child.kill('SIGTERM')
      forceTimer = setTimeout(() => { if (!settled) child.kill('SIGKILL') }, 5_000)
      forceTimer.unref()
    }
    child.once('error', async error => {
      if (settled) return
      settled = true
      cleanup()
      await termination
      reject(abortFailure ?? error)
    })
    child.once('close', async (code, signal) => {
      if (settled) return
      settled = true
      cleanup()
      await termination
      if (abortFailure) {
        reject(abortFailure)
        return
      }
      resolveResult({ exitCode: code ?? -1, stdout: stdout.finish(), stderr: stderr.finish(), ...(signal ? { signal } : {}) })
    })
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) abort()
  })
}

async function sourceAuthorityDigest(root: string, signal?: AbortSignal): Promise<string> {
  const options = signal ? { signal } : {}
  const head = await run('git', ['-C', root, 'rev-parse', 'HEAD'], options)
  const indexTree = await run('git', ['-C', root, 'write-tree'], options)
  const status = await run('git', ['-C', root, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], options)
  const entries = status.stdout.split('\0').filter(Boolean)
  if (head.exitCode !== 0 || indexTree.exitCode !== 0 || status.exitCode !== 0
    || entries.some(entry => entry !== '?? .leppy-loop.local.json')) {
    const detail = entries.length ? entries.slice(0, 8).join(', ')
      : `head=${head.exitCode}:${head.stderr.trim()} index=${indexTree.exitCode}:${indexTree.stderr.trim()} status=${status.exitCode}:${status.stderr.trim()}`
    throw new Error(`${WSL_VALIDATION_UNAVAILABLE}: source repoRoot changed or contains unauthenticated WIP: ${detail}`)
  }
  return createHash('sha256').update(`${head.stdout.trim()}\0${indexTree.stdout.trim()}\0${status.stdout}`).digest('hex')
}

async function resolveWslPath(distribution: string, path: string, signal?: AbortSignal): Promise<string> {
  const result = await run('wsl.exe', ['--distribution', distribution, '--exec', 'wslpath', '-a', '-u', resolve(path)], signal ? { signal } : {})
  const mapped = result.stdout.trim()
  if (result.exitCode !== 0 || !mapped.startsWith('/') || /[\0\r\n]/u.test(mapped) || Buffer.byteLength(mapped) > 4_096) {
    throw new Error(`${WSL_VALIDATION_UNAVAILABLE}: selected distribution cannot map Host staging path: ${result.stderr.trim()}`)
  }
  return mapped
}

const CAPSULE_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail
capsule_id="$1"
archive="$2"
env_file="$3"
exports_file="$4"
seed_root="$5"
prepare_bins="$6"
prepare_scripts="$7"
web_timeout="$8"
config_path="$9"
status_file="\${10}"
shift 10
printf 'outer' > "$status_file"
capsule="/tmp/leppy-validation-$capsule_id"
mkdir -m 700 "$capsule"
cleanup() { rm -rf "$capsule"; }
trap cleanup EXIT INT TERM
mkdir -p "$capsule/workspace" "$capsule/home" "$capsule/runtime" "$capsule/npm-cache" "$capsule/resolver"
cp -L /etc/resolv.conf "$capsule/resolver/resolv.conf"
cp "$exports_file" "$capsule/resolver/validation.exports"
chmod 400 "$capsule/resolver/validation.exports"
: > "$capsule/home/.npmrc"
: > "$capsule/home/global.npmrc"
: > "$capsule/resolver/blocked"
chmod 000 "$capsule/resolver/blocked"
cat > "$capsule/resolver/authenticate-playwright.mjs" <<'LEPPY_AUTHENTICATE_PLAYWRIGHT'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'))
const packages = lock.packages
if (!packages || typeof packages !== 'object') throw new Error('package-lock packages authority is missing')
const definitions = [
  ['node_modules/@playwright/test', '@playwright/test', version => '/@playwright/test/-/test-' + version + '.tgz'],
  ['node_modules/playwright', 'playwright', version => '/playwright/-/playwright-' + version + '.tgz'],
  ['node_modules/playwright-core', 'playwright-core', version => '/playwright-core/-/playwright-core-' + version + '.tgz'],
]
for (const [path, name, expectedPath] of definitions) {
  const locked = packages[path]
  if (!locked || typeof locked.version !== 'string' || typeof locked.resolved !== 'string'
    || typeof locked.integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/u.test(locked.integrity)) {
    throw new Error('authenticated ' + name + ' lock entry is incomplete')
  }
  const source = new URL(locked.resolved)
  if (source.protocol !== 'https:' || source.hostname !== 'registry.npmjs.org' || source.username || source.password
    || source.search || source.hash || source.pathname !== expectedPath(locked.version)) {
    throw new Error('authenticated ' + name + ' must resolve from its canonical npm registry tarball')
  }
  const installed = JSON.parse(readFileSync(path + '/package.json', 'utf8'))
  if (installed.name !== name || installed.version !== locked.version) throw new Error('installed ' + name + ' does not match lock authority')
}
const testPackage = packages['node_modules/@playwright/test']
const playwrightPackage = packages['node_modules/playwright']
const corePackage = packages['node_modules/playwright-core']
if (testPackage.dependencies?.playwright !== playwrightPackage.version
  || playwrightPackage.dependencies?.['playwright-core'] !== corePackage.version) {
  throw new Error('Playwright dependency edges do not match exact locked versions')
}
const launcher = resolve('node_modules/playwright/cli.js')
const testLauncher = resolve('node_modules/@playwright/test/cli.js')
const launchers = [launcher, testLauncher]
for (const entrypoint of launchers) {
  const entrypointStat = lstatSync(entrypoint)
  if (!entrypointStat.isFile() || entrypointStat.isSymbolicLink() || entrypointStat.nlink !== 1) {
    throw new Error('Playwright launcher is not one private regular package entrypoint')
  }
}
if (!launchers.map(path => realpathSync(path)).includes(realpathSync('node_modules/.bin/playwright'))) {
  throw new Error('Playwright shim does not resolve to an authenticated package entrypoint')
}
console.error('LEPPY_PLAYWRIGHT_PACKAGE=' + playwrightPackage.version)
LEPPY_AUTHENTICATE_PLAYWRIGHT
cat > "$capsule/resolver/install.sh" <<'LEPPY_INSTALL'
#!/usr/bin/env bash
set -euo pipefail
npm ci --ignore-scripts --no-audit --no-fund
node /mnt/wsl/authenticate-playwright.mjs
LEPPY_INSTALL
cat > "$capsule/resolver/browser.sh" <<'LEPPY_BROWSER'
#!/usr/bin/env bash
set -Eeuo pipefail
trap 'code=$?; echo "LEPPY_WSL_VALIDATION_UNAVAILABLE: phase=browser-install exit=$code" >&2; exit $code' ERR
node ./node_modules/playwright/cli.js install chromium
LEPPY_BROWSER
cat > "$capsule/resolver/prepare.sh" <<'LEPPY_PREPARE'
#!/usr/bin/env bash
set -euo pipefail
source /mnt/wsl/validation.exports
if [[ -n "\${LEPPY_PREPARE_SCRIPTS:-}" ]]; then
  IFS=: read -r -a scripts <<< "$LEPPY_PREPARE_SCRIPTS"
  for script in "\${scripts[@]}"; do npm run "$script"; done
fi
if [[ -n "\${LEPPY_PREPARE_BINS:-}" ]]; then
  IFS=: read -r -a bins <<< "$LEPPY_PREPARE_BINS"
  for bin in "\${bins[@]}"; do "./node_modules/.bin/$bin"; done
fi
LEPPY_PREPARE
cat > "$capsule/resolver/test.sh" <<'LEPPY_TEST'
#!/usr/bin/env bash
set -euo pipefail
source /mnt/wsl/validation.exports
exec node ./node_modules/playwright/cli.js "$@"
LEPPY_TEST
chmod 500 "$capsule/resolver/install.sh" "$capsule/resolver/browser.sh" "$capsule/resolver/prepare.sh" "$capsule/resolver/test.sh"
cp -a "$seed_root/." "$capsule/workspace/"
tar -xf "$archive" -C "$capsule/workspace"
if [ -n "$web_timeout" ]; then
  printf '%s\n' \
    "import base from './$config_path';" \
    "const timeout = $web_timeout;" \
    "const webServer = Array.isArray(base.webServer) ? base.webServer.map(value => ({ ...value, timeout })) : base.webServer ? { ...base.webServer, timeout } : base.webServer;" \
    "export default { ...base, webServer };" \
    > "$capsule/workspace/.leppy-wsl-playwright.config.ts"
fi
if [ -s "$env_file" ]; then cp "$env_file" "$capsule/workspace/.env"; chmod 600 "$capsule/workspace/.env"; fi
while IFS= read -r mount_target; do
  case "$mount_target" in
    /usr/*|/bin/*|/sbin/*|/lib/*|/lib64/*|/etc/*)
      case "$mount_target" in
        /usr/lib/modules|/usr/lib/modules/*|/usr/lib/wsl/drivers|/usr/lib/wsl/lib) ;;
        *) echo "LEPPY_WSL_VALIDATION_UNAVAILABLE: unexpected runtime submount $mount_target" >&2; exit 1 ;;
      esac
      ;;
  esac
done < <(findmnt -rn -o TARGET)
capsule_exec() {
  local deps_args=()
  if [ -d "$capsule/deps" ]; then
    deps_args=(
      --ro-bind "$capsule/deps" /tmp/workspace/node_modules
      --bind "$capsule/dependency-cache/vite-temp" /tmp/workspace/node_modules/.vite-temp
      --bind "$capsule/dependency-cache/vite" /tmp/workspace/node_modules/.vite
      --bind "$capsule/dependency-cache/cache" /tmp/workspace/node_modules/.cache
    )
  fi
  bwrap \\
  --unshare-all --share-net --die-with-parent --new-session --clearenv \\
  --tmpfs / \\
  --ro-bind /usr /usr --ro-bind /bin /bin --ro-bind /sbin /sbin --ro-bind /lib /lib --ro-bind-try /lib64 /lib64 --ro-bind /etc /etc \\
  --tmpfs /usr/lib/modules --tmpfs /usr/lib/wsl/drivers --tmpfs /usr/lib/wsl/lib \\
  --tmpfs /home --tmpfs /root --tmpfs /mnt --tmpfs /media --tmpfs /run --tmpfs /tmp --tmpfs /var --tmpfs /opt --tmpfs /srv \\
  --ro-bind "$capsule/resolver/blocked" /init \\
  --proc /proc --dev /dev \\
  --dir /mnt/wsl --ro-bind "$capsule/resolver" /mnt/wsl \\
  --dir /tmp/workspace --dir /tmp/home --dir /tmp/runtime --dir /tmp/npm-cache \\
  --bind "$capsule/workspace" /tmp/workspace \\
  "\${deps_args[@]}" \\
  --bind "$capsule/home" /tmp/home \\
  --bind "$capsule/runtime" /tmp/runtime \\
  --bind "$capsule/npm-cache" /tmp/npm-cache \\
  --chdir /tmp/workspace \\
  --setenv HOME /tmp/home --setenv TMPDIR /tmp/runtime --setenv npm_config_cache /tmp/npm-cache \\
  --setenv npm_config_userconfig /tmp/home/.npmrc --setenv npm_config_globalconfig /tmp/home/global.npmrc \\
  --setenv CI 1 --setenv NO_COLOR 1 --setenv FORCE_COLOR 0 --setenv PLAYWRIGHT_BROWSERS_PATH /tmp/home/ms-playwright \\
  --setenv LEPPY_PREPARE_BINS "$prepare_bins" --setenv LEPPY_PREPARE_SCRIPTS "$prepare_scripts" \\
  --setenv PATH /usr/local/bin:/usr/bin:/bin \\
  -- "$@"
}
printf 'bootstrap' > "$status_file"
set +e
capsule_exec /bin/true
code=$?
set -e
if [ "$code" -ne 0 ]; then exit "$code"; fi
printf 'setup' > "$status_file"
set +e
capsule_exec /mnt/wsl/install.sh
code=$?
set -e
if [ "$code" -ne 0 ]; then exit "$code"; fi
printf 'bootstrap' > "$status_file"
set +e
capsule_exec /mnt/wsl/browser.sh
code=$?
set -e
if [ "$code" -ne 0 ]; then exit "$code"; fi
mv "$capsule/workspace/node_modules" "$capsule/deps"
mkdir -p "$capsule/workspace/node_modules" "$capsule/dependency-cache/vite-temp" "$capsule/dependency-cache/vite" "$capsule/dependency-cache/cache"
mkdir -p "$capsule/deps/.vite-temp" "$capsule/deps/.vite" "$capsule/deps/.cache"
printf 'prepare' > "$status_file"
set +e
capsule_exec /mnt/wsl/prepare.sh
code=$?
set -e
if [ "$code" -ne 0 ]; then exit "$code"; fi
printf 'test' > "$status_file"
set +e
capsule_exec /mnt/wsl/test.sh "$@"
code=$?
set -e
exit "$code"
`

export async function executePlaywrightInWsl(options: {
  root: string
  repoRoot: string
  commitHead: string
  args: readonly string[]
  profile: WslValidationProfile
  signal?: AbortSignal
  onPhase?: (phase: string) => void
}): Promise<WslValidationResult> {
  if (!/^[0-9a-f]{40}$/u.test(options.commitHead)) throw new Error(`${WSL_VALIDATION_UNAVAILABLE}: authenticated commit head is invalid`)
  const args = canonicalPlaywrightArgs(options.args)
  if (options.profile.webServerTimeoutMs !== undefined) {
    if (args.some(argument => argument === '--config' || argument.startsWith('--config='))) {
      throw new Error(`${WSL_VALIDATION_UNAVAILABLE}: worker --config cannot override the authenticated timeout wrapper`)
    }
    args.push('--config=.leppy-wsl-playwright.config.ts')
  }
  const staging = mkdtempSync(resolve(tmpdir(), 'leppy-wsl-validation-'))
  const archive = resolve(staging, 'candidate.tar')
  const envPath = resolve(staging, 'validation.env')
  const exportsPath = resolve(staging, 'validation.exports')
  const seedRoot = resolve(staging, 'seed')
  const statusPath = resolve(staging, 'phase.status')
  const scriptPath = resolve(staging, 'run.sh')
  const capsuleId = randomBytes(16).toString('hex')
  const capsulePath = `/tmp/leppy-validation-${capsuleId}`
  let wslMapped = false
  const signalOptions = options.signal ? { signal: options.signal } : {}
  try {
    const main = realpathSync(options.repoRoot)
    const [candidateCommon, candidateTop, candidateHead, mainCommon, mainTop] = await Promise.all([
      run('git', ['-C', options.root, 'rev-parse', '--path-format=absolute', '--git-common-dir'], signalOptions),
      run('git', ['-C', options.root, 'rev-parse', '--show-toplevel'], signalOptions),
      run('git', ['-C', options.root, 'rev-parse', 'HEAD'], signalOptions),
      run('git', ['-C', main, 'rev-parse', '--path-format=absolute', '--git-common-dir'], signalOptions),
      run('git', ['-C', main, 'rev-parse', '--show-toplevel'], signalOptions),
    ])
    if (candidateCommon.exitCode !== 0 || candidateTop.exitCode !== 0 || candidateHead.exitCode !== 0
      || mainCommon.exitCode !== 0 || mainTop.exitCode !== 0
      || realpathSync(candidateTop.stdout.trim()) !== realpathSync(options.root)
      || candidateHead.stdout.trim() !== options.commitHead
      || realpathSync(mainTop.stdout.trim()) !== main
      || realpathSync(candidateCommon.stdout.trim()) !== realpathSync(mainCommon.stdout.trim())) {
      throw new Error(`${WSL_VALIDATION_UNAVAILABLE}: repoRoot is not the exact source worktree for the authenticated repository`)
    }
    const sourceAuthority = await sourceAuthorityDigest(main, options.signal)
    const overlays = [
      ...(options.profile.seedPaths ?? []),
      ...(options.profile.envFile ? ['.env'] : []),
      ...(options.profile.webServerTimeoutMs !== undefined ? ['.leppy-wsl-playwright.config.ts'] : []),
    ]
    if (overlays.length) {
      for (const sourceRoot of [options.root, main]) {
        const trackedOverlays = await run('git', ['-C', sourceRoot, 'ls-files', '-z', '--', ...overlays], signalOptions)
        if (trackedOverlays.exitCode !== 0) throw new Error(`${WSL_VALIDATION_UNAVAILABLE}: cannot classify capsule overlays against both authenticated roots`)
        assertCapsuleOverlaysUntracked(trackedOverlays.stdout)
      }
    }
    const destinationAncestors = seedAncestorPaths(options.profile.seedPaths ?? [])
    if (destinationAncestors.length) {
      const objectSpecs = destinationAncestors.map(path => `${options.commitHead}:${path}`)
      const topology = await run('git', ['-C', options.root, 'cat-file', '--batch-check=%(objecttype)'], {
        ...signalOptions, stdin: `${objectSpecs.join('\n')}\n`,
      })
      if (topology.exitCode !== 0) throw new Error(`${WSL_VALIDATION_UNAVAILABLE}: cannot authenticate candidate seed destination topology`)
      assertSeedDestinationTopology(topology.stdout, objectSpecs)
    }
    if (options.profile.playwrightConfig) {
      const configEntry = await run('git', ['-C', options.root, 'ls-tree', '-z', options.commitHead, '--', options.profile.playwrightConfig], signalOptions)
      if (configEntry.exitCode !== 0 || !/^100(?:644|755) blob [0-9a-f]{40}\t[^\0]+\0$/u.test(configEntry.stdout)) {
        throw new Error(`${WSL_VALIDATION_UNAVAILABLE}: authenticated Playwright config is missing, non-regular, or executable topology is unsafe`)
      }
    }
    mkdirSync(seedRoot, { recursive: true })
    const seedSnapshot = stageSeedPaths(main, options.profile, seedRoot)
    if (seedSnapshot.paths.length) {
      const ignoredFiles = await run('git', ['-c', 'core.excludesFile=', '-C', main, 'check-ignore', '-z', '-v', '--no-index', '--stdin'], {
        ...signalOptions, stdin: `${seedSnapshot.paths.join('\0')}\0`,
      })
      const fields = ignoredFiles.stdout.split('\0')
      if (ignoredFiles.exitCode !== 0 || fields.at(-1) !== '' || (fields.length - 1) % 4 !== 0) {
        throw new Error(`${WSL_VALIDATION_UNAVAILABLE}: cannot classify every staged seed leaf against tracked ignore authority`)
      }
      const ignored = new Set<string>()
      const ignoreSources = new Set<string>()
      for (let index = 0; index < fields.length - 1; index += 4) {
        const source = fields[index]
        const path = fields[index + 3]
        if (!source || !path || !source.replaceAll('\\', '/').endsWith('.gitignore')) {
          throw new Error(`${WSL_VALIDATION_UNAVAILABLE}: seed ignore authority must come from a repository .gitignore`)
        }
        const physicalSource = resolve(main, source)
        if (!inside(main, physicalSource)) throw new Error(`${WSL_VALIDATION_UNAVAILABLE}: seed ignore authority escaped repoRoot`)
        ignoreSources.add(relative(main, physicalSource).replaceAll('\\', '/'))
        ignored.add(path.replaceAll('\\', '/'))
      }
      const trackedIgnoreSources = await run('git', ['-C', main, 'ls-files', '-z', '--', ...ignoreSources], signalOptions)
      const tracked = new Set(trackedIgnoreSources.stdout.split('\0').filter(Boolean).map(path => path.replaceAll('\\', '/')))
      const unexpected = seedSnapshot.paths.filter(path => !ignored.has(path))
      if (trackedIgnoreSources.exitCode !== 0 || unexpected.length || [...ignoreSources].some(path => !tracked.has(path))) {
        throw new Error(`${WSL_VALIDATION_UNAVAILABLE}: seed leaves are not explicit ignored Host-generated files under tracked ignore authority: ${unexpected.slice(0, 8).join(', ')}`)
      }
    }
    if (await sourceAuthorityDigest(main, options.signal) !== sourceAuthority) {
      throw new Error(`${WSL_VALIDATION_UNAVAILABLE}: source Git/index/ignore authority changed while staging seeds`)
    }
    const validationEnvironment = allowlistedEnvironment(options.profile, main)
    writeFileSync(envPath, validationEnvironment.body, { encoding: 'utf8', mode: 0o600 })
    writeFileSync(exportsPath, validationEnvironment.exports, { encoding: 'utf8', mode: 0o600 })
    writeFileSync(statusPath, 'host-launch', { encoding: 'utf8', mode: 0o600 })
    writeFileSync(scriptPath, CAPSULE_SCRIPT, { encoding: 'utf8', mode: 0o700 })
    const archived = await run('git', ['-C', options.root, 'archive', '--format=tar', `--output=${archive}`, options.commitHead], signalOptions)
    if (archived.exitCode !== 0) throw new Error(`${WSL_VALIDATION_UNAVAILABLE}: cannot archive authenticated verification HEAD: ${archived.stderr.trim()}`)
    const [wslScript, wslArchive, wslEnv, wslExports, wslSeed, wslStatus] = await Promise.all(
      [scriptPath, archive, envPath, exportsPath, seedRoot, statusPath].map(async path => await resolveWslPath(options.profile.distribution, path, options.signal)),
    ) as [string, string, string, string, string, string]
    wslMapped = true
    let lastObservedPhase = ''
    const phaseWatcher = options.onPhase ? setInterval(() => {
      try {
        const observed = readFileSync(statusPath, 'utf8').trim()
        if (observed && observed !== lastObservedPhase) {
          lastObservedPhase = observed
          options.onPhase?.(observed)
        }
      } catch { /* the Host-owned receipt may be between atomic staging operations */ }
    }, 100) : undefined
    phaseWatcher?.unref()
    let result: CommandResult
    try {
      result = await run('wsl.exe', [
        '--distribution', options.profile.distribution,
        '--exec', 'bash', wslScript, capsuleId, wslArchive, wslEnv, wslExports, wslSeed, options.profile.prepareBins?.join(':') ?? '', options.profile.prepareScripts?.join(':') ?? '', options.profile.webServerTimeoutMs?.toString() ?? '', options.profile.playwrightConfig ?? '', wslStatus, ...args,
      ], { ...signalOptions, redactions: validationEnvironment.secrets })
    } finally {
      if (phaseWatcher) clearInterval(phaseWatcher)
    }
    const phase = readFileSync(statusPath, 'utf8').trim()
    if (phase !== 'setup' && phase !== 'prepare' && phase !== 'test') {
      throw new Error(`${WSL_VALIDATION_UNAVAILABLE}: phase=${phase || 'unknown'} exit=${result.exitCode}; ${result.stderr.slice(-8 * 1024)}`)
    }
    const sanitizeCandidateMarkers = (text: string): string => text
      .replaceAll(WSL_VALIDATION_UNAVAILABLE, 'CANDIDATE_WSL_VALIDATION_TEXT')
      .replaceAll(WINDOWS_NAMED_PIPE_UNAVAILABLE, 'CANDIDATE_WINDOWS_NAMED_PIPE_TEXT')
    return {
      exitCode: result.exitCode,
      stdout: sanitizeCandidateMarkers(result.stdout),
      stderr: `${sanitizeCandidateMarkers(result.stderr)}\nLEPPY_WSL_SEED_DIGEST=${seedSnapshot.digest}`,
    }
  } catch (error) {
    if (options.signal?.aborted) throw abortError(options.signal)
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(message.startsWith(WSL_VALIDATION_UNAVAILABLE) ? message : `${WSL_VALIDATION_UNAVAILABLE}: ${message}`)
  } finally {
    if (wslMapped) {
      await run('wsl.exe', ['--distribution', options.profile.distribution, '--exec', 'rm', '-rf', '--', capsulePath]).catch(() => undefined)
    }
    rmSync(staging, { recursive: true, force: true })
  }
}

export function namedPipeUnavailableDetail(profile: WslValidationProfile | undefined): string {
  return `${WINDOWS_NAMED_PIPE_UNAVAILABLE}: Playwright cannot create runner/browser named pipes inside the Windows WRITE_RESTRICTED token; validation was not run.${profile ? ' Commit the candidate so the disposable verification worker can use the configured WSL2 capsule.' : ' Configure tracked .leppy-loop.json validationExecutor kind=wsl2; no unconfined fallback is permitted.'}`
}
