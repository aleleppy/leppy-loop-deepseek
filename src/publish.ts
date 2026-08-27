import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { runFile } from './process.js'
import type { PublicationHooks, PullRequestRequest } from './types.js'

export class PublicationConflictError extends Error {
  constructor(
    readonly paths: string[],
    readonly detail: string,
  ) {
    super(`pull request rebase requires bounded conflict repair in: ${paths.join(', ')}`)
    this.name = 'PublicationConflictError'
  }
}

interface RebaseMetadata {
  backend: 'rebase-merge' | 'rebase-apply'
  root: string
  headName: string
  onto: string
  originalHead: string
}

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

async function gitPath(worktree: string, relative: string, signal: AbortSignal): Promise<string> {
  const result = await runFile('git', ['rev-parse', '--git-path', relative], { cwd: worktree, signal })
  const path = result.stdout.trim()
  return isAbsolute(path) ? path : resolve(worktree, path)
}

async function rebaseMetadata(worktree: string, signal: AbortSignal): Promise<RebaseMetadata | undefined> {
  const matches: RebaseMetadata[] = []
  for (const backend of ['rebase-merge', 'rebase-apply'] as const) {
    const root = await gitPath(worktree, backend, signal)
    if (!existsSync(root)) continue
    const headNamePath = resolve(root, 'head-name')
    const ontoPath = resolve(root, 'onto')
    const originalHeadPath = resolve(root, 'orig-head')
    if (![headNamePath, ontoPath, originalHeadPath].every(existsSync)) throw new Error(`incomplete ${backend} metadata refuses publication recovery`)
    matches.push({
      backend,
      root,
      headName: readFileSync(headNamePath, 'utf8').trim(),
      onto: readFileSync(ontoPath, 'utf8').trim(),
      originalHead: readFileSync(originalHeadPath, 'utf8').trim(),
    })
  }
  if (matches.length > 1) throw new Error('ambiguous simultaneous rebase backends refuse publication recovery')
  return matches[0]
}

async function conflictPaths(worktree: string, signal: AbortSignal): Promise<string[]> {
  const result = await runFile('git', ['diff', '--name-only', '--diff-filter=U', '-z'], { cwd: worktree, signal })
  return [...new Set(result.stdout.split('\0').filter(Boolean))]
}

async function expectedBaseCommit(request: PullRequestRequest, targetRef: string, signal: AbortSignal): Promise<string> {
  return (await runFile('git', ['rev-parse', '--verify', `${targetRef}^{commit}`], { cwd: request.worktree, signal })).stdout.trim()
}

async function validateRebaseIdentity(request: PullRequestRequest, metadata: RebaseMetadata, targetRef: string, signal: AbortSignal): Promise<void> {
  if (metadata.headName !== `refs/heads/${request.branch}`) throw new Error('publication rebase head-name does not match the authenticated Leppy branch')
  const currentBase = await expectedBaseCommit(request, targetRef, signal)
  if (metadata.onto !== currentBase) {
    const ancestor = await runFile('git', ['merge-base', '--is-ancestor', metadata.onto, currentBase], { cwd: request.worktree, signal, allowFailure: true })
    if (ancestor.exitCode !== 0) throw new Error('publication rebase onto is not the authoritative base or its ancestor')
  }
  if (!/^[0-9a-f]{40}$/u.test(metadata.originalHead)) throw new Error('publication rebase original head is invalid')
  const branchHead = (await runFile('git', ['rev-parse', '--verify', `refs/heads/${request.branch}^{commit}`], { cwd: request.worktree, signal })).stdout.trim()
  if (branchHead !== metadata.originalHead) throw new Error('publication rebase original head does not match the authenticated branch ref')
}

/** Read-only proof that a detached worktree is the authenticated publication rebase. */
export async function isAuthenticatedPublicationRebase(request: PullRequestRequest, signal: AbortSignal): Promise<boolean> {
  const metadata = await rebaseMetadata(request.worktree, signal)
  if (!metadata) return false
  const { remote, base } = branchTarget(request.syncBranch)
  try {
    await validateRebaseIdentity(request, metadata, `${remote}/${base}`, signal)
    return true
  } catch {
    return false
  }
}

/** Discard any partial/manual prior resolution before a newly granted publication attempt. */
export async function abortInterruptedPublicationRebase(request: PullRequestRequest, signal: AbortSignal): Promise<boolean> {
  const metadata = await rebaseMetadata(request.worktree, signal)
  if (!metadata) return false
  const { remote, base } = branchTarget(request.syncBranch)
  await validateRebaseIdentity(request, metadata, `${remote}/${base}`, signal)
  await runFile('git', ['rebase', '--abort'], { cwd: request.worktree, signal, timeoutMs: 30_000 })
  const branch = (await runFile('git', ['branch', '--show-current'], { cwd: request.worktree, signal })).stdout.trim()
  if (branch !== request.branch) throw new Error('publication rebase abort did not restore the authenticated Leppy branch')
  const status = await runFile('git', ['status', '--porcelain'], { cwd: request.worktree, signal })
  if (status.stdout.trim() !== '') throw new Error('publication rebase abort did not restore a clean worktree')
  return true
}

