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

export function branchTarget(syncBranch: string): { remote: string; base: string } {
  const value = syncBranch.trim()
  const localHead = value.startsWith('refs/heads/')
  const normalized = localHead ? value.slice('refs/heads/'.length) : value.replace(/^refs\/remotes\//u, '')
  const slash = normalized.indexOf('/')
  const target = !localHead && slash > 0
    ? { remote: normalized.slice(0, slash), base: normalized.slice(slash + 1) }
    : { remote: 'origin', base: normalized }
  const forbidden = ['~', '^', ':', '?', '*', '[', '\\']
  if (!/^[A-Za-z0-9._-]+$/u.test(target.remote) || target.base === '' || target.base.startsWith('/') || target.base.endsWith('/') || target.base.endsWith('.') || target.base.includes('..') || target.base.includes('@{') || /(?:^|\/)\.\.?\/?$/u.test(target.base) || /\s/u.test(target.base) || forbidden.some(character => target.base.includes(character))) {
    throw new Error(`cannot derive a safe remote/base from ${JSON.stringify(syncBranch)}`)
  }
  return target
}

export function githubRepositoryFromRemoteUrl(remoteUrl: string): string {
  const value = remoteUrl.trim()
  const match = /^(?:https?:\/\/github\.com\/|ssh:\/\/(?:git@)?github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/iu.exec(value)
  if (!match) throw new Error('publication remote must be an explicit github.com owner/repository URL')
  return `${match[1]}/${match[2]}`
}

export function pullRequestListArguments(repository: string, branch: string): string[] {
  return ['pr', 'list', '--repo', repository, '--state', 'all', '--head', branch, '--json', 'url,state,headRefName,headRepositoryOwner,baseRefName,headRefOid,mergeCommit', '--limit', '100']
}

export function pullRequestCreateArguments(repository: string, base: string, branch: string): string[] {
  return ['pr', 'create', '--repo', repository, '--base', base, '--head', branch, '--fill']
}

interface ExistingPullRequest {
  url: string
  state: 'OPEN' | 'MERGED'
  base: string
  head: string
  mergeCommit?: string
}

export function parseExistingPullRequest(stdout: string, repository: string, branch: string, expectedHead: string): ExistingPullRequest | undefined {
  let value: unknown
  try { value = JSON.parse(stdout) } catch { return undefined }
  if (!Array.isArray(value)) return undefined
  const owner = repository.split('/')[0]?.toLowerCase()
  const prefix = `https://github.com/${repository.toLowerCase()}/pull/`
  const candidates = value.flatMap(entry => {
    if (!entry || typeof entry !== 'object') return []
    const row = entry as Record<string, unknown>
    const state = row.state
    const headOwner = row.headRepositoryOwner
    const login = headOwner && typeof headOwner === 'object' ? (headOwner as Record<string, unknown>).login : undefined
    const mergeCommit = row.mergeCommit
    const mergeOid = mergeCommit && typeof mergeCommit === 'object' ? (mergeCommit as Record<string, unknown>).oid : undefined
    if ((state !== 'OPEN' && state !== 'MERGED')
      || row.headRefName !== branch
      || typeof login !== 'string' || login.toLowerCase() !== owner
      || typeof row.url !== 'string' || !row.url.toLowerCase().startsWith(prefix)
      || typeof row.baseRefName !== 'string'
      || row.headRefOid !== expectedHead
      || (state === 'MERGED' && (typeof mergeOid !== 'string' || !/^[0-9a-f]{40}$/u.test(mergeOid)))) return []
    return [{ url: row.url, state, base: row.baseRefName, head: expectedHead, ...(typeof mergeOid === 'string' ? { mergeCommit: mergeOid } : {}) } satisfies ExistingPullRequest]
  })
  const open = candidates.filter(candidate => candidate.state === 'OPEN')
  if (open.length > 1) throw new Error('multiple exact open pull requests exist for the authenticated Leppy branch')
  if (open[0]) return open[0]
  const merged = candidates.filter(candidate => candidate.state === 'MERGED')
  if (merged.length > 1) throw new Error('multiple exact merged pull requests exist for the authenticated Leppy branch')
  return merged[0]
}

function parseCreatedPullRequestUrl(stdout: string, repository: string): string | undefined {
  const trimmed = stdout.trim()
  const last = trimmed.split(/\r?\n/u).at(-1)
  if (!last) return undefined
  return last.toLowerCase().startsWith(`https://github.com/${repository.toLowerCase()}/pull/`) ? last : undefined
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

interface PublicationTarget {
  remote: string
  base: string
  requestedBase: string
  baseCommit: string
  repository: string
  fetchUrl: string
  pushUrl: string
  remoteBranchHead?: string
}

function remoteHead(stdout: string, branch: string): string | undefined {
  const suffix = `\trefs/heads/${branch}`
  const line = stdout.split(/\r?\n/u).find(candidate => candidate.endsWith(suffix))
  const hash = line?.slice(0, -suffix.length)
  return hash && /^[0-9a-f]{40}$/u.test(hash) ? hash : undefined
}

async function resolvePublicationTarget(request: PullRequestRequest, remote: string, requestedBase: string, repository: string, fetchUrl: string, pushUrl: string, signal: AbortSignal, execute: typeof runFile): Promise<PublicationTarget> {
  await execute('git', ['fetch', '--prune', fetchUrl, `+refs/heads/*:refs/remotes/${remote}/*`], { cwd: request.worktree, signal, timeoutMs: 120_000 })
  const baseHeads = await execute('git', ['ls-remote', '--heads', fetchUrl, `refs/heads/${requestedBase}`], { cwd: request.worktree, signal, timeoutMs: 60_000 })
  const branchHeads = await execute('git', ['ls-remote', '--heads', pushUrl, `refs/heads/${request.branch}`], { cwd: request.worktree, signal, timeoutMs: 60_000 })
  const requestedHead = remoteHead(baseHeads.stdout, requestedBase)
  const remoteBranchHead = remoteHead(branchHeads.stdout, request.branch)
  if (!requestedHead) throw new Error(`publication base ${remote}/${requestedBase} does not exist on the remote`)

  const originalTarget = request.originalSyncBranch ? branchTarget(request.originalSyncBranch) : undefined
  if (originalTarget && originalTarget.remote !== remote) throw new Error('publication target cannot change the authenticated Git remote')
  if (originalTarget && originalTarget.base !== requestedBase) {
    const priorTarget = request.priorTargetCommit
    if (!priorTarget || !/^[0-9a-f]{40}$/u.test(priorTarget)) throw new Error('publication base retarget requires an authenticated prior target commit')
    await execute('git', ['fetch', fetchUrl, requestedHead], { cwd: request.worktree, signal, timeoutMs: 120_000 })
    const incorporated = await execute('git', ['merge-base', '--is-ancestor', priorTarget, requestedHead], { cwd: request.worktree, signal, allowFailure: true })
    if (incorporated.exitCode !== 0) throw new Error(`publication retarget refuses ${remote}/${requestedBase}: prior target ${priorTarget} is not incorporated`)
  }

  const localHead = (await execute('git', ['rev-parse', 'HEAD'], { cwd: request.worktree, signal })).stdout.trim()
  if (remoteBranchHead && remoteBranchHead !== request.priorRemoteHead) {
    const owned = await execute('git', ['merge-base', '--is-ancestor', remoteBranchHead, localHead], { cwd: request.worktree, signal, allowFailure: true })
    if (owned.exitCode !== 0) throw new Error(`remote Leppy branch ${request.branch} contains commits outside the authenticated local lineage`)
  }
  await execute('git', ['fetch', fetchUrl, requestedHead], { cwd: request.worktree, signal, timeoutMs: 120_000 })
  return { remote, base: requestedBase, requestedBase, baseCommit: requestedHead, repository, fetchUrl, pushUrl, ...(remoteBranchHead ? { remoteBranchHead } : {}) }
}

export async function preparePublicationRebase(request: PullRequestRequest, remote: string, base: string, hooks: PublicationHooks, signal: AbortSignal, fetchRemote = true): Promise<void> {
  if (await rebaseMetadata(request.worktree, signal)) throw new Error('interrupted publication rebase must be aborted before starting a new attempt')
  const status = await runFile('git', ['status', '--porcelain'], { cwd: request.worktree, signal })
  if (status.stdout.trim() !== '') throw new Error('refusing to publish a dirty Leppy worktree')
  if (fetchRemote) await runFile('git', ['fetch', '--prune', remote], { cwd: request.worktree, signal, timeoutMs: 120_000 })
  const upstream = /^[0-9a-f]{40}$/u.test(base) ? base : `${remote}/${base}`
  const rebased = await runFile('git', ['rebase', upstream], { cwd: request.worktree, signal, timeoutMs: 120_000, allowFailure: true })
  if (rebased.exitCode === 0) return
  let conflict = await requireConflictOrAbort(request, `git rebase ${upstream} failed (${rebased.exitCode}): ${rebased.stderr.trim()}`, signal)
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

async function canReconcileExistingPullRequest(request: PullRequestRequest, existing: ExistingPullRequest, remote: string, requestedBase: string, fetchUrl: string, signal: AbortSignal, execute: typeof runFile): Promise<boolean> {
  if (existing.base !== requestedBase) return false
  const original = request.originalSyncBranch ? branchTarget(request.originalSyncBranch) : { remote, base: requestedBase }
  const retargeted = original.remote !== remote || original.base !== requestedBase
  if (existing.state === 'OPEN' && !retargeted) return true
  const priorTarget = request.priorTargetCommit
  if (retargeted && (!priorTarget || !/^[0-9a-f]{40}$/u.test(priorTarget))) return false
  const heads = await execute('git', ['ls-remote', '--heads', fetchUrl, `refs/heads/${requestedBase}`], { cwd: request.worktree, signal, timeoutMs: 60_000 })
  const baseCommit = remoteHead(heads.stdout, requestedBase)
  if (!baseCommit) return false
  await execute('git', ['fetch', fetchUrl, baseCommit], { cwd: request.worktree, signal, timeoutMs: 120_000 })
  if (retargeted) {
    const incorporated = await execute('git', ['merge-base', '--is-ancestor', priorTarget!, baseCommit], { cwd: request.worktree, signal, allowFailure: true })
    if (incorporated.exitCode !== 0) return false
  }
  if (existing.state === 'MERGED') {
    if (!existing.mergeCommit) return false
    const delivered = await execute('git', ['merge-base', '--is-ancestor', existing.mergeCommit, baseCommit], { cwd: request.worktree, signal, allowFailure: true })
    if (delivered.exitCode !== 0) return false
  }
  return true
}

export async function publishPullRequest(request: PullRequestRequest, signal: AbortSignal, hooks: PublicationHooks, execute: typeof runFile = runFile): Promise<{ url: string; validationReceipt: string; reconciledExisting?: boolean }> {
  const requested = branchTarget(request.syncBranch)
  if (requested.base === '') throw new Error(`cannot derive a pull request base from ${JSON.stringify(request.syncBranch)}`)
  const original = request.originalSyncBranch ? branchTarget(request.originalSyncBranch) : requested
  if (original.remote !== requested.remote) throw new Error('publication target cannot change the authenticated Git remote')
  const fetchUrl = (await execute('git', ['remote', 'get-url', requested.remote], { cwd: request.worktree, signal })).stdout.trim()
  const pushUrls = (await execute('git', ['remote', 'get-url', '--push', '--all', requested.remote], { cwd: request.worktree, signal })).stdout.split(/\r?\n/u).map(value => value.trim()).filter(Boolean)
  const uniquePushUrls = [...new Set(pushUrls)]
  if (uniquePushUrls.length !== 1) throw new Error(`publication requires exactly one explicit push URL for remote ${requested.remote}`)
  const fetchRepository = githubRepositoryFromRemoteUrl(fetchUrl)
  const githubRepository = githubRepositoryFromRemoteUrl(uniquePushUrls[0]!)
  if (fetchRepository.toLowerCase() !== githubRepository.toLowerCase()) throw new Error('publication fetch and push URLs target different GitHub repositories')

  const initialHead = (await execute('git', ['rev-parse', 'HEAD'], { cwd: request.worktree, signal })).stdout.trim()
  const listed = await execute('gh', pullRequestListArguments(githubRepository, request.branch), { cwd: request.worktree, signal, timeoutMs: 60_000 })
  const existing = parseExistingPullRequest(listed.stdout, githubRepository, request.branch, initialHead)
  if (existing && await canReconcileExistingPullRequest(request, existing, requested.remote, requested.base, fetchUrl, signal, execute)) {
    return { url: existing.url, validationReceipt: 'reconciled-existing-pr', reconciledExisting: true }
  }

  const target = await resolvePublicationTarget(request, requested.remote, requested.base, githubRepository, fetchUrl, uniquePushUrls[0]!, signal, execute)
  await hooks.recordRemoteHead?.(target.remoteBranchHead)
  await preparePublicationRebase(request, target.remote, target.baseCommit, hooks, signal, false)
  const targetCommit = await expectedBaseCommit(request, target.baseCommit, signal)
  const validation = await hooks.validateBeforePush(targetCommit)
  const ahead = await execute('git', ['rev-list', '--count', `${targetCommit}..HEAD`], { cwd: request.worktree, signal })
  if (Number.parseInt(ahead.stdout.trim(), 10) < 1) throw new Error('refusing to open a pull request without commits')
  if ((await execute('git', ['rev-parse', 'HEAD'], { cwd: request.worktree, signal })).stdout.trim() !== validation.validatedHead) throw new Error('validated publication HEAD changed before push')
  if ((await execute('git', ['status', '--porcelain'], { cwd: request.worktree, signal })).stdout.trim() !== '') throw new Error('validated publication worktree became dirty before push')

  const liveBase = await execute('git', ['ls-remote', '--heads', target.fetchUrl, `refs/heads/${target.base}`], { cwd: request.worktree, signal, timeoutMs: 60_000 })
  const liveBranch = await execute('git', ['ls-remote', '--heads', target.pushUrl, `refs/heads/${request.branch}`], { cwd: request.worktree, signal, timeoutMs: 60_000 })
  if (remoteHead(liveBase.stdout, target.base) !== targetCommit) throw new Error('publication base changed after the final gate')
  if (remoteHead(liveBranch.stdout, request.branch) !== target.remoteBranchHead) throw new Error('remote Leppy branch changed after publication preflight')

  if (target.remoteBranchHead !== validation.validatedHead) {
    const push = ['push', `--force-with-lease=refs/heads/${request.branch}:${target.remoteBranchHead ?? ''}`, target.pushUrl, `HEAD:refs/heads/${request.branch}`]
    const mutate = () => execute('git', push, { cwd: request.worktree, signal, timeoutMs: 5 * 60_000 })
    if (hooks.authorizeRemoteMutation) await hooks.authorizeRemoteMutation(mutate)
    else await mutate()
  }
  const pushed = await execute('git', ['ls-remote', '--heads', target.pushUrl, `refs/heads/${request.branch}`], { cwd: request.worktree, signal, timeoutMs: 60_000 })
  if (remoteHead(pushed.stdout, request.branch) !== validation.validatedHead) throw new Error('remote Leppy branch does not match the validated HEAD after push')
  await hooks.recordRemoteHead?.(validation.validatedHead)

  const relisted = await execute('gh', pullRequestListArguments(target.repository, request.branch), { cwd: request.worktree, signal, timeoutMs: 60_000 })
  const raced = parseExistingPullRequest(relisted.stdout, target.repository, request.branch, validation.validatedHead)
  if (raced && await canReconcileExistingPullRequest(request, raced, target.remote, target.base, target.fetchUrl, signal, execute)) return { url: raced.url, validationReceipt: validation.receipt }
  const create = () => execute('gh', pullRequestCreateArguments(target.repository, target.base, request.branch), { cwd: request.worktree, signal, timeoutMs: 120_000, allowFailure: true })
  const created = hooks.authorizeRemoteMutation ? await hooks.authorizeRemoteMutation(create) : await create()
  const url = created.exitCode === 0 ? parseCreatedPullRequestUrl(created.stdout, target.repository) : undefined
  if (url) return { url, validationReceipt: validation.receipt }
  const afterCreate = await execute('gh', pullRequestListArguments(target.repository, request.branch), { cwd: request.worktree, signal, timeoutMs: 60_000 })
  const concurrent = parseExistingPullRequest(afterCreate.stdout, target.repository, request.branch, validation.validatedHead)
  if (concurrent && await canReconcileExistingPullRequest(request, concurrent, target.remote, target.base, target.fetchUrl, signal, execute)) return { url: concurrent.url, validationReceipt: validation.receipt }
  throw new Error(`gh pr create did not return the expected GitHub pull request URL (${created.exitCode}): ${created.stderr.trim()}`)
}
