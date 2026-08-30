import { createHash } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { delimiter, isAbsolute, relative, resolve, sep } from 'node:path'

const SECRET_NAME = /(token|secret|password|passwd|api[_-]?key|authorization|cookie|credential)/i
const HEADER = /\b(authorization|proxy-authorization|cookie|set-cookie)\s*:\s*[^\r\n]+/gi
const URL_SECRET = /([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+):([^\s/@]+)@/gi
const KNOWN_REMOTE_CLIENTS = new Set(['curl', 'wget', 'ssh', 'scp', 'rsync', 'ftp', 'sftp'])
const SHELLS = new Set(['bash', 'sh', 'zsh', 'fish', 'cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe'])
const POWERSHELLS = new Set(['powershell', 'powershell.exe', 'pwsh', 'pwsh.exe'])
const READ_ONLY_GIT = new Set(['status', 'rev-parse', 'ls-files', 'merge-base', 'name-rev', 'describe'])
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun'])
const PACKAGE_FRONTENDS = new Set(['corepack', 'pnpx', 'yarnpkg'])
const PACKAGE_SCRIPT_COMMANDS: Readonly<Record<string, ReadonlySet<string>>> = {
  npm: new Set(['run', 'run-script', 'test', 't', 'tst']),
  pnpm: new Set(['run', 'run-script', 'test', 't']),
  yarn: new Set(['run', 'test']),
  bun: new Set(['run', 'test']),
}
const PACKAGE_CACHE_FLAGS = /^(?:--cache|--cache-dir|--cache-folder|--store-dir|--state-dir)(?:=|$)/u
const PACKAGE_OPTIONS_WITH_VALUES = new Set([
  '--prefix', '--workspace', '-w', '--userconfig', '--globalconfig', '--registry', '--cache', '--loglevel',
  '--dir', '-c', '--cwd', '--filter', '--config', '--use-yarnrc',
])

export function redact<T>(value: T, knownSecrets: readonly string[] = []): T {
  const visit = (current: unknown, key?: string): unknown => {
    if (key && SECRET_NAME.test(key)) return '[REDACTED]'
    if (typeof current === 'string') {
      let text = current.replace(HEADER, '$1: [REDACTED]').replace(URL_SECRET, '$1[REDACTED]@')
      for (const secret of knownSecrets.filter(Boolean).sort((a, b) => b.length - a.length)) text = text.replaceAll(secret, '[REDACTED]')
      return text
    }
    if (Array.isArray(current)) return current.map(item => visit(item))
    if (current && typeof current === 'object') {
      return Object.fromEntries(Object.entries(current).map(([childKey, child]) => [childKey, visit(child, childKey)]))
    }
    return current
  }
  return visit(value) as T
}

export function scrubEnvironment(environment: NodeJS.ProcessEnv, allow: readonly string[] = []): NodeJS.ProcessEnv {
  const keep = new Set(['PATH', 'Path', 'PATHEXT', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'COMSPEC', 'LANG', 'LC_ALL', 'NODE_OPTIONS', ...allow])
  return Object.fromEntries(Object.entries(environment).filter(([name]) => keep.has(name) && !SECRET_NAME.test(name)))
}

export function fingerprint(command: string): string {
  return createHash('sha256').update(command).digest('hex')
}

function basename(command: string): string {
  return command.replaceAll('\\', '/').split('/').at(-1)!.toLowerCase().replace(/\.(?:cmd|bat|exe|com)$/u, '')
}

function packageCommandWords(args: readonly string[]): string[] {
  const words: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!
    if (argument === '--') break
    if (PACKAGE_OPTIONS_WITH_VALUES.has(argument)) { index += 1; continue }
    if (!argument.startsWith('-')) words.push(argument)
  }
  return words
}

