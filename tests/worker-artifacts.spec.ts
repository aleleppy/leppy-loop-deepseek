import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  quarantineWorkerNpmCache, recordWorkerNpmCacheBaseline, sameArtifactIdentity,
  workerNpmCacheRecovery, workerNpmCacheTransactionPresent,
} from '../src/worker-artifacts.js'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function fixture(): { root: string; stateDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'leppy-worker-artifact-'))
  const stateDir = mkdtempSync(join(tmpdir(), 'leppy-worker-artifact-state-'))
  writeFileSync(join(root, 'source.ts'), 'export const value = 1\n')
  git(root, 'init', '-b', 'main')
  git(root, 'config', 'user.email', 'tests@example.invalid')
  git(root, 'config', 'user.name', 'Leppy Tests')
  git(root, 'add', '--', 'source.ts')
  git(root, 'commit', '-m', 'chore: seed')
  return { root, stateDir }
}

function cache(root: string, value = 'cache evidence\n'): void {
  mkdirSync(join(root, '.npm-cache', '_logs'), { recursive: true })
  writeFileSync(join(root, '.npm-cache', '_logs', 'worker.log'), value)
}

const detail = 'npx is unavailable and leppy_commit rejected .npm-cache/_logs/worker.log outside this task write scope'
const digest = 'a'.repeat(64)

