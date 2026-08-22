import { createHash } from 'node:crypto'
import { delimiter, isAbsolute, relative, resolve, sep } from 'node:path'

const SECRET_NAME = /(token|secret|password|passwd|api[_-]?key|authorization|cookie|credential)/i
const HEADER = /\b(authorization|proxy-authorization|cookie|set-cookie)\s*:\s*[^\r\n]+/gi
const URL_SECRET = /([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+):([^\s/@]+)@/gi
const KNOWN_REMOTE_CLIENTS = new Set(['curl', 'wget', 'ssh', 'scp', 'rsync', 'ftp', 'sftp'])
const SHELLS = new Set(['bash', 'sh', 'zsh', 'fish', 'cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe'])

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
  return command.replaceAll('\\', '/').split('/').at(-1)!.toLowerCase()
}

export function validateArgv(command: string, args: readonly string[], cwd: string, repoRoot: string, gateFingerprint?: string): void {
  if (command.trim() === '' || command.includes('\0') || args.some(arg => arg.includes('\0'))) throw new Error('empty or NUL-containing argv denied')
  const executable = basename(command)
  const lowerArgs = args.map(arg => arg.toLowerCase())
  if (SHELLS.has(executable)) throw new Error(`shell interpreter denied: ${executable}`)
  if (KNOWN_REMOTE_CLIENTS.has(executable) || executable === 'gh') throw new Error(`remote client denied: ${executable}`)
  if (executable === 'git') {
    const verb = lowerArgs.find(arg => !arg.startsWith('-'))
    if (!verb) throw new Error('git invocation without a verb denied')
    if (['add', 'commit'].includes(verb)) throw new Error(`git ${verb} must use the dedicated leppy_commit capability`)
    if (['push', 'pull', 'fetch', 'remote', 'worktree', 'merge', 'rebase', 'cherry-pick', 'switch', 'checkout'].includes(verb)) throw new Error(`git ${verb} denied`)
  }
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(executable)) {
    const verb = lowerArgs.find(arg => !arg.startsWith('-'))
    if (verb && ['publish', 'login', 'adduser', 'whoami', 'deploy'].includes(verb)) throw new Error(`${executable} ${verb} denied`)
  }
  if (['node', 'deno', 'bun'].includes(executable) && lowerArgs.some(arg => ['-e', '--eval', '-p', '--print'].includes(arg))) throw new Error('dynamic program evaluation denied')
  const resolvedCwd = resolve(cwd)
  const root = resolve(repoRoot)
  const rel = relative(root, resolvedCwd)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('cwd outside worktree denied')
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
