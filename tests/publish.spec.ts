import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  abortInterruptedPublicationRebase,
  isAuthenticatedPublicationRebase,
  preparePublicationRebase,
} from '../src/publish.js'
import { commitTaskChanges } from '../src/worker-tool.js'
import { runFile } from '../src/process.js'
import type { PullRequestRequest } from '../src/types.js'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

describe('publication rebase protocol', () => {
  it.each(['--merge', '--apply'])('discards prior manual resolution under %s, then continues only from the bounded commit capability', async backend => {
    const root = mkdtempSync(join(tmpdir(), 'leppy-publish-'))
    const value = join(root, 'value.txt')
    git(root, 'init', '-b', 'main')
    git(root, 'config', 'user.email', 'tests@example.invalid')
    git(root, 'config', 'user.name', 'Leppy Tests')
    git(root, 'config', 'core.autocrlf', 'false')
    writeFileSync(value, 'seed\n')
    git(root, 'add', '--', 'value.txt')
    git(root, 'commit', '-m', 'chore: seed')
    git(root, 'checkout', '-b', 'feature')
    writeFileSync(value, 'feature\n')
    git(root, 'commit', '-am', 'feat: feature value')
    git(root, 'checkout', 'main')
    writeFileSync(value, 'base\n')
    git(root, 'commit', '-am', 'fix: base value')
    git(root, 'checkout', 'feature')
    git(root, 'remote', 'add', 'origin', root)
    git(root, 'fetch', 'origin')
    expect(() => git(root, 'rebase', backend, 'origin/main')).toThrow()

    const request: PullRequestRequest = {
      runId: 'publish-test', repoRoot: root, worktree: root, branch: 'feature', syncBranch: 'origin/main',
    }
    await expect(isAuthenticatedPublicationRebase(request, new AbortController().signal)).resolves.toBe(true)

    // A manual/pre-resolved commit is never accepted by the next controller job.
    writeFileSync(value, 'manual\n')
    git(root, 'add', '--', 'value.txt')
    git(root, 'commit', '-m', 'fix: manual resolution')
    await expect(abortInterruptedPublicationRebase(request, new AbortController().signal)).resolves.toBe(true)
    expect(git(root, 'branch', '--show-current')).toBe('feature')
    expect(readFileSync(value, 'utf8').trim()).toBe('feature')

    let repairedPaths: string[] = []
    await preparePublicationRebase(request, 'origin', 'main', {
      repairConflict: async conflict => {
        repairedPaths = conflict.paths
        writeFileSync(value, 'base\nfeature\n')
        return await commitTaskChanges({ root, checklist: join(root, 'tasks.task.md'), allowed: [value] }, 'fix: reconcile publication conflict', async args => {
          return await runFile('git', args, { cwd: root, allowFailure: true })
        })
      },
      validateBeforePush: async () => 'test-receipt',
    }, new AbortController().signal)

    expect(repairedPaths).toEqual(['value.txt'])
    expect(git(root, 'branch', '--show-current')).toBe('feature')
    expect(git(root, 'status', '--porcelain')).toBe('')
  }, 30_000)
})
