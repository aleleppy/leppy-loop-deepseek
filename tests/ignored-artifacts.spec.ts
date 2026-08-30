import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  EMPTY_IGNORED_PATHS_DIGEST, recordWorkerIgnoredPathBaseline, reconcileWorkerIgnoredPaths,
} from '../src/ignored-artifacts.js'
import type { IgnoredArtifactTransactionRef } from '../src/types.js'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function fixture(): { root: string; stateDir: string; key: Buffer } {
  const root = mkdtempSync(join(tmpdir(), 'leppy-ignored-artifacts-'))
  git(root, 'init', '-b', 'main')
  git(root, 'config', 'user.email', 'test@example.com')
  git(root, 'config', 'user.name', 'Test')
  writeFileSync(join(root, '.gitignore'), 'ignored/\n')
  writeFileSync(join(root, 'tracked.txt'), 'tracked\n')
  git(root, 'add', '.')
  git(root, 'commit', '-m', 'test: fixture')
  const stateDir = `${root}-state`
  mkdirSync(stateDir)
  return { root, stateDir, key: randomBytes(32) }
}

const identity = { runId: 'ignoredrun01', taskKey: 'a'.repeat(64), taskIndex: 0, attempt: 1 }

function writeIgnored(root: string, path: string, content: string): string {
  const target = join(root, 'ignored', path)
  mkdirSync(join(target, '..'), { recursive: true })
  writeFileSync(target, content)
  return target
}

async function baseline(repo: ReturnType<typeof fixture>) {
  return recordWorkerIgnoredPathBaseline({
    worktree: repo.root, stateDir: repo.stateDir, key: repo.key, ...identity,
  })
}

async function reconcile(repo: ReturnType<typeof fixture>, digest: string, hooks: {
  expectedTransaction?: IgnoredArtifactTransactionRef
  onTransactionPrepared?: (transaction: IgnoredArtifactTransactionRef) => Promise<void>
  afterReceiptPrepared?: () => Promise<void>
  afterEntryQuarantined?: (index: number) => Promise<void>
} = {}) {
  return reconcileWorkerIgnoredPaths({
    worktree: repo.root, stateDir: repo.stateDir, key: repo.key,
    expectedBaselineDigest: digest, ...identity, ...hooks,
  })
}

