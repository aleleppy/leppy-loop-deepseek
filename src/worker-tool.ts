import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { safePathEnvironment, validateArgv } from './security.js'
import { isConventional } from './git.js'
import type { WorkerMode } from './types.js'
import { normalizeExecCommand } from './windows-command.js'

export const name = 'leppy-loop-worker-tools'
export const inject = ['tools', 'subprocess', 'sandbox', 'sandboxPolicy', 'systemPrompt']

export interface WorkerPolicy {
  root: string
  checklist: string
  allowed: string[]
  mode?: WorkerMode
  gateFingerprint?: string
}

function loadPolicy(): WorkerPolicy {
  const root = realpathSync(requiredEnv('LEPPY_WORKTREE'))
  const checklist = resolve(root, requiredEnv('LEPPY_CHECKLIST'))
  const allowed = JSON.parse(requiredEnv('LEPPY_ALLOWED_PATHS')) as unknown
  if (!Array.isArray(allowed) || !allowed.every(item => typeof item === 'string')) throw new Error('LEPPY_ALLOWED_PATHS must be a string array')
  const mode = process.env.LEPPY_WORKER_MODE ?? 'task'
  if (!['task', 'verification', 'publication-conflict'].includes(mode)) throw new Error('LEPPY_WORKER_MODE is invalid')
  return { root, checklist, allowed: allowed.map(item => resolve(root, item)), mode: mode as WorkerMode, ...(process.env.LEPPY_GATE_FINGERPRINT ? { gateFingerprint: process.env.LEPPY_GATE_FINGERPRINT } : {}) }
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

function resolvePolicyPath(policy: WorkerPolicy, candidate: string, writing: boolean): string {
  if (candidate.includes('\0') || isAbsolute(candidate)) throw new Error('path must be repo-relative')
  const absolute = resolve(policy.root, candidate)
  const { real, suffix } = nearestReal(absolute)
  const canonical = resolve(real, suffix)
  if (!inside(policy.root, canonical)) throw new Error('path escapes worktree through traversal or link')
  const repoRelative = relative(policy.root, canonical)
  if (repoRelative === '.git' || repoRelative.startsWith(`.git${sep}`)) throw new Error('Git metadata is denied')
  if (canonical === policy.checklist) throw new Error('controlling checklist is denied')
  const permitted = !writing && policy.mode !== 'publication-conflict'
    ? true
    : policy.allowed.some(scope => canonical === scope || (policy.mode !== 'publication-conflict' && inside(scope, canonical)))
  if (!permitted) throw new Error(`path is outside this task write scope: ${candidate}`)
  return canonical
}

export function resolveAllowed(policy: WorkerPolicy, candidate: string, writing: boolean): string {
  const canonical = resolvePolicyPath(policy, candidate, writing)
  if (!writing && !existsSync(canonical)) throw new Error(`path does not exist: ${candidate}`)
  return canonical
}

export function resolveExecCwd(policy: WorkerPolicy, candidate?: string): string {
  if (candidate === undefined || candidate === '.' || candidate === './' || candidate === '.\\') return policy.root
  return resolveAllowed(policy, candidate, false)
}

function workerExecEnvironment(policy: WorkerPolicy): Record<string, string> {
  const environment = Object.fromEntries(
    Object.entries(safePathEnvironment(process.env)).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
  const pathName = Object.hasOwn(environment, 'Path') ? 'Path' : 'PATH'
  const localBin = resolve(policy.root, 'node_modules', '.bin')
  const existing = environment[pathName]?.split(delimiter).filter(Boolean) ?? []
  const key = (value: string): string => process.platform === 'win32' ? value.toLowerCase() : value
  environment[pathName] = [localBin, ...existing.filter(value => key(value) !== key(localBin))].join(delimiter)
  return environment
}

function explicitRepoExecutable(policy: WorkerPolicy, cwd: string, command: string): string {
  if (isAbsolute(command) || !/[\\/]/u.test(command)) return command
  const candidate = resolve(cwd, command)
  if (!existsSync(candidate)) return candidate
  const canonical = realpathSync(candidate)
  if (!inside(policy.root, canonical)) throw new Error('explicit executable escapes the worktree through traversal or link')
  return candidate
}

function textOutput(value: unknown): [{ type: 'text'; text: string }] {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }]
}