export function validateArgv(command: string, args: readonly string[], cwd: string, repoRoot: string, gateFingerprint?: string): void {
  if (command.trim() === '' || command.includes('\0') || args.some(arg => arg.includes('\0'))) throw new Error('empty or NUL-containing argv denied')
  const executable = basename(command)
  const lowerArgs = args.map(arg => arg.toLowerCase())
  const resolvedCwd = resolve(cwd)
  const root = resolve(repoRoot)
  const cwdRel = relative(root, resolvedCwd)
  if (cwdRel === '..' || cwdRel.startsWith(`..${sep}`) || isAbsolute(cwdRel)) throw new Error('cwd outside worktree denied')
  if (SHELLS.has(executable)) {
    const fileIndexes = lowerArgs.flatMap((arg, index) => arg === '-file' ? [index] : [])
    const fileIndex = fileIndexes[0] ?? -1
    const script = fileIndex >= 0 ? args[fileIndex + 1] : undefined
    const scriptPath = script ? resolve(resolvedCwd, script) : undefined
    const canonicalScript = scriptPath && existsSync(scriptPath) ? realpathSync(scriptPath) : undefined
    const scriptRel = canonicalScript ? relative(root, canonicalScript) : undefined
    const validScript = canonicalScript && scriptRel !== '..' && !scriptRel?.startsWith(`..${sep}`) && !isAbsolute(scriptRel ?? '') && /\.ps1$/iu.test(canonicalScript)
    const allowedPrefix = new Set(['-noprofile', '-noninteractive', '-nologo'])
    const validOptions = lowerArgs.slice(0, fileIndex).every(arg => allowedPrefix.has(arg))
    if (!POWERSHELLS.has(executable) || fileIndexes.length !== 1 || !validOptions || !validScript) {
      throw new Error(`shell interpreter denied: ${executable}; PowerShell requires exact -File, a real repo-local .ps1 script, and only -NoProfile/-NonInteractive/-NoLogo before it`)
    }
  }
  if (KNOWN_REMOTE_CLIENTS.has(executable) || executable === 'gh') throw new Error(`remote client denied: ${executable}`)
  if (executable === 'git') {
    const verb = lowerArgs.find(arg => !arg.startsWith('-'))
    if (!verb) throw new Error('git invocation without a verb denied')
    if (['add', 'commit'].includes(verb)) throw new Error(`git ${verb} must use the dedicated leppy_commit capability`)
    if (!READ_ONLY_GIT.has(verb)) throw new Error(`git ${verb} denied; worker Git access is read-only`)
    if (lowerArgs.some(arg => arg === '--output' || arg.startsWith('--output='))) throw new Error(`git ${verb} output redirection denied`)
    if (lowerArgs.some(arg => ['--no-index', '--ext-diff'].includes(arg))) throw new Error(`git ${verb} external path or executable hooks denied`)
  }
  if (executable === 'npx' || executable === 'bunx' || PACKAGE_FRONTENDS.has(executable)) {
    throw new Error(`${executable} package frontend denied; invoke an already-materialized local binary directly`)
  }
  if (PACKAGE_MANAGERS.has(executable)) {
    const command = packageCommandWords(lowerArgs)[0]
    if (lowerArgs.some(arg => PACKAGE_CACHE_FLAGS.test(arg))) throw new Error(`${executable} project-local cache overrides denied`)
    if (!command || !PACKAGE_SCRIPT_COMMANDS[executable]?.has(command)) {
      throw new Error(`${executable} command denied; workers may use only explicit run/test package scripts`)
    }
  }
  if (['node', 'deno', 'bun'].includes(executable) && lowerArgs.some(arg => ['-e', '--eval', '-p', '--print'].includes(arg))) throw new Error('dynamic program evaluation denied')
  const joined = [command, ...args].join('\0')
  if (gateFingerprint && fingerprint(joined) === gateFingerprint) throw new Error('phase gate command denied inside worker')
}

export function safePathEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const scrubbed = scrubEnvironment(base)
  const pathName = Object.hasOwn(scrubbed, 'Path') ? 'Path' : 'PATH'
  const value = scrubbed[pathName]
  if (value) scrubbed[pathName] = value.split(delimiter).filter(Boolean).join(delimiter)
  return scrubbed
}