describe('authenticated ignored artifact recovery', () => {
  it('quarantines only baseline-absent files and preserves their bytes', async () => {
    const repo = fixture()
    const before = await baseline(repo)
    const source = writeIgnored(repo.root, 'report.json', '{"worker":true}\n')

    const result = await reconcile(repo, before.digest)
    expect(result).toMatchObject({ digest: EMPTY_IGNORED_PATHS_DIGEST, paths: ['ignored/report.json'], resumed: false, basis: 'recorded' })
    expect(existsSync(source)).toBe(false)
    expect(readFileSync(join(result.quarantine!, 'ignored', 'report.json'), 'utf8')).toBe('{"worker":true}\n')
  })

  it('classifies the whole delta before mutation and preserves changed pre-existing WIP', async () => {
    const repo = fixture()
    const existing = writeIgnored(repo.root, 'existing.txt', 'before\n')
    const before = await baseline(repo)
    writeFileSync(existing, 'changed\n')
    const added = writeIgnored(repo.root, 'added.txt', 'new\n')

    await expect(reconcile(repo, before.digest)).rejects.toThrow('pre-existing ignored artifact changed')
    expect(readFileSync(existing, 'utf8')).toBe('changed\n')
    expect(readFileSync(added, 'utf8')).toBe('new\n')
    expect(existsSync(join(repo.stateDir, 'worker-ignored-path-recovery', '0-1.json'))).toBe(false)
  })

  it('moves nothing after a prepared crash when pre-existing ignored WIP changed', async () => {
    const repo = fixture()
    const existing = writeIgnored(repo.root, 'existing.txt', 'before\n')
    const before = await baseline(repo)
    const added = writeIgnored(repo.root, 'added.txt', 'new\n')
    await expect(reconcile(repo, before.digest, {
      afterReceiptPrepared: async () => { throw new Error('crash after prepared') },
    })).rejects.toThrow('crash after prepared')
    writeFileSync(existing, 'user changed after crash\n')

    await expect(reconcile(repo, before.digest)).rejects.toThrow('pre-existing ignored artifact changed')
    expect(readFileSync(existing, 'utf8')).toBe('user changed after crash\n')
    expect(readFileSync(added, 'utf8')).toBe('new\n')
  })

  it('allows a pre-existing ignored file to become tracked in the clean candidate', async () => {
    const repo = fixture()
    const promoted = writeIgnored(repo.root, 'promoted.txt', 'before\n')
    const before = await baseline(repo)
    writeFileSync(promoted, 'committed\n')
    git(repo.root, 'add', '-f', '--', 'ignored/promoted.txt')
    git(repo.root, 'commit', '-m', 'feat: promote ignored file')

    const result = await reconcile(repo, before.digest)
    expect(result).toMatchObject({ digest: EMPTY_IGNORED_PATHS_DIGEST, paths: [] })
    expect(readFileSync(promoted, 'utf8')).toBe('committed\n')
  })

  it('recovers prepared and partially moved transactions exactly once', async () => {
    const repo = fixture()
    const before = await baseline(repo)
    const first = writeIgnored(repo.root, 'a.txt', 'a\n')
    const second = writeIgnored(repo.root, 'b.txt', 'b\n')

    await expect(reconcile(repo, before.digest, {
      afterReceiptPrepared: async () => { throw new Error('crash after prepared receipt') },
    })).rejects.toThrow('crash after prepared receipt')
    expect(existsSync(first)).toBe(true)
    expect(existsSync(second)).toBe(true)

    await expect(reconcile(repo, before.digest, {
      afterEntryQuarantined: async index => { if (index === 0) throw new Error('crash after first move') },
    })).rejects.toThrow('crash after first move')
    expect([existsSync(first), existsSync(second)].filter(Boolean)).toHaveLength(1)

    const recovered = await reconcile(repo, before.digest)
    expect(recovered).toMatchObject({ digest: EMPTY_IGNORED_PATHS_DIGEST, resumed: true, paths: ['ignored/a.txt', 'ignored/b.txt'] })
    expect(readFileSync(join(recovered.quarantine!, 'ignored', 'a.txt'), 'utf8')).toBe('a\n')
    expect(readFileSync(join(recovered.quarantine!, 'ignored', 'b.txt'), 'utf8')).toBe('b\n')
  })

  it('rejects a prepared quarantine root replaced by an escaping junction', async () => {
    const repo = fixture()
    const before = await baseline(repo)
    const source = writeIgnored(repo.root, 'escape.txt', 'private\n')
    await expect(reconcile(repo, before.digest, {
      afterReceiptPrepared: async () => { throw new Error('prepared') },
    })).rejects.toThrow('prepared')
    const receipt = JSON.parse(readFileSync(join(repo.stateDir, 'worker-ignored-path-recovery', '0-1.json'), 'utf8'))
    const outside = `${repo.stateDir}-outside`
    mkdirSync(outside)
    rmSync(receipt.quarantineRoot, { recursive: true, force: true })
    symlinkSync(outside, receipt.quarantineRoot, 'junction')

    await expect(reconcile(repo, before.digest)).rejects.toThrow('not one physical private-state directory')
    expect(readFileSync(source, 'utf8')).toBe('private\n')
    expect(existsSync(join(outside, 'ignored', 'escape.txt'))).toBe(false)
  })

  it('preflights every receipt entry before resuming any move', async () => {
    const repo = fixture()
    const before = await baseline(repo)
    const first = writeIgnored(repo.root, 'a.txt', 'a\n')
    const second = writeIgnored(repo.root, 'b.txt', 'b\n')
    await expect(reconcile(repo, before.digest, {
      afterReceiptPrepared: async () => { throw new Error('prepared') },
    })).rejects.toThrow('prepared')
    const receipt = JSON.parse(readFileSync(join(repo.stateDir, 'worker-ignored-path-recovery', '0-1.json'), 'utf8'))
    const secondMove = receipt.entries[1]
    renameSync(secondMove.source, secondMove.quarantine)
    writeFileSync(secondMove.source, 'reappeared\n')

    await expect(reconcile(repo, before.digest)).rejects.toThrow('ambiguous path state')
    expect(readFileSync(first, 'utf8')).toBe('a\n')
    expect(readFileSync(second, 'utf8')).toBe('reappeared\n')
    expect(readFileSync(secondMove.quarantine, 'utf8')).toBe('b\n')
  })

  it('does not quarantine an entry promoted to tracked after a prepared crash', async () => {
    const repo = fixture()
    const before = await baseline(repo)
    const source = writeIgnored(repo.root, 'promoted-after-prepared.txt', 'candidate\n')
    await expect(reconcile(repo, before.digest, {
      afterReceiptPrepared: async () => { throw new Error('prepared') },
    })).rejects.toThrow('prepared')
    git(repo.root, 'add', '-f', '--', 'ignored/promoted-after-prepared.txt')
    git(repo.root, 'commit', '-m', 'feat: promote after prepared receipt')

    await expect(reconcile(repo, before.digest)).rejects.toThrow('no longer the authenticated ignored artifact')
    expect(readFileSync(source, 'utf8')).toBe('candidate\n')
    expect(git(repo.root, 'ls-files', '--', 'ignored/promoted-after-prepared.txt')).toBe('ignored/promoted-after-prepared.txt')
  })

  it('fails closed when an HMAC-bound transaction receipt disappears after a partial move', async () => {
    const repo = fixture()
    const before = await baseline(repo)
    writeIgnored(repo.root, 'a.txt', 'a\n')
    writeIgnored(repo.root, 'b.txt', 'b\n')
    let transaction!: IgnoredArtifactTransactionRef
    await expect(reconcile(repo, before.digest, {
      onTransactionPrepared: async value => { transaction = value },
      afterEntryQuarantined: async index => { if (index === 0) throw new Error('partial') },
    })).rejects.toThrow('partial')
    unlinkSync(join(repo.stateDir, 'worker-ignored-path-recovery', '0-1.json'))

    await expect(reconcile(repo, before.digest, { expectedTransaction: transaction })).rejects.toThrow('transaction receipt is missing')
  })

  it('rejects receipt tampering and source reappearance without moving more bytes', async () => {
    const repo = fixture()
    const before = await baseline(repo)
    const source = writeIgnored(repo.root, 'report.txt', 'report\n')
    await expect(reconcile(repo, before.digest, {
      afterReceiptPrepared: async () => { throw new Error('prepared') },
    })).rejects.toThrow('prepared')
    const receiptPath = join(repo.stateDir, 'worker-ignored-path-recovery', '0-1.json')
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'))
    receipt.entries[0].path = 'ignored/forged.txt'
    writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`)

    await expect(reconcile(repo, before.digest)).rejects.toThrow('worker ignored recovery receipt is invalid')
    expect(readFileSync(source, 'utf8')).toBe('report\n')
  })

  it('blocks a source recreated after authenticated quarantine', async () => {
    const repo = fixture()
    const before = await baseline(repo)
    const source = writeIgnored(repo.root, 'reappeared.txt', 'first\n')
    const quarantined = await reconcile(repo, before.digest)
    expect(existsSync(source)).toBe(false)
    writeIgnored(repo.root, 'reappeared.txt', 'second\n')

    await expect(reconcile(repo, before.digest)).rejects.toThrow('ambiguous path state')
    expect(readFileSync(source, 'utf8')).toBe('second\n')
    expect(readFileSync(join(quarantined.quarantine!, 'ignored', 'reappeared.txt'), 'utf8')).toBe('first\n')
  })

  it('resumes a legacy active attempt only when its authenticated digest proves an empty baseline', async () => {
    const empty = fixture()
    const source = writeIgnored(empty.root, 'legacy.txt', 'legacy\n')
    const recovered = await reconcile(empty, EMPTY_IGNORED_PATHS_DIGEST)
    expect(recovered).toMatchObject({ basis: 'authenticated-empty-digest', paths: ['ignored/legacy.txt'] })
    expect(existsSync(source)).toBe(false)

    const nonEmpty = fixture()
    writeIgnored(nonEmpty.root, 'unknown.txt', 'preserve\n')
    const unknownDigest = createHash('sha256').update('unknown baseline').digest('hex')
    await expect(reconcile(nonEmpty, unknownDigest)).rejects.toThrow('lacks its authenticated pre-attempt baseline')
    expect(readFileSync(join(nonEmpty.root, 'ignored', 'unknown.txt'), 'utf8')).toBe('preserve\n')
  })

  it('rejects hardlinked worker artifacts without moving either link', async () => {
    const repo = fixture()
    const before = await baseline(repo)
    const source = writeIgnored(repo.root, 'hardlink-a.txt', 'linked\n')
    const alias = join(repo.root, 'ignored', 'hardlink-b.txt')
    linkSync(source, alias)

    await expect(reconcile(repo, before.digest)).rejects.toThrow('rejects hardlinked entries')
    expect(readFileSync(source, 'utf8')).toBe('linked\n')
    expect(readFileSync(alias, 'utf8')).toBe('linked\n')
  })
})
