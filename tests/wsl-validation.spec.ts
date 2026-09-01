import { linkSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  WINDOWS_NAMED_PIPE_UNAVAILABLE,
  assertCapsuleOverlaysUntracked,
  assertSeedDestinationTopology,
  canonicalPlaywrightArgs,
  collectBoundedRedacted,
  isPlaywrightExecutable,
  loadWslValidationProfile,
  namedPipeUnavailableDetail,
  readStableRegularText,
  redactEnvironmentValues,
  stageSeedPaths,
  validationRouting,
  wslHostEnvironment,
  type WslValidationProfile,
} from '../src/wsl-validation.js'

function rootWith(config: unknown): string {
  const root = mkdtempSync(join(tmpdir(), 'leppy-wsl-profile-'))
  writeFileSync(join(root, '.leppy-loop.json'), `${JSON.stringify(config)}\n`)
  return root
}

const profile: WslValidationProfile = {
  kind: 'wsl2', distribution: 'Ubuntu', envFile: '.env',
  envAllowlist: ['E2E_BACKEND_URL', 'E2E_SYSTEM_KEY'], envPrefixes: ['PUBLIC_'], envAliases: { BACKEND_URL: 'E2E_BACKEND_URL' }, prepareBins: ['reflect'], prepareScripts: ['prepare'], seedPaths: ['src/reflector'], webServerTimeoutMs: 600_000, playwrightConfig: 'playwright.config.ts',
}

describe('WSL validation profile', () => {
  it('loads one bounded tracked profile without secret values', () => {
    const root = rootWith({ customInstructions: 'keep', validationExecutor: profile })
    expect(loadWslValidationProfile(root)).toEqual(profile)
  })

  it('does not silently enable an executor when neither tracked nor Host-local authority exists', () => {
    expect(loadWslValidationProfile(rootWith({ customInstructions: 'keep' }))).toBeUndefined()
  })

  it('lets an uncommitted Host-local profile configure an existing commit without changing candidate code', () => {
    const worktree = rootWith({ customInstructions: 'keep' })
    const repoRoot = rootWith({ customInstructions: 'unrelated' })
    writeFileSync(join(repoRoot, '.leppy-loop.local.json'), `${JSON.stringify({ validationExecutor: profile })}\n`)
    expect(loadWslValidationProfile(worktree, repoRoot)).toEqual(profile)
    expect(readFileSync(join(import.meta.dirname, '..', '.gitignore'), 'utf8').split(/\r?\n/u)).toContain('/.leppy-loop.local.json')
  })

  it('fails closed on unknown keys, path escapes, duplicate names, and missing env source', () => {
    expect(() => loadWslValidationProfile(rootWith({ validationExecutor: { ...profile, shell: 'bash' } }))).toThrow('unknown keys')
    expect(() => loadWslValidationProfile(rootWith({ validationExecutor: { ...profile, envFile: '../.env' } }))).toThrow('repo-relative')
    expect(() => loadWslValidationProfile(rootWith({ validationExecutor: { ...profile, envAllowlist: ['E2E_SYSTEM_KEY', 'E2E_SYSTEM_KEY'] } }))).toThrow('duplicates')
    expect(() => loadWslValidationProfile(rootWith({ validationExecutor: { kind: 'wsl2', distribution: 'Ubuntu', envAllowlist: ['E2E_SYSTEM_KEY'] } }))).toThrow('envFile is required')
    expect(() => loadWslValidationProfile(rootWith({ validationExecutor: { ...profile, prepareBins: ['reflect;touch-pwned'] } }))).toThrow('bare binary names')
    expect(() => loadWslValidationProfile(rootWith({ validationExecutor: { ...profile, prepareScripts: ['prepare;touch-pwned'] } }))).toThrow('package script names')
    expect(() => loadWslValidationProfile(rootWith({ validationExecutor: { ...profile, prepareScripts: ['prepare:ambiguous'] } }))).toThrow('package script names')
    expect(() => loadWslValidationProfile(rootWith({ validationExecutor: { ...profile, envAliases: { BACKEND_URL: 'UNAUTHORIZED_SECRET' } } }))).toThrow('envAliases')
    expect(() => loadWslValidationProfile(rootWith({ validationExecutor: { ...profile, seedPaths: ['../host-secret'] } }))).toThrow('seedPaths')
    expect(() => loadWslValidationProfile(rootWith({ validationExecutor: { ...profile, seedPaths: ['.env'] } }))).toThrow('seedPaths')
    expect(() => loadWslValidationProfile(rootWith({ validationExecutor: { ...profile, envPrefixes: ['PUBLIC_*'] } }))).toThrow('envPrefixes')
    expect(() => loadWslValidationProfile(rootWith({ validationExecutor: { ...profile, webServerTimeoutMs: 60_000 } }))).toThrow('webServerTimeoutMs')
    const withoutConfig = { ...profile }
    delete withoutConfig.playwrightConfig
    expect(() => loadWslValidationProfile(rootWith({ validationExecutor: withoutConfig }))).toThrow('playwrightConfig is required')
    expect(() => loadWslValidationProfile(rootWith({ validationExecutor: { ...profile, playwrightConfig: "bad'config.ts" } }))).toThrow('playwrightConfig')
  })

  it('accepts explicit JS/MJS/CJS/custom configs and a genuinely config-less profile without timeout mutation', () => {
    for (const playwrightConfig of ['playwright.config.js', 'playwright.config.mjs', 'playwright.config.cjs', 'config/e2e.config.mts']) {
      expect(loadWslValidationProfile(rootWith({ validationExecutor: { ...profile, playwrightConfig } }))).toMatchObject({ playwrightConfig })
    }
    const configless = { ...profile }
    delete configless.playwrightConfig
    delete configless.webServerTimeoutMs
    expect(loadWslValidationProfile(rootWith({ validationExecutor: configless }))).toEqual(configless)
  })

  it('rejects malformed distribution and environment authority', () => {
    expect(() => loadWslValidationProfile(rootWith({ validationExecutor: { ...profile, distribution: 'Ubuntu; rm -rf /' } }))).toThrow('distribution is invalid')
    expect(() => loadWslValidationProfile(rootWith({ validationExecutor: { ...profile, envAllowlist: ['Path'] } }))).toThrow('canonical environment names')
  })
})

