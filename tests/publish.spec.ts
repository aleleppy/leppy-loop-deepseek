import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  abortInterruptedPublicationRebase,
  branchTarget,
  githubRepositoryFromRemoteUrl,
  parseExistingPullRequest,
  publishPullRequest,
  isAuthenticatedPublicationRebase,
  preparePublicationRebase,
  pullRequestCreateArguments,
  pullRequestListArguments,
} from '../src/publish.js'
import { runFile } from '../src/process.js'
import type { PullRequestRequest } from '../src/types.js'

const TEST_GITHUB_REMOTE = 'https://github.com/aleleppy/elysium-ts.git'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

async function runPublicationFile(file: string, args: readonly string[], options?: Parameters<typeof runFile>[2]): ReturnType<typeof runFile> {
  return await runFile(file, args.map(value => value === TEST_GITHUB_REMOTE ? 'origin' : value), options)
}

function repository(backend: 'merge' | 'apply'): { root: string; request: PullRequestRequest } {
  const root = mkdtempSync(join(tmpdir(), 'leppy-publish-'))
  git(root, 'init', '-b', 'main')
  git(root, 'config', 'user.email', 'tests@example.invalid')
  git(root, 'config', 'user.name', 'Leppy Tests')
  git(root, 'config', 'core.autocrlf', 'false')
  git(root, 'config', 'rebase.backend', backend)
  writeFileSync(join(root, 'conflict.txt'), 'seed\n')
  writeFileSync(join(root, 'clean.txt'), 'seed\n')
  git(root, 'add', '--', 'conflict.txt', 'clean.txt')
  git(root, 'commit', '-m', 'chore: seed')

  git(root, 'checkout', '-b', 'feature')
  writeFileSync(join(root, 'conflict.txt'), 'feature\n')
  writeFileSync(join(root, 'clean.txt'), 'feature-clean\n')
  git(root, 'commit', '-am', 'feat: change conflict and clean paths')

  git(root, 'checkout', 'main')
  writeFileSync(join(root, 'conflict.txt'), 'base\n')
  git(root, 'commit', '-am', 'fix: advance base conflict')
  git(root, 'checkout', 'feature')
  git(root, 'remote', 'add', 'origin', root)
  git(root, 'fetch', 'origin')

  return {
    root,
    request: { runId: 'publish-test', repoRoot: root, worktree: root, branch: 'feature', syncBranch: 'origin/main' },
  }
}

function emptyConflictRepository(): { root: string; request: PullRequestRequest } {
  const root = mkdtempSync(join(tmpdir(), 'leppy-publish-empty-'))
  git(root, 'init', '-b', 'main')
  git(root, 'config', 'user.email', 'tests@example.invalid')
  git(root, 'config', 'user.name', 'Leppy Tests')
  git(root, 'config', 'core.autocrlf', 'false')
  git(root, 'config', 'rebase.backend', 'apply')
  writeFileSync(join(root, 'conflict.txt'), 'seed\n')
  git(root, 'add', '--', 'conflict.txt')
  git(root, 'commit', '-m', 'chore: seed')
  git(root, 'checkout', '-b', 'feature')
  writeFileSync(join(root, 'conflict.txt'), 'feature\n')
  git(root, 'commit', '-am', 'feat: conflicting change')
  git(root, 'checkout', 'main')
  writeFileSync(join(root, 'conflict.txt'), 'base\n')
  git(root, 'commit', '-am', 'fix: authoritative base value')
  git(root, 'checkout', 'feature')
  git(root, 'remote', 'add', 'origin', root)
  git(root, 'fetch', 'origin')
  return { root, request: { runId: 'empty-publish-test', repoRoot: root, worktree: root, branch: 'feature', syncBranch: 'origin/main' } }
}

