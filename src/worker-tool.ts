import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-subprocess'
import { safePathEnvironment, validateArgv } from './security.js'
import { isConventional } from './git.js'

export const name = 'leppy-loop-worker-tools'
export const inject = ['tools', 'subprocess', 'sandbox', 'sandboxPolicy']

interface WorkerPolicy {
  root: string
  checklist: string
  allowed: string[]
  gateFingerprint?: string
}

function loadPolicy(): WorkerPolicy {
  const root = realpathSync(requiredEnv('LEPPY_WORKTREE'))
  const checklist = resolve(root, requiredEnv('LEPPY_CHECKLIST'))
  const allowed = JSON.parse(requiredEnv('LEPPY_ALLOWED_PATHS')) as unknown
  if (!Array.isArray(allowed) || !allowed.every(item => typeof item === 'string')) throw new Error('LEPPY_ALLOWED_PATHS must be a string array')
  return { root, checklist, allowed: allowed.map(item => resolve(root, item)), ...(process.env.LEPPY_GATE_FINGERPRINT ? { gateFingerprint: process.env.LEPPY_GATE_FINGERPRINT } : {}) }
}

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

function nearestReal(path: string): { real: string; suffix: string } {
  let current = path
  while (!existsSync(current)) {
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return { real: realpathSync(current), suffix: relative(current, path) }
}

function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

function resolveAllowed(policy: WorkerPolicy, candidate: string, writing: boolean): string {
  if (candidate.includes('\0') || isAbsolute(candidate)) throw new Error('path must be repo-relative')
  const absolute = resolve(policy.root, candidate)
  const { real, suffix } = nearestReal(absolute)
  const canonical = resolve(real, suffix)
  if (!inside(policy.root, canonical)) throw new Error('path escapes worktree through traversal or link')
  if (canonical === policy.checklist) throw new Error('controlling checklist is denied')
  const permitted = policy.allowed.some(scope => canonical === scope || inside(scope, canonical))
  if (!permitted) throw new Error(`path is outside this task scope: ${candidate}`)
  if (!writing && !existsSync(canonical)) throw new Error(`path does not exist: ${candidate}`)
  return canonical
}

function textOutput(value: unknown): [{ type: 'text'; text: string }] {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }]
}

async function gitCommand(ctx: Context, policy: WorkerPolicy, args: readonly string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const env = Object.fromEntries(Object.entries(safePathEnvironment(process.env)).filter((entry): entry is [string, string] => entry[1] !== undefined))
  const executable = await ctx.subprocess.resolveExecutable('git', env)
  const handle = ctx.subprocess.spawn({
    argv: [executable, ...args], cwd: policy.root, env,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 256 * 1024 }, stderr: { maxBytes: 256 * 1024 } },
    graceMs: 2_000,
  })
  const outcome = await handle.done
  return {
    exitCode: outcome.exitCode ?? -1,
    stdout: handle.collected.stdout?.readFrom(0).text ?? '',
    stderr: handle.collected.stderr?.readFrom(0).text ?? '',
  }
}

function nulPaths(text: string): string[] { return text.split('\0').filter(Boolean) }

export function apply(ctx: Context): void {
  const policy = loadPolicy()
  ctx.tools.register(defineTool({
    name: 'leppy_read',
    description: 'Read one UTF-8 file inside the current task path scope.',
    parameters: { path: { type: 'string', required: true } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } }, render: (_args, value) => textOutput((value as { text: string }).text) },
    async execute(args) {
      return { text: readFileSync(resolveAllowed(policy, args.path, false), 'utf8') }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'leppy_commit',
    description: 'Create the task conventional commit through a narrow Git-metadata capability after validating every changed path against this task scope.',
    parameters: { message: { type: 'string', required: true } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { commit: { type: 'string', required: true } } }, render: (_args, value) => textOutput(value) },
    async execute(args) {
      if (!isConventional(args.message)) throw new Error('commit message must be conventional')
      const probes = await Promise.all([
        gitCommand(ctx, policy, ['diff', '--name-only', '-z']),
        gitCommand(ctx, policy, ['diff', '--cached', '--name-only', '-z']),
        gitCommand(ctx, policy, ['ls-files', '--others', '--exclude-standard', '-z']),
      ])
      if (probes.some(result => result.exitCode !== 0)) throw new Error(`cannot inspect Git changes: ${probes.map(result => result.stderr).join('\n')}`)
      const changed = [...new Set(probes.flatMap(result => nulPaths(result.stdout)))]
      if (changed.length === 0) throw new Error('no task changes to commit')
      for (const path of changed) resolveAllowed(policy, path, true)
      const relativeScopes = policy.allowed.map(path => relative(policy.root, path))
      const add = await gitCommand(ctx, policy, ['add', '--', ...relativeScopes])
      if (add.exitCode !== 0) throw new Error(`git add failed: ${add.stderr}`)
      const commit = await gitCommand(ctx, policy, ['commit', '-m', args.message])
      if (commit.exitCode !== 0) throw new Error(`git commit failed: ${commit.stderr}`)
      const id = await gitCommand(ctx, policy, ['rev-parse', 'HEAD'])
      if (id.exitCode !== 0) throw new Error(`cannot resolve commit: ${id.stderr}`)
      return { commit: id.stdout.trim() }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'leppy_write',
    description: 'Replace one UTF-8 file inside the current task path scope. Parent directories are created.',
    parameters: { path: { type: 'string', required: true }, content: { type: 'string', required: true } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { bytes: { type: 'number', required: true } } }, render: (_args, value) => textOutput(value) },
    async execute(args) {
      const path = resolveAllowed(policy, args.path, true)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, args.content, 'utf8')
      return { bytes: Buffer.byteLength(args.content) }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'leppy_exec',
    description: 'Run an exact local argv without a shell. Remote, publication, integration and dynamic-eval commands are denied.',
    parameters: {
      command: { type: 'string', required: true },
      args: { type: 'array', items: { type: 'string' }, required: true },
      cwd: { type: 'string', description: 'Repo-relative working directory; defaults to repository root.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { exitCode: { type: 'number', required: true }, stdout: { type: 'string', required: true }, stderr: { type: 'string', required: true } } },
      render: (_args, value) => textOutput(value),
    },
    async execute(args, exec) {
      const cwd = args.cwd ? resolveAllowed(policy, args.cwd, false) : policy.root
      validateArgv(args.command, args.args, cwd, policy.root, policy.gateFingerprint)
      const execution = ctx.sandboxPolicy.resolve(exec.agent?.session ? { session: exec.agent.session } : {})
      if (execution.mode !== 'workspace-write') throw new Error(`worker requires workspace-write, got ${execution.mode}`)
      const confined = ctx.sandbox.confine([args.command, ...args.args], execution as SandboxPolicy)
      const handle = ctx.subprocess.spawn({
        argv: confined.argv,
        cwd,
        env: safePathEnvironment(process.env),
        stdio: { stdin: 'ignore', stdout: { maxBytes: 256 * 1024 }, stderr: { maxBytes: 256 * 1024 } },
        graceMs: 2_000,
        signal: exec.signal,
      })
      const outcome = await handle.done
      const stdout = handle.collected.stdout?.readFrom(0).text ?? ''
      const stderr = handle.collected.stderr?.readFrom(0).text ?? ''
      return { exitCode: outcome.exitCode ?? -1, stdout, stderr }
    },
  }))
}
