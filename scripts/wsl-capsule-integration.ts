import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { executePlaywrightInWsl as executePlaywrightInWslType } from '../src/wsl-validation.js'

const runtime = await import(new URL('../dist/wsl-validation.js', import.meta.url).href) as { executePlaywrightInWsl: typeof executePlaywrightInWslType }
const { executePlaywrightInWsl } = runtime

if (process.platform !== 'win32') {
  console.log('WSL capsule integration skipped: release boundary requires Windows with WSL2')
  process.exit(0)
}

const root = mkdtempSync(join(tmpdir(), 'leppy-wsl-integration-'))
const candidateParent = mkdtempSync(join(tmpdir(), 'leppy-wsl-candidate-'))
const candidateRoot = join(candidateParent, 'worktree')
let candidateRegistered = false
const run = (file: string, args: string[]): void => {
  execFileSync(file, args, { cwd: root, stdio: 'inherit', windowsHide: true })
}
try {
  writeFileSync(join(root, 'package.json'), `${JSON.stringify({
    name: 'leppy-wsl-integration', private: true, type: 'module',
    scripts: { postinstall: "node -e \"require('node:fs').writeFileSync('lifecycle-ran','forged')\"" },
    devDependencies: { '@playwright/test': '1.58.2' },
  }, null, 2)}\n`)
  writeFileSync(join(root, 'hang.spec.mjs'), `
import { test } from '@playwright/test'
test('stays alive until Host cancellation', async () => await new Promise(resolve => setTimeout(resolve, 120_000)))
`)
  writeFileSync(join(root, 'browser.spec.mjs'), `
import { accessSync, constants, existsSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { test, expect } from '@playwright/test'
test('confines a real browser and scrubs Host credentials', async ({ page }) => {
  expect(process.env.LEPPY_SECRET_CANARY).toBeUndefined()
  expect(existsSync('/mnt/c/Windows')).toBe(false)
  const allowedRoot = new Set(['bin', 'dev', 'etc', 'home', 'init', 'lib', 'lib64', 'media', 'mnt', 'opt', 'proc', 'root', 'run', 'sbin', 'srv', 'tmp', 'usr', 'var'])
  expect(readdirSync('/').filter(name => !allowedRoot.has(name))).toEqual([])
  expect(readdirSync('/usr/lib/modules')).toEqual([])
  expect(readdirSync('/usr/lib/wsl/drivers')).toEqual([])
  expect(readdirSync('/usr/lib/wsl/lib')).toEqual([])
  expect(existsSync('/proc/sys/fs/binfmt_misc/WSLInterop')).toBe(false)
  expect(() => accessSync('/init', constants.X_OK)).toThrow()
  expect(existsSync('lifecycle-ran')).toBe(false)
  expect(() => writeFileSync('node_modules/playwright/cli.js', 'forged')).toThrow()
  const escape = '/etc/leppy-wsl-integration-escape'
  let escaped = false
  try { writeFileSync(escape, 'denied'); escaped = true } catch { /* expected read-only root */ }
  if (escaped) { try { unlinkSync(escape) } catch { /* best-effort cleanup */ }; throw new Error('capsule wrote outside its private mounts') }
  await page.setContent('<h1>capsule-ok</h1>')
  await expect(page.locator('h1')).toHaveText('capsule-ok')
})
`)
  writeFileSync(join(root, 'playwright.config.js'), 'export default {}\n')
  writeFileSync(join(root, 'playwright.config.mjs'), 'export default {}\n')
  writeFileSync(join(root, 'playwright.config.cjs'), 'module.exports = {}\n')
  mkdirSync(join(root, 'configs'))
  writeFileSync(join(root, 'configs', 'custom.config.ts'), 'export default {}\n')
  const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  run(process.execPath, [npmCli, 'install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'])
  run('git.exe', ['init', '-b', 'main'])
  run('git.exe', ['config', 'user.email', 'integration@example.invalid'])
  run('git.exe', ['config', 'user.name', 'Leppy WSL Integration'])
  run('git.exe', ['add', '--', 'package.json', 'package-lock.json', 'browser.spec.mjs', 'hang.spec.mjs', 'playwright.config.js', 'playwright.config.mjs', 'playwright.config.cjs', 'configs/custom.config.ts'])
  run('git.exe', ['commit', '-m', 'test: seed WSL capsule integration'])
  process.env.LEPPY_SECRET_CANARY = 'host-secret-must-not-cross'
  const commitHead = execFileSync('git.exe', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim()
  const distribution = process.env.LEPPY_WSL_DISTRIBUTION ?? 'Ubuntu'
  const profile = { kind: 'wsl2' as const, distribution, envAllowlist: [] }
  await executePlaywrightInWsl({ root, repoRoot: root, commitHead, args: ['test', 'browser.spec.mjs'], profile: { ...profile, distribution: 'LeppyMissingDistribution' } })
    .then(() => { throw new Error('missing WSL distribution unexpectedly launched') }, error => {
      if (!(error instanceof Error) || !error.message.includes('LEPPY_WSL_VALIDATION_UNAVAILABLE')) throw error
    })
  const invalidPackage = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { devDependencies: Record<string, string> }
  invalidPackage.devDependencies['left-pad'] = '1.3.0'
  writeFileSync(join(root, 'package.json'), `${JSON.stringify(invalidPackage, null, 2)}\n`)
  run('git.exe', ['add', '--', 'package.json'])
  run('git.exe', ['commit', '-m', 'test: create candidate lock mismatch'])
  const invalidCommitHead = execFileSync('git.exe', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim()
  const setupFailure = await executePlaywrightInWsl({ root, repoRoot: root, commitHead: invalidCommitHead, args: ['test', 'browser.spec.mjs'], profile })
  if (setupFailure.exitCode === 0 || setupFailure.stderr.includes('LEPPY_WSL_VALIDATION_UNAVAILABLE')) {
    throw new Error(`candidate npm setup failure was misclassified as infrastructure: ${setupFailure.stderr}`)
  }
  run('git.exe', ['reset', '--hard', commitHead])
  run('git.exe', ['worktree', 'add', '--detach', candidateRoot, commitHead])
  candidateRegistered = true
  const result = await executePlaywrightInWsl({
    root: candidateRoot, repoRoot: root, commitHead, args: ['test', 'browser.spec.mjs'],
    profile,
  })
  if (result.exitCode !== 0) throw new Error(`capsule integration failed (${result.exitCode}): ${result.stderr}`)
  if (!result.stderr.includes('LEPPY_WSL_SEED_DIGEST=')) throw new Error('capsule omitted the authenticated seed digest receipt')
  if (!result.stderr.includes('LEPPY_PLAYWRIGHT_PACKAGE=1.58.2')) throw new Error('capsule omitted the authenticated canonical Playwright package receipt')
  if (result.stdout.includes(process.env.LEPPY_SECRET_CANARY) || result.stderr.includes(process.env.LEPPY_SECRET_CANARY)) {
    throw new Error('Host secret canary leaked into capsule output')
  }

  const jsConfig = await executePlaywrightInWsl({
    root: candidateRoot, repoRoot: root, commitHead, args: ['test', 'browser.spec.mjs'],
    profile: { ...profile, playwrightConfig: 'playwright.config.js', webServerTimeoutMs: 180_000 },
  })
  if (jsConfig.exitCode !== 0) throw new Error(`JavaScript Playwright config failed at runtime: ${jsConfig.stderr}`)

  const mjsConfig = await executePlaywrightInWsl({
    root: candidateRoot, repoRoot: root, commitHead, args: ['test', 'browser.spec.mjs'],
    profile: { ...profile, playwrightConfig: 'playwright.config.mjs', webServerTimeoutMs: 180_000 },
  })
  if (mjsConfig.exitCode !== 0) throw new Error(`MJS Playwright config failed at runtime: ${mjsConfig.stderr}`)
  const tsConfig = await executePlaywrightInWsl({
    root: candidateRoot, repoRoot: root, commitHead, args: ['test', 'browser.spec.mjs'],
    profile: { ...profile, playwrightConfig: 'configs/custom.config.ts', webServerTimeoutMs: 180_000 },
  })
  if (tsConfig.exitCode !== 0) throw new Error(`custom TypeScript Playwright config failed at runtime: ${tsConfig.stderr}`)
  const genuineFailure = await executePlaywrightInWsl({
    root: candidateRoot, repoRoot: root, commitHead, args: ['test', 'missing.spec.mjs'], profile,
  })
  if (genuineFailure.exitCode === 0 || genuineFailure.stderr.includes('LEPPY_WSL_VALIDATION_UNAVAILABLE')) {
    throw new Error(`genuine test failure was misclassified: exit=${genuineFailure.exitCode} ${genuineFailure.stderr}`)
  }

  const snapshot = (args: string[]): Set<string> => {
    const observed = spawnSync('wsl.exe', ['--distribution', distribution, '--exec', ...args], { encoding: 'utf8', windowsHide: true })
    if (observed.status !== 0 && observed.status !== 1) throw new Error(`cannot snapshot WSL teardown boundary: ${observed.stderr}`)
    return new Set(observed.stdout.split(/\r?\n/u).filter(Boolean))
  }
  const waitForNoNew = async (args: string[], baseline: Set<string>, label: string): Promise<void> => {
    const deadline = Date.now() + 5_000
    do {
      const leaked = [...snapshot(args)].filter(value => !baseline.has(value))
      if (leaked.length === 0) return
      await new Promise(resolve => setTimeout(resolve, 100))
    } while (Date.now() < deadline)
    const leaked = [...snapshot(args)].filter(value => !baseline.has(value))
    throw new Error(`canceled capsule left ${label}: ${leaked.join(', ')}`)
  }
  const capsulesBefore = snapshot(['find', '/tmp', '-maxdepth', '1', '-name', 'leppy-validation-*', '-print'])
  const bwrapBefore = snapshot(['pgrep', '-af', 'bwrap'])
  const cancellation = new AbortController()
  let testLaunchObserved = false
  const watchdog = setTimeout(() => cancellation.abort(new Error('integration cancellation watchdog')), 120_000)
  await executePlaywrightInWsl({
    root: candidateRoot, repoRoot: root, commitHead, args: ['test', 'hang.spec.mjs'],
    profile: { ...profile, playwrightConfig: 'playwright.config.cjs', webServerTimeoutMs: 180_000 }, signal: cancellation.signal,
    onPhase(phase) {
      if (phase === 'test') {
        testLaunchObserved = true
        cancellation.abort(new Error('integration cancellation'))
      }
    },
  }).then(() => { throw new Error('canceled capsule unexpectedly completed') }, error => {
    if (!(error instanceof Error) || error.message !== 'integration cancellation') throw error
  })
  clearTimeout(watchdog)
  if (!testLaunchObserved) throw new Error('cancellation did not synchronize on the Host-only test-launch receipt')
  await waitForNoNew(['find', '/tmp', '-maxdepth', '1', '-name', 'leppy-validation-*', '-print'], capsulesBefore, 'private state')
  await waitForNoNew(['pgrep', '-af', 'bwrap'], bwrapBefore, 'bwrap descendants')
  console.log('WSL capsule integration and cancellation passed')
} finally {
  delete process.env.LEPPY_SECRET_CANARY
  if (candidateRegistered) spawnSync('git.exe', ['worktree', 'remove', '--force', candidateRoot], { cwd: root, windowsHide: true })
  rmSync(candidateParent, { recursive: true, force: true })
  rmSync(root, { recursive: true, force: true })
}