function deletedBaseRepository(): { root: string; request: PullRequestRequest; priorTarget: string; remoteFeature: string } {
  const root = mkdtempSync(join(tmpdir(), 'leppy-publish-retarget-'))
  const bare = mkdtempSync(join(tmpdir(), 'leppy-publish-remote-'))
  git(bare, 'init', '--bare')
  git(root, 'init', '-b', 'main')
  git(root, 'config', 'user.email', 'tests@example.invalid')
  git(root, 'config', 'user.name', 'Leppy Tests')
  git(root, 'config', 'core.autocrlf', 'false')
  writeFileSync(join(root, 'value.txt'), 'seed\n')
  git(root, 'add', '--', 'value.txt')
  git(root, 'commit', '-m', 'chore: seed')
  git(root, 'checkout', '-b', 'plugins')
  writeFileSync(join(root, 'plugin.txt'), 'base plugin\n')
  git(root, 'add', '--', 'plugin.txt')
  git(root, 'commit', '-m', 'feat: plugin base')
  const priorTarget = git(root, 'rev-parse', 'HEAD')
  git(root, 'checkout', '-b', 'feature')
  writeFileSync(join(root, 'feature.txt'), 'feature\n')
  git(root, 'add', '--', 'feature.txt')
  git(root, 'commit', '-m', 'feat: lifecycle work')
  git(root, 'checkout', 'main')
  git(root, 'merge', '--ff-only', 'plugins')
  writeFileSync(join(root, 'main.txt'), 'new main\n')
  git(root, 'add', '--', 'main.txt')
  git(root, 'commit', '-m', 'feat: advance main')
  git(root, 'checkout', 'feature')
  git(root, 'remote', 'add', 'origin', bare)
  git(root, 'push', 'origin', 'main', 'plugins', 'feature')
  git(root, 'fetch', 'origin')
  const remoteFeature = git(root, 'rev-parse', 'refs/remotes/origin/feature')
  git(bare, 'update-ref', '-d', 'refs/heads/plugins')
  return {
    root, priorTarget, remoteFeature,
    request: { runId: 'retarget-test', repoRoot: root, worktree: root, branch: 'feature', syncBranch: 'origin/plugins' },
  }
}

describe('GitHub publication target', () => {
  it.each([
    ['https://github.com/aleleppy/elysium-ts.git', 'aleleppy/elysium-ts'],
    ['git@github.com:aleleppy/elysium-ts.git', 'aleleppy/elysium-ts'],
    ['ssh://git@github.com/aleleppy/elysium-ts.git', 'aleleppy/elysium-ts'],
  ])('derives an explicit gh --repo target from %s', (remoteUrl, expected) => {
    expect(githubRepositoryFromRemoteUrl(remoteUrl)).toBe(expected)
  })

  it('passes the resolved repository explicitly to lookup and creation', () => {
    expect(pullRequestListArguments('aleleppy/elysium-ts', 'leppy-loop/run')).toEqual([
      'pr', 'list', '--repo', 'aleleppy/elysium-ts', '--state', 'all', '--head', 'leppy-loop/run', '--json', 'url,state,headRefName,headRepositoryOwner,baseRefName,headRefOid,mergeCommit', '--limit', '100',
    ])
    expect(pullRequestCreateArguments('aleleppy/elysium-ts', 'plugins', 'leppy-loop/run')).toEqual([
      'pr', 'create', '--repo', 'aleleppy/elysium-ts', '--base', 'plugins', '--head', 'leppy-loop/run', '--fill',
    ])
  })

  it.each([
    ['origin/plugins', { remote: 'origin', base: 'plugins' }],
    ['refs/remotes/origin/plugins', { remote: 'origin', base: 'plugins' }],
    ['main', { remote: 'origin', base: 'main' }],
    ['refs/heads/main', { remote: 'origin', base: 'main' }],
    ['refs/heads/release/1.0', { remote: 'origin', base: 'release/1.0' }],
  ])('parses publication ref %s without inventing a remote', (value, expected) => {
    expect(branchTarget(value)).toEqual(expected)
  })

  it('authenticates exact same-owner PR identity and ignores closed or wrong-head rows', () => {
    const head = 'a'.repeat(40)
    const rows = JSON.stringify([
      { url: 'https://github.com/aleleppy/elysium-ts/pull/1', state: 'CLOSED', headRefName: 'run', headRepositoryOwner: { login: 'aleleppy' }, baseRefName: 'main', headRefOid: head, mergeCommit: { oid: 'b'.repeat(40) } },
      { url: 'https://github.com/aleleppy/elysium-ts/pull/2', state: 'OPEN', headRefName: 'other', headRepositoryOwner: { login: 'aleleppy' }, baseRefName: 'main', headRefOid: head, mergeCommit: { oid: 'b'.repeat(40) } },
      { url: 'https://github.com/aleleppy/elysium-ts/pull/46', state: 'MERGED', headRefName: 'run', headRepositoryOwner: { login: 'aleleppy' }, baseRefName: 'main', headRefOid: head, mergeCommit: { oid: 'b'.repeat(40) } },
    ])
    expect(parseExistingPullRequest(rows, 'aleleppy/elysium-ts', 'run', head)).toMatchObject({ state: 'MERGED', base: 'main' })
  })

  it('rejects non-GitHub and ambiguous remote URLs', () => {
    expect(() => githubRepositoryFromRemoteUrl('https://gitlab.com/aleleppy/elysium-ts.git')).toThrow('explicit github.com')
    expect(() => githubRepositoryFromRemoteUrl('../local-repository')).toThrow('explicit github.com')
  })
})