export function validatedExecOutput(exitCode: number, stdout: string, stderr: string): { exitCode: number; stdout: string; stderr: string } {
  if (exitCode !== 0) {
    const detail = [stderr.trim(), stdout.trim()].filter(Boolean).join('\n').slice(-16 * 1024)
    throw new Error(`command failed with exit ${exitCode}${detail ? `: ${detail}` : ''}`)
  }
  return { exitCode, stdout, stderr }
}

async function gitCommand(ctx: Context, policy: WorkerPolicy, args: readonly string[]): Promise<GitResult> {
  const env = Object.fromEntries(Object.entries(safePathEnvironment(process.env)).filter((entry): entry is [string, string] => entry[1] !== undefined))
  const executable = await ctx.subprocess.resolveExecutable('git', env)
  const handle = ctx.subprocess.spawn({
    argv: [executable, ...args], cwd: policy.root, env,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 256 * 1024 }, stderr: { maxBytes: 256 * 1024 } },
    graceMs: 2_000,
  })
  const outcome = await handle.done
  const stdout = handle.collected.stdout?.readFrom(0)
  const stderr = handle.collected.stderr?.readFrom(0)
  if (stdout === undefined || stderr === undefined) throw new Error('git command produced no collected output streams')
  return {
    exitCode: outcome.exitCode ?? -1,
    stdout: stdout.text,
    stderr: stderr.text,
    lossy: stdout.lossy || stderr.lossy,
  }
}

function nulPaths(text: string): string[] { return text.split('\0').filter(Boolean) }

type GitResult = { exitCode: number; stdout: string; stderr: string; lossy?: boolean }
type GitRunner = (args: readonly string[]) => Promise<GitResult>

function requireCompleteGitOutput(result: GitResult, operation: string): GitResult {
  if (result.lossy) throw new Error(`GIT_OUTPUT_OVERFLOW: ${operation} exceeded the 256 KiB capture limit; narrow the search or command and retry`)
  return result
}

/** Validate and commit exactly the changed paths inside one worker's declared scope. */
export async function commitTaskChanges(policy: WorkerPolicy, message: string, runGit: GitRunner): Promise<string> {
  if (policy.mode !== 'task') throw new Error(`${policy.mode} workers cannot commit`)
  if (!isConventional(message)) throw new Error('commit message must be conventional')
  const relativeScopes = policy.allowed.map(path => relative(policy.root, path))
  const probes = (await Promise.all([
    runGit(['diff', '--name-only', '-z']),
    runGit(['diff', '--cached', '--name-only', '-z']),
    runGit(['ls-files', '--others', '--exclude-standard', '-z']),
    runGit(['ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--', ...relativeScopes]),
  ])).map(result => requireCompleteGitOutput(result, 'Git change inspection'))
  if (probes.some(result => result.exitCode !== 0)) throw new Error(`cannot inspect Git changes: ${probes.map(result => result.stderr).join('\n')}`)
  const changed = [...new Set(probes.flatMap(result => nulPaths(result.stdout)))]
  if (changed.length === 0) throw new Error('no task changes to commit')
  for (const path of changed) resolveAllowed(policy, path, true)
  const add = await runGit(['add', '-f', '--', ...changed])
  if (add.exitCode !== 0) throw new Error(`git add failed: ${add.stderr}`)
  const commit = await runGit(['commit', '-m', message])
  if (commit.exitCode !== 0) throw new Error(`git commit failed: ${commit.stderr}`)
  const id = requireCompleteGitOutput(await runGit(['rev-parse', 'HEAD']), 'Git commit reconciliation')
  if (id.exitCode !== 0) throw new Error(`cannot resolve commit: ${id.stderr}`)
  return id.stdout.trim()
}

