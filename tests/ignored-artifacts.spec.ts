import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  EMPTY_IGNORED_PATHS_DIGEST, recordWorkerIgnoredPathBaseline, reconcileWorkerIgnoredPaths, workerIgnoredBaselineRecovery,
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
  legacyBaseHead?: string
  onTransactionPrepared?: (transaction: IgnoredArtifactTransactionRef) => Promise<void>
  afterLegacySnapshot?: () => Promise<void>
  afterLegacyBaselinePersisted?: () => Promise<void>
  afterReceiptPrepared?: () => Promise<void>
  afterEntryQuarantined?: (index: number) => Promise<void>
} = {}) {
  return reconcileWorkerIgnoredPaths({
    worktree: repo.root, stateDir: repo.stateDir, key: repo.key,
    expectedBaselineDigest: digest, ...identity, ...hooks,
  })
}

describe('authenticated ignored artifact recovery', () => {
  it('recognizes only exact superseded legacy capability failures', () => {
    const missing = 'worker ignored artifact recovery lacks its authenticated pre-attempt baseline'
    const threeAddition = 'worker ignored artifact recovery cannot prove its legacy non-empty baseline from current fingerprints'
    expect(workerIgnoredBaselineRecovery(missing)).toBe(false)
    expect(workerIgnoredBaselineRecovery(threeAddition)).toBe(false)
    expect(workerIgnoredBaselineRecovery(`\r\n ${threeAddition}\t`)).toBe(false)
    expect(workerIgnoredBaselineRecovery(`${threeAddition} within 4 additions and 3 candidates`)).toBe(false)
    expect(workerIgnoredBaselineRecovery(`${threeAddition} within 4 additions and 92170 candidates`)).toBe(false)
    expect(workerIgnoredBaselineRecovery(`prefix: ${missing}`)).toBe(false)
    expect(workerIgnoredBaselineRecovery(`${threeAddition} within 4 additions and 0 candidates`)).toBe(false)
    expect(workerIgnoredBaselineRecovery(`${threeAddition} within 4 additions and 100 candidates`)).toBe(false)
    expect(workerIgnoredBaselineRecovery(`${threeAddition} within 4 additions and 0003 candidates`)).toBe(false)
    expect(workerIgnoredBaselineRecovery(`${threeAddition} within 4 additions and 9007199254740993 candidates`)).toBe(false)
    expect(workerIgnoredBaselineRecovery(`${threeAddition} after exact newly tracked promotion inference within 4 additions and 3 candidates`)).toBe(false)
    expect(workerIgnoredBaselineRecovery(`${threeAddition} after exact newly tracked promotion inference within 4 additions and 0003 candidates`)).toBe(false)
    expect(workerIgnoredBaselineRecovery(`${threeAddition} after exact tracked-promotion and base-ignore inference within 4 additions and 3 candidates`)).toBe(false)
    expect(workerIgnoredBaselineRecovery(`${threeAddition} after exact tracked-promotion and base-ignore inference within 4 additions and 0003 candidates`)).toBe(false)
    expect(workerIgnoredBaselineRecovery(`${threeAddition} after exact tracked and untracked base-ignore inference within 4 additions and 3 candidates`)).toBe(true)
    expect(workerIgnoredBaselineRecovery(`${threeAddition} after exact tracked and untracked base-ignore inference within 4 additions and 0003 candidates`)).toBe(false)
    expect(workerIgnoredBaselineRecovery(`${threeAddition} after exact baseline-only ordinary-untracked inference within 4 additions and 3 candidates`)).toBe(false)
    expect(workerIgnoredBaselineRecovery(undefined)).toBe(false)
  })

  it('quarantines only baseline-absent files and preserves their bytes', async () => {
    const repo = fixture()
    const before = await baseline(repo)
    const source = writeIgnored(repo.root, 'report.json', '{"worker":true}\n')

    const result = await reconcile(repo, before.digest)
    expect(result).toMatchObject({ digest: EMPTY_IGNORED_PATHS_DIGEST, paths: ['ignored/report.json'], resumed: false, basis: 'recorded' })
    expect(existsSync(source)).toBe(false)
    expect(readFileSync(join(result.quarantine!, 'ignored', 'report.json'), 'utf8')).toBe('{"worker":true}\n')
  })

  it('quarantines a POSIX ignored artifact with a literal backslash path without relocation', async () => {
    if (process.platform === 'win32') return
    const repo = fixture()
    writeIgnored(repo.root, 'pre-existing.txt', 'baseline\n')
    const before = await baseline(repo)
    const source = writeIgnored(repo.root, 'a\\b.txt', 'worker\n')

    const result = await reconcile(repo, before.digest)
    expect(result.paths).toEqual(['ignored/a\\b.txt'])
    expect(existsSync(source)).toBe(false)
    expect(readFileSync(join(result.quarantine!, 'ignored', 'a\\b.txt'), 'utf8')).toBe('worker\n')
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

  it('recovers legacy empty and cryptographically provable non-empty baselines', async () => {
    const empty = fixture()
    const source = writeIgnored(empty.root, 'legacy.txt', 'legacy\n')
    const recovered = await reconcile(empty, EMPTY_IGNORED_PATHS_DIGEST)
    expect(recovered).toMatchObject({ basis: 'authenticated-empty-digest', paths: ['ignored/legacy.txt'] })
    expect(existsSync(source)).toBe(false)

    const nonEmpty = fixture()
    const preserved = writeIgnored(nonEmpty.root, 'pre-existing.txt', 'preserve\n')
    const recorded = await baseline(nonEmpty)
    rmSync(join(nonEmpty.stateDir, 'worker-ignored-path-baselines'), { recursive: true, force: true })
    const added = writeIgnored(nonEmpty.root, 'worker-output.txt', 'worker\n')
    const inferred = await reconcile(nonEmpty, recorded.digest)
    expect(inferred).toMatchObject({ basis: 'authenticated-subset-digest', paths: ['ignored/worker-output.txt'] })
    expect(readFileSync(preserved, 'utf8')).toBe('preserve\n')
    expect(existsSync(added)).toBe(false)
    expect(readFileSync(join(inferred.quarantine!, 'ignored', 'worker-output.txt'), 'utf8')).toBe('worker\n')

    const fourOutputs = fixture()
    const fourPreserved = writeIgnored(fourOutputs.root, 'pre-existing.txt', 'preserve\n')
    const fourRecorded = await baseline(fourOutputs)
    rmSync(join(fourOutputs.stateDir, 'worker-ignored-path-baselines'), { recursive: true, force: true })
    const generated = Array.from({ length: 4 }, (_value, index) => writeIgnored(fourOutputs.root, `worker-output-${index}.txt`, `worker-${index}\n`))
    const inferredFour = await reconcile(fourOutputs, fourRecorded.digest)
    expect(inferredFour).toMatchObject({
      basis: 'authenticated-subset-digest',
      paths: ['ignored/worker-output-0.txt', 'ignored/worker-output-1.txt', 'ignored/worker-output-2.txt', 'ignored/worker-output-3.txt'],
    })
    expect(readFileSync(fourPreserved, 'utf8')).toBe('preserve\n')
    expect(generated.every(path => !existsSync(path))).toBe(true)

    const unmatched = fixture()
    writeIgnored(unmatched.root, 'unknown.txt', 'preserve\n')
    const unknownDigest = createHash('sha256').update('unknown baseline').digest('hex')
    await expect(reconcile(unmatched, unknownDigest)).rejects.toThrow('cannot prove its legacy non-empty baseline')
    expect(readFileSync(join(unmatched.root, 'ignored', 'unknown.txt'), 'utf8')).toBe('preserve\n')
  })

  it('reconstructs a legacy baseline from an exact ignored path newly tracked since the active base', async () => {
    const repo = fixture()
    const promoted = writeIgnored(repo.root, 'pre-existing.txt', 'preserve\n')
    const recorded = await baseline(repo)
    const baseHead = git(repo.root, 'rev-parse', 'HEAD')
    rmSync(join(repo.stateDir, 'worker-ignored-path-baselines'), { recursive: true, force: true })
    git(repo.root, 'add', '-f', '--', 'ignored/pre-existing.txt')
    git(repo.root, 'commit', '-m', 'feat: promote exact ignored candidate')
    const added = writeIgnored(repo.root, 'worker-output.txt', 'worker\n')

    const inferred = await reconcile(repo, recorded.digest, { legacyBaseHead: baseHead })
    expect(inferred).toMatchObject({ basis: 'authenticated-subset-digest', paths: ['ignored/worker-output.txt'] })
    expect(git(repo.root, 'ls-files', '--', 'ignored/pre-existing.txt')).toBe('ignored/pre-existing.txt')
    expect(readFileSync(promoted, 'utf8')).toBe('preserve\n')
    expect(existsSync(added)).toBe(false)
    expect(readFileSync(join(inferred.quarantine!, 'ignored', 'worker-output.txt'), 'utf8')).toBe('worker\n')
  })

  it('recovers a base-ignored tracked promotion that is now de-ignored and detected as a rename', async () => {
    const repo = fixture()
    writeFileSync(join(repo.root, 'source.txt'), 'preserve\n')
    git(repo.root, 'add', '--', 'source.txt')
    git(repo.root, 'commit', '-m', 'chore: add rename source')
    const promoted = writeIgnored(repo.root, 'pre-existing.txt', 'preserve\n')
    const recorded = await baseline(repo)
    const baseHead = git(repo.root, 'rev-parse', 'HEAD')
    rmSync(join(repo.stateDir, 'worker-ignored-path-baselines'), { recursive: true, force: true })
    writeFileSync(join(repo.root, '.gitignore'), 'ignored/worker-output.txt\n')
    rmSync(join(repo.root, 'source.txt'))
    git(repo.root, 'add', '--', '.gitignore', 'source.txt')
    git(repo.root, 'add', '-f', '--', 'ignored/pre-existing.txt')
    git(repo.root, 'commit', '-m', 'feat: rename into a now de-ignored promotion')
    const added = writeIgnored(repo.root, 'worker-output.txt', 'worker\n')

    const inferred = await reconcile(repo, recorded.digest, { legacyBaseHead: baseHead })
    expect(inferred).toMatchObject({ basis: 'authenticated-subset-digest', paths: ['ignored/worker-output.txt'] })
    expect(git(repo.root, 'ls-files', '--', 'ignored/pre-existing.txt')).toBe('ignored/pre-existing.txt')
    expect(readFileSync(promoted, 'utf8')).toBe('preserve\n')
    expect(existsSync(added)).toBe(false)
  })

  it('reconstructs a legacy baseline from an unchanged path de-ignored since the active base', async () => {
    const repo = fixture()
    const preserved = writeIgnored(repo.root, 'pre-existing.txt', 'preserve\n')
    const recorded = await baseline(repo)
    const baseHead = git(repo.root, 'rev-parse', 'HEAD')
    rmSync(join(repo.stateDir, 'worker-ignored-path-baselines'), { recursive: true, force: true })
    writeFileSync(join(repo.root, '.gitignore'), 'ignored/still-ignored.txt\n')
    git(repo.root, 'add', '--', '.gitignore')
    git(repo.root, 'commit', '-m', 'feat: narrow ignore rules')
    const deignoredOutput = writeIgnored(repo.root, 'worker-output.txt', 'ordinary worker output\n')
    const ignoredOutput = writeIgnored(repo.root, 'still-ignored.txt', 'ignored worker output\n')

    const inferred = await reconcile(repo, recorded.digest, { legacyBaseHead: baseHead })
    expect(inferred).toMatchObject({
      basis: 'authenticated-subset-digest',
      paths: ['ignored/still-ignored.txt', 'ignored/worker-output.txt'],
    })
    expect(readFileSync(preserved, 'utf8')).toBe('preserve\n')
    expect(existsSync(deignoredOutput)).toBe(false)
    expect(existsSync(ignoredOutput)).toBe(false)
    expect(readFileSync(join(inferred.quarantine!, 'ignored', 'worker-output.txt'), 'utf8')).toBe('ordinary worker output\n')
    expect(readFileSync(join(inferred.quarantine!, 'ignored', 'still-ignored.txt'), 'utf8')).toBe('ignored worker output\n')
  })

  it('skips optional ordinary inference over 128 paths when ignored baseline authority is sufficient', async () => {
    const repo = fixture()
    const preserved = writeIgnored(repo.root, 'pre-existing.txt', 'preserve\n')
    const recorded = await baseline(repo)
    const baseHead = git(repo.root, 'rev-parse', 'HEAD')
    rmSync(join(repo.stateDir, 'worker-ignored-path-baselines'), { recursive: true, force: true })
    const ordinary = join(repo.root, 'ordinary')
    mkdirSync(ordinary)
    for (let index = 0; index < 129; index += 1) writeFileSync(join(ordinary, `${index}.txt`), `${index}\n`)
    const generated = writeIgnored(repo.root, 'worker-output.txt', 'worker\n')

    const inferred = await reconcile(repo, recorded.digest, { legacyBaseHead: baseHead })
    expect(inferred).toMatchObject({ basis: 'authenticated-subset-digest', paths: ['ignored/worker-output.txt'] })
    expect(readFileSync(preserved, 'utf8')).toBe('preserve\n')
    expect(existsSync(generated)).toBe(false)
    expect(readFileSync(join(ordinary, '128.txt'), 'utf8')).toBe('128\n')
  })

  it('isolates base rules from mutable repository excludes while preserving ordinary unproven WIP', async () => {
    const repo = fixture()
    const exclude = resolve(repo.root, git(repo.root, 'rev-parse', '--git-path', 'info/exclude'))
    writeFileSync(exclude, 'private/\n')
    const preserved = join(repo.root, 'private', 'pre-existing.env')
    mkdirSync(join(repo.root, 'private'))
    writeFileSync(preserved, 'baseline\n')
    const recorded = await baseline(repo)
    const baseHead = git(repo.root, 'rev-parse', 'HEAD')
    expect(recorded.entries).toHaveLength(1)
    rmSync(join(repo.stateDir, 'worker-ignored-path-baselines'), { recursive: true, force: true })
    writeFileSync(exclude, 'victim.txt\n')
    writeFileSync(join(repo.root, '.gitignore'), 'ignored/\n!victim.txt\n')
    const generated = writeIgnored(repo.root, 'worker-output.txt', 'worker\n')
    const ordinaryWip = join(repo.root, 'victim.txt')
    writeFileSync(ordinaryWip, 'human WIP\n')

    const inferred = await reconcile(repo, recorded.digest, { legacyBaseHead: baseHead })
    expect(inferred).toMatchObject({ basis: 'authenticated-subset-digest', paths: ['ignored/worker-output.txt'] })
    expect(readFileSync(preserved, 'utf8')).toBe('baseline\n')
    expect(readFileSync(ordinaryWip, 'utf8')).toBe('human WIP\n')
    expect(existsSync(generated)).toBe(false)
    expect(readFileSync(join(inferred.quarantine!, 'ignored', 'worker-output.txt'), 'utf8')).toBe('worker\n')
  })

  it('never materializes a symlink .gitignore blob as an active base rule', async () => {
    const repo = fixture()
    mkdirSync(join(repo.root, 'safe'))
    writeFileSync(join(repo.root, 'safe', '.gitignore'), 'baseline.env\n')
    git(repo.root, 'add', '--', 'safe/.gitignore')
    const linkTarget = join(repo.stateDir, 'ignore-link-target.txt')
    writeFileSync(linkTarget, 'victim.txt\n')
    const objectId = git(repo.root, 'hash-object', '-w', '--', linkTarget)
    git(repo.root, 'update-index', '--add', '--cacheinfo', `120000,${objectId},.gitignore`)
    git(repo.root, 'commit', '-m', 'chore: symlink ignore base')
    const baseHead = git(repo.root, 'rev-parse', 'HEAD')
    writeFileSync(join(repo.root, 'safe', 'baseline.env'), 'baseline\n')
    const victim = join(repo.root, 'victim.txt')
    writeFileSync(victim, 'ordinary WIP\n')
    git(repo.root, 'rm', '-f', '--', '.gitignore')
    git(repo.root, 'commit', '-m', 'feat: remove symlink ignore entry')
    const fingerprint = `safe/baseline.env\0file\0${Buffer.byteLength('baseline\n')}\0${createHash('sha256').update('baseline\n').digest('hex')}`
    const expectedDigest = createHash('sha256').update(JSON.stringify([fingerprint])).digest('hex')

    const inferred = await reconcile(repo, expectedDigest, { legacyBaseHead: baseHead })
    expect(inferred).toMatchObject({ basis: 'authenticated-subset-digest', paths: [] })
    expect(readFileSync(victim, 'utf8')).toBe('ordinary WIP\n')
    expect(existsSync(join(repo.stateDir, 'worker-ignored-path-recovery', '0-1.json'))).toBe(false)
  })

  it('preserves literal POSIX backslashes instead of relocating base ignore rules', async () => {
    if (process.platform === 'win32') return
    const repo = fixture()
    writeFileSync(join(repo.root, '.gitignore'), '')
    mkdirSync(join(repo.root, 'safe'))
    writeFileSync(join(repo.root, 'safe', '.gitignore'), 'safe.env\n')
    mkdirSync(join(repo.root, 'a\\b'))
    writeFileSync(join(repo.root, 'a\\b', '.gitignore'), 'victim.txt\n')
    git(repo.root, 'add', '--all')
    git(repo.root, 'commit', '-m', 'chore: literal backslash ignore base')
    const baseHead = git(repo.root, 'rev-parse', 'HEAD')
    writeFileSync(join(repo.root, 'safe', 'safe.env'), 'baseline\n')
    const victim = join(repo.root, 'a', 'b', 'victim.txt')
    mkdirSync(join(victim, '..'), { recursive: true })
    writeFileSync(victim, 'ordinary WIP\n')
    const recorded = await baseline(repo)
    expect(recorded.entries).toHaveLength(1)
    rmSync(join(repo.stateDir, 'worker-ignored-path-baselines'), { recursive: true, force: true })

    const inferred = await reconcile(repo, recorded.digest, { legacyBaseHead: baseHead })
    expect(inferred).toMatchObject({ basis: 'authenticated-subset-digest', paths: [] })
    expect(readFileSync(victim, 'utf8')).toBe('ordinary WIP\n')
  })

  it('materializes regular base ignore blobs byte-exactly without UTF-8 replacement rules', async () => {
    const repo = fixture()
    writeFileSync(join(repo.root, '.gitignore'), Buffer.from([...
      Buffer.from('safe.env\n', 'utf8'), 0xff, 0x0a,
    ]))
    git(repo.root, 'add', '--', '.gitignore')
    git(repo.root, 'commit', '-m', 'chore: raw-byte ignore base')
    const baseHead = git(repo.root, 'rev-parse', 'HEAD')
    writeFileSync(join(repo.root, 'safe.env'), 'baseline\n')
    const victim = join(repo.root, '\ufffd')
    writeFileSync(victim, 'ordinary WIP\n')
    const recorded = await baseline(repo)
    expect(recorded.entries).toHaveLength(1)
    rmSync(join(repo.stateDir, 'worker-ignored-path-baselines'), { recursive: true, force: true })
    writeFileSync(join(repo.root, '.gitignore'), '')
    git(repo.root, 'add', '--', '.gitignore')
    git(repo.root, 'commit', '-m', 'feat: remove raw ignore rules')

    const inferred = await reconcile(repo, recorded.digest, { legacyBaseHead: baseHead })
    expect(inferred).toMatchObject({ basis: 'authenticated-subset-digest', paths: [] })
    expect(readFileSync(victim, 'utf8')).toBe('ordinary WIP\n')
    expect(existsSync(join(repo.stateDir, 'worker-ignored-path-recovery', '0-1.json'))).toBe(false)
  })

  it('rejects base ignore files with checkout-transforming attributes', async () => {
    const repo = fixture()
    writeFileSync(join(repo.root, '.gitattributes'), '.gitignore filter=untrusted\n')
    git(repo.root, 'add', '--', '.gitattributes')
    git(repo.root, 'commit', '-m', 'chore: configure ignore filter')
    const preserved = writeIgnored(repo.root, 'pre-existing.txt', 'preserve\n')
    const recorded = await baseline(repo)
    const baseHead = git(repo.root, 'rev-parse', 'HEAD')
    rmSync(join(repo.stateDir, 'worker-ignored-path-baselines'), { recursive: true, force: true })
    writeFileSync(join(repo.root, '.gitignore'), '')
    git(repo.root, 'add', '--', '.gitignore')
    git(repo.root, 'commit', '-m', 'feat: remove ignore rules')
    const output = writeIgnored(repo.root, 'worker-output.txt', 'worker\n')

    await expect(reconcile(repo, recorded.digest, { legacyBaseHead: baseHead })).rejects.toThrow('checkout-transforming attribute')
    expect(readFileSync(preserved, 'utf8')).toBe('preserve\n')
    expect(readFileSync(output, 'utf8')).toBe('worker\n')
    expect(existsSync(join(repo.stateDir, 'worker-ignored-path-recovery', '0-1.json'))).toBe(false)
  })

  it('moves nothing when a base-ignored path was changed before it became ordinary untracked state', async () => {
    const repo = fixture()
    const preserved = writeIgnored(repo.root, 'pre-existing.txt', 'before\n')
    const recorded = await baseline(repo)
    const baseHead = git(repo.root, 'rev-parse', 'HEAD')
    rmSync(join(repo.stateDir, 'worker-ignored-path-baselines'), { recursive: true, force: true })
    writeFileSync(preserved, 'changed\n')
    writeFileSync(join(repo.root, '.gitignore'), '')
    git(repo.root, 'add', '--', '.gitignore')
    git(repo.root, 'commit', '-m', 'feat: remove ignore rules')
    const output = writeIgnored(repo.root, 'worker-output.txt', 'worker\n')

    await expect(reconcile(repo, recorded.digest, { legacyBaseHead: baseHead })).rejects.toThrow('cannot prove its legacy non-empty baseline')
    expect(readFileSync(preserved, 'utf8')).toBe('changed\n')
    expect(readFileSync(output, 'utf8')).toBe('worker\n')
    expect(existsSync(join(repo.stateDir, 'worker-ignored-path-recovery', '0-1.json'))).toBe(false)
  })

  it.skip('obsolete: 512 MiB legacy ignored-proof budget is not used by mutable workers', async () => {
    const repo = fixture()
    writeIgnored(repo.root, 'small.txt', 'x')
    const ordinary = join(repo.root, 'ordinary-large.bin')
    writeFileSync(ordinary, '')
    truncateSync(ordinary, 512 * 1024 * 1024)

    await expect(reconcile(repo, createHash('sha256').update('unknown').digest('hex'), {
      legacyBaseHead: git(repo.root, 'rev-parse', 'HEAD'),
    })).rejects.toThrow('worker ignored artifact fingerprinting exceeds 512 MiB of file content')
    expect(existsSync(ordinary)).toBe(true)
    expect(existsSync(join(repo.stateDir, 'worker-ignored-path-recovery', '0-1.json'))).toBe(false)
  })

  it.skip('obsolete: oversized legacy promoted content is not inspected for mutable workers', async () => {
    const repo = fixture()
    const baseHead = git(repo.root, 'rev-parse', 'HEAD')
    const promoted = writeIgnored(repo.root, 'oversized.bin', 'small\n')
    git(repo.root, 'add', '-f', '--', 'ignored/oversized.bin')
    git(repo.root, 'commit', '-m', 'feat: add ignored promotion candidate')
    truncateSync(promoted, 512 * 1024 * 1024 + 1)

    await expect(reconcile(repo, 'e'.repeat(64), { legacyBaseHead: baseHead })).rejects.toThrow('exceeds 512 MiB of file content')
    expect(existsSync(join(repo.stateDir, 'worker-ignored-path-baselines', '0-1.json'))).toBe(false)
    expect(existsSync(join(repo.stateDir, 'worker-ignored-path-recovery', '0-1.json'))).toBe(false)
  })

  it('does not add ordinary newly tracked source paths to legacy ignored candidates', async () => {
    const repo = fixture()
    const preserved = writeIgnored(repo.root, 'pre-existing.txt', 'preserve\n')
    const recorded = await baseline(repo)
    const baseHead = git(repo.root, 'rev-parse', 'HEAD')
    rmSync(join(repo.stateDir, 'worker-ignored-path-baselines'), { recursive: true, force: true })
    writeFileSync(join(repo.root, 'new-source.txt'), 'tracked candidate\n')
    git(repo.root, 'add', '--', 'new-source.txt')
    git(repo.root, 'commit', '-m', 'feat: add ordinary source')
    const added = writeIgnored(repo.root, 'worker-output.txt', 'worker\n')

    const inferred = await reconcile(repo, recorded.digest, { legacyBaseHead: baseHead })
    expect(inferred.paths).toEqual(['ignored/worker-output.txt'])
    expect(readFileSync(preserved, 'utf8')).toBe('preserve\n')
    expect(readFileSync(join(repo.root, 'new-source.txt'), 'utf8')).toBe('tracked candidate\n')
    expect(existsSync(added)).toBe(false)
  })

  it.skip('obsolete: inferred legacy promotion receipts no longer gate mutable workers', async () => {
    const repo = fixture()
    const promoted = writeIgnored(repo.root, 'pre-existing.txt', 'before\n')
    const recorded = await baseline(repo)
    const baseHead = git(repo.root, 'rev-parse', 'HEAD')
    rmSync(join(repo.stateDir, 'worker-ignored-path-baselines'), { recursive: true, force: true })
    git(repo.root, 'add', '-f', '--', 'ignored/pre-existing.txt')
    git(repo.root, 'commit', '-m', 'feat: promote exact ignored candidate')
    const added = writeIgnored(repo.root, 'worker-output.txt', 'worker\n')

    await expect(reconcile(repo, recorded.digest, {
      legacyBaseHead: baseHead,
      afterLegacyBaselinePersisted: async () => { throw new Error('crash after inferred promotion receipt') },
    })).rejects.toThrow('crash after inferred promotion receipt')
    truncateSync(promoted, 512 * 1024 * 1024 + 1)

    await expect(reconcile(repo, recorded.digest, { legacyBaseHead: baseHead })).rejects.toThrow('exceeds 512 MiB of file content')
    expect(existsSync(promoted)).toBe(true)
    expect(readFileSync(added, 'utf8')).toBe('worker\n')
    expect(existsSync(join(repo.stateDir, 'worker-ignored-path-baselines', '0-1.json'))).toBe(true)
    expect(existsSync(join(repo.stateDir, 'worker-ignored-path-recovery', '0-1.json'))).toBe(false)
  })

  it('moves nothing when a newly tracked legacy baseline candidate races after inference', async () => {
    const repo = fixture()
    const promoted = writeIgnored(repo.root, 'pre-existing.txt', 'before\n')
    const recorded = await baseline(repo)
    const baseHead = git(repo.root, 'rev-parse', 'HEAD')
    rmSync(join(repo.stateDir, 'worker-ignored-path-baselines'), { recursive: true, force: true })
    git(repo.root, 'add', '-f', '--', 'ignored/pre-existing.txt')
    git(repo.root, 'commit', '-m', 'feat: promote exact ignored candidate')
    const added = writeIgnored(repo.root, 'worker-output.txt', 'worker\n')

    await expect(reconcile(repo, recorded.digest, {
      legacyBaseHead: baseHead,
      afterLegacySnapshot: async () => { writeFileSync(promoted, 'raced\n') },
    })).rejects.toThrow('ignored artifacts, tracked promotions, or ordinary untracked paths changed during legacy baseline inference')
    expect(readFileSync(promoted, 'utf8')).toBe('raced\n')
    expect(readFileSync(added, 'utf8')).toBe('worker\n')
    expect(existsSync(join(repo.stateDir, 'worker-ignored-path-baselines', '0-1.json'))).toBe(false)
  })

  it('moves nothing when a newly tracked legacy baseline candidate changed before promotion', async () => {
    const repo = fixture()
    const promoted = writeIgnored(repo.root, 'pre-existing.txt', 'before\n')
    const recorded = await baseline(repo)
    const baseHead = git(repo.root, 'rev-parse', 'HEAD')
    rmSync(join(repo.stateDir, 'worker-ignored-path-baselines'), { recursive: true, force: true })
    writeFileSync(promoted, 'changed\n')
    git(repo.root, 'add', '-f', '--', 'ignored/pre-existing.txt')
    git(repo.root, 'commit', '-m', 'feat: mutate ignored candidate')
    const added = writeIgnored(repo.root, 'worker-output.txt', 'worker\n')

    await expect(reconcile(repo, recorded.digest, { legacyBaseHead: baseHead })).rejects.toThrow('cannot prove its legacy non-empty baseline')
    expect(readFileSync(promoted, 'utf8')).toBe('changed\n')
    expect(readFileSync(added, 'utf8')).toBe('worker\n')
    expect(existsSync(join(repo.stateDir, 'worker-ignored-path-baselines', '0-1.json'))).toBe(false)
    expect(existsSync(join(repo.stateDir, 'worker-ignored-path-recovery', '0-1.json'))).toBe(false)
  })

  it('moves nothing when a legacy non-empty baseline fingerprint changed', async () => {
    const repo = fixture()
    const existing = writeIgnored(repo.root, 'pre-existing.txt', 'before\n')
    const recorded = await baseline(repo)
    rmSync(join(repo.stateDir, 'worker-ignored-path-baselines'), { recursive: true, force: true })
    writeFileSync(existing, 'changed\n')
    const added = writeIgnored(repo.root, 'worker-output.txt', 'worker\n')

    await expect(reconcile(repo, recorded.digest)).rejects.toThrow('cannot prove its legacy non-empty baseline')
    expect(readFileSync(existing, 'utf8')).toBe('changed\n')
    expect(readFileSync(added, 'utf8')).toBe('worker\n')
    expect(existsSync(join(repo.stateDir, 'worker-ignored-path-recovery', '0-1.json'))).toBe(false)
  })

  it('does not persist a poisoned inferred baseline when files race identity sampling', async () => {
    const repo = fixture()
    const existing = writeIgnored(repo.root, 'pre-existing.txt', 'before\n')
    const recorded = await baseline(repo)
    rmSync(join(repo.stateDir, 'worker-ignored-path-baselines'), { recursive: true, force: true })
    const added = writeIgnored(repo.root, 'worker-output.txt', 'worker\n')

    await expect(reconcile(repo, recorded.digest, {
      afterLegacySnapshot: async () => { writeFileSync(existing, 'raced\n') },
    })).rejects.toThrow('changed during legacy baseline inference')
    expect(existsSync(join(repo.stateDir, 'worker-ignored-path-baselines', '0-1.json'))).toBe(false)
    expect(readFileSync(added, 'utf8')).toBe('worker\n')

    writeFileSync(existing, 'before\n')
    const recovered = await reconcile(repo, recorded.digest)
    expect(recovered).toMatchObject({ basis: 'authenticated-subset-digest', paths: ['ignored/worker-output.txt'] })
    expect(readFileSync(existing, 'utf8')).toBe('before\n')
  })

  it('safely re-infers an inconsistent subset receipt before any transaction exists', async () => {
    const repo = fixture()
    const existing = writeIgnored(repo.root, 'pre-existing.txt', 'before\n')
    const recorded = await baseline(repo)
    rmSync(join(repo.stateDir, 'worker-ignored-path-baselines'), { recursive: true, force: true })
    writeIgnored(repo.root, 'worker-output.txt', 'worker\n')
    await expect(reconcile(repo, recorded.digest, {
      afterLegacyBaselinePersisted: async () => {
        unlinkSync(existing)
        writeFileSync(existing, 'raced after persist\n')
        throw new Error('crash after inferred baseline persisted')
      },
    })).rejects.toThrow('crash after inferred baseline persisted')
    expect(existsSync(join(repo.stateDir, 'worker-ignored-path-baselines', '0-1.json'))).toBe(true)

    unlinkSync(existing)
    writeFileSync(existing, 'before\n')
    const recovered = await reconcile(repo, recorded.digest)
    expect(recovered).toMatchObject({ basis: 'authenticated-subset-digest', paths: ['ignored/worker-output.txt'] })
    expect(readFileSync(existing, 'utf8')).toBe('before\n')
  })

  it('exhausts four removals for the complete predecessor-error entry envelope', async () => {
    const repo = fixture()
    for (let index = 0; index < 39; index += 1) {
      writeIgnored(repo.root, `wide/${String(index).padStart(2, '0')}.txt`, `${index}\n`)
    }
    const unknownDigest = createHash('sha256').update('unmatched predecessor baseline').digest('hex')

    await expect(reconcile(repo, unknownDigest)).rejects.toThrow('after exact baseline-only ordinary-untracked inference within 4 additions and 92170 candidates')
    expect(existsSync(join(repo.stateDir, 'worker-ignored-path-baselines', '0-1.json'))).toBe(false)
    expect(existsSync(join(repo.stateDir, 'worker-ignored-path-recovery', '0-1.json'))).toBe(false)
  }, 30_000)

  it('retains the predecessor work cap outside the exact four-addition bridge envelope', async () => {
    const repo = fixture()
    for (let index = 0; index < 40; index += 1) {
      writeIgnored(repo.root, `wide/${String(index).padStart(2, '0')}.txt`, `${index}\n`)
    }
    const unknownDigest = createHash('sha256').update('unmatched wide predecessor baseline').digest('hex')

    await expect(reconcile(repo, unknownDigest)).rejects.toThrow('exceeds 10000 authenticated candidates')
    expect(existsSync(join(repo.stateDir, 'worker-ignored-path-baselines', '0-1.json'))).toBe(false)
    expect(existsSync(join(repo.stateDir, 'worker-ignored-path-recovery', '0-1.json'))).toBe(false)
  })

  it('rejects legacy subset inference before combinatorial work exceeds its entry budget', async () => {
    const repo = fixture()
    for (let index = 0; index < 129; index += 1) writeIgnored(repo.root, `wide/${String(index).padStart(3, '0')}.txt`, `${index}\n`)
    const unknownDigest = createHash('sha256').update('unmatched wide baseline').digest('hex')

    await expect(reconcile(repo, unknownDigest)).rejects.toThrow('exceeds 128 current entries')
    expect(existsSync(join(repo.stateDir, 'worker-ignored-path-baselines', '0-1.json'))).toBe(false)
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
