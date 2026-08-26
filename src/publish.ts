import { runFile } from './process.js'
import type { PullRequestRequest } from './types.js'

function branchTarget(syncBranch: string): { remote: string; base: string } {
  const normalized = syncBranch.replace(/^refs\/remotes\//u, '')
  const slash = normalized.indexOf('/')
  if (slash > 0) return { remote: normalized.slice(0, slash), base: normalized.slice(slash + 1) }
  return { remote: 'origin', base: normalized.replace(/^refs\/heads\//u, '') }
}

function parsePullRequestUrl(stdout: string): string | undefined {
  const trimmed = stdout.trim()
  if (trimmed === '') return undefined
  try {
    const value = JSON.parse(trimmed) as unknown
    if (Array.isArray(value)) {
      const first = value[0] as { url?: unknown } | undefined
      return typeof first?.url === 'string' ? first.url : undefined
    }
  } catch {
    // `gh pr create` returns the URL as plain text.
  }
  return /^https:\/\/github\.com\//u.test(trimmed) ? trimmed.split(/\r?\n/u).at(-1) : undefined
}

export async function publishPullRequest(request: PullRequestRequest, signal: AbortSignal): Promise<string> {
  const status = await runFile('git', ['status', '--porcelain'], { cwd: request.worktree, signal })
  if (status.stdout.trim() !== '') throw new Error('refusing to publish a dirty Leppy worktree')

  const { remote, base } = branchTarget(request.syncBranch)
  if (base === '') throw new Error(`cannot derive a pull request base from ${JSON.stringify(request.syncBranch)}`)

  await runFile('git', ['fetch', remote], { cwd: request.worktree, signal, timeoutMs: 120_000 })
  await runFile('git', ['rebase', `${remote}/${base}`], { cwd: request.worktree, signal, timeoutMs: 120_000 })
  const ahead = await runFile('git', ['rev-list', '--count', `${remote}/${base}..HEAD`], { cwd: request.worktree, signal })
  if (Number.parseInt(ahead.stdout.trim(), 10) < 1) throw new Error('refusing to open a pull request without commits')

  await runFile('git', ['push', '--set-upstream', remote, `HEAD:refs/heads/${request.branch}`], {
    cwd: request.worktree,
    signal,
    timeoutMs: 5 * 60_000,
  })

  const existing = await runFile('gh', [
    'pr', 'list', '--state', 'all', '--head', request.branch,
    '--json', 'url', '--limit', '1',
  ], { cwd: request.worktree, signal, timeoutMs: 60_000 })
  const existingUrl = parsePullRequestUrl(existing.stdout)
  if (existingUrl) return existingUrl

  const created = await runFile('gh', [
    'pr', 'create', '--base', base, '--head', request.branch, '--fill',
  ], { cwd: request.worktree, signal, timeoutMs: 120_000 })
  const url = parsePullRequestUrl(created.stdout)
  if (!url) throw new Error('gh pr create did not return a GitHub pull request URL')
  return url
}