export function apply(ctx: Context): void {
  const policy = loadPolicy()
  ctx.systemPrompt.variable('leppy_prompt', () => requiredEnv('LEPPY_SYSTEM_PROMPT'))
  ctx.tools.register(defineTool({
    name: 'leppy_read',
    description: 'Read one UTF-8 file inside the current task path scope.',
    parameters: { path: { type: 'string', required: true } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } }, render: (_args, value) => textOutput((value as { text: string }).text) },
    async execute(args) {
      return { text: readFileSync(resolveAllowed(policy, args.path, false), 'utf8') }
    },
  }))
  if (policy.mode !== 'publication-conflict') ctx.tools.register(defineTool({
    name: 'leppy_search',
    description: 'Search tracked repository text with Git grep. Use this instead of rg, grep, find, or shell pipelines. Missing requested paths are reported as a normal discovery result; retry without paths to search the repository.',
    parameters: {
      pattern: { type: 'string', required: true },
      paths: { type: 'array', items: { type: 'string' }, description: 'Optional repo-relative files or directories. Reads may inspect the worktree, but never the controller.' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } }, render: (_args, value) => textOutput((value as { text: string }).text) },
    async execute(args) {
      const requestedPaths = args.paths ?? []
      const resolved = requestedPaths.map(candidate => ({ candidate, path: resolvePolicyPath(policy, candidate, false) }))
      const existing = resolved.filter(candidate => existsSync(candidate.path))
      const missing = resolved.filter(candidate => !existsSync(candidate.path)).map(candidate => candidate.candidate)
      if (requestedPaths.length > 0 && existing.length === 0) return { text: `No requested search path exists: ${missing.join(', ')}` }
      const relativePaths = existing.map(candidate => relative(policy.root, candidate.path))
      const pathspecs = requestedPaths.length > 0 ? relativePaths : ['.']
      pathspecs.push(`:(exclude)${relative(policy.root, policy.checklist).replaceAll('\\', '/')}`)
      const result = requireCompleteGitOutput(
        await gitCommand(ctx, policy, ['grep', '-n', '-e', args.pattern, '--', ...pathspecs]),
        'repository search',
      )
      const missingNotice = missing.length > 0 ? `Skipped missing search path(s): ${missing.join(', ')}\n` : ''
      if (result.exitCode === 1) return { text: missingNotice }
      if (result.exitCode !== 0) throw new Error(`repository search failed: ${result.stderr || `exit ${result.exitCode}`}`)
      return { text: missingNotice + result.stdout }
    },
  }))
  if (policy.mode === 'task') ctx.tools.register(defineTool({
    name: 'leppy_edit',
    description: 'Replace exact UTF-8 text inside one writable task path. Prefer this over rewriting whole files or constructing patches.',
    parameters: {
      path: { type: 'string', required: true },
      oldText: { type: 'string', required: true },
      newText: { type: 'string', required: true },
      replaceAll: { type: 'boolean', description: 'Replace every match. Defaults to false, which requires exactly one match.' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { replacements: { type: 'number', required: true } } }, render: (_args, value) => textOutput(value) },
    async execute(args) {
      if (args.oldText === '') throw new Error('oldText must not be empty')
      const path = resolveAllowed(policy, args.path, true)
      const source = readFileSync(path, 'utf8')
      const matches = source.split(args.oldText).length - 1
      if (matches === 0) throw new Error('oldText was not found')
      if (!args.replaceAll && matches !== 1) throw new Error(`oldText matched ${matches} times; provide a unique match or set replaceAll`)
      writeFileSync(path, args.replaceAll ? source.replaceAll(args.oldText, args.newText) : source.replace(args.oldText, args.newText), 'utf8')
      return { replacements: args.replaceAll ? matches : 1 }
    },
  }))
  if (policy.mode === 'task') ctx.tools.register(defineTool({
    name: 'leppy_commit',
    description: 'Create the task conventional commit through a narrow Git-metadata capability after validating every changed path against this task scope.',
    parameters: { message: { type: 'string', required: true } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { commit: { type: 'string', required: true } } }, render: (_args, value) => textOutput(value) },
    async execute(args) {
      const commit = await commitTaskChanges(policy, args.message, command => gitCommand(ctx, policy, command))
      return { commit }
    },
  }))
  if (policy.mode !== 'verification') ctx.tools.register(defineTool({
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
  if (policy.mode === 'publication-conflict') ctx.tools.register(defineTool({
    name: 'leppy_delete',
    description: 'Delete one exact conflicted path. This capability exists only during authenticated publication conflict repair.',
    parameters: { path: { type: 'string', required: true } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { deleted: { type: 'boolean', required: true } } }, render: (_args, value) => textOutput(value) },
    async execute(args) {
      const path = resolveAllowed(policy, args.path, true)
      const deleted = existsSync(path)
      if (deleted) rmSync(path, { force: true })
      return { deleted }
    },
  }))
  if (policy.mode !== 'publication-conflict') ctx.tools.register(defineTool({
    name: 'leppy_exec',
    description: policy.mode === 'verification'
      ? 'Run one direct already-materialized validation binary in the disposable verification worktree. Package managers, repository scripts, shells, interpreter frontends, remote clients, publication and dynamic evaluation are denied.'
      : 'Run an exact local argv without a shell. Bare commands resolve local-first from the authenticated root node_modules/.bin; Windows shims select .cmd automatically. Keep command and args separate. Package managers permit only explicit run/test scripts; npx/dlx/corepack and alternate package frontends, install, cache overrides, remote, publication and dynamic-eval commands are denied.',
    parameters: {
      command: { type: 'string', required: true },
      args: { type: 'array', items: { type: 'string' }, required: true },
      cwd: { type: 'string', description: 'Repo-relative working directory; omit it or use "." for repository root.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { exitCode: { type: 'number', required: true }, stdout: { type: 'string', required: true }, stderr: { type: 'string', required: true } } },
      render: (_args, value) => textOutput(value),
    },
    async execute(args, exec) {
      const cwd = resolveExecCwd(policy, args.cwd)
      const normalized = normalizeExecCommand(args.command, cwd)
      validateArgv(normalized, args.args, cwd, policy.root, policy.gateFingerprint, policy.mode)
      const environment = workerExecEnvironment(policy)
      const command = await ctx.subprocess.resolveExecutable(explicitRepoExecutable(policy, cwd, normalized), environment, exec.signal)
      if (policy.mode === 'verification') {
        if (isAbsolute(normalized) || /[\\/]/u.test(normalized)) throw new Error('verification requires a bare authenticated local validation binary')
        const localBin = resolve(policy.root, 'node_modules', '.bin')
        const resolvedRelative = relative(localBin, command)
        if (resolvedRelative === '..' || resolvedRelative.startsWith(`..${sep}`) || isAbsolute(resolvedRelative)) {
          throw new Error('verification executable did not resolve from authenticated root node_modules/.bin')
        }
      }
      validateArgv(command, args.args, cwd, policy.root, undefined, policy.mode)
      const execution = ctx.sandboxPolicy.resolve(exec.agent?.session ? { session: exec.agent.session } : {})
      if (execution.mode !== 'workspace-write') throw new Error(`worker requires workspace-write, got ${execution.mode}`)
      if (realpathSync(execution.workspaceRoot) !== policy.root) throw new Error('worker sandbox root does not match the authenticated worktree')
      const confined = ctx.sandbox.confine([command, ...args.args], execution as SandboxPolicy)
      const handle = ctx.subprocess.spawn({
        argv: confined.argv,
        cwd,
        env: environment,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 256 * 1024 }, stderr: { maxBytes: 256 * 1024 } },
        graceMs: 2_000,
        signal: exec.signal,
      })
      const outcome = await handle.done
      const stdout = handle.collected.stdout?.readFrom(0).text ?? ''
      const stderr = handle.collected.stderr?.readFrom(0).text ?? ''
      return validatedExecOutput(outcome.exitCode ?? -1, stdout, stderr)
    },
  }))
}