describe('pull request publication orchestration', () => {
  it('rejects a private publication target that changes the authenticated remote', async () => {
    const { request } = repository('merge')
    await expect(publishPullRequest({
      ...request, syncBranch: 'backup/main', originalSyncBranch: 'origin/main', priorTargetCommit: 'a'.repeat(40),
    }, new AbortController().signal, {
      repairConflict: async () => {},
      validateBeforePush: async () => ({ receipt: 'forbidden', validatedHead: 'a'.repeat(40) }),
    })).rejects.toThrow('cannot change the authenticated Git remote')
  }, 30_000)

  it('reconciles an exact merged PR before fetch, rebase, gate, or push', async () => {
    const { root, request } = repository('merge')
    const current = git(root, 'rev-parse', 'HEAD')
    const liveMain = git(root, 'rev-parse', 'main')
    const calls: string[] = []
    const execute: typeof runFile = async (file, args, options) => {
      calls.push(`${file} ${args.join(' ')}`)
      if (file === 'git' && args[0] === 'remote') return { stdout: 'https://github.com/aleleppy/elysium-ts.git\n', stderr: '', exitCode: 0 }
      if (file === 'gh') return {
        stdout: JSON.stringify([{ url: 'https://github.com/aleleppy/elysium-ts/pull/46', state: 'MERGED', headRefName: 'feature', headRepositoryOwner: { login: 'aleleppy' }, baseRefName: 'main', headRefOid: current, mergeCommit: { oid: liveMain } }]),
        stderr: '', exitCode: 0,
      }
      return await runPublicationFile(file, args, options)
    }
    const result = await publishPullRequest(request, new AbortController().signal, {
      repairConflict: async () => { throw new Error('must not repair') },
      validateBeforePush: async () => { throw new Error('must not run gate') },
    }, execute)
    expect(result).toEqual({ url: 'https://github.com/aleleppy/elysium-ts/pull/46', validationReceipt: 'reconciled-existing-pr', reconciledExisting: true })
    expect(calls.some(call => call.includes(' push '))).toBe(false)
    expect(git(root, 'rev-parse', 'HEAD')).toBe(current)
  }, 30_000)

  it('does not reconcile a merged PR whose merge commit is no longer in the live base', async () => {
    const { root, request } = repository('merge')
    const current = git(root, 'rev-parse', 'HEAD')
    let gateRan = false
    const execute: typeof runFile = async (file, args, options) => {
      if (file === 'git' && args[0] === 'remote') return { stdout: `${TEST_GITHUB_REMOTE}\n`, stderr: '', exitCode: 0 }
      if (file === 'gh' && args[1] === 'list') return {
        stdout: JSON.stringify([{ url: 'https://github.com/aleleppy/elysium-ts/pull/51', state: 'MERGED', headRefName: 'feature', headRepositoryOwner: { login: 'aleleppy' }, baseRefName: 'main', headRefOid: current, mergeCommit: { oid: 'e'.repeat(40) } }]),
        stderr: '', exitCode: 0,
      }
      return await runPublicationFile(file, args, options)
    }
    await expect(publishPullRequest(request, new AbortController().signal, {
      repairConflict: async () => { writeFileSync(join(root, 'conflict.txt'), 'base\nfeature\n') },
      validateBeforePush: async () => {
        gateRan = true
        return { receipt: 'stale-merge-gate', validatedHead: git(root, 'rev-parse', 'HEAD') }
      },
    }, execute)).rejects.toThrow('remote Leppy branch changed')
    expect(gateRan).toBe(true)
  }, 30_000)

  it('does not reconcile a merged exact-head PR into an unauthenticated different base', async () => {
    const { root, request } = repository('merge')
    const current = git(root, 'rev-parse', 'HEAD')
    let gateRan = false
    const execute: typeof runFile = async (file, args, options) => {
      if (file === 'git' && args[0] === 'remote') return { stdout: `${TEST_GITHUB_REMOTE}\n`, stderr: '', exitCode: 0 }
      if (file === 'gh' && args[1] === 'list') return {
        stdout: JSON.stringify([{ url: 'https://github.com/aleleppy/elysium-ts/pull/49', state: 'MERGED', headRefName: 'feature', headRepositoryOwner: { login: 'aleleppy' }, baseRefName: 'release', headRefOid: current, mergeCommit: { oid: 'd'.repeat(40) } }]),
        stderr: '', exitCode: 0,
      }
      if (file === 'gh' && args[1] === 'create') return { stdout: 'https://github.com/aleleppy/elysium-ts/pull/50\n', stderr: '', exitCode: 0 }
      return await runPublicationFile(file, args, options)
    }
    await expect(publishPullRequest({
      ...request,
      syncBranch: 'origin/main',
      originalSyncBranch: 'origin/plugins',
      priorTargetCommit: git(root, 'rev-parse', 'main'),
    }, new AbortController().signal, {
      repairConflict: async () => { writeFileSync(join(root, 'conflict.txt'), 'base\nfeature\n') },
      validateBeforePush: async () => {
        gateRan = true
        return { receipt: 'matching-base-gate', validatedHead: git(root, 'rev-parse', 'HEAD') }
      },
    }, execute)).rejects.toThrow('remote Leppy branch changed')
    expect(gateRan).toBe(true)
  }, 30_000)

  it('detects a deleted remote base instead of trusting its stale tracking ref', async () => {
    const { root, request } = deletedBaseRepository()
    const execute: typeof runFile = async (file, args, options) => {
      if (file === 'git' && args[0] === 'remote') return { stdout: 'https://github.com/aleleppy/elysium-ts.git\n', stderr: '', exitCode: 0 }
      if (file === 'gh') return { stdout: '[]', stderr: '', exitCode: 0 }
      return await runPublicationFile(file, args, options)
    }
    await expect(publishPullRequest(request, new AbortController().signal, {
      repairConflict: async () => {},
      validateBeforePush: async () => { throw new Error('gate must not run') },
    }, execute)).rejects.toThrow('does not exist on the remote')
    expect(() => git(root, 'show-ref', '--verify', 'refs/remotes/origin/plugins')).toThrow()
  }, 30_000)

  it('retargets only with ancestry proof and updates an already-pushed branch using an exact lease', async () => {
    const { root, request, priorTarget, remoteFeature } = deletedBaseRepository()
    const calls: string[][] = []
    const execute: typeof runFile = async (file, args, options) => {
      calls.push([file, ...args])
      if (file === 'git' && args[0] === 'remote') return { stdout: 'https://github.com/aleleppy/elysium-ts.git\n', stderr: '', exitCode: 0 }
      if (file === 'gh' && args[1] === 'list') return { stdout: '[]', stderr: '', exitCode: 0 }
      if (file === 'gh' && args[1] === 'create') return { stdout: 'https://github.com/aleleppy/elysium-ts/pull/47\n', stderr: '', exitCode: 0 }
      return await runPublicationFile(file, args, options)
    }
    const result = await publishPullRequest({
      ...request, syncBranch: 'origin/main', originalSyncBranch: 'origin/plugins', priorTargetCommit: priorTarget,
    }, new AbortController().signal, {
      repairConflict: async () => { throw new Error('unexpected conflict') },
      validateBeforePush: async targetCommit => ({ receipt: `gate:${targetCommit}`, validatedHead: git(root, 'rev-parse', 'HEAD') }),
    }, execute)
    expect(result.url).toBe('https://github.com/aleleppy/elysium-ts/pull/47')
    const push = calls.find(call => call[0] === 'git' && call[1] === 'push')
    expect(push).toContain(`--force-with-lease=refs/heads/feature:${remoteFeature}`)
    expect(push).toContain(TEST_GITHUB_REMOTE)
    expect(calls.some(call => call[0] === 'git' && call[1] === 'fetch' && call.includes(TEST_GITHUB_REMOTE))).toBe(true)
    expect(git(root, 'ls-remote', '--heads', 'origin', 'refs/heads/feature')).toContain(git(root, 'rev-parse', 'HEAD'))
  }, 30_000)

  it('routes git push and gh pr create mutations through remote authorization', async () => {
    const { root, request, priorTarget } = deletedBaseRepository()
    let authorizationDepth = 0
    let authorizationCalls = 0
    const mutations: string[] = []
    const execute: typeof runFile = async (file, args, options) => {
      if (file === 'git' && args[0] === 'remote') return { stdout: `${TEST_GITHUB_REMOTE}\n`, stderr: '', exitCode: 0 }
      if (file === 'gh' && args[1] === 'list') return { stdout: '[]', stderr: '', exitCode: 0 }
      if (file === 'git' && args[0] === 'push') {
        expect(authorizationDepth).toBe(1)
        mutations.push('git push')
      }
      if (file === 'gh' && args[1] === 'create') {
        expect(authorizationDepth).toBe(1)
        mutations.push('gh pr create')
        return { stdout: 'https://github.com/aleleppy/elysium-ts/pull/60\n', stderr: '', exitCode: 0 }
      }
      return await runPublicationFile(file, args, options)
    }
    const result = await publishPullRequest({
      ...request, syncBranch: 'origin/main', originalSyncBranch: 'origin/plugins', priorTargetCommit: priorTarget,
    }, new AbortController().signal, {
      repairConflict: async () => { throw new Error('unexpected conflict') },
      validateBeforePush: async () => ({ receipt: 'authorized-mutations', validatedHead: git(root, 'rev-parse', 'HEAD') }),
      authorizeRemoteMutation: async mutation => {
        authorizationCalls += 1
        authorizationDepth += 1
        try { return await mutation() } finally { authorizationDepth -= 1 }
      },
    }, execute)
    expect(result.url).toBe('https://github.com/aleleppy/elysium-ts/pull/60')
    expect(authorizationCalls).toBe(2)
    expect(mutations).toEqual(['git push', 'gh pr create'])
  }, 60_000)

  it('does not execute git push when remote mutation authorization rejects it', async () => {
    const { root, request, priorTarget } = deletedBaseRepository()
    let authorizationCalls = 0
    const mutations: string[] = []
    const execute: typeof runFile = async (file, args, options) => {
      if (file === 'git' && args[0] === 'remote') return { stdout: `${TEST_GITHUB_REMOTE}\n`, stderr: '', exitCode: 0 }
      if (file === 'gh' && args[1] === 'list') return { stdout: '[]', stderr: '', exitCode: 0 }
      if (file === 'git' && args[0] === 'push') mutations.push('git push')
      if (file === 'gh' && args[1] === 'create') mutations.push('gh pr create')
      return await runPublicationFile(file, args, options)
    }
    await expect(publishPullRequest({
      ...request, syncBranch: 'origin/main', originalSyncBranch: 'origin/plugins', priorTargetCommit: priorTarget,
    }, new AbortController().signal, {
      repairConflict: async () => { throw new Error('unexpected conflict') },
      validateBeforePush: async () => ({ receipt: 'push-rejected', validatedHead: git(root, 'rev-parse', 'HEAD') }),
      authorizeRemoteMutation: async () => {
        authorizationCalls += 1
        throw new Error('remote push authorization rejected')
      },
    }, execute)).rejects.toThrow('remote push authorization rejected')
    expect(authorizationCalls).toBe(1)
    expect(mutations).toEqual([])
  }, 60_000)

  it('does not execute gh pr create when its remote mutation authorization rejects it', async () => {
    const { root, request, priorTarget } = deletedBaseRepository()
    let authorizationCalls = 0
    const mutations: string[] = []
    const execute: typeof runFile = async (file, args, options) => {
      if (file === 'git' && args[0] === 'remote') return { stdout: `${TEST_GITHUB_REMOTE}\n`, stderr: '', exitCode: 0 }
      if (file === 'gh' && args[1] === 'list') return { stdout: '[]', stderr: '', exitCode: 0 }
      if (file === 'git' && args[0] === 'push') mutations.push('git push')
      if (file === 'gh' && args[1] === 'create') mutations.push('gh pr create')
      return await runPublicationFile(file, args, options)
    }
    await expect(publishPullRequest({
      ...request, syncBranch: 'origin/main', originalSyncBranch: 'origin/plugins', priorTargetCommit: priorTarget,
    }, new AbortController().signal, {
      repairConflict: async () => { throw new Error('unexpected conflict') },
      validateBeforePush: async () => ({ receipt: 'create-rejected', validatedHead: git(root, 'rev-parse', 'HEAD') }),
      authorizeRemoteMutation: async mutation => {
        authorizationCalls += 1
        if (authorizationCalls === 2) throw new Error('pull request creation authorization rejected')
        return await mutation()
      },
    }, execute)).rejects.toThrow('pull request creation authorization rejected')
    expect(authorizationCalls).toBe(2)
    expect(mutations).toEqual(['git push'])
  }, 60_000)

  it('refuses a publication retarget whose authenticated prior target is not incorporated', async () => {
    const { root, request } = deletedBaseRepository()
    const unrelated = git(root, 'rev-parse', 'feature')
    let gated = false
    const execute: typeof runFile = async (file, args, options) => {
      if (file === 'git' && args[0] === 'remote') return { stdout: 'https://github.com/aleleppy/elysium-ts.git\n', stderr: '', exitCode: 0 }
      if (file === 'gh') return { stdout: '[]', stderr: '', exitCode: 0 }
      return await runPublicationFile(file, args, options)
    }
    await expect(publishPullRequest({
      ...request, syncBranch: 'origin/main', originalSyncBranch: 'origin/plugins', priorTargetCommit: unrelated,
    }, new AbortController().signal, {
      repairConflict: async () => {},
      validateBeforePush: async () => { gated = true; throw new Error('must not gate') },
    }, execute)).rejects.toThrow('prior target')
    expect(gated).toBe(false)
  }, 30_000)

  it('refuses a post-gate base race and retries safely from the persisted remote lease', async () => {
    const { root, request, priorTarget, remoteFeature } = deletedBaseRepository()
    let recordedRemoteHead: string | undefined
    let gateCalls = 0
    const execute: typeof runFile = async (file, args, options) => {
      if (file === 'git' && args[0] === 'remote') return { stdout: 'https://github.com/aleleppy/elysium-ts.git\n', stderr: '', exitCode: 0 }
      if (file === 'gh' && args[1] === 'create') return { stdout: 'https://github.com/aleleppy/elysium-ts/pull/48\n', stderr: '', exitCode: 0 }
      if (file === 'gh') return { stdout: '[]', stderr: '', exitCode: 0 }
      return await runPublicationFile(file, args, options)
    }
    const effectiveRequest = { ...request, syncBranch: 'origin/main', originalSyncBranch: 'origin/plugins', priorTargetCommit: priorTarget }
    const hooks = {
      repairConflict: async () => { throw new Error('unexpected conflict') },
      recordRemoteHead: async (head: string | undefined) => { recordedRemoteHead = head },
      validateBeforePush: async () => {
        gateCalls += 1
        if (gateCalls === 1) {
          const parent = git(root, 'rev-parse', 'origin/main')
          const tree = git(root, 'rev-parse', 'origin/main^{tree}')
          const raced = git(root, 'commit-tree', tree, '-p', parent, '-m', 'test: advance remote base after gate')
          git(root, 'push', 'origin', `${raced}:refs/heads/main`)
        }
        return { receipt: `gate-race-${gateCalls}`, validatedHead: git(root, 'rev-parse', 'HEAD') }
      },
    }
    await expect(publishPullRequest(effectiveRequest, new AbortController().signal, hooks, execute)).rejects.toThrow('base changed after the final gate')
    expect(recordedRemoteHead).toBe(remoteFeature)
    expect(git(root, 'ls-remote', '--heads', 'origin', 'refs/heads/feature')).toContain(remoteFeature)

    const retried = await publishPullRequest({ ...effectiveRequest, priorRemoteHead: recordedRemoteHead! }, new AbortController().signal, hooks, execute)
    expect(retried.url).toBe('https://github.com/aleleppy/elysium-ts/pull/48')
    expect(recordedRemoteHead).toBe(git(root, 'rev-parse', 'HEAD'))
  }, 60_000)
})

