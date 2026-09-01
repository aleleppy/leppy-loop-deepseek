import { createHash } from 'node:crypto'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { runFile, runFileBuffer } from './process.js'
import { loadWslValidationProfile } from './wsl-validation.js'

export interface GitSetup {
  repoRoot: string
  commonDir: string
  sourceHead: string
  branch: string
  worktree: string
  checklistRelative: string
}

export async function resolveRepoRoot(start: string, signal?: AbortSignal): Promise<string> {
  return realpathSync((await runFile('git', ['rev-parse', '--show-toplevel'], { cwd: start, signal })).stdout.trim())
}

export async function assertSourceReady(repoRoot: string, checklistPath: string, signal?: AbortSignal): Promise<void> {
  const status = (await runFile('git', ['status', '--porcelain=v1', '-z', '--untracked-files=normal'], { cwd: repoRoot, signal })).stdout
  const records = status.split('\0').filter(Boolean)
  const trackedLocalProfile = await runFile('git', ['ls-files', '--error-unmatch', '--', '.leppy-loop.local.json'], { cwd: repoRoot, allowFailure: true, signal })
  if (trackedLocalProfile.exitCode === 0) throw new Error('Host-local .leppy-loop.local.json must remain untracked; use tracked .leppy-loop.json for portable authority')
  const localProfileRecord = '?? .leppy-loop.local.json'
  if (records.some(record => record !== localProfileRecord)) throw new Error('source checkout must be clean before Leppy Loop starts')
  if (records.includes(localProfileRecord)) {
    const localProfile = resolve(repoRoot, '.leppy-loop.local.json')
    const stat = lstatSync(localProfile)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 64 * 1024
      || !inside(realpathSync(repoRoot), realpathSync(localProfile))) {
      throw new Error('Host-local .leppy-loop.local.json must be one private regular file inside the source checkout and at most 64 KiB')
    }
    loadWslValidationProfile(repoRoot)
  }
  const tracked = await runFile('git', ['ls-files', '--error-unmatch', '--', checklistPath], { cwd: repoRoot, allowFailure: true, signal })
  if (tracked.exitCode !== 0) throw new Error('controlling checklist must be tracked by Git')
}

