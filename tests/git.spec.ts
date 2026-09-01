import { execFileSync } from 'node:child_process'
import { linkSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertSourceReady } from '../src/git.js'

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'leppy-source-ready-'))
  writeFileSync(join(root, 'tasks.task.md'), '- [ ] task\n')
  execFileSync('git', ['init', '-b', 'main'], { cwd: root })
  execFileSync('git', ['config', 'user.email', 'tests@example.invalid'], { cwd: root })
  execFileSync('git', ['config', 'user.name', 'Leppy Tests'], { cwd: root })
  execFileSync('git', ['add', '--', 'tasks.task.md'], { cwd: root })
  execFileSync('git', ['commit', '-m', 'chore: seed'], { cwd: root })
  return root
}

describe('source checkout readiness', () => {
  it('permits only the bounded untracked Host-local validation profile', async () => {
    const root = repository()
    writeFileSync(join(root, '.leppy-loop.local.json'), '{"validationExecutor":{"kind":"wsl2","distribution":"Ubuntu","envAllowlist":[]}}\n')
    await expect(assertSourceReady(root, 'tasks.task.md')).resolves.toBeUndefined()
  })

  it('rejects malformed Host-local authority during source preflight', async () => {
    const root = repository()
    writeFileSync(join(root, '.leppy-loop.local.json'), '{"validationExecutor":{"kind":"wsl2","distribution":"Ubuntu","envAllowlist":[],"unknown":true}}\n')
    await expect(assertSourceReady(root, 'tasks.task.md')).rejects.toThrow('unknown keys')
  })

  it('still rejects unrelated untracked WIP beside the Host-local profile', async () => {
    const root = repository()
    writeFileSync(join(root, '.leppy-loop.local.json'), '{}\n')
    writeFileSync(join(root, 'unrelated.txt'), 'WIP\n')
    await expect(assertSourceReady(root, 'tasks.task.md')).rejects.toThrow('source checkout must be clean')
  })

  it('rejects a tracked local profile instead of treating candidate bytes as Host authority', async () => {
    const root = repository()
    writeFileSync(join(root, '.leppy-loop.local.json'), '{}\n')
    execFileSync('git', ['add', '--', '.leppy-loop.local.json'], { cwd: root })
    execFileSync('git', ['commit', '-m', 'test: invalid tracked local authority'], { cwd: root })
    await expect(assertSourceReady(root, 'tasks.task.md')).rejects.toThrow('must remain untracked')
  })

  it('rejects a hardlinked local profile instead of granting ambient Host data', async () => {
    const root = repository()
    const outside = mkdtempSync(join(tmpdir(), 'leppy-source-profile-'))
    writeFileSync(join(outside, 'profile.json'), '{}\n')
    linkSync(join(outside, 'profile.json'), join(root, '.leppy-loop.local.json'))
    await expect(assertSourceReady(root, 'tasks.task.md')).rejects.toThrow('private regular file')
  })
})
