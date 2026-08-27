import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { commitTaskChanges, resolveExecCwd, type WorkerPolicy } from '../src/worker-tool.js'

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
}

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'leppy-worker-tool-'))
  mkdirSync(join(root, 'prisma', 'schemas'), { recursive: true })
  writeFileSync(join(root, '.gitignore'), 'prisma/migrations/\n.env.secret\n')
  writeFileSync(join(root, 'tasks.task.md'), '- [ ] migration\n')
  writeFileSync(join(root, 'prisma', 'schemas', 'auth.prisma'), 'model Seed { id Int @id }\n')
  git(root, 'init', '-b', 'main')
  git(root, 'config', 'user.email', 'tests@example.invalid')
  git(root, 'config', 'user.name', 'Leppy Tests')
  git(root, 'add', '--', '.gitignore', 'tasks.task.md', 'prisma/schemas/auth.prisma')
  git(root, 'commit', '-m', 'chore: seed')
  return root
}

function runner(root: string) {
  return async (args: readonly string[]) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
    return { exitCode: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
  }
}

describe('worker commit capability', () => {
  it('normalizes an explicit dot cwd to the repository root without widening file scope', () => {
    const root = repository()
    const policy: WorkerPolicy = { root, checklist: join(root, 'tasks.task.md'), allowed: [join(root, 'prisma', 'schemas')] }
    expect(resolveExecCwd(policy)).toBe(root)
    expect(resolveExecCwd(policy, '.')).toBe(root)
    expect(resolveExecCwd(policy, './')).toBe(root)
    expect(resolveExecCwd(policy, 'prisma/schemas')).toBe(join(root, 'prisma', 'schemas'))
    expect(() => resolveExecCwd(policy, 'prisma')).toThrow('outside this task scope')
  })

  it('force-adds only changed ignored files inside the declared task scope', async () => {
    const root = repository()
    mkdirSync(join(root, 'prisma', 'migrations', '20260826_auth'), { recursive: true })
    writeFileSync(join(root, 'prisma', 'migrations', '20260826_auth', 'migration.sql'), 'CREATE TABLE auth_state ();\n')
    writeFileSync(join(root, 'prisma', 'schemas', 'auth.prisma'), 'model AuthState { id Int @id }\n')
    writeFileSync(join(root, '.env.secret'), 'must-not-stage\n')
    const policy: WorkerPolicy = {
      root,
      checklist: join(root, 'tasks.task.md'),
      allowed: [join(root, 'prisma', 'schemas'), join(root, 'prisma', 'migrations')],
    }

    const commit = await commitTaskChanges(policy, 'feat: persist auth state', runner(root))

    expect(commit).toMatch(/^[0-9a-f]{40}$/u)
    expect(git(root, 'show', '--pretty=format:', '--name-only', 'HEAD').split(/\r?\n/u).filter(Boolean).sort()).toEqual([
      'prisma/migrations/20260826_auth/migration.sql',
      'prisma/schemas/auth.prisma',
    ])
    expect(git(root, 'ls-files', '--', '.env.secret')).toBe('')
  })
})
