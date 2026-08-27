import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { apply as applyWorkerTools, commitTaskChanges, resolveAllowed, resolveExecCwd, type WorkerPolicy } from '../src/worker-tool.js'

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

function registeredTools(root: string, mode: 'task' | 'publication-conflict'): string[] {
  const variables = ['LEPPY_WORKTREE', 'LEPPY_CHECKLIST', 'LEPPY_ALLOWED_PATHS', 'LEPPY_WORKER_MODE'] as const
  const previous = Object.fromEntries(variables.map(name => [name, process.env[name]]))
  process.env.LEPPY_WORKTREE = root
  process.env.LEPPY_CHECKLIST = 'tasks.task.md'
  process.env.LEPPY_ALLOWED_PATHS = JSON.stringify(['prisma/schemas/auth.prisma'])
  process.env.LEPPY_WORKER_MODE = mode
  const names: string[] = []
  try {
    applyWorkerTools({ tools: { register: (definition: { name: string }) => { names.push(definition.name); return () => {} } } } as unknown as Context)
  } finally {
    for (const name of variables) {
      const value = previous[name]
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
  return names
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

  it('gives publication conflict workers exact file scope and no commit capability', async () => {
    const root = repository()
    const exact = join(root, 'prisma', 'schemas', 'auth.prisma')
    const policy: WorkerPolicy = {
      root,
      checklist: join(root, 'tasks.task.md'),
      allowed: [exact],
      mode: 'publication-conflict',
    }
    expect(resolveAllowed(policy, 'prisma/schemas/auth.prisma', false)).toBe(exact)
    expect(() => resolveAllowed(policy, 'prisma/schemas', false)).toThrow('outside this task scope')
    expect(() => resolveAllowed(policy, 'prisma/schemas/nested.prisma', true)).toThrow('outside this task scope')
    expect(() => resolveAllowed(policy, 'tasks.task.md', false)).toThrow('controlling checklist is denied')
    await expect(commitTaskChanges(policy, 'fix: forbidden conflict commit', runner(root))).rejects.toThrow('cannot commit')
  })

  it('registers only edit tools in publication conflict mode', () => {
    const root = repository()
    expect(registeredTools(root, 'publication-conflict')).toEqual(['leppy_read', 'leppy_write', 'leppy_delete'])
    expect(registeredTools(root, 'task')).toEqual(['leppy_read', 'leppy_commit', 'leppy_write', 'leppy_exec'])
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
