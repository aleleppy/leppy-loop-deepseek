import { basename, dirname, resolve } from 'node:path'
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { runFile } from './process.js'

export interface GitSetup {
  repoRoot: string
  commonDir: string
  sourceHead: string
  branch: string
  worktree: string
  checklistRelative: string
}

export async function resolveRepoRoot(start: string): Promise<string> {
  return realpathSync((await runFile('git', ['rev-parse', '--show-toplevel'], { cwd: start })).stdout.trim())
}

export async function assertSourceReady(repoRoot: string, checklistPath: string): Promise<void> {
  const status = (await runFile('git', ['status', '--porcelain=v1', '--untracked-files=normal'], { cwd: repoRoot })).stdout
  if (status.trim() !== '') throw new Error('source checkout must be clean before Leppy Loop starts')
  const tracked = await runFile('git', ['ls-files', '--error-unmatch', '--', checklistPath], { cwd: repoRoot, allowFailure: true })
  if (tracked.exitCode !== 0) throw new Error('controlling checklist must be tracked by Git')
}

export async function createRunWorktree(repoRoot: string, checklistRelative: string, syncBranch: string, runId: string, fetch: boolean, syncMaxSeconds: number): Promise<GitSetup> {
  await assertSourceReady(repoRoot, checklistRelative)
  if (fetch) await runFile('git', ['fetch', '--prune'], { cwd: repoRoot, timeoutMs: syncMaxSeconds * 1000 })
  const base = (await runFile('git', ['rev-parse', '--verify', `${syncBranch}^{commit}`], { cwd: repoRoot })).stdout.trim()
  const slug = basename(checklistRelative).replace(/\.task\.md$/i, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'tasks'
  const branch = `leppy-loop/${slug}-${runId}`
  const worktree = resolve(dirname(repoRoot), `${basename(repoRoot)}-${slug}-${runId}`)
  await runFile('git', ['worktree', 'add', '-b', branch, worktree, base], { cwd: repoRoot })
  const commonRaw = (await runFile('git', ['rev-parse', '--git-common-dir'], { cwd: repoRoot })).stdout.trim()
  const commonDir = realpathSync(resolve(repoRoot, commonRaw))
  return { repoRoot, commonDir, sourceHead: base, branch, worktree, checklistRelative }
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
