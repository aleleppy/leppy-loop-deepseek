import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fingerprint, redact, scrubEnvironment, validateArgv } from '../src/security.js'

describe('security boundary', () => {
  it('redacts recursive names, known values, headers and credential URLs', () => {
    const secret = 'sk-test-secret'
    const value = redact({ apiKey: secret, nested: [`Authorization: Bearer ${secret}`, `https://u:p@example.test/${secret}`] }, [secret])
    expect(JSON.stringify(value)).not.toContain(secret)
    expect(JSON.stringify(value)).not.toContain('u:p@')
  })

  it('scrubs credential-shaped environment names', () => {
    expect(scrubEnvironment({ PATH: 'x', DEEPSEEK_API_KEY: 'secret', SESSION_TOKEN: 'secret' })).toEqual({ PATH: 'x' })
  })

  it.each([
    ['git', ['push']], ['git.exe', ['commit', '-m', 'bypass']], ['gh', ['pr', 'merge']], ['npm', ['publish']],
    ['npm.cmd', ['exec', 'playwright']], ['npm', ['--prefix', '.', 'exec', 'playwright']], ['npx.cmd', ['playwright']],
    ['pnpm', ['dlx', 'vitest']], ['pnpm', ['--dir', '.', 'up']], ['yarn.cmd', ['install']], ['yarn', ['--cwd', '.']], ['yarn', ['--cwd', '.', 'add', 'x']],
    ['bunx.exe', ['vitest']], ['pnpx.cmd', ['playwright']], ['yarnpkg', ['add', 'x']],
    ['corepack.exe', ['pnpm', 'dlx', 'playwright']], ['corepack', ['yarn', 'add', 'x']],
    ['npm', ['it']], ['npm', ['cit']], ['npm', ['prune']], ['npm', ['dedupe']],
    ['npm', ['rebuild']], ['npm', ['--cache=.npm-cache', 'test']], ['pwsh', ['-Command', 'x']],
    ['node', ['-e', 'process.exit()']], ['curl', ['https://example.test']], ['git', ['worktree', 'remove', 'x']],
  ])('denies %s %j', (command, args) => {
    expect(() => validateArgv(command, args, process.cwd(), process.cwd())).toThrow()
  })

  it('allows local tests, real repo-local PowerShell files and only read-only Git verbs', () => {
    const root = mkdtempSync(join(tmpdir(), 'leppy-security-'))
    mkdirSync(join(root, 'scripts'))
    writeFileSync(join(root, 'scripts', 'focused.ps1'), 'exit 0\n')
    expect(() => validateArgv('pnpm', ['test', '--', 'focused'], root, root)).not.toThrow()
    expect(() => validateArgv('pnpm', ['--dir', '.', 'run', 'lint'], root, root)).not.toThrow()
    expect(() => validateArgv('npm.cmd', ['--prefix', '.', 'run', 'test:e2e'], root, root)).not.toThrow()
    expect(() => validateArgv('pwsh', ['-NoProfile', '-File', 'scripts/focused.ps1'], root, root)).not.toThrow()
    for (const selector of ['-Com', '-Comm', '-Enc', '-EncodedCommand']) {
      expect(() => validateArgv('powershell.exe', [selector, 'Write-Output bypass', '-File', 'scripts/focused.ps1'], root, root)).toThrow(/requires exact -File/)
    }
    expect(() => validateArgv('pwsh', ['-File', 'scripts/focused.ps1', '-File', 'scripts/focused.ps1'], root, root)).toThrow(/requires exact -File/)
    expect(() => validateArgv('git', ['status', '--short'], root, root)).not.toThrow()
    expect(() => validateArgv('git', ['show', 'HEAD:tasks/task.md'], root, root)).toThrow(/read-only/)
    expect(() => validateArgv('git', ['grep', 'secret', '--', 'tasks/task.md'], root, root)).toThrow(/read-only/)
    expect(() => validateArgv('git', ['commit', '-m', 'fix: x'], root, root)).toThrow(/leppy_commit/)
    expect(() => validateArgv('git', ['apply', 'change.patch'], root, root)).toThrow(/read-only/)
    expect(() => validateArgv('git', ['restore', '--', 'src'], root, root)).toThrow(/read-only/)
    expect(() => validateArgv('git', ['diff', '--output=patch.txt'], root, root)).toThrow(/read-only/)
    expect(() => validateArgv('git', ['diff', '--no-index', 'NUL', '..\\outside.txt'], root, root)).toThrow(/read-only/)
    expect(() => validateArgv('git', ['log', '--ext-diff'], root, root)).toThrow(/read-only/)
    expect(() => validateArgv('pwsh', ['-File', '..\\outside.ps1'], root, root)).toThrow(/denied/)
    expect(() => validateArgv('node', ['script.js'], root, root, fingerprint(['node', 'script.js'].join('\0')))).toThrow(/gate/)
  })
})