async function abortFailedPublicationRebase(request: PullRequestRequest, original: unknown): Promise<never> {
  const originalMessage = original instanceof Error ? original.message : String(original)
  const aborted = await runFile('git', ['rebase', '--abort'], { cwd: request.worktree, timeoutMs: 30_000, allowFailure: true })
  const [metadata, branch, head, branchHead, status] = await Promise.all([
    rebaseMetadata(request.worktree, new AbortController().signal).catch(() => ({ invalid: true })),
    runFile('git', ['branch', '--show-current'], { cwd: request.worktree, allowFailure: true }),
    runFile('git', ['rev-parse', 'HEAD'], { cwd: request.worktree, allowFailure: true }),
    runFile('git', ['rev-parse', `refs/heads/${request.branch}`], { cwd: request.worktree, allowFailure: true }),
    runFile('git', ['status', '--porcelain'], { cwd: request.worktree, allowFailure: true }),
  ])
  const restored = metadata === undefined
    && branch.exitCode === 0 && branch.stdout.trim() === request.branch
    && head.exitCode === 0 && branchHead.exitCode === 0 && head.stdout.trim() === branchHead.stdout.trim()
    && status.exitCode === 0 && status.stdout.trim() === ''
  if (!restored) {
    const abortDetail = `${aborted.stderr}\n${branch.stderr}\n${head.stderr}\n${branchHead.stderr}\n${status.stderr}`.trim().slice(-8 * 1024)
    throw new Error(`${originalMessage}; publication rollback failed (abort exit ${aborted.exitCode})${abortDetail ? `: ${abortDetail}` : ''}`)
  }
  throw original
}

async function requireConflictOrAbort(request: PullRequestRequest, detail: string, signal: AbortSignal): Promise<PublicationConflictError> {
  const paths = await conflictPaths(request.worktree, signal)
  if (paths.length > 0) return new PublicationConflictError(paths, detail)
  await runFile('git', ['rebase', '--abort'], { cwd: request.worktree, timeoutMs: 30_000, allowFailure: true })
  throw new Error(detail)
}

interface ConflictRepairSnapshot {
  head: string
  index: string
  paths: string[]
}

function samePaths(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify([...new Set(left)].sort()) === JSON.stringify([...new Set(right)].sort())
}

async function conflictRepairSnapshot(request: PullRequestRequest, signal: AbortSignal): Promise<ConflictRepairSnapshot> {
  return {
    head: (await runFile('git', ['rev-parse', 'HEAD'], { cwd: request.worktree, signal })).stdout.trim(),
    index: (await runFile('git', ['ls-files', '--stage', '-z'], { cwd: request.worktree, signal })).stdout,
    paths: (await conflictPaths(request.worktree, signal)).sort(),
  }
}

