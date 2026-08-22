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
    ['git', ['push']], ['gh', ['pr', 'merge']], ['npm', ['publish']], ['pwsh', ['-Command', 'x']],
    ['node', ['-e', 'process.exit()']], ['curl', ['https://example.test']], ['git', ['worktree', 'remove', 'x']],
  ])('denies %s %j', (command, args) => {
    expect(() => validateArgv(command, args, process.cwd(), process.cwd())).toThrow()
  })

  it('allows local test and commit argv and denies a fingerprinted gate', () => {
    expect(() => validateArgv('pnpm', ['test', '--', 'focused'], process.cwd(), process.cwd())).not.toThrow()
    expect(() => validateArgv('git', ['commit', '-m', 'fix: x'], process.cwd(), process.cwd())).toThrow(/leppy_commit/)
    expect(() => validateArgv('node', ['script.js'], process.cwd(), process.cwd(), fingerprint(['node', 'script.js'].join('\0')))).toThrow(/gate/)
  })
})