describe('publication rebase protocol', () => {
  it.each(['merge', 'apply'] as const)('lets the controller continue a %s rebase while preserving clean staged replay paths', async backend => {
    const { root, request } = repository(backend)
    let repairedPaths: string[] = []

    await preparePublicationRebase(request, 'origin', 'main', {
      repairConflict: async conflict => {
        repairedPaths = conflict.paths
        expect(await isAuthenticatedPublicationRebase(request, new AbortController().signal)).toBe(true)
        expect(git(root, 'diff', '--cached', '--name-only').split(/\r?\n/u)).toContain('clean.txt')
        writeFileSync(join(root, 'conflict.txt'), 'base\nfeature\n')
      },
      validateBeforePush: async () => ({ receipt: 'unused', validatedHead: 'unused' }),
    }, new AbortController().signal)

    expect(repairedPaths).toEqual(['conflict.txt'])
    expect(git(root, 'branch', '--show-current')).toBe('feature')
    expect(git(root, 'status', '--porcelain')).toBe('')
    expect(readFileSync(join(root, 'conflict.txt'), 'utf8')).toBe('base\nfeature\n')
    expect(readFileSync(join(root, 'clean.txt'), 'utf8')).toBe('feature-clean\n')
    expect(git(root, 'show', '--pretty=format:', '--name-only', 'HEAD').split(/\r?\n/u).filter(Boolean).sort()).toEqual([
      'clean.txt',
      'conflict.txt',
    ])
  }, 30_000)

  it('safely skips an apply-backend replay step resolved completely in favor of the base', async () => {
    const { root, request } = emptyConflictRepository()
    await preparePublicationRebase(request, 'origin', 'main', {
      repairConflict: async conflict => {
        expect(conflict.paths).toEqual(['conflict.txt'])
        writeFileSync(join(root, 'conflict.txt'), 'base\n')
      },
      validateBeforePush: async () => ({ receipt: 'unused', validatedHead: 'unused' }),
    }, new AbortController().signal)

    expect(git(root, 'branch', '--show-current')).toBe('feature')
    expect(git(root, 'status', '--porcelain')).toBe('')
    expect(git(root, 'rev-list', '--count', 'origin/main..HEAD')).toBe('0')
    expect(readFileSync(join(root, 'conflict.txt'), 'utf8')).toBe('base\n')
  }, 30_000)

  it('rejects a worker edit to a clean staged replay path outside the conflict scope', async () => {
    const { root, request } = repository('merge')
    const originalHead = git(root, 'rev-parse', 'HEAD')

    await expect(preparePublicationRebase(request, 'origin', 'main', {
      repairConflict: async () => {
        writeFileSync(join(root, 'conflict.txt'), 'base\nfeature\n')
        writeFileSync(join(root, 'clean.txt'), 'unauthorized worker edit\n')
      },
      validateBeforePush: async () => ({ receipt: 'unused', validatedHead: 'unused' }),
    }, new AbortController().signal)).rejects.toThrow('outside the exact unmerged set')

    expect(git(root, 'branch', '--show-current')).toBe('feature')
    expect(git(root, 'rev-parse', 'HEAD')).toBe(originalHead)
    expect(git(root, 'status', '--porcelain')).toBe('')
    expect(readFileSync(join(root, 'clean.txt'), 'utf8')).toBe('feature-clean\n')
  }, 30_000)

  it('rejects worker index mutation and aborts back to the authenticated feature head', async () => {
    const { root, request } = repository('merge')
    const originalHead = git(root, 'rev-parse', 'HEAD')

    await expect(preparePublicationRebase(request, 'origin', 'main', {
      repairConflict: async () => {
        writeFileSync(join(root, 'conflict.txt'), 'unauthorized staged resolution\n')
        git(root, 'add', '--', 'conflict.txt')
      },
      validateBeforePush: async () => ({ receipt: 'unused', validatedHead: 'unused' }),
    }, new AbortController().signal)).rejects.toThrow('changed the Git index')

    expect(git(root, 'branch', '--show-current')).toBe('feature')
    expect(git(root, 'rev-parse', 'HEAD')).toBe(originalHead)
    expect(git(root, 'status', '--porcelain')).toBe('')
    expect(readFileSync(join(root, 'conflict.txt'), 'utf8')).toBe('feature\n')
    expect(readFileSync(join(root, 'clean.txt'), 'utf8')).toBe('feature-clean\n')
  }, 30_000)

  it('surfaces rollback failure instead of claiming the authenticated branch was restored', async () => {
    const { root, request } = repository('merge')
    await expect(preparePublicationRebase(request, 'origin', 'main', {
      repairConflict: async () => {
        const metadata = git(root, 'rev-parse', '--git-path', 'rebase-merge')
        rmSync(resolve(root, metadata), { recursive: true, force: true })
      },
      validateBeforePush: async () => ({ receipt: 'unused', validatedHead: 'unused' }),
    }, new AbortController().signal)).rejects.toThrow('publication rollback failed')
    expect(git(root, 'branch', '--show-current')).not.toBe('feature')
  }, 30_000)

  it('discards a prior manual resolution before a newly granted publication attempt', async () => {
    const { root, request } = repository('merge')
    const originalHead = git(root, 'rev-parse', 'HEAD')
    expect(() => git(root, 'rebase', 'origin/main')).toThrow()
    writeFileSync(join(root, 'conflict.txt'), 'manual\n')
    git(root, 'add', '--', 'conflict.txt')
    git(root, 'commit', '-m', 'fix: manual resolution')

    await expect(abortInterruptedPublicationRebase(request, new AbortController().signal)).resolves.toBe(true)
    expect(git(root, 'branch', '--show-current')).toBe('feature')
    expect(git(root, 'rev-parse', 'HEAD')).toBe(originalHead)
    expect(readFileSync(join(root, 'conflict.txt'), 'utf8')).toBe('feature\n')
  }, 30_000)
})