async function continueAfterValidatedRepair(
  request: PullRequestRequest,
  snapshot: ConflictRepairSnapshot,
  signal: AbortSignal,
): Promise<{ done: true } | { conflict: PublicationConflictError }> {
  if (!await isAuthenticatedPublicationRebase(request, signal)) throw new Error('publication conflict worker changed the authenticated rebase identity')
  const currentHead = (await runFile('git', ['rev-parse', 'HEAD'], { cwd: request.worktree, signal })).stdout.trim()
  if (currentHead !== snapshot.head) throw new Error('publication conflict worker changed HEAD')
  const currentIndex = (await runFile('git', ['ls-files', '--stage', '-z'], { cwd: request.worktree, signal })).stdout
  if (currentIndex !== snapshot.index) throw new Error('publication conflict worker changed the Git index')
  const unresolved = await conflictPaths(request.worktree, signal)
  if (!samePaths(unresolved, snapshot.paths)) throw new Error('publication conflict worker changed the exact unmerged path set')
  const unstaged = (await runFile('git', ['diff', '--name-only', '-z'], { cwd: request.worktree, signal })).stdout.split('\0').filter(Boolean)
  if (!unstaged.every(path => snapshot.paths.includes(path))) throw new Error('publication conflict worker changed a path outside the exact unmerged set')
  const untracked = (await runFile('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: request.worktree, signal })).stdout.split('\0').filter(Boolean)
  if (untracked.length > 0) throw new Error('publication conflict worker created untracked paths')

  await runFile('git', ['add', '-A', '--', ...snapshot.paths], { cwd: request.worktree, signal })
  if ((await conflictPaths(request.worktree, signal)).length > 0) throw new Error('controller staging left unresolved publication conflicts')
  const residue = (await runFile('git', ['diff', '--name-only', '-z'], { cwd: request.worktree, signal })).stdout.split('\0').filter(Boolean)
  if (residue.length > 0) throw new Error('publication conflict repair left unstaged paths')
  const staged = await runFile('git', ['diff', '--cached', '--quiet', '--exit-code'], { cwd: request.worktree, signal, allowFailure: true })
  if (![0, 1].includes(staged.exitCode)) throw new Error(`cannot inspect the resolved rebase step (${staged.exitCode}): ${staged.stderr.trim()}`)
  const action = staged.exitCode === 0 ? '--skip' : '--continue'
  const continued = await runFile('git', ['rebase', action], {
    cwd: request.worktree,
    signal,
    timeoutMs: 120_000,
    allowFailure: true,
    env: { ...process.env, GIT_EDITOR: ':' },
  })
  if (continued.exitCode === 0) return { done: true }
  return { conflict: await requireConflictOrAbort(request, `git rebase ${action} failed (${continued.exitCode}): ${continued.stderr.trim()}`, signal) }
}

export async function preparePublicationRebase(request: PullRequestRequest, remote: string, base: string, hooks: PublicationHooks, signal: AbortSignal): Promise<void> {
  if (await rebaseMetadata(request.worktree, signal)) throw new Error('interrupted publication rebase must be aborted before starting a new attempt')
  const status = await runFile('git', ['status', '--porcelain'], { cwd: request.worktree, signal })
  if (status.stdout.trim() !== '') throw new Error('refusing to publish a dirty Leppy worktree')
  await runFile('git', ['fetch', remote], { cwd: request.worktree, signal, timeoutMs: 120_000 })
  const rebased = await runFile('git', ['rebase', `${remote}/${base}`], { cwd: request.worktree, signal, timeoutMs: 120_000, allowFailure: true })
  if (rebased.exitCode === 0) return
  let conflict = await requireConflictOrAbort(request, `git rebase ${remote}/${base} failed (${rebased.exitCode}): ${rebased.stderr.trim()}`, signal)
  for (;;) {
    let snapshot: ConflictRepairSnapshot
    try {
      snapshot = await conflictRepairSnapshot(request, signal)
      if (!samePaths(snapshot.paths, conflict.paths)) throw new Error('publication conflict receipt does not match the live unmerged set')
      await hooks.repairConflict(conflict)
    } catch (error) {
      return await abortFailedPublicationRebase(request, error)
    }
    let next: { done: true } | { conflict: PublicationConflictError }
    try {
      next = await continueAfterValidatedRepair(request, snapshot, signal)
    } catch (error) {
      return await abortFailedPublicationRebase(request, error)
    }
    if ('done' in next) return
    conflict = next.conflict
  }
}

export async function publishPullRequest(request: PullRequestRequest, signal: AbortSignal, hooks: PublicationHooks): Promise<{ url: string; validationReceipt: string }> {
  const { remote, base } = branchTarget(request.syncBranch)
  if (base === '') throw new Error(`cannot derive a pull request base from ${JSON.stringify(request.syncBranch)}`)

  await preparePublicationRebase(request, remote, base, hooks, signal)
  const targetCommit = await expectedBaseCommit(request, `${remote}/${base}`, signal)
  const validationReceipt = await hooks.validateBeforePush(targetCommit)
  const ahead = await runFile('git', ['rev-list', '--count', `${remote}/${base}..HEAD`], { cwd: request.worktree, signal })
  if (Number.parseInt(ahead.stdout.trim(), 10) < 1) throw new Error('refusing to open a pull request without commits')

  await runFile('git', ['push', '--set-upstream', remote, `HEAD:refs/heads/${request.branch}`], { cwd: request.worktree, signal, timeoutMs: 5 * 60_000 })
  const existing = await runFile('gh', ['pr', 'list', '--state', 'all', '--head', request.branch, '--json', 'url', '--limit', '1'], { cwd: request.worktree, signal, timeoutMs: 60_000 })
  const existingUrl = parsePullRequestUrl(existing.stdout)
  if (existingUrl) return { url: existingUrl, validationReceipt }

  const created = await runFile('gh', ['pr', 'create', '--base', base, '--head', request.branch, '--fill'], { cwd: request.worktree, signal, timeoutMs: 120_000 })
  const url = parsePullRequestUrl(created.stdout)
  if (!url) throw new Error('gh pr create did not return a GitHub pull request URL')
  return { url, validationReceipt }
}
