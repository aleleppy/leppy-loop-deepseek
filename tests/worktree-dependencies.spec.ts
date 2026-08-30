import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { dependencyBridgeRecoveryAvailable, dependencyCacheMiss, dependencyResolutionMiss, inspectWorktreeDependencies, provisionWorktreeDependencies } from '../src/worktree-dependencies.js'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function staging(root: string): string {
  return join(root, '.git', 'leppy-dependency-stage-test')
}

async function fakeNpmInstall(installRoot: string): Promise<void> {
  const shim = join(installRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc')
  mkdirSync(dirname(shim), { recursive: true })
  mkdirSync(join(installRoot, 'node_modules', 'typescript'), { recursive: true })
  writeFileSync(join(installRoot, 'node_modules', 'typescript', 'package.json'), '{"name":"typescript","version":"5.9.3","resolved":"https://registry.npmjs.org/typescript/-/typescript-5.9.3.tgz","integrity":"sha512-jl1vZzPDinLr9eUt3J/t7V6FgNEw9QjvBPdysz9KfQDD41fQrC2Y4vKQdiaUpFT4bXlb1RHhLpp8wtm6M5TgSw==","bin":{"tsc":"bin/tsc"}}\n')
  writeFileSync(shim, 'fixture shim\n')
  writeFileSync(join(installRoot, 'node_modules', '.package-lock.json'), '{"lockfileVersion":3,"packages":{"node_modules/typescript":{"version":"5.9.3","resolved":"https://registry.npmjs.org/typescript/-/typescript-5.9.3.tgz","integrity":"sha512-jl1vZzPDinLr9eUt3J/t7V6FgNEw9QjvBPdysz9KfQDD41fQrC2Y4vKQdiaUpFT4bXlb1RHhLpp8wtm6M5TgSw==","bin":{"tsc":"bin/tsc"}}}}\n')
}

function repository(): { root: string; worktree: string } {
  const root = mkdtempSync(join(tmpdir(), 'leppy-dependencies-'))
  writeFileSync(join(root, '.gitignore'), 'node_modules/\n')
  writeFileSync(join(root, 'package.json'), '{"name":"fixture","private":true,"devDependencies":{"typescript":"5.9.3"}}\n')
  writeFileSync(join(root, 'package-lock.json'), '{"name":"fixture","lockfileVersion":3,"packages":{"":{"name":"fixture","devDependencies":{"typescript":"5.9.3"}},"node_modules/typescript":{"version":"5.9.3","resolved":"https://registry.npmjs.org/typescript/-/typescript-5.9.3.tgz","integrity":"sha512-jl1vZzPDinLr9eUt3J/t7V6FgNEw9QjvBPdysz9KfQDD41fQrC2Y4vKQdiaUpFT4bXlb1RHhLpp8wtm6M5TgSw==","bin":{"tsc":"bin/tsc"}}}}\n')
  git(root, 'init', '-b', 'main')
  git(root, 'config', 'user.email', 'tests@example.invalid')
  git(root, 'config', 'user.name', 'Leppy Tests')
  git(root, 'add', '--', '.gitignore', 'package.json', 'package-lock.json')
  git(root, 'commit', '-m', 'chore: seed')
  const shim = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc')
  mkdirSync(dirname(shim), { recursive: true })
  mkdirSync(join(root, 'node_modules', 'typescript'), { recursive: true })
  writeFileSync(join(root, 'node_modules', 'typescript', 'package.json'), '{"name":"typescript","version":"5.9.3","resolved":"https://registry.npmjs.org/typescript/-/typescript-5.9.3.tgz","integrity":"sha512-jl1vZzPDinLr9eUt3J/t7V6FgNEw9QjvBPdysz9KfQDD41fQrC2Y4vKQdiaUpFT4bXlb1RHhLpp8wtm6M5TgSw==","bin":{"tsc":"bin/tsc"}}\n')
  writeFileSync(shim, 'fixture shim\n')
  writeFileSync(join(root, 'node_modules', '.package-lock.json'), '{"lockfileVersion":3,"packages":{"node_modules/typescript":{"version":"5.9.3","resolved":"https://registry.npmjs.org/typescript/-/typescript-5.9.3.tgz","integrity":"sha512-jl1vZzPDinLr9eUt3J/t7V6FgNEw9QjvBPdysz9KfQDD41fQrC2Y4vKQdiaUpFT4bXlb1RHhLpp8wtm6M5TgSw==","bin":{"tsc":"bin/tsc"}}}}\n')
  const worktree = `${root}-worker`
  git(root, 'worktree', 'add', '-b', 'worker', worktree, 'HEAD')
  return { root, worktree }
}

describe('worktree dependency hydration', () => {
  it('atomically copies exact-lock dependencies and preserves the source on worktree removal', async () => {
    const { root, worktree } = repository()
    expect(inspectWorktreeDependencies(root, worktree)).toMatchObject({ status: 'copyable', lockfile: 'package-lock.json' })

    await expect(provisionWorktreeDependencies(root, worktree, { stagingRoot: staging(root) })).resolves.toMatchObject({ status: 'copied' })
    expect(inspectWorktreeDependencies(root, worktree)).toMatchObject({ status: 'local', lockfile: 'package-lock.json' })
    expect(existsSync(join(worktree, 'node_modules', 'typescript', 'package.json'))).toBe(true)
    expect(existsSync(staging(root))).toBe(false)
    expect(git(worktree, 'status', '--porcelain')).toBe('')

    git(root, 'worktree', 'remove', '--force', worktree)
    expect(existsSync(join(root, 'node_modules', 'typescript', 'package.json'))).toBe(true)
  })

  it('cleans stale private staging without deleting any target tree', async () => {
    const { root, worktree } = repository()
    mkdirSync(staging(root), { recursive: true })
    writeFileSync(join(staging(root), 'stale.txt'), 'stale\n')
    await expect(provisionWorktreeDependencies(root, worktree, { stagingRoot: staging(root) })).resolves.toMatchObject({ status: 'copied' })
    expect(existsSync(staging(root))).toBe(false)
    expect(inspectWorktreeDependencies(root, worktree)).toMatchObject({ status: 'local' })
  })

  it('materializes an exact worktree npm lock in private staging when no trusted copy exists', async () => {
    const { root, worktree } = repository()
    rmSync(join(root, 'node_modules'), { recursive: true, force: true })
    expect(inspectWorktreeDependencies(root, worktree)).toMatchObject({ status: 'installable', lockfile: 'package-lock.json' })
    await expect(provisionWorktreeDependencies(root, worktree, {
      stagingRoot: staging(root), installNpm: fakeNpmInstall,
    })).resolves.toMatchObject({ status: 'copied', materializedBy: 'npm-ci' })
    expect(inspectWorktreeDependencies(root, worktree)).toMatchObject({ status: 'local' })
    expect(existsSync(staging(root))).toBe(false)
  })

  it.runIf(process.env.LEPPY_NETWORK_SMOKE === '1')('materializes through the production npm CLI with lifecycle scripts disabled', async () => {
    const { root, worktree } = repository()
    rmSync(join(root, 'node_modules'), { recursive: true, force: true })
    await expect(provisionWorktreeDependencies(root, worktree, { stagingRoot: staging(root) }))
      .resolves.toMatchObject({ status: 'copied', materializedBy: 'npm-ci' })
    expect(existsSync(join(worktree, 'node_modules', 'typescript', 'bin', 'tsc'))).toBe(true)
  }, 120_000)

  it.runIf(Boolean(process.env.LEPPY_REAL_NPM_PROJECT))('materializes a real project lock with bundled dependencies before worker release', async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'leppy-real-npm-lock-'))
    const source = join(fixtureRoot, 'source')
    const worktree = join(fixtureRoot, 'worktree')
    mkdirSync(source)
    mkdirSync(worktree)
    const project = process.env.LEPPY_REAL_NPM_PROJECT!
    for (const name of ['package.json', 'package-lock.json']) {
      cpSync(join(project, name), join(source, name))
      cpSync(join(project, name), join(worktree, name))
    }
    try {
      expect(inspectWorktreeDependencies(source, worktree)).toMatchObject({ status: 'installable' })
      await expect(provisionWorktreeDependencies(source, worktree, { stagingRoot: join(fixtureRoot, 'state') }))
        .resolves.toMatchObject({ status: 'copied', materializedBy: 'npm-ci' })
      expect(inspectWorktreeDependencies(source, worktree)).toMatchObject({ status: 'local' })
      expect(existsSync(join(worktree, 'node_modules', 'typescript', 'bin', 'tsc'))).toBe(true)
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true })
    }
  }, 10 * 60_000)

  it('rejects install locks that widen materialization beyond HTTPS integrity-pinned packages', () => {
    const local = repository()
    rmSync(join(local.root, 'node_modules'), { recursive: true, force: true })
    const localLock = JSON.parse(readFileSync(join(local.worktree, 'package-lock.json'), 'utf8')) as { packages: Record<string, Record<string, unknown>> }
    localLock.packages['node_modules/typescript'] = { version: '5.9.3', resolved: 'file:../typescript' }
    writeFileSync(join(local.worktree, 'package-lock.json'), `${JSON.stringify(localLock)}\n`)
    expect(inspectWorktreeDependencies(local.root, local.worktree)).toMatchObject({ status: 'unavailable', reason: expect.stringContaining('cannot be materialized') })

    const gitDependency = repository()
    rmSync(join(gitDependency.root, 'node_modules'), { recursive: true, force: true })
    const gitLock = JSON.parse(readFileSync(join(gitDependency.worktree, 'package-lock.json'), 'utf8')) as { packages: Record<string, Record<string, unknown>> }
    gitLock.packages['node_modules/typescript'] = { version: '5.9.3', resolved: 'git+ssh://git@example.invalid/typescript.git', integrity: 'sha512-YWJjZA==' }
    writeFileSync(join(gitDependency.worktree, 'package-lock.json'), `${JSON.stringify(gitLock)}\n`)
    expect(inspectWorktreeDependencies(gitDependency.root, gitDependency.worktree)).toMatchObject({ status: 'unavailable' })
  })

  it('accepts integrity-covered inBundle children but rejects undeclared bundled metadata', async () => {
    const accepted = repository()
    rmSync(join(accepted.root, 'node_modules'), { recursive: true, force: true })
    const parent = 'node_modules/bundled-parent'
    const child = `${parent}/node_modules/bundled-child`
    const parentMetadata = {
      version: '1.0.0', resolved: 'https://registry.npmjs.org/bundled-parent/-/bundled-parent-1.0.0.tgz',
      integrity: 'sha512-YWJjZA==', bundleDependencies: ['bundled-child'],
    }
    const childMetadata = { version: '2.0.0', inBundle: true }
    const lock = { name: 'fixture', lockfileVersion: 3, packages: { '': { name: 'fixture' }, [parent]: parentMetadata, [child]: childMetadata } }
    writeFileSync(join(accepted.worktree, 'package-lock.json'), `${JSON.stringify(lock)}\n`)
    expect(inspectWorktreeDependencies(accepted.root, accepted.worktree)).toMatchObject({ status: 'installable' })
    await expect(provisionWorktreeDependencies(accepted.root, accepted.worktree, {
      stagingRoot: staging(accepted.root),
      installNpm: async installRoot => {
        mkdirSync(join(installRoot, child), { recursive: true })
        writeFileSync(join(installRoot, parent, 'package.json'), '{"name":"bundled-parent","version":"1.0.0"}\n')
        writeFileSync(join(installRoot, child, 'package.json'), '{"name":"bundled-child","version":"2.0.0"}\n')
        writeFileSync(join(installRoot, 'node_modules', '.package-lock.json'), `${JSON.stringify({ lockfileVersion: 3, packages: { [parent]: parentMetadata, [child]: childMetadata } })}\n`)
      },
    })).resolves.toMatchObject({ status: 'copied', materializedBy: 'npm-ci' })

    const rejected = repository()
    rmSync(join(rejected.root, 'node_modules'), { recursive: true, force: true })
    const undeclared = { ...lock, packages: { ...lock.packages, [parent]: { ...parentMetadata, bundleDependencies: [] } } }
    writeFileSync(join(rejected.worktree, 'package-lock.json'), `${JSON.stringify(undeclared)}\n`)
    expect(inspectWorktreeDependencies(rejected.root, rejected.worktree)).toMatchObject({
      status: 'unavailable', reason: expect.stringContaining('not declared by its bundle parent'),
    })
  })

  it('rejects hidden top-level npm payloads before atomic publication', async () => {
    const { root, worktree } = repository()
    rmSync(join(root, 'node_modules'), { recursive: true, force: true })
    await expect(provisionWorktreeDependencies(root, worktree, {
      stagingRoot: staging(root),
      installNpm: async installRoot => {
        await fakeNpmInstall(installRoot)
        writeFileSync(join(installRoot, 'node_modules', '.payload'), 'hidden\n')
      },
    })).rejects.toThrow('does not match the authenticated lock')
    expect(existsSync(join(worktree, 'node_modules'))).toBe(false)

    const scoped = repository()
    rmSync(join(scoped.root, 'node_modules'), { recursive: true, force: true })
    await expect(provisionWorktreeDependencies(scoped.root, scoped.worktree, {
      stagingRoot: staging(scoped.root),
      installNpm: async installRoot => {
        await fakeNpmInstall(installRoot)
        mkdirSync(join(installRoot, 'node_modules', '@scope'))
        writeFileSync(join(installRoot, 'node_modules', '@scope', '.payload'), 'hidden\n')
      },
    })).rejects.toThrow('does not match the authenticated lock')
  })

  it('enforces the entry cap while streaming a wide dependency directory', async () => {
    const { root, worktree } = repository()
    rmSync(join(root, 'node_modules'), { recursive: true, force: true })
    await expect(provisionWorktreeDependencies(root, worktree, {
      stagingRoot: staging(root),
      maxDependencyFiles: 16,
      installNpm: async installRoot => {
        await fakeNpmInstall(installRoot)
        const wide = join(installRoot, 'node_modules', 'typescript', 'wide')
        mkdirSync(wide)
        for (let index = 0; index < 32; index += 1) writeFileSync(join(wide, `${index}.txt`), `${index}\n`)
      },
    })).rejects.toThrow('dependency tree exceeds hydration file limit')
    expect(existsSync(join(worktree, 'node_modules'))).toBe(false)
  })

  it('fails closed when worktree package-manager metadata is invalid or ambiguous', () => {
    const first = repository()
    writeFileSync(join(first.worktree, 'package-lock.json'), '{"name":"fixture","lockfileVersion":2}\n')
    expect(inspectWorktreeDependencies(first.root, first.worktree)).toMatchObject({ status: 'unavailable' })

    const second = repository()
    writeFileSync(join(second.root, 'yarn.lock'), '# competing lock\n')
    writeFileSync(join(second.worktree, 'yarn.lock'), '# competing lock\n')
    expect(inspectWorktreeDependencies(second.root, second.worktree)).toMatchObject({
      status: 'unavailable', reason: 'automatic dependency hydration requires one unambiguous lockfile',
    })
  })

  it('accepts a valid npm tree with no executable shims', async () => {
    const { root, worktree } = repository()
    rmSync(join(root, 'node_modules', '.bin'), { recursive: true, force: true })
    writeFileSync(join(root, 'package-lock.json'), '{"name":"fixture","lockfileVersion":3,"packages":{"":{"name":"fixture"},"node_modules/typescript":{"version":"5.9.3"}}}\n')
    writeFileSync(join(worktree, 'package-lock.json'), readFileSync(join(root, 'package-lock.json'), 'utf8'))
    writeFileSync(join(root, 'node_modules', 'typescript', 'package.json'), '{"name":"typescript","version":"5.9.3"}\n')
    writeFileSync(join(root, 'node_modules', '.package-lock.json'), '{"lockfileVersion":3,"packages":{"node_modules/typescript":{"version":"5.9.3"}}}\n')
    expect(inspectWorktreeDependencies(root, worktree)).toMatchObject({ status: 'copyable' })
    await expect(provisionWorktreeDependencies(root, worktree, { stagingRoot: staging(root) })).resolves.toMatchObject({ status: 'copied' })
  })

  it('allows optional packages omitted from the current platform receipt', () => {
    const { root, worktree } = repository()
    const lock = '{"name":"fixture","lockfileVersion":3,"packages":{"":{"name":"fixture","devDependencies":{"typescript":"5.9.3"}},"node_modules/typescript":{"version":"5.9.3","resolved":"https://registry.npmjs.org/typescript/-/typescript-5.9.3.tgz","integrity":"sha512-jl1vZzPDinLr9eUt3J/t7V6FgNEw9QjvBPdysz9KfQDD41fQrC2Y4vKQdiaUpFT4bXlb1RHhLpp8wtm6M5TgSw==","bin":{"tsc":"bin/tsc"}},"node_modules/platform-only":{"version":"1.0.0","optional":true,"os":["darwin"]}}}\n'
    writeFileSync(join(root, 'package-lock.json'), lock)
    writeFileSync(join(worktree, 'package-lock.json'), lock)
    expect(inspectWorktreeDependencies(root, worktree)).toMatchObject({ status: 'copyable' })
  })

  it('refuses stale source receipts and falls back to isolated lock materialization', () => {
    const stale = repository()
    writeFileSync(join(stale.root, 'node_modules', '.package-lock.json'), '{"lockfileVersion":3,"packages":{"node_modules/typescript":{"version":"5.8.0"}}}\n')
    expect(inspectWorktreeDependencies(stale.root, stale.worktree)).toMatchObject({ status: 'installable' })

    const rogue = repository()
    mkdirSync(join(rogue.root, 'node_modules', 'rogue'))
    writeFileSync(join(rogue.root, 'node_modules', 'rogue', 'package.json'), '{"name":"rogue"}\n')
    expect(inspectWorktreeDependencies(rogue.root, rogue.worktree)).toMatchObject({ status: 'installable' })
  })

  it('never replaces an unowned worktree node_modules', async () => {
    const { root, worktree } = repository()
    mkdirSync(join(worktree, 'node_modules'))
    writeFileSync(join(worktree, 'node_modules', 'owned.txt'), 'keep\n')
    expect(inspectWorktreeDependencies(root, worktree)).toMatchObject({ status: 'unavailable' })
    await expect(provisionWorktreeDependencies(root, worktree, { stagingRoot: staging(root) })).resolves.toMatchObject({ status: 'unavailable' })
    expect(readFileSync(join(worktree, 'node_modules', 'owned.txt'), 'utf8')).toBe('keep\n')
  })

  it('rejects source and target node_modules roots redirected outside their checkout', async () => {
    const source = repository()
    const outside = mkdtempSync(join(tmpdir(), 'leppy-dependency-root-outside-'))
    const outsideModules = join(outside, 'node_modules')
    renameSync(join(source.root, 'node_modules'), outsideModules)
    symlinkSync(outsideModules, join(source.root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(inspectWorktreeDependencies(source.root, source.worktree)).toMatchObject({ status: 'installable' })

    const target = repository()
    symlinkSync(join(target.root, 'node_modules'), join(target.worktree, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(inspectWorktreeDependencies(target.root, target.worktree)).toMatchObject({ status: 'unavailable' })
    expect(existsSync(join(target.root, 'node_modules', 'typescript'))).toBe(true)
  })

  it('rejects nested dependency links that escape staging', async () => {
    const { root, worktree } = repository()
    const outside = mkdtempSync(join(tmpdir(), 'leppy-dependency-outside-'))
    writeFileSync(join(outside, 'secret.txt'), 'outside\n')
    rmSync(join(root, 'node_modules'), { recursive: true, force: true })
    await expect(provisionWorktreeDependencies(root, worktree, {
      stagingRoot: staging(root),
      installNpm: async installRoot => {
        await fakeNpmInstall(installRoot)
        symlinkSync(outside, join(installRoot, 'node_modules', 'typescript', 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
        writeFileSync(join(installRoot, 'node_modules', '.package-lock.json'), '{"lockfileVersion":3,"packages":{"node_modules/typescript":{"version":"5.9.3","resolved":"https://registry.npmjs.org/typescript/-/typescript-5.9.3.tgz","integrity":"sha512-jl1vZzPDinLr9eUt3J/t7V6FgNEw9QjvBPdysz9KfQDD41fQrC2Y4vKQdiaUpFT4bXlb1RHhLpp8wtm6M5TgSw==","bin":{"tsc":"bin/tsc"}}}}\n')
      },
    })).rejects.toThrow()
    expect(existsSync(join(worktree, 'node_modules'))).toBe(false)
    expect(existsSync(staging(root))).toBe(false)
  })

  it('rejects hardlinked package payloads instead of publishing aliases', async () => {
    const { root, worktree } = repository()
    linkSync(join(root, 'node_modules', 'typescript', 'package.json'), join(root, 'node_modules', 'typescript', 'hardlink.json'))
    writeFileSync(join(root, 'node_modules', '.package-lock.json'), '{"lockfileVersion":3,"packages":{"node_modules/typescript":{"version":"5.9.3","resolved":"https://registry.npmjs.org/typescript/-/typescript-5.9.3.tgz","integrity":"sha512-jl1vZzPDinLr9eUt3J/t7V6FgNEw9QjvBPdysz9KfQDD41fQrC2Y4vKQdiaUpFT4bXlb1RHhLpp8wtm6M5TgSw==","bin":{"tsc":"bin/tsc"}}}}\n')
    await expect(provisionWorktreeDependencies(root, worktree, { stagingRoot: staging(root) })).rejects.toThrow('hardlinked or non-regular file')
    expect(existsSync(join(worktree, 'node_modules'))).toBe(false)
  })

  it('rejects a target package path that is a junction or regular file', async () => {
    const linked = repository()
    await provisionWorktreeDependencies(linked.root, linked.worktree, { stagingRoot: staging(linked.root) })
    rmSync(join(linked.worktree, 'node_modules', 'typescript'), { recursive: true, force: true })
    symlinkSync(join(linked.root, 'node_modules', 'typescript'), join(linked.worktree, 'node_modules', 'typescript'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(inspectWorktreeDependencies(linked.root, linked.worktree)).toMatchObject({ status: 'unavailable' })

    const file = repository()
    await provisionWorktreeDependencies(file.root, file.worktree, { stagingRoot: staging(file.root) })
    rmSync(join(file.worktree, 'node_modules', 'typescript'), { recursive: true, force: true })
    writeFileSync(join(file.worktree, 'node_modules', 'typescript'), 'not a directory\n')
    expect(inspectWorktreeDependencies(file.root, file.worktree)).toMatchObject({ status: 'unavailable' })
  })

  it('recovers a proven dependency miss whenever the filesystem is materially repairable', async () => {
    const { root, worktree } = repository()
    const cacheMiss = 'npm error code ENOTCACHED\ncache mode is only-if-cached'
    const moduleMiss = "code: MODULE_NOT_FOUND; Cannot find module 'worktree/node_modules/typescript/bin/tsc'"
    expect(dependencyCacheMiss(cacheMiss)).toBe(true)
    expect(dependencyResolutionMiss(moduleMiss)).toBe(true)
    expect(dependencyBridgeRecoveryAvailable({ repoRoot: root, worktree, detail: cacheMiss, dependencyBridgeActive: true })).toBe(true)
    expect(dependencyBridgeRecoveryAvailable({ repoRoot: root, worktree, detail: moduleMiss, dependencyBridgeActive: true })).toBe(true)
    await provisionWorktreeDependencies(root, worktree, { stagingRoot: staging(root) })
    expect(dependencyBridgeRecoveryAvailable({ repoRoot: root, worktree, detail: moduleMiss, dependencyBridgeActive: true })).toBe(false)
    expect(dependencyBridgeRecoveryAvailable({ repoRoot: root, worktree, detail: 'command failed with exit 1' })).toBe(false)
  })
})