describe('Host environment file authority', () => {
  it('rejects hardlinked environment leaves', () => {
    const root = mkdtempSync(join(tmpdir(), 'leppy-env-hardlink-'))
    const outside = mkdtempSync(join(tmpdir(), 'leppy-env-outside-'))
    writeFileSync(join(outside, '.env'), 'KEY=value\n')
    linkSync(join(outside, '.env'), join(root, '.env'))
    expect(() => readStableRegularText(root, join(root, '.env'), 'envFile', 64 * 1024)).toThrow('private regular file')
  })

  it('rejects a regular leaf reached through an ancestor junction', () => {
    const root = mkdtempSync(join(tmpdir(), 'leppy-env-junction-'))
    const outside = mkdtempSync(join(tmpdir(), 'leppy-env-outside-'))
    writeFileSync(join(outside, '.env'), 'KEY=value\n')
    symlinkSync(outside, join(root, 'linked'), 'junction')
    expect(() => readStableRegularText(root, join(root, 'linked', '.env'), 'envFile', 64 * 1024)).toThrow('junction')
  })
})

describe('Host-owned generated seed paths', () => {
  it('copies bounded regular files into private staging without mounting the Host path', () => {
    const main = mkdtempSync(join(tmpdir(), 'leppy-seed-main-'))
    const destination = mkdtempSync(join(tmpdir(), 'leppy-seed-stage-'))
    mkdirSync(join(main, 'src', 'reflector'), { recursive: true })
    writeFileSync(join(main, 'src', 'reflector', 'enums.ts'), 'export const seeded = true\n')
    stageSeedPaths(main, { ...profile, seedPaths: ['src/reflector'] }, destination)
    expect(readFileSync(join(destination, 'src', 'reflector', 'enums.ts'), 'utf8')).toContain('seeded = true')
  })

  it('rejects any seed overlap that could replace authenticated candidate code', () => {
    expect(() => assertCapsuleOverlaysUntracked('src/reflector/enums.ts\0')).toThrow('overlap authenticated tracked paths')
    expect(() => assertCapsuleOverlaysUntracked('')).not.toThrow()
  })

  it('rejects hardlinked seed leaves instead of granting ambient Host data', () => {
    const main = mkdtempSync(join(tmpdir(), 'leppy-seed-hardlink-'))
    const destination = mkdtempSync(join(tmpdir(), 'leppy-seed-stage-'))
    writeFileSync(join(main, 'artifact'), 'bytes')
    linkSync(join(main, 'artifact'), join(main, 'alias'))
    expect(() => stageSeedPaths(main, { ...profile, seedPaths: ['artifact'] }, destination)).toThrow('hardlinks')
  })
})

