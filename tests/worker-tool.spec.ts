import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { apply as applyWorkerTools, commitTaskChanges, resolveAllowed, resolveExecCwd, validatedExecOutput, type WorkerPolicy } from '../src/worker-tool.js'

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

interface RegisteredWorkerTool {
  name: string
  execute: (args: Record<string, unknown>, exec?: { signal: AbortSignal }) => Promise<unknown>
}

function registeredRuntime(
  root: string,
  mode: 'task' | 'verification' | 'publication-conflict',
  output: { stdoutLossy?: boolean; stderrLossy?: boolean; workspaceRoot?: string; resolvedCommand?: string; spawnError?: string } = {},
): {
  tools: string[]
  definitions: RegisteredWorkerTool[]
  commands: string[][]
  resolutions: Array<{ command: string; environment: NodeJS.ProcessEnv }>
  spawnEnvironments: NodeJS.ProcessEnv[]
  promptVariables: Array<{ name: string; value: string }>
} {
  const variables = ['LEPPY_WORKTREE', 'LEPPY_REPO_ROOT', 'LEPPY_CHECKLIST', 'LEPPY_ALLOWED_PATHS', 'LEPPY_WORKER_MODE', 'LEPPY_VERIFICATION_COMMIT_HEAD', 'LEPPY_SYSTEM_PROMPT'] as const
  const previous = Object.fromEntries(variables.map(name => [name, process.env[name]]))
  process.env.LEPPY_WORKTREE = root
  process.env.LEPPY_REPO_ROOT = root
  process.env.LEPPY_CHECKLIST = 'tasks.task.md'
  process.env.LEPPY_ALLOWED_PATHS = JSON.stringify(['prisma/schemas/auth.prisma'])
  process.env.LEPPY_WORKER_MODE = mode
  if (mode === 'verification') process.env.LEPPY_VERIFICATION_COMMIT_HEAD = git(root, 'rev-parse', 'HEAD')
  else delete process.env.LEPPY_VERIFICATION_COMMIT_HEAD
  process.env.LEPPY_SYSTEM_PROMPT = 'preserve literal {{ duration: 200 }}'
  const tools: string[] = []
  const definitions: RegisteredWorkerTool[] = []
  const commands: string[][] = []
  const resolutions: Array<{ command: string; environment: NodeJS.ProcessEnv }> = []
  const spawnEnvironments: NodeJS.ProcessEnv[] = []
  const promptVariables: Array<{ name: string; value: string }> = []
  try {
    const stdout = { readFrom: () => ({ text: '', nextOffset: 0, lossy: output.stdoutLossy ?? false }) }
    const stderr = { readFrom: () => ({ text: '', nextOffset: 0, lossy: output.stderrLossy ?? false }) }
    applyWorkerTools({
      systemPrompt: { variable: (name: string, provider: () => string) => { promptVariables.push({ name, value: provider() }); return () => {} } },
      tools: { register: (definition: RegisteredWorkerTool) => { tools.push(definition.name); definitions.push(definition); return () => {} } },
      subprocess: {
        resolveExecutable: async (command: string, environment: NodeJS.ProcessEnv) => {
          resolutions.push({ command, environment })
          if (output.resolvedCommand) return output.resolvedCommand
          if (command === 'tsc') return join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc')
          return command
        },
        spawn: ({ argv, env }: { argv: string[]; env: NodeJS.ProcessEnv }) => {
          commands.push(argv)
          spawnEnvironments.push(env)
          if (output.spawnError) throw new Error(output.spawnError)
          return { done: Promise.resolve({ exitCode: 1 }), collected: { stdout, stderr } }
        },
      },
      sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: output.workspaceRoot ?? root }) },
      sandbox: { confine: (argv: string[]) => ({ argv }) },
    } as unknown as Context)
  } finally {
    for (const name of variables) {
      const value = previous[name]
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
  return { tools, definitions, commands, resolutions, spawnEnvironments, promptVariables }
}

describe('worker commit capability', () => {
  it('surfaces nonzero argv outcomes as real tool errors', () => {
    expect(validatedExecOutput(0, 'ok', '')).toEqual({ exitCode: 0, stdout: 'ok', stderr: '' })
    expect(() => validatedExecOutput(127, '', 'missing executable')).toThrow('command failed with exit 127: missing executable')
  })

  it.runIf(process.platform === 'win32')('returns Windows spawn EPERM as advisory task evidence', async () => {
    const root = repository()
    mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true })
    writeFileSync(join(root, 'node_modules', '.bin', 'vitest.cmd'), '@echo off\r\n')
    const runtime = registeredRuntime(root, 'task', { resolvedCommand: join(root, 'node_modules', '.bin', 'vitest.cmd'), spawnError: 'spawn EPERM' })
    const execute = runtime.definitions.find(definition => definition.name === 'leppy_exec')!.execute
    await expect(execute({ command: 'vitest', args: ['run'] }, { signal: new AbortController().signal })).resolves.toMatchObject({
      exitCode: 0,
      commandExitCode: 126,
      advisory: true,
      stderr: expect.stringContaining('spawn EPERM'),
    })
  })

  it('normalizes cwd while allowing writes anywhere in the isolated worktree', () => {
    const root = repository()
    const policy: WorkerPolicy = { root, repoRoot: root, checklist: join(root, 'tasks.task.md'), allowed: [join(root, 'prisma', 'schemas')] }
    expect(resolveExecCwd(policy)).toBe(root)
    expect(resolveExecCwd(policy, '.')).toBe(root)
    expect(resolveExecCwd(policy, './')).toBe(root)
    expect(resolveExecCwd(policy, 'prisma/schemas')).toBe(join(root, 'prisma', 'schemas'))
    expect(resolveExecCwd(policy, 'prisma')).toBe(join(root, 'prisma'))
    expect(resolveAllowed(policy, '.gitignore', false)).toBe(join(root, '.gitignore'))
    expect(() => resolveAllowed(policy, '.git', false)).toThrow('Git metadata is denied')
    expect(resolveAllowed(policy, '.gitignore', true)).toBe(join(root, '.gitignore'))
  })

  it('gives publication conflict workers exact file scope and no commit capability', async () => {
    const root = repository()
    const exact = join(root, 'prisma', 'schemas', 'auth.prisma')
    const policy: WorkerPolicy = {
      root,
      repoRoot: root,
      checklist: join(root, 'tasks.task.md'),
      allowed: [exact],
      mode: 'publication-conflict',
    }
    expect(resolveAllowed(policy, 'prisma/schemas/auth.prisma', false)).toBe(exact)
    expect(() => resolveAllowed(policy, 'prisma/schemas', false)).toThrow('outside this task write scope')
    expect(() => resolveAllowed(policy, 'prisma/schemas/nested.prisma', true)).toThrow('outside this task write scope')
    expect(() => resolveAllowed(policy, 'tasks.task.md', false)).toThrow('controlling checklist is denied')
    await expect(commitTaskChanges(policy, 'fix: forbidden conflict commit', runner(root))).rejects.toThrow('cannot commit')
  })

  it('accepts verification mode with read, search and exec but no durable mutation capability', async () => {
    const root = repository()
    const policy: WorkerPolicy = {
      root,
      repoRoot: root,
      checklist: join(root, 'tasks.task.md'),
      allowed: [join(root, 'prisma', 'schemas', 'auth.prisma')],
      mode: 'verification',
    }
    const verification = registeredRuntime(root, 'verification')
    expect(verification.promptVariables).toEqual([{ name: 'leppy_prompt', value: 'preserve literal {{ duration: 200 }}' }])
    expect(verification.tools).toEqual(['leppy_read', 'leppy_search', 'leppy_exec'])
    for (const denied of ['leppy_write', 'leppy_edit', 'leppy_commit', 'leppy_delete']) expect(verification.tools).not.toContain(denied)
    await expect(commitTaskChanges(policy, 'test: forbidden verification commit', runner(root))).rejects.toThrow('verification workers cannot commit')
  })

  it('denies verification package scripts and interpreter frontends before resolution but admits a direct local binary', async () => {
    const root = repository()
    mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true })
    writeFileSync(join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc'), 'fixture\n')
    const runtime = registeredRuntime(root, 'verification')
    const execute = runtime.definitions.find(definition => definition.name === 'leppy_exec')!.execute
    for (const invocation of [
      { command: 'npm.cmd', args: ['test'] },
      { command: 'pnpm', args: ['run', 'test:e2e'] },
      { command: 'node', args: ['scripts/check.mjs'] },
      { command: 'python3', args: ['scripts/check.py'] },
    ]) {
      await expect(execute(invocation, { signal: new AbortController().signal })).rejects.toThrow(/verification command frontend denied/u)
    }
    expect(runtime.resolutions).toHaveLength(0)
    expect(runtime.commands).toHaveLength(0)

    await expect(execute({ command: 'tsc', args: ['--noEmit'] }, { signal: new AbortController().signal })).rejects.toThrow('command failed')
    const expected = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc')
    expect(runtime.resolutions).toHaveLength(1)
    expect(runtime.commands).toEqual([[expected, '--noEmit']])
  })

  it.runIf(process.platform === 'win32')('rejects snapshot mutation before launching the verification capsule', async () => {
    const root = repository()
    const playwright = join(root, 'node_modules', '.bin', 'playwright.cmd')
    mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true })
    writeFileSync(playwright, '@echo off\r\n')
    writeFileSync(join(root, '.leppy-loop.json'), `${JSON.stringify({ validationExecutor: { kind: 'wsl2', distribution: 'Ubuntu', envAllowlist: [] } })}\n`)
    const runtime = registeredRuntime(root, 'verification', { resolvedCommand: playwright })
    const execute = runtime.definitions.find(definition => definition.name === 'leppy_exec')!.execute
    await expect(execute({ command: 'playwright', args: ['test', '--update-snapshots=all'] }, { signal: new AbortController().signal }))
      .rejects.toThrow('snapshot-update')
    expect(runtime.commands).toHaveLength(0)
  })

  it.runIf(process.platform === 'win32')('classifies Playwright named-pipe validation before any doomed confined spawn', async () => {
    const root = repository()
    const playwright = join(root, 'node_modules', '.bin', 'playwright.cmd')
    mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true })
    writeFileSync(playwright, '@echo off\r\n')
    const runtime = registeredRuntime(root, 'task', { resolvedCommand: playwright })
    const execute = runtime.definitions.find(definition => definition.name === 'leppy_exec')!.execute
    await expect(execute({ command: 'playwright', args: ['test', 'tests/e2e/auth'] }, { signal: new AbortController().signal }))
      .resolves.toMatchObject({ exitCode: 0, commandExitCode: 126, advisory: true, stderr: expect.stringContaining('LEPPY_WINDOWS_NAMED_PIPE_UNAVAILABLE') })
    expect(runtime.commands).toHaveLength(0)
  })

  it('preserves task and publication conflict capability boundaries', () => {
    const root = repository()
    const conflict = registeredRuntime(root, 'publication-conflict')
    const task = registeredRuntime(root, 'task')
    expect(conflict.promptVariables).toEqual([{ name: 'leppy_prompt', value: 'preserve literal {{ duration: 200 }}' }])
    expect(conflict.tools).toEqual(['leppy_read', 'leppy_write', 'leppy_delete'])
    expect(task.tools).toEqual(['leppy_read', 'leppy_search', 'leppy_edit', 'leppy_commit', 'leppy_write', 'leppy_exec'])
  })

  it('normalizes explicit local executables before resolving and confinement', async () => {
    const root = repository()
    mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true })
    writeFileSync(join(root, 'node_modules', '.bin', 'tsc.cmd'), '@echo off\r\n')
    if (process.platform !== 'win32') writeFileSync(join(root, 'node_modules', '.bin', 'tsc'), '#!/bin/sh\n')
    const runtime = registeredRuntime(root, 'task')
    const execute = runtime.definitions.find(definition => definition.name === 'leppy_exec')!.execute
    await expect(execute({ command: "'node_modules/.bin/tsc'", args: ['--noEmit'] }, { signal: new AbortController().signal })).resolves.toMatchObject({ exitCode: 0, commandExitCode: 1, advisory: true })
    const expected = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc')
    expect(runtime.resolutions.at(-1)?.command).toBe(expected)
    expect(runtime.commands.at(-1)).toEqual([expected, '--noEmit'])
  })

  it('resolves bare package binaries local-first with the exact environment used to spawn', async () => {
    const root = repository()
    mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true })
    writeFileSync(join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc'), 'fixture\n')
    mkdirSync(join(root, 'prisma', 'schemas', 'node_modules', '.bin'), { recursive: true })
    writeFileSync(join(root, 'prisma', 'schemas', 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc'), 'untrusted nested fixture\n')
    const runtime = registeredRuntime(root, 'task')
    const execute = runtime.definitions.find(definition => definition.name === 'leppy_exec')!.execute
    await expect(execute({ command: 'tsc', args: ['--noEmit'], cwd: 'prisma/schemas' }, { signal: new AbortController().signal })).resolves.toMatchObject({ exitCode: 0, commandExitCode: 1, advisory: true })
    const resolution = runtime.resolutions.at(-1)!
    const pathName = Object.hasOwn(resolution.environment, 'Path') ? 'Path' : 'PATH'
    expect(resolution.environment[pathName]?.split(process.platform === 'win32' ? ';' : ':')[0]).toBe(join(root, 'node_modules', '.bin'))
    expect(runtime.spawnEnvironments.at(-1)).toBe(resolution.environment)
    expect(runtime.commands.at(-1)?.[0]).toBe(join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc'))
  })

  it('allows package frontends, installs and cache commands for mutable workers', async () => {
    const root = repository()
    const runtime = registeredRuntime(root, 'task')
    const execute = runtime.definitions.find(definition => definition.name === 'leppy_exec')!.execute
    for (const invocation of [
      { command: 'npx.cmd', args: ['playwright', 'test'] },
      { command: 'pnpm', args: ['dlx', 'playwright', 'test'] },
      { command: 'corepack', args: ['yarn', 'add', 'x'] },
      { command: 'npm', args: ['install'] },
      { command: 'pnpm', args: ['--cache-dir=.npm-cache', 'test'] },
    ]) {
      await expect(execute(invocation, { signal: new AbortController().signal })).resolves.toMatchObject({ exitCode: 0 })
    }
    expect(runtime.resolutions).toHaveLength(5)
    expect(runtime.commands).toHaveLength(5)
  })

  it('trusts the executable resolved for a mutable worker', async () => {
    const root = repository()
    const runtime = registeredRuntime(root, 'task', { resolvedCommand: join(root, 'node_modules', '.bin', 'corepack.cmd') })
    const execute = runtime.definitions.find(definition => definition.name === 'leppy_exec')!.execute
    await expect(execute({ command: 'local-check', args: ['pnpm', 'dlx', 'playwright'] }, {
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ exitCode: 0 })
    expect(runtime.resolutions).toHaveLength(1)
    expect(runtime.commands).toHaveLength(1)
  })

  it('rejects a mismatched sandbox root and explicit executable traversal before spawn', async () => {
    const root = repository()
    mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true })
    writeFileSync(join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc'), 'fixture\n')
    const outside = mkdtempSync(join(tmpdir(), 'leppy-worker-outside-'))
    const executable = join(outside, process.platform === 'win32' ? 'probe.cmd' : 'probe')
    writeFileSync(executable, 'fixture\n')
    const wrongRoot = registeredRuntime(root, 'task', { workspaceRoot: outside })
    const wrongRootExec = wrongRoot.definitions.find(definition => definition.name === 'leppy_exec')!.execute
    await expect(wrongRootExec({ command: 'tsc', args: [] }, { signal: new AbortController().signal })).rejects.toThrow('sandbox root')
    expect(wrongRoot.commands).toHaveLength(0)

    const traversal = registeredRuntime(root, 'task')
    const traversalExec = traversal.definitions.find(definition => definition.name === 'leppy_exec')!.execute
    await expect(traversalExec({ command: relative(root, executable), args: [] }, { signal: new AbortController().signal })).rejects.toThrow('escapes the worktree')
    expect(traversal.resolutions).toHaveLength(0)
    expect(traversal.commands).toHaveLength(0)
  })

  it('reports a missing search path as a non-fatal discovery result', async () => {
    const root = repository()
    const search = registeredRuntime(root, 'task').definitions.find(definition => definition.name === 'leppy_search')
    expect(search).toBeDefined()
    await expect(search!.execute({ pattern: 'Company', paths: ['messages'] })).resolves.toEqual({
      text: 'No requested search path exists: messages',
    })
  })

  it('searches only existing scopes when requested paths are mixed', async () => {
    const root = repository()
    const runtime = registeredRuntime(root, 'task')
    const search = runtime.definitions.find(definition => definition.name === 'leppy_search')
    expect(search).toBeDefined()
    await expect(search!.execute({ pattern: 'Seed', paths: ['messages', 'prisma/schemas'] })).resolves.toEqual({
      text: 'Skipped missing search path(s): messages\n',
    })
    expect(runtime.commands).toHaveLength(1)
    const argv = runtime.commands[0]!.map(argument => argument.replaceAll('\\', '/'))
    expect(argv).toContain('prisma/schemas')
    expect(argv).not.toContain('messages')
    expect(argv).not.toContain('.')
  })

  it('fails clearly when Git search output is truncated on either stream', async () => {
    const root = repository()
    for (const output of [{ stdoutLossy: true }, { stderrLossy: true }]) {
      const runtime = registeredRuntime(root, 'task', output)
      const search = runtime.definitions.find(definition => definition.name === 'leppy_search')
      expect(search).toBeDefined()
      await expect(search!.execute({ pattern: 'Seed', paths: ['prisma/schemas'] })).rejects.toThrow(
        'GIT_OUTPUT_OVERFLOW: repository search exceeded the 256 KiB capture limit',
      )
    }
  })

  it('reconciles HEAD after a successful commit whose diagnostic output was truncated', async () => {
    const root = repository()
    const commitId = '0123456789abcdef0123456789abcdef01234567'
    const commands: string[][] = []
    const runGit = async (args: readonly string[]) => {
      commands.push([...args])
      if (args[0] === 'diff' && !args.includes('--cached')) {
        return { exitCode: 0, stdout: 'prisma/schemas/auth.prisma\0', stderr: '' }
      }
      if (args[0] === 'commit') return { exitCode: 0, stdout: 'retained commit tail', stderr: '', lossy: true }
      if (args[0] === 'rev-parse') return { exitCode: 0, stdout: `${commitId}\n`, stderr: '' }
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    const policy: WorkerPolicy = {
      root,
      repoRoot: root,
      checklist: join(root, 'tasks.task.md'),
      allowed: [join(root, 'prisma', 'schemas', 'auth.prisma')],
      mode: 'task',
    }

    await expect(commitTaskChanges(policy, 'fix: reconcile lossy commit output', runGit)).resolves.toBe(commitId)
    expect(commands.slice(-2).map(args => args[0])).toEqual(['commit', 'rev-parse'])
  })

  it('discards untracked svelte-check validation cache before scoped commit', async () => {
    const root = repository()
    writeFileSync(join(root, 'prisma', 'schemas', 'auth.prisma'), 'model AuthState { id Int @id }\n')
    mkdirSync(join(root, '.svelte-check'))
    writeFileSync(join(root, '.svelte-check', 'manifest.json'), '{"generated":true}\n')
    const policy: WorkerPolicy = {
      root,
      repoRoot: root,
      checklist: join(root, 'tasks.task.md'),
      allowed: [join(root, 'prisma', 'schemas')],
      mode: 'task',
    }

    await commitTaskChanges(policy, 'feat: persist auth state', runner(root))

    expect(existsSync(join(root, '.svelte-check'))).toBe(false)
    expect(git(root, 'show', '--pretty=format:', '--name-only', 'HEAD').split(/\r?\n/u).filter(Boolean)).toEqual([
      'prisma/schemas/auth.prisma',
    ])
  })

  it('force-adds only changed ignored files inside the declared task scope', async () => {
    const root = repository()
    mkdirSync(join(root, 'prisma', 'migrations', '20260826_auth'), { recursive: true })
    writeFileSync(join(root, 'prisma', 'migrations', '20260826_auth', 'migration.sql'), 'CREATE TABLE auth_state ();\n')
    writeFileSync(join(root, 'prisma', 'schemas', 'auth.prisma'), 'model AuthState { id Int @id }\n')
    writeFileSync(join(root, '.env.secret'), 'must-not-stage\n')
    const policy: WorkerPolicy = {
      root,
      repoRoot: root,
      checklist: join(root, 'tasks.task.md'),
      allowed: [join(root, 'prisma', 'schemas'), join(root, 'prisma', 'migrations')],
      mode: 'task',
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
