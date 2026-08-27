import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  abortInterruptedPublicationRebase,
  githubRepositoryFromRemoteUrl,
  isAuthenticatedPublicationRebase,
  preparePublicationRebase,
  pullRequestCreateArguments,
  pullRequestListArguments,
} from '../src/publish.js'
import type { PullRequestRequest } from '../src/types.js'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
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
      'pr', 'list', '--repo', 'aleleppy/elysium-ts', '--state', 'all', '--head', 'leppy-loop/run', '--json', 'url', '--limit', '1',
    ])
    expect(pullRequestCreateArguments('aleleppy/elysium-ts', 'plugins', 'leppy-loop/run')).toEqual([
      'pr', 'create', '--repo', 'aleleppy/elysium-ts', '--base', 'plugins', '--head', 'leppy-loop/run', '--fill',
    ])
  })

  it('rejects non-GitHub and ambiguous remote URLs', () => {
    expect(() => githubRepositoryFromRemoteUrl('https://gitlab.com/aleleppy/elysium-ts.git')).toThrow('explicit github.com')
    expect(() => githubRepositoryFromRemoteUrl('../local-repository')).toThrow('explicit github.com')
  })
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
      validateBeforePush: async () => 'unused',
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
      validateBeforePush: async () => 'unused',
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
      validateBeforePush: async () => 'unused',
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
      validateBeforePush: async () => 'unused',
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
      validateBeforePush: async () => 'unused',
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