describe('Playwright validation routing', () => {
  it('recognizes only the direct authenticated Playwright binary', () => {
    expect(isPlaywrightExecutable('playwright')).toBe(true)
    expect(isPlaywrightExecutable('C:\\repo\\node_modules\\.bin\\playwright.cmd')).toBe(true)
    expect(isPlaywrightExecutable('npm.cmd')).toBe(false)
    expect(isPlaywrightExecutable('playwright-wrapper.cmd')).toBe(false)
  })

  it('canonicalizes noninteractive tests and pins bounded output behavior', () => {
    expect(canonicalPlaywrightArgs(['test', 'tests/e2e/auth/login.spec.ts'])).toEqual([
      'test', 'tests/e2e/auth/login.spec.ts', '--workers=1', '--reporter=line',
    ])
    expect(canonicalPlaywrightArgs(['test', '--workers=2', '--reporter=dot'])).toEqual(['test', '--workers=2', '--reporter=dot'])
    expect(() => canonicalPlaywrightArgs(['show-report'])).toThrow('only permits playwright test')
    expect(() => canonicalPlaywrightArgs(['test', '--ui'])).toThrow('interactive')
    expect(() => canonicalPlaywrightArgs(['test', '--update-snapshots'])).toThrow('snapshot-update')
    expect(() => canonicalPlaywrightArgs(['test', '--update-snapshots=all'])).toThrow('snapshot-update')
    expect(() => canonicalPlaywrightArgs(['test', '--update-source-method=overwrite'])).toThrow('snapshot-update')
  })

  it('never routes task workers or unconfigured verification to an unconfined fallback', () => {
    const expectedTask = process.platform === 'win32' ? 'named-pipe-unavailable' : 'sandbox'
    const expectedVerifier = process.platform === 'win32' ? 'capsule' : 'sandbox'
    expect(validationRouting('task', 'playwright.cmd', profile)).toBe(expectedTask)
    expect(validationRouting('verification', 'playwright.cmd', undefined)).toBe(expectedTask)
    expect(validationRouting('verification', 'playwright.cmd', profile)).toBe(expectedVerifier)
    expect(validationRouting('verification', 'tsc.cmd', profile)).toBe('sandbox')
  })

  it('rejects candidate symlink or file topology at every seed destination ancestor', () => {
    const specs = ['abc:src', 'abc:src/reflector', 'abc:src/reflector/controllers']
    expect(() => assertSeedDestinationTopology('tree\ntree\nabc:src/reflector/controllers missing\n', specs)).not.toThrow()
    expect(() => assertSeedDestinationTopology('tree\nblob\nabc:src/reflector/controllers missing\n', specs)).toThrow('non-directory ancestor')
    expect(() => assertSeedDestinationTopology('tree\n', specs)).toThrow('incomplete topology receipt')
  })

  it('scrubs model credentials and Windows-to-WSL propagation before staging', () => {
    const environment = wslHostEnvironment({ Path: 'C:\\Windows', SYSTEMROOT: 'C:\\Windows', WSLENV: 'LEPPY_SECRET_CANARY/u', LEPPY_SECRET_CANARY: 'never-forward', DEEPSEEK_API_KEY: 'never-forward' })
    expect(environment.Path).toBe('C:\\Windows')
    expect(environment.SYSTEMROOT).toBe('C:\\Windows')
    expect(environment.WSLENV).toBe('')
    expect(environment.LEPPY_SECRET_CANARY).toBeUndefined()
    expect(environment.DEEPSEEK_API_KEY).toBeUndefined()
  })

  it('redacts every allowlisted env value from bounded test output', () => {
    expect(redactEnvironmentValues('url=http://backend key=system-secret', ['http://backend', 'system-secret']))
      .toBe('url=[REDACTED] key=[REDACTED]')
  })

  it('redacts secrets split across chunks and the retained-output cap boundary', () => {
    const secret = 'secret-canary-value'
    const output = collectBoundedRedacted([
      Buffer.alloc(256 * 1024 - 5, 'x'),
      Buffer.from('secret-can'),
      Buffer.from('ary-value tail'),
    ], [secret])
    expect(output).toContain('[REDACTED] tail')
    expect(output).not.toContain('secret-can')
    expect(output).not.toContain('ary-value')
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(256 * 1024)
    const splitUtf8 = collectBoundedRedacted([
      Buffer.concat([Buffer.from('€'), Buffer.alloc(256 * 1024 - 1, 'y')]),
    ], [])
    expect(Buffer.byteLength(splitUtf8)).toBeLessThanOrEqual(256 * 1024)
  })

  it('emits a stable actionable code without claiming tests failed', () => {
    const detail = namedPipeUnavailableDetail(undefined)
    expect(detail).toContain(WINDOWS_NAMED_PIPE_UNAVAILABLE)
    expect(detail).toContain('validation was not run')
    expect(detail).toContain('no unconfined fallback')
  })
})