export async function createRunWorktree(repoRoot: string, checklistRelative: string, syncBranch: string, runId: string, fetch: boolean, syncMaxSeconds: number, signal?: AbortSignal): Promise<GitSetup> {
  await assertSourceReady(repoRoot, checklistRelative, signal)
  if (fetch) await runFile('git', ['fetch', '--prune'], { cwd: repoRoot, timeoutMs: syncMaxSeconds * 1000, signal })
  const base = (await runFile('git', ['rev-parse', '--verify', `${syncBranch}^{commit}`], { cwd: repoRoot, signal })).stdout.trim()
  signal?.throwIfAborted()
  const slug = basename(checklistRelative).replace(/\.task\.md$/i, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'tasks'
  const branch = `leppy-loop/${slug}-${runId}`
  const worktree = resolve(dirname(repoRoot), `${basename(repoRoot)}-${slug}-${runId}`)
  // Worktree creation is a short critical section. Finish it and persist run
  // ownership before the controller observes a cancellation.
  await runFile('git', ['worktree', 'add', '-b', branch, worktree, base], { cwd: repoRoot })
  const commonRaw = (await runFile('git', ['rev-parse', '--git-common-dir'], { cwd: repoRoot })).stdout.trim()
  const commonDir = realpathSync(resolve(repoRoot, commonRaw))
  return { repoRoot, commonDir, sourceHead: base, branch, worktree, checklistRelative }
}

function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function registryPath(path: string): string {
  const normalized = resolve(path).replaceAll('\\', '/')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

async function verificationRegistration(repoRoot: string, worktree: string): Promise<{ head: string; detached: boolean } | undefined> {
  const output = (await runFile('git', ['worktree', 'list', '--porcelain', '-z'], { cwd: repoRoot })).stdout
  const expected = registryPath(worktree)
  const matches = output.split('\0\0').map(record => record.split('\0').filter(Boolean)).filter(fields => {
    const path = fields.find(field => field.startsWith('worktree '))?.slice('worktree '.length)
    return path !== undefined && registryPath(path) === expected
  })
  if (matches.length > 1) throw new Error('verification worktree has ambiguous Git registrations')
  const fields = matches[0]
  if (!fields) return undefined
  const registeredHead = fields.find(field => field.startsWith('HEAD '))?.slice('HEAD '.length)
  if (!registeredHead || !/^[0-9a-f]{40}$/u.test(registeredHead)) throw new Error('verification worktree registration lacks an exact HEAD')
  return { head: registeredHead, detached: fields.includes('detached') }
}

/** Remove only the exact authenticated disposable registration, including add-crash metadata with no directory. */
export async function reconcileVerificationWorktreeRegistration(repoRoot: string, worktree: string, commit: string): Promise<void> {
  const expected = resolve(worktree)
  const commonRaw = (await runFile('git', ['rev-parse', '--git-common-dir'], { cwd: repoRoot })).stdout.trim()
  const commonDir = resolve(repoRoot, commonRaw)
  if (!inside(resolve(commonDir, 'leppy-loop', 'runs'), expected)) throw new Error('verification worktree path escapes private run state')
  const registration = await verificationRegistration(repoRoot, expected)
  if (!registration) {
    if (!existsSync(expected)) return
    if (realpathSync(expected) !== expected) throw new Error('unregistered verification worktree canonical identity changed')
    rmSync(expected, { recursive: true, force: false })
    if (existsSync(expected)) throw new Error('unregistered verification worktree target remained after exact reconciliation')
    return
  }
  if (registration.head !== commit || !registration.detached) throw new Error('retained verification worktree registration identity changed')
  if (existsSync(expected)) {
    if (realpathSync(expected) !== expected) throw new Error('retained verification worktree canonical identity changed')
    await discardVerificationWorktree(repoRoot, expected)
    return
  }
  const removed = await runFile('git', ['worktree', 'remove', '--force', expected], { cwd: repoRoot, allowFailure: true })
  if (removed.exitCode === 0) {
    if (await verificationRegistration(repoRoot, expected)) throw new Error('verification worktree registration remained after Git removal')
    return
  }
  const adminRoot = resolve(commonDir, 'worktrees')
  const matches = existsSync(adminRoot) ? readdirSync(adminRoot, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => resolve(adminRoot, entry.name)).filter(admin => {
    const gitdir = resolve(admin, 'gitdir')
    if (!existsSync(gitdir)) return false
    const target = readFileSync(gitdir, 'utf8').trim().replaceAll('\\', '/').replace(/\/\.git$/u, '')
    return registryPath(target) === registryPath(expected)
  }) : []
  if (matches.length !== 1) throw new Error('missing verification worktree has ambiguous administrative metadata')
  const adminHead = readFileSync(resolve(matches[0]!, 'HEAD'), 'utf8').trim()
  if (adminHead !== commit) throw new Error('missing verification worktree administrative HEAD changed')
  rmSync(matches[0]!, { recursive: true, force: false })
  if (await verificationRegistration(repoRoot, expected)) throw new Error('verification worktree registration remained after exact reconciliation')
}

/** Create one detached disposable worktree pinned to an authenticated committed task. */
export async function createVerificationWorktree(repoRoot: string, worktree: string, commit: string, signal?: AbortSignal): Promise<string> {
  const expected = resolve(worktree)
  await reconcileVerificationWorktreeRegistration(repoRoot, expected, commit)
  try {
    await runFile('git', ['worktree', 'add', '--detach', expected, commit], { cwd: repoRoot, signal })
  } catch (error) {
    await reconcileVerificationWorktreeRegistration(repoRoot, expected, commit)
    throw error
  }
  const actual = realpathSync(expected)
  if (actual !== expected) {
    await runFile('git', ['worktree', 'remove', '--force', expected], { cwd: repoRoot, allowFailure: true })
    throw new Error('verification worktree canonical identity changed during creation')
  }
  return actual
}

export async function discardVerificationWorktree(repoRoot: string, worktree: string): Promise<void> {
  await runFile('git', ['worktree', 'remove', '--force', worktree], { cwd: repoRoot })
  if (existsSync(worktree)) throw new Error('verification worktree remained after authenticated removal')
}

/** Roll back a worktree that this invocation created but has not started using. */
export async function discardUnstartedRunWorktree(repoRoot: string, worktree: string, branch: string): Promise<void> {
  await runFile('git', ['worktree', 'remove', '--force', worktree], { cwd: repoRoot })
  await runFile('git', ['branch', '-D', branch], { cwd: repoRoot })
}

export async function head(cwd: string): Promise<string> {
  return (await runFile('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim()
}

export async function branch(cwd: string): Promise<string> {
  return (await runFile('git', ['branch', '--show-current'], { cwd })).stdout.trim()
}

export async function status(cwd: string): Promise<string> {
  return (await runFile('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd })).stdout
}

/** Bind ignored paths and bytes outside separately authenticated dependency/cache roots. */
export async function verificationStatus(cwd: string, signal?: AbortSignal): Promise<string> {
  return (await runFile('git', [
    'status', '--porcelain=v1', '--untracked-files=all', '--', '.', ':(exclude,glob)**/node_modules/**',
  ], { cwd, signal })).stdout
}

function strictGitNulPaths(output: Buffer, label: string): string[] {
  const paths: string[] = []
  let start = 0
  for (let index = 0; index <= output.length; index += 1) {
    if (index < output.length && output[index] !== 0) continue
    if (index > start) {
      const bytes = output.subarray(start, index)
      const path = bytes.toString('utf8')
      if (!Buffer.from(path, 'utf8').equals(bytes)) throw new Error(`${label} contains a non-UTF-8 path`)
      if (process.platform === 'win32' && path.includes('\\')) {
        throw new Error(`${label} contains a Windows-noncanonical backslash path`)
      }
      paths.push(path)
    }
    start = index + 1
  }
  return paths
}

export interface IgnoredPathSnapshot {
  entries: readonly string[]
  digest: string
}

export async function ignoredPathSnapshot(cwd: string, signal?: AbortSignal): Promise<IgnoredPathSnapshot> {
  const output = await runFileBuffer('git', [
    'ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--', '.',
    ':(exclude,glob)**/node_modules/**', ':(exclude,glob).npm-cache/**', ':(exclude,glob)**/.npm-cache/**',
  ], { cwd, signal })
  const paths = strictGitNulPaths(output, 'ignored artifact baseline').sort()
  if (paths.length > 100_000) throw new Error('ignored artifact baseline exceeds 100000 paths')
  let totalBytes = 0
  const entries = paths.map(path => {
    const absolute = resolve(cwd, path)
    const stat = lstatSync(absolute)
    if (stat.isSymbolicLink()) return `${path}\0link\0${readlinkSync(absolute)}`
    if (!stat.isFile()) return `${path}\0${stat.isDirectory() ? 'directory' : 'special'}\0${stat.mode}`
    totalBytes += stat.size
    if (totalBytes > 512 * 1024 * 1024) throw new Error('ignored artifact baseline exceeds 512 MiB')
    return `${path}\0file\0${stat.size}\0${createHash('sha256').update(readFileSync(absolute)).digest('hex')}`
  })
  return { entries, digest: createHash('sha256').update(JSON.stringify(entries)).digest('hex') }
}

export async function ignoredPathDigest(cwd: string, signal?: AbortSignal): Promise<string> {
  return (await ignoredPathSnapshot(cwd, signal)).digest
}

export async function commitCount(cwd: string, fromExclusive: string): Promise<number> {
  return Number((await runFile('git', ['rev-list', '--count', `${fromExclusive}..HEAD`], { cwd })).stdout.trim())
}

export async function commitSubject(cwd: string): Promise<string> {
  return (await runFile('git', ['log', '-1', '--pretty=%s'], { cwd })).stdout.trim()
}

export function isConventional(subject: string): boolean {
  return /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^)]+\))?!?:\s+\S/.test(subject)
}

export async function writeChecklistAndAmend(cwd: string, relativePath: string, source: string, fallbackSubject: string): Promise<void> {
  const absolute = resolve(cwd, relativePath)
  mkdirSync(dirname(absolute), { recursive: true })
  const prior = readFileSync(absolute, 'utf8')
  const eol = prior.includes('\r\n') ? '\r\n' : '\n'
  writeFileSync(absolute, source.replaceAll('\n', eol), 'utf8')
  await runFile('git', ['add', '--', relativePath], { cwd })
  const hasHead = (await runFile('git', ['rev-parse', '--verify', 'HEAD'], { cwd, allowFailure: true })).exitCode === 0
  if (hasHead) await runFile('git', ['commit', '--amend', '--no-edit'], { cwd })
  else await runFile('git', ['commit', '-m', fallbackSubject], { cwd })
}

export async function commitControllerChange(cwd: string, paths: readonly string[], subject: string): Promise<void> {
  await runFile('git', ['add', '--', ...paths], { cwd })
  await runFile('git', ['commit', '-m', subject], { cwd })
}

export async function assertTaskCommit(cwd: string, previousHead: string, expectedBranch: string): Promise<void> {
  if (await branch(cwd) !== expectedBranch) throw new Error('worker changed the run branch')
  const count = await commitCount(cwd, previousHead)
  if (count !== 1) throw new Error(`worker must create exactly one commit; observed ${count}`)
  const subject = await commitSubject(cwd)
  if (!isConventional(subject)) throw new Error(`worker commit is not conventional: ${JSON.stringify(subject)}`)
  if ((await status(cwd)).trim() !== '') throw new Error('worker must leave a clean tree')
}

export async function summarizeDiff(cwd: string, from: string): Promise<string> {
  return (await runFile('git', ['diff', '--stat', `${from}..HEAD`], { cwd })).stdout
}