describe('authenticated worker artifact recovery', () => {
  it('classifies only the exact npx/cache/commit recovery condition', () => {
    expect(workerNpmCacheRecovery(detail)).toBe(true)
    expect(workerNpmCacheRecovery('npx unavailable')).toBe(false)
    expect(workerNpmCacheRecovery('.npm-cache outside scope')).toBe(false)
    expect(workerNpmCacheRecovery('npx changed another/cache and leppy_commit failed')).toBe(false)
  })

  it('preserves bigint filesystem identities as distinct decimal strings', () => {
    expect(sameArtifactIdentity(
      { dev: '9007199254740992', ino: '18446744073709551614', type: 'directory' },
      { dev: '9007199254740992', ino: '18446744073709551615', type: 'directory' },
    )).toBe(false)
  })

  it('quarantines only when the signed pre-attempt baseline proves absence', async () => {
    const { root, stateDir } = fixture()
    const key = randomBytes(32)
    recordWorkerNpmCacheBaseline({ worktree: root, stateDir, runId: 'run-cache', taskIndex: 0, attempt: 1, key })
    cache(root)
    const result = await quarantineWorkerNpmCache({
      worktree: root, stateDir, runId: 'run-cache', taskIndex: 0, attempt: 1,
      recoveryErrorDigest: digest, allowLegacyDigest: false, key,
    })
    expect(result.basis).toBe('baseline-absent')
    expect(existsSync(join(root, '.npm-cache'))).toBe(false)
    expect(readFileSync(join(result.quarantine, '_logs', 'worker.log'), 'utf8')).toBe('cache evidence\n')
    expect(workerNpmCacheTransactionPresent(stateDir)).toBe(true)
    expect(git(root, 'status', '--short')).toBe('')
  })

  it('refuses unrelated untracked cache WIP that existed in the signed baseline', async () => {
    const { root, stateDir } = fixture()
    const key = randomBytes(32)
    cache(root, 'user cache WIP\n')
    recordWorkerNpmCacheBaseline({ worktree: root, stateDir, runId: 'run-owned', taskIndex: 0, attempt: 1, key })
    await expect(quarantineWorkerNpmCache({
      worktree: root, stateDir, runId: 'run-owned', taskIndex: 0, attempt: 1,
      recoveryErrorDigest: digest, allowLegacyDigest: true, key,
    })).rejects.toThrow('baseline proves .npm-cache was already present')
    expect(readFileSync(join(root, '.npm-cache', '_logs', 'worker.log'), 'utf8')).toBe('user cache WIP\n')
  })

  it('resumes the same identity-bound transaction after a crash immediately after rename', async () => {
    const { root, stateDir } = fixture()
    cache(root)
    const key = randomBytes(32)
    await expect(quarantineWorkerNpmCache({
      worktree: root, stateDir, runId: 'run-crash', taskIndex: 0, attempt: 7,
      recoveryErrorDigest: digest, allowLegacyDigest: true, key,
      afterQuarantinePublish: async () => { throw new Error('simulated host crash after quarantine publish') },
    })).rejects.toThrow('simulated host crash')
    expect(existsSync(join(root, '.npm-cache'))).toBe(false)
    expect(workerNpmCacheTransactionPresent(stateDir)).toBe(true)

    const resumed = await quarantineWorkerNpmCache({
      worktree: root, stateDir, runId: 'run-crash', taskIndex: 0, attempt: 7, allowLegacyDigest: false, key,
    })
    expect(resumed.resumed).toBe(true)
    expect(readFileSync(join(resumed.quarantine, '_logs', 'worker.log'), 'utf8')).toBe('cache evidence\n')
  })

  it('does not complete a receipt when the source reappears after atomic quarantine', async () => {
    const { root, stateDir } = fixture()
    cache(root, 'original\n')
    const key = randomBytes(32)
    await expect(quarantineWorkerNpmCache({
      worktree: root, stateDir, runId: 'run-race', taskIndex: 0, attempt: 2,
      recoveryErrorDigest: digest, allowLegacyDigest: true, key,
      afterQuarantinePublish: async () => { cache(root, 'replacement\n') },
    })).rejects.toThrow('appeared before quarantine completion')
    expect(readFileSync(join(root, '.npm-cache', '_logs', 'worker.log'), 'utf8')).toBe('replacement\n')
    const receipt = JSON.parse(readFileSync(join(stateDir, 'worker-npm-cache-recovery.json'), 'utf8'))
    expect(receipt.phase).toBe('prepared')
  })

  it('checks exact run binding even on a completed receipt fast path', async () => {
    const { root, stateDir } = fixture()
    cache(root)
    const key = randomBytes(32)
    await quarantineWorkerNpmCache({
      worktree: root, stateDir, runId: 'run-a', taskIndex: 0, attempt: 1,
      recoveryErrorDigest: digest, allowLegacyDigest: true, key,
    })
    await expect(quarantineWorkerNpmCache({
      worktree: root, stateDir, runId: 'run-b', allowLegacyDigest: false, key,
    })).rejects.toThrow('another run')
  })

  it('reconciles a completed receipt and blocks a source recreated during downtime', async () => {
    const { root, stateDir } = fixture()
    cache(root, 'original\n')
    const key = randomBytes(32)
    await quarantineWorkerNpmCache({
      worktree: root, stateDir, runId: 'run-downtime', taskIndex: 0, attempt: 1,
      recoveryErrorDigest: digest, allowLegacyDigest: true, key,
    })
    cache(root, 'new during downtime\n')
    expect(workerNpmCacheTransactionPresent(stateDir)).toBe(true)
    await expect(quarantineWorkerNpmCache({
      worktree: root, stateDir, runId: 'run-downtime', allowLegacyDigest: false, key,
    })).rejects.toThrow('appeared after the authenticated quarantine')
    expect(readFileSync(join(root, '.npm-cache', '_logs', 'worker.log'), 'utf8')).toBe('new during downtime\n')
  })

  it('rejects cross-device quarantine before writing a prepared receipt', async () => {
    const { root, stateDir } = fixture()
    cache(root, 'cross-device preserved\n')
    await expect(quarantineWorkerNpmCache({
      worktree: root, stateDir, runId: 'run-device', taskIndex: 0, attempt: 1,
      recoveryErrorDigest: digest, allowLegacyDigest: true, key: randomBytes(32),
      stateDeviceOverride: '18446744073709551615',
    })).rejects.toThrow('same filesystem')
    expect(readFileSync(join(root, '.npm-cache', '_logs', 'worker.log'), 'utf8')).toBe('cross-device preserved\n')
    expect(existsSync(join(stateDir, 'worker-npm-cache-recovery.json'))).toBe(false)
  })

  it('refuses tracked cache content and preserves both worktree bytes and staging state', async () => {
    const { root, stateDir } = fixture()
    cache(root, 'must remain\n')
    git(root, 'add', '--', '.npm-cache/_logs/worker.log')
    const beforeStatus = git(root, 'status', '--short')
    await expect(quarantineWorkerNpmCache({
      worktree: root, stateDir, runId: 'run-tracked', taskIndex: 0, attempt: 1,
      recoveryErrorDigest: digest, allowLegacyDigest: true, key: randomBytes(32),
    })).rejects.toThrow('tracked or staged')
    expect(readFileSync(join(root, '.npm-cache', '_logs', 'worker.log'), 'utf8')).toBe('must remain\n')
    expect(git(root, 'status', '--short')).toBe(beforeStatus)
    expect(existsSync(join(stateDir, 'worker-npm-cache-recovery.json'))).toBe(false)
  })
})
