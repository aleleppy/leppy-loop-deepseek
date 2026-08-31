import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { CommandDefinition, CommandInvocation } from '@deepseek-ai/dsh-commands'
import type { JobHooks, JobId, JobStart } from '@deepseek-ai/dsh-jobs'
import type { SkillProvider } from '@deepseek-ai/dsh-skill'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import {
  apply, createChatProgressReporter, executeLeppyLoopCommand, executeLeppyLoopControl,
} from '../src/command.js'
import { selectControllerForPublication, selectControllerForStatus } from '../src/controller-auth.js'
import type { AuthenticatedController } from '../src/controller-auth.js'
import { HumanGrantStore } from '../src/human-grant.js'
import { lifecycleCommonDir } from '../src/lifecycle-authority.js'
import { parseLeppyLoopCommandInput, tokenizeLeppyLoopCommandInput } from '../src/options.js'
import type { LeppyLoopRuntime } from '../src/command.js'
import { acquireLock } from '../src/state.js'
import type { ActiveTaskAttempt, LeppyLoopOptions, LifecycleAuthority, PendingTaskValidation, RunProgress, RunResult } from '../src/types.js'

const cwd = process.cwd()

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
}

function dependencyRecoveryRepository(): { root: string; worktree: string } {
  const root = mkdtempSync(join(tmpdir(), 'leppy-command-dependencies-'))
  writeFileSync(join(root, '.gitignore'), 'node_modules/\n')
  writeFileSync(join(root, 'tasks.task.md'), '- [ ] Change `src/value.txt` | Done: value says done\n')
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src', 'value.txt'), 'before\n')
  writeFileSync(join(root, 'package.json'), '{"name":"command-fixture","private":true,"devDependencies":{"typescript":"5.9.3"}}\n')
  writeFileSync(join(root, 'package-lock.json'), '{"name":"command-fixture","lockfileVersion":3,"packages":{"":{"name":"command-fixture","devDependencies":{"typescript":"5.9.3"}},"node_modules/typescript":{"version":"5.9.3","resolved":"https://registry.npmjs.org/typescript/-/typescript-5.9.3.tgz","integrity":"sha512-jl1vZzPDinLr9eUt3J/t7V6FgNEw9QjvBPdysz9KfQDD41fQrC2Y4vKQdiaUpFT4bXlb1RHhLpp8wtm6M5TgSw==","bin":{"tsc":"bin/tsc"}}}}\n')
  git(root, 'init', '-b', 'main')
  git(root, 'config', 'user.email', 'tests@example.invalid')
  git(root, 'config', 'user.name', 'Leppy Tests')
  git(root, 'add', '--', '.gitignore', 'tasks.task.md', 'src/value.txt', 'package.json', 'package-lock.json')
  git(root, 'commit', '-m', 'chore: seed')
  mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true })
  mkdirSync(join(root, 'node_modules', 'typescript'), { recursive: true })
  writeFileSync(join(root, 'node_modules', 'typescript', 'package.json'), '{"name":"typescript","version":"5.9.3","resolved":"https://registry.npmjs.org/typescript/-/typescript-5.9.3.tgz","integrity":"sha512-jl1vZzPDinLr9eUt3J/t7V6FgNEw9QjvBPdysz9KfQDD41fQrC2Y4vKQdiaUpFT4bXlb1RHhLpp8wtm6M5TgSw==","bin":{"tsc":"bin/tsc"}}\n')
  writeFileSync(join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc'), 'fixture shim\n')
  writeFileSync(join(root, 'node_modules', '.package-lock.json'), '{"lockfileVersion":3,"packages":{"node_modules/typescript":{"version":"5.9.3","resolved":"https://registry.npmjs.org/typescript/-/typescript-5.9.3.tgz","integrity":"sha512-jl1vZzPDinLr9eUt3J/t7V6FgNEw9QjvBPdysz9KfQDD41fQrC2Y4vKQdiaUpFT4bXlb1RHhLpp8wtm6M5TgSw==","bin":{"tsc":"bin/tsc"}}}}\n')
  const worktree = `${root}-worker`
  git(root, 'worktree', 'add', '-b', 'leppy-loop/recovery', worktree, 'HEAD')
  return { root, worktree }
}

function controller(overrides: Partial<AuthenticatedController> = {}): AuthenticatedController {
  return {
    runId: '44c85fb806c6', status: 'stalled', repoRoot: cwd,
    checklistRelative: 'examples/feature.task.md', sourceHead: 'source-head', syncBranch: 'origin/plugins',
    branch: 'leppy-loop/recovery', worktree: resolve(cwd, '..', 'preserved-worktree'), authorityDigest: 'controller-digest',
    currentTask: 11, attempt: 15, completedTasks: 5, updatedAt: '2026-08-27T14:19:07.160Z',
    openTask: {
      index: 11, line: 29, phase: 'Phase 6', mark: ' ', kind: 'task', text: 'P6.1 update documentation', raw: '- [ ] P6.1',
      metadata: { paths: ['README.md'], done: 'documentation matches release' },
    },
    ...overrides,
  }
}

function pendingValidation(overrides: Partial<PendingTaskValidation> = {}): PendingTaskValidation {
  return {
    schemaVersion: 1,
    taskKey: 'a'.repeat(64),
    taskIndex: 11,
    baseHead: '1'.repeat(40),
    commitHead: '2'.repeat(40),
    checklistDigest: 'b'.repeat(64),
    ignoredPathsDigest: 'd'.repeat(64),
    failureSignature: 'c'.repeat(64),
    createdAttempt: 15,
    verifierAttempts: 2,
    phase: 'pending',
    ...overrides,
  }
}

function activeAttempt(overrides: Partial<ActiveTaskAttempt> = {}): ActiveTaskAttempt {
  return {
    schemaVersion: 1, taskKey: 'a'.repeat(64), taskIndex: 11, baseHead: '1'.repeat(40),
    checklistDigest: 'b'.repeat(64), ignoredPathsDigest: 'd'.repeat(64), attempt: 15,
    ...overrides,
  }
}

function agent(id = 'session-a', followup: (message: unknown) => void = () => {}, append: (type: string, data: unknown) => void = () => {}, workspace = cwd): Agent {
  const tools = { register: vi.fn(() => () => {}) }
  return {
    id,
    ctx: { tools },
    session: { header: { cwd: workspace }, append },
    followup,
  } as unknown as Agent
}

class FakeJobs {
  starts: Array<{ id: JobId; spec: JobStart; hooks: JobHooks; status: 'running' | 'stopping' | 'completed' }> = []

  start(spec: JobStart): JobId {
    const hooks = spec.run()
    const id = `leppy-loop-${this.starts.length + 1}` as JobId
    const row = { id, spec, hooks, status: 'running' as const }
    this.starts.push(row)
    void hooks.done.then(() => { (row as { status: string }).status = 'completed' })
    return id
  }

  get(id: JobId, caller?: Agent): { status: string } {
    const row = this.starts.find(candidate => candidate.id === id)
    if (!row || row.spec.owner !== caller) throw new Error('foreign or unknown job')
    return { status: row.status }
  }

  kill(id: JobId, caller?: Agent): 'requested' | 'already-finished' {
    const row = this.starts.find(candidate => candidate.id === id)
    if (!row || row.spec.owner !== caller) throw new Error('foreign or unknown job')
    if (row.status === 'completed') return 'already-finished'
    row.hooks.cancel('human stop')
    ;(row as { status: string }).status = 'stopping'
    return 'requested'
  }
}

function context(jobs = new FakeJobs()): Context {
  return { jobs } as unknown as Context
}

function runtime(hooks: LeppyLoopRuntime['hooks'] = {}): LeppyLoopRuntime {
  return {
    grants: new HumanGrantStore(), jobs: [], activeRepositories: new Set(), registeredAgents: new WeakSet(), lifetime: new AbortController(), hooks: { persistAuthority: async () => {}, ...hooks },
  }
}

function issueGrant(rt: LeppyLoopRuntime, owner: Agent, overrides: { runId?: string; allowPublication?: boolean; maxTransitions?: number } = {}) {
  return rt.grants.issue({
    agent: owner, repoRoot: cwd, ...(overrides.runId ? { runId: overrides.runId } : {}),
    allowPublication: overrides.allowPublication ?? false,
    maxIterations: 64, maxRepairCycles: 3, maxTransitions: overrides.maxTransitions ?? 16,
  })
}

function invocation(owner: Agent, rawInput: string): CommandInvocation {
  return { commandId: 'command-test', agent: owner, rawInput, attachments: [], signal: new AbortController().signal } as unknown as CommandInvocation
}

const completed: RunResult = { runId: 'run-web', status: 'completed', completedTasks: 3, diagnostics: [] }

describe('CLI-only technical parser', () => {
  it('still tokenizes quoted CLI values without evaluating shell syntax', () => {
    expect(tokenizeLeppyLoopCommandInput(String.raw` --tasks "\\server\share\my task.md" --sync-branch origin/main `)).toEqual([
      '--tasks', String.raw`\\server\share\my task.md`, '--sync-branch', 'origin/main',
    ])
    expect(parseLeppyLoopCommandInput('--tasks tasks/a.md --sync-branch main --open-pr').openPullRequest).toBe(true)
  })
})

describe('chat task progress', () => {
  it('keeps the global attempt in card identity while displaying the per-task attempt', () => {
    const events: Array<{ type: string; data: unknown }> = []
    const report = createChatProgressReporter(agent('session', () => {}, (type, data) => { events.push({ type, data }) }))
    const base: RunProgress = {
      type: 'task-start', runId: 'run-1', taskIndex: 2, attempt: 15, taskAttempt: 2, kind: 'task', phase: 'Phase 6',
      text: 'A very long task label', completedTasks: 5, totalTasks: 14, elapsedMs: 0,
    }
    report(base)
    report({ ...base, type: 'task-done', completedTasks: 6, elapsedMs: 65_000 })
    expect(events[0]).toMatchObject({
      type: 'command/run',
      data: { commandId: 'leppy-progress-run-1-2-15', args: expect.stringContaining('leppy-attempt=2') },
    })
    expect(events[1]).toMatchObject({ type: 'command/done', data: { text: 'Task completed — 6/14 — 1m 5s elapsed.' } })
  })
})

describe('simple human slash surface', () => {
  it('reserves /leppy-loop for the command and registers a distinct model-only operator skill', async () => {
    let definition: CommandDefinition | undefined
    let globalTool: ToolDefinition | undefined
    let skillProvider: SkillProvider | undefined
    const ctx = {
      commands: { register: (value: CommandDefinition) => { definition = value; return () => {} } },
      tools: { register: (value: ToolDefinition) => { globalTool = value; return () => {} } },
      skills: { registerProvider: (factory: () => SkillProvider) => { skillProvider = factory(); return () => {} } },
      effect: (setup: () => (() => void)) => setup(),
    } as unknown as Context
    apply(ctx)
    expect(definition?.name).toBe('leppy-loop')
    expect(definition?.input).toEqual({ hint: '[natural-language intent|status|parar]' })
    expect(globalTool?.name).toBe('leppy_loop_control')
    const candidates = await skillProvider!.list({})
    expect(Array.isArray(candidates)).toBe(true)
    if (!Array.isArray(candidates)) throw new Error('expected static skill candidates')
    expect(candidates).toMatchObject([{ name: 'leppy-loop-operator', invocation: { modelInvocable: true, userInvocable: false } }])
    expect(candidates[0]!.name).not.toBe(definition!.name)
    const skill = await skillProvider!.get(candidates[0]!, {})
    expect(skill?.content).toContain('Never invent, remember, or pass a `leppy-loop-*` job ID')

    const messages: unknown[] = []
    const owner = agent('scope-agent', message => { messages.push(message) })
    const result = await definition!.handler(invocation(owner, ''))
    expect(result).toMatchObject({ kind: 'success', text: expect.stringContaining('lifecycle authorized') })
    expect(messages).toHaveLength(1)
    const register = owner.ctx.tools.register as ReturnType<typeof vi.fn>
    expect(register).not.toHaveBeenCalled()
    const toolProperties = (globalTool!.parameters as { properties: Record<string, { enum?: string[] }> }).properties
    expect(toolProperties).not.toHaveProperty('phaseGateCommand')
    expect(toolProperties).not.toHaveProperty('repairPaths')
    expect(toolProperties).not.toHaveProperty('repairCycles')
    expect(toolProperties).toHaveProperty('publish')
    expect(toolProperties).toHaveProperty('publicationTarget')
    expect(toolProperties.operation?.enum).not.toContain('stop')
  })

  it('/leppy-loop continuar returns before the controller and gives the AI exact authenticated facts', async () => {
    const messages: unknown[] = []
    const owner = agent('continue-agent', message => { messages.push(message) })
    const rt = runtime({ inspectControllers: async () => [controller()] })
    const result = await executeLeppyLoopCommand(context(), invocation(owner, 'continuar'), rt)
    expect(result).toMatchObject({ kind: 'success', text: expect.stringContaining('44c85fb806c6') })
    const prompt = JSON.stringify(messages[0])
    expect(prompt).toContain('leppy_loop_control')
    expect(prompt).toContain('first tool call must be operation=status with its exact runId')
    expect(prompt).toContain('currentTask: 11')
    expect(prompt).toContain('attempt: 15')
    expect(prompt).toContain('examples/feature.task.md')
  })

  it('surfaces pending committed verification in lifecycle prompt and human status', async () => {
    const pending = pendingValidation()
    const durable = controller({ pendingTaskValidation: pending, autoRecoveryBlocked: true })
    const messages: unknown[] = []
    const owner = agent('pending-verification-owner', message => { messages.push(message) })
    const rt = runtime({ inspectControllers: async () => [durable] })

    await expect(executeLeppyLoopCommand(context(), invocation(owner, 'continuar'), rt)).resolves.toMatchObject({ kind: 'success' })
    const prompt = JSON.stringify(messages[0])
    expect(prompt).toContain(pending.commitHead)
    expect(prompt).toContain('pending')
    expect(prompt).toContain('verifier attempts 2')

    const status = await executeLeppyLoopCommand(context(), invocation(agent('pending-status-owner'), 'status'), runtime({
      inspectControllers: async () => [durable],
    }))
    expect(status).toMatchObject({ kind: 'success' })
    expect(status.text).toContain(pending.commitHead)
    expect(status.text).toMatch(/pending|validation/iu)
  })

  it('pending-state visibility does not bypass a truly unchanged open recovery circuit', async () => {
    const owner = agent('unchanged-circuit-owner')
    const unchanged = controller({
      autoRecoveryBlocked: true,
      detail: 'unchanged worker failure',
      updatedAt: new Date(Date.now() - 1_000).toISOString(),
      lifecycleAuthority: {
        sessionId: 'unchanged-circuit-owner', allowPublication: false, maxIterations: 64, maxRepairCycles: 3,
        maxTransitions: 16, transitions: 2, issuedAt: Date.now() - 60_000, expiresAt: Date.now() + 60_000,
      },
    })
    const rt = runtime({ inspectControllers: async () => [unchanged] })
    await expect(executeLeppyLoopCommand(context(), invocation(owner, 'status'), rt)).resolves.toMatchObject({ kind: 'success' })
    await expect(executeLeppyLoopControl(context(), rt, owner, {
      operation: 'continue', runId: unchanged.runId, tasks: unchanged.checklistRelative, syncBranch: unchanged.syncBranch,
    })).rejects.toThrow('fresh direct human /leppy-loop authorization is required')
  })

  it('/leppy-loop publicar authorizes the newest completed controller without reopening work', async () => {
    const messages: unknown[] = []
    const owner = agent('publish-completed-agent', message => { messages.push(message) })
    const finished = controller({ status: 'completed', completedTasks: 18, attempt: 33 })
    delete finished.currentTask
    delete finished.openTask
    let observed: LeppyLoopOptions | undefined
    const jobs = new FakeJobs()
    const rt = runtime({
      inspectControllers: async () => [finished],
      run: async options => { observed = options; return { ...completed, runId: finished.runId, completedTasks: 18 } },
    })
    const accepted = await executeLeppyLoopCommand(context(jobs), invocation(owner, 'publicar'), rt)
    expect(accepted).toMatchObject({ kind: 'success', text: expect.stringContaining(finished.runId) })
    expect(JSON.stringify(messages[0])).toContain('may push its owned branch and create or reconcile a pull request')
    await executeLeppyLoopControl(context(jobs), rt, owner, {
      operation: 'continue', recovery: 'resume', publish: true, runId: finished.runId,
      tasks: finished.checklistRelative, syncBranch: finished.syncBranch, fetch: false,
    })
    expect(observed).toMatchObject({ recoverRunId: finished.runId, openPullRequest: true, publicationRepairCycles: 3 })
  })

  it('prioritizes the authenticated interrupted publication over unrelated completed controllers', () => {
    const unrelated = controller({ runId: '8073b13ed018', status: 'completed', completedTasks: 2, updatedAt: '2026-08-28T00:00:00.000Z' })
    delete unrelated.currentTask
    delete unrelated.openTask
    const intended = controller({ status: 'stalled', completedTasks: 18, attempt: 33, publicationRebase: true, updatedAt: '2026-08-27T17:57:57.286Z' })
    delete intended.currentTask
    delete intended.openTask
    expect(selectControllerForPublication([unrelated, intended])?.runId).toBe('44c85fb806c6')
  })

  it('status selects the newest controller instead of an older run merely because it has open work', async () => {
    const oldOpen = controller({ runId: '606090827cf1', updatedAt: '2026-08-27T08:51:47.101Z' })
    const publicationStall = controller({ status: 'stalled', completedTasks: 18, attempt: 34, updatedAt: '2026-08-27T19:40:58.876Z', detail: 'publication conflict repair failed' })
    delete publicationStall.currentTask
    delete publicationStall.openTask
    expect(selectControllerForStatus([oldOpen, publicationStall])?.runId).toBe('44c85fb806c6')
    expect(selectControllerForStatus([publicationStall, oldOpen])?.runId).toBe('44c85fb806c6')

    const result = await executeLeppyLoopCommand(
      context(), invocation(agent('status-agent'), ' status'), runtime({ inspectControllers: async () => [oldOpen, publicationStall] }),
    )
    expect(result).toMatchObject({ kind: 'success', text: expect.stringContaining('run=44c85fb806c6') })
    expect(result.text).toContain('detail=publication conflict repair failed')
    expect(result.text).not.toContain('undefined')
  })

  it('/leppy-loop publicar can retry an authenticated publication-only stall', async () => {
    const messages: unknown[] = []
    const owner = agent('publish-stalled-agent', message => { messages.push(message) })
    const stalled = controller({ status: 'stalled', completedTasks: 18, attempt: 33 })
    delete stalled.currentTask
    delete stalled.openTask
    const accepted = await executeLeppyLoopCommand(
      context(), invocation(owner, 'publicar'), runtime({ inspectControllers: async () => [stalled] }),
    )
    expect(accepted).toMatchObject({ kind: 'success', text: expect.stringContaining(stalled.runId) })
    expect(JSON.stringify(messages[0])).toContain('status: stalled')
  })

  it('rejects the old technical flag UX instead of awaiting a foreground loop', async () => {
    const result = await executeLeppyLoopCommand(context(), invocation(agent(), '--tasks huge/path --sync-branch origin/main'), runtime())
    expect(result).toMatchObject({ kind: 'error', text: expect.stringContaining('technical flags are private') })
  })

  it('accepts natural language while keeping explicit publication negation immutable', async () => {
    for (const text of ['nao publicar', 'não publique', 'não quero publicar', 'nunca publique', 'do not publish', "don't publish", 'never publish', 'please avoid publishing', 'continuar sem publicar']) {
      const followup = vi.fn()
      const owner = agent(`negated-${text}`, followup)
      const rt = runtime()
      const result = await executeLeppyLoopCommand(context(), invocation(owner, text), rt)
      expect(result).toMatchObject({ kind: 'success', text: expect.stringContaining('lifecycle authorized') })
      expect(rt.grants.permits(owner, cwd)[0]?.allowPublication, text).toBe(false)
      expect(followup).toHaveBeenCalledOnce()
    }
  }, 30_000)

  it('persists a direct-human publication downgrade before acknowledging or enqueueing followup', async () => {
    const order: string[] = []
    const owner = agent('downgrade-owner', () => { order.push('followup') })
    const durable = controller({
      lifecycleAuthority: {
        sessionId: 'downgrade-owner', allowPublication: true, maxIterations: 64, maxRepairCycles: 3,
        maxTransitions: 16, transitions: 2, issuedAt: Date.now() - 1_000, expiresAt: Date.now() + 60_000,
      },
    })
    let persisted: LifecycleAuthority | undefined
    const rt = runtime({
      inspectControllers: async () => [durable],
      persistAuthority: async (_repo, _runId, authority) => { persisted = authority; order.push('persist') },
    })
    await expect(executeLeppyLoopCommand(context(), invocation(owner, 'continuar localmente, nao publicar'), rt)).resolves.toMatchObject({ kind: 'success' })
    expect(order).toEqual(['persist', 'followup'])
    expect(persisted).toMatchObject({ allowPublication: false, transitions: 2 })
    expect(persisted!.issuedAt).toBeGreaterThan(durable.lifecycleAuthority!.issuedAt)
    expect(persisted!.expiresAt).toBeGreaterThan(durable.lifecycleAuthority!.expiresAt)
  })

  it('opens and persists a fresh budget epoch when a direct human reauthorizes the exact exhausted run', async () => {
    const order: string[] = []
    const owner = agent('exhausted-owner', () => { order.push('followup') })
    const exhausted = controller({
      lifecycleAuthority: {
        sessionId: 'exhausted-owner', allowPublication: false, maxIterations: 64, maxRepairCycles: 3,
        maxTransitions: 16, transitions: 16, issuedAt: Date.now() - 60_000, expiresAt: Date.now() + 60_000,
      },
    })
    const persisted: LifecycleAuthority[] = []
    let observed: LeppyLoopOptions | undefined
    const jobs = new FakeJobs()
    const rt = runtime({
      inspectControllers: async () => [exhausted],
      persistAuthority: async (_repo, _runId, authority) => { persisted.push({ ...authority }); order.push('persist') },
      run: async options => { observed = options; return { ...completed, runId: exhausted.runId } },
    })
    const ctx = context(jobs)
    await expect(executeLeppyLoopCommand(ctx, invocation(owner, 'continuar'), rt)).resolves.toMatchObject({ kind: 'success' })
    expect(order).toEqual(['persist', 'followup'])
    expect(persisted[0]).toMatchObject({ epoch: 2, transitions: 0, maxTransitions: 16, sessionId: 'exhausted-owner' })
    await expect(executeLeppyLoopControl(ctx, rt, owner, {
      operation: 'continue', runId: exhausted.runId, tasks: exhausted.checklistRelative, syncBranch: exhausted.syncBranch,
    })).resolves.toMatchObject({ status: 'running', runId: exhausted.runId })
    expect(persisted[1]).toMatchObject({ epoch: 2, transitions: 1 })
    await jobs.starts[0]!.hooks.done
    expect(observed?.lifecycleAuthority).toMatchObject({ epoch: 2, transitions: 1 })
  })

  it('renews an exhausted orphaned durable-running controller only after its lock and lease have settled', async () => {
    const owner = agent('orphaned-budget-owner')
    const orphaned = controller({
      status: 'running',
      lifecycleAuthority: {
        sessionId: 'orphaned-budget-owner', allowPublication: false, maxIterations: 64, maxRepairCycles: 3,
        maxTransitions: 16, transitions: 16, issuedAt: Date.now() - 60_000, expiresAt: Date.now() + 60_000,
      },
    })
    let persisted: LifecycleAuthority | undefined
    const rt = runtime({
      inspectControllers: async () => [orphaned],
      persistAuthority: async (_repo, _runId, authority) => { persisted = authority },
    })
    await expect(executeLeppyLoopCommand(context(), invocation(owner, 'continuar'), rt)).resolves.toMatchObject({ kind: 'success' })
    expect(persisted).toMatchObject({ epoch: 2, transitions: 0 })
  })

  it('does not roll an exhausted budget while an authenticated repository lock remains live', async () => {
    const owner = agent('live-lock-budget-owner')
    const stalled = controller({
      lifecycleAuthority: {
        sessionId: 'live-lock-budget-owner', allowPublication: false, maxIterations: 64, maxRepairCycles: 3,
        maxTransitions: 16, transitions: 16, issuedAt: Date.now() - 60_000, expiresAt: Date.now() + 60_000,
      },
    })
    let persisted = false
    const rt = runtime({
      inspectControllers: async () => [stalled],
      persistAuthority: async () => { persisted = true },
    })
    const release = await acquireLock(await lifecycleCommonDir(cwd), 'other-live-run')
    try {
      await expect(executeLeppyLoopCommand(context(), invocation(owner, 'continuar'), rt)).resolves.toMatchObject({
        kind: 'error', text: expect.stringContaining('repository lock'),
      })
      expect(persisted).toBe(false)
    } finally { release() }
  })

  it('rolls back a prepared renewal when durable persistence fails and permits a clean retry', async () => {
    const followup = vi.fn()
    const owner = agent('persist-retry-owner', followup)
    const durable = controller({
      lifecycleAuthority: {
        sessionId: 'persist-retry-owner', allowPublication: false, maxIterations: 64, maxRepairCycles: 3,
        maxTransitions: 16, transitions: 15, issuedAt: Date.now() - 60_000, expiresAt: Date.now() + 60_000,
      },
    })
    let writes = 0
    const rt = runtime({
      inspectControllers: async () => [durable],
      persistAuthority: async () => { writes += 1; if (writes === 1) throw new Error('disk full') },
    })
    await expect(executeLeppyLoopCommand(context(), invocation(owner, 'continuar'), rt)).resolves.toMatchObject({
      kind: 'error', text: expect.stringContaining('disk full'),
    })
    expect(rt.grants.permits(owner, cwd)).toHaveLength(0)
    await expect(executeLeppyLoopCommand(context(), invocation(owner, 'continuar'), rt)).resolves.toMatchObject({ kind: 'success' })
    expect(writes).toBe(2)
    expect(followup).toHaveBeenCalledOnce()
    expect(rt.grants.permits(owner, cwd)[0]).toMatchObject({ epoch: 1, transitions: 15 })
  })

  it('serializes concurrent direct-human renewals for one exact run', async () => {
    const followup = vi.fn()
    const owner = agent('concurrent-renew-owner', followup)
    const durable = controller({
      lifecycleAuthority: {
        sessionId: 'concurrent-renew-owner', allowPublication: false, maxIterations: 64, maxRepairCycles: 3,
        maxTransitions: 16, transitions: 15, issuedAt: Date.now() - 60_000, expiresAt: Date.now() + 60_000,
      },
    })
    let releasePersist!: () => void
    const persistence = new Promise<void>(resolve => { releasePersist = resolve })
    let writes = 0
    const rt = runtime({
      inspectControllers: async () => [durable],
      persistAuthority: async () => { writes += 1; await persistence },
    })
    const first = executeLeppyLoopCommand(context(), invocation(owner, 'continuar'), rt)
    await vi.waitFor(() => { expect(writes).toBe(1) })
    await expect(executeLeppyLoopCommand(context(), invocation(owner, 'continuar'), rt)).resolves.toMatchObject({
      kind: 'error', text: expect.stringContaining('already in progress'),
    })
    releasePersist()
    await expect(first).resolves.toMatchObject({ kind: 'success' })
    expect(writes).toBe(1)
    expect(followup).toHaveBeenCalledOnce()
  })

  it('renews and durably persists an expired permit from one fresh direct-human continue command', async () => {
    const order: string[] = []
    const owner = agent('expired-owner', () => { order.push('followup') })
    const expired = controller({
      lifecycleAuthority: {
        sessionId: 'expired-owner', allowPublication: false, maxIterations: 64, maxRepairCycles: 3,
        maxTransitions: 16, transitions: 7, issuedAt: Date.now() - 172_800_000, expiresAt: Date.now() - 86_400_000,
      },
    })
    let persisted: LifecycleAuthority | undefined
    const rt = runtime({
      inspectControllers: async () => [expired],
      persistAuthority: async (_repo, _runId, authority) => { persisted = authority; order.push('persist') },
    })
    await expect(executeLeppyLoopCommand(context(), invocation(owner, 'continuar'), rt)).resolves.toMatchObject({
      kind: 'success', text: expect.stringContaining(expired.runId),
    })
    expect(order).toEqual(['persist', 'followup'])
    expect(persisted).toMatchObject({ sessionId: 'expired-owner', allowPublication: false, transitions: 7 })
    expect(persisted!.issuedAt).toBeGreaterThan(expired.lifecycleAuthority!.expiresAt)
    expect(persisted!.expiresAt).toBeGreaterThan(Date.now())
    expect(rt.grants.permits(owner, cwd)).toHaveLength(1)
  })
})

describe('grant-validated background controller tool', () => {
  it('runs read-only checklist preflight without consuming a lifecycle permit or creating a job', async () => {
    const owner = agent('preflight-agent')
    let observed: LeppyLoopOptions | undefined
    const jobs = new FakeJobs()
    const value = await executeLeppyLoopControl(context(jobs), runtime({
      run: async options => {
        observed = options
        return {
          runId: 'preview-run', status: 'dry-run', completedTasks: 0,
          diagnostics: [{ severity: 'error', code: 'unsupported-path-syntax', message: 'extension-only fragments are not paths', line: 4 }],
        }
      },
    }), owner, { operation: 'preflight', tasks: 'examples/feature.task.md', syncBranch: 'origin/plugins' })
    expect(value).toMatchObject({ operation: 'preflight', status: 'invalid', detail: expect.stringContaining('unsupported-path-syntax') })
    expect(observed).toMatchObject({ dryRun: true, repoRoot: cwd })
    expect(jobs.starts).toHaveLength(0)
  })

  it('reports a durable running controller as orphaned when no owned Host job exists', async () => {
    const owner = agent('session-a')
    const value = await executeLeppyLoopControl(context(), runtime({
      inspectControllers: async () => [controller({
        status: 'running',
        lifecycleAuthority: {
          sessionId: 'session-a', allowPublication: false, maxIterations: 64, maxRepairCycles: 3,
          maxTransitions: 16, transitions: 1, issuedAt: Date.now() - 1_000, expiresAt: Date.now() + 60_000,
        },
      })],
    }), owner, { operation: 'status', runId: '44c85fb806c6' })
    expect(value).toMatchObject({ status: 'orphaned', runId: '44c85fb806c6', detail: expect.stringContaining('no session-owned Host job') })
    expect(value).not.toHaveProperty('jobId')
  })

  it('does not expose another session durable controller through global status', async () => {
    const owner = agent('session-a')
    const foreign = controller({
      runId: 'foreign-run', detail: 'private failure detail', autoRecoveryBlocked: true,
      lifecycleAuthority: {
        sessionId: 'session-b', allowPublication: true, maxIterations: 64, maxRepairCycles: 3,
        maxTransitions: 16, transitions: 4, issuedAt: Date.now() - 1_000, expiresAt: Date.now() + 60_000,
      },
    })
    const rt = runtime({ inspectControllers: async () => [foreign] })
    await expect(executeLeppyLoopControl(context(), rt, owner, { operation: 'status' })).resolves.toEqual({ operation: 'status', status: 'not-found' })
    await expect(executeLeppyLoopControl(context(), rt, owner, { operation: 'status', runId: foreign.runId })).resolves.toEqual({ operation: 'status', status: 'not-found' })
    await expect(executeLeppyLoopControl(context(), rt, owner, {
      operation: 'continue', runId: foreign.runId, tasks: foreign.checklistRelative, syncBranch: foreign.syncBranch,
    })).rejects.toThrow('belongs to another session')
  })

  it('hydrates the same session-bound lifecycle permit and continues after a Host restart', async () => {
    const owner = agent('session-a')
    const durable = controller({
      lifecycleAuthority: {
        sessionId: 'session-a', allowPublication: true, maxIterations: 64, maxRepairCycles: 3,
        maxTransitions: 16, transitions: 1, issuedAt: Date.now() - 1_000, expiresAt: Date.now() + 60_000,
      },
    })
    let observed: LeppyLoopOptions | undefined
    const jobs = new FakeJobs()
    const rt = runtime({
      inspectControllers: async () => [durable],
      run: async options => { observed = options; return { ...completed, runId: durable.runId } },
    })
    const value = await executeLeppyLoopControl(context(jobs), rt, owner, {
      operation: 'continue', runId: durable.runId, tasks: durable.checklistRelative, syncBranch: durable.syncBranch,
    })
    expect(value).toMatchObject({ status: 'running', runId: durable.runId, jobId: 'leppy-loop-1' })
    expect(observed?.lifecycleAuthority).toMatchObject({ sessionId: 'session-a', transitions: 2, allowPublication: true })
    await expect(jobs.starts[0]!.hooks.done).resolves.toMatchObject({ status: 'completed' })
  })

  it('starts a jobs-owned controller immediately without awaiting its promise', async () => {
    const owner = agent('background-agent')
    const jobs = new FakeJobs()
    let settle!: (result: RunResult) => void
    const run = new Promise<RunResult>(resolveRun => { settle = resolveRun })
    const order: string[] = []
    const rt = runtime({
      persistAuthority: async (_repo, _runId, authority) => { order.push(`persist-${authority.transitions}`) },
      run: async () => { order.push('run'); return await run },
    })
    issueGrant(rt, owner)

    const value = await executeLeppyLoopControl(context(jobs), rt, owner, {
      operation: 'start', tasks: 'examples/feature.task.md', syncBranch: 'origin/main', fetch: false,
    })
    expect(value).toMatchObject({ status: 'running', jobId: 'leppy-loop-1' })
    expect(jobs.starts).toHaveLength(1)
    expect(order).toEqual(['persist-1', 'run'])
    settle({ ...completed, runId: value.runId! })
    await expect(jobs.starts[0]!.hooks.done).resolves.toMatchObject({ status: 'completed' })
  })

  it('reuses one lifecycle permit across settled controller transitions without another slash command', async () => {
    const followup = vi.fn()
    const owner = agent('lifecycle-agent', followup)
    const jobs = new FakeJobs()
    let calls = 0
    const rt = runtime({
      inspectControllers: async () => [controller()],
      run: async () => ++calls === 1
        ? { runId: '44c85fb806c6', status: 'stalled', completedTasks: 5, currentTask: 11, diagnostics: [], detail: 'recoverable worker stall' }
        : { runId: '44c85fb806c6', status: 'completed', completedTasks: 18, diagnostics: [] },
    })
    issueGrant(rt, owner, { runId: '44c85fb806c6', allowPublication: true })
    await executeLeppyLoopControl(context(jobs), rt, owner, {
      operation: 'continue', runId: '44c85fb806c6', tasks: 'examples/feature.task.md', syncBranch: 'origin/plugins', fetch: false,
    })
    await jobs.starts[0]!.hooks.done
    await vi.waitFor(() => { expect(rt.grants.permits(owner, cwd)[0]?.inFlight).toBe(false) })
    await executeLeppyLoopControl(context(jobs), rt, owner, {
      operation: 'continue', publish: true, runId: '44c85fb806c6', tasks: 'examples/feature.task.md', syncBranch: 'origin/plugins', fetch: false,
    })
    expect(jobs.starts).toHaveLength(2)
    expect(rt.grants.permits(owner, cwd)[0]?.transitions).toBe(2)
    expect(followup).toHaveBeenCalled()
  })

  it('keeps read-only status available while the durable recovery circuit is open', async () => {
    const owner = agent('blocked-status-agent')
    const blocked = controller({
      autoRecoveryBlocked: true, detail: 'scope missing',
      lifecycleAuthority: {
        sessionId: 'blocked-status-agent', allowPublication: false, maxIterations: 64, maxRepairCycles: 3,
        maxTransitions: 16, transitions: 5, issuedAt: Date.now() - 60_000, expiresAt: Date.now() + 60_000,
      },
    })
    const rt = runtime({ inspectControllers: async () => [blocked] })

    await expect(executeLeppyLoopControl(context(), rt, owner, {
      operation: 'status', runId: blocked.runId,
    })).resolves.toMatchObject({ operation: 'status', status: 'stalled', runId: blocked.runId, detail: 'scope missing' })
    expect(rt.grants.permits(owner, cwd)).toHaveLength(0)
  })

  it('does not auto-loop a controller whose durable failure circuit is open', async () => {
    const followup = vi.fn()
    const owner = agent('blocked-loop-agent', followup)
    const jobs = new FakeJobs()
    const rt = runtime({
      inspectControllers: async () => [controller({ autoRecoveryBlocked: true, detail: 'scope missing', updatedAt: new Date(Date.now() - 1_000).toISOString() })],
      run: async () => ({ runId: '44c85fb806c6', status: 'stalled', completedTasks: 5, diagnostics: [], detail: 'scope missing' }),
    })
    issueGrant(rt, owner, { runId: '44c85fb806c6' })
    await executeLeppyLoopControl(context(jobs), rt, owner, {
      operation: 'continue', runId: '44c85fb806c6', tasks: 'examples/feature.task.md', syncBranch: 'origin/plugins', fetch: false,
    })
    await jobs.starts[0]!.hooks.done
    await vi.waitFor(() => { expect(rt.grants.permits(owner, cwd)[0]?.inFlight).toBe(false) })
    expect(followup).not.toHaveBeenCalled()
  })

  it('rejects old model authority at an open circuit and accepts fresh direct-human reauthorization without resetting its budget', async () => {
    const owner = agent('circuit-owner')
    const updatedAt = new Date(Date.now() - 1_000).toISOString()
    const stalled = controller({
      autoRecoveryBlocked: true, updatedAt,
      lifecycleAuthority: {
        sessionId: 'circuit-owner', allowPublication: false, maxIterations: 64, maxRepairCycles: 3,
        maxTransitions: 16, transitions: 2, issuedAt: Date.now() - 60_000, expiresAt: Date.now() + 60_000,
      },
    })
    const jobs = new FakeJobs()
    let persisted: LifecycleAuthority | undefined
    const rt = runtime({
      inspectControllers: async () => [stalled],
      persistAuthority: async (_repo, _runId, authority) => { persisted = authority },
      run: async () => ({ ...completed, runId: stalled.runId }),
    })
    await expect(executeLeppyLoopControl(context(jobs), rt, owner, {
      operation: 'continue', runId: stalled.runId, tasks: stalled.checklistRelative, syncBranch: stalled.syncBranch,
    })).rejects.toThrow('fresh direct human /leppy-loop authorization is required')
    expect(rt.grants.permits(owner, cwd)).toHaveLength(0)

    await expect(executeLeppyLoopCommand(context(jobs), invocation(owner, 'continuar'), rt)).resolves.toMatchObject({ kind: 'success' })
    const resumed = await executeLeppyLoopControl(context(jobs), rt, owner, {
      operation: 'continue', runId: stalled.runId, tasks: stalled.checklistRelative, syncBranch: stalled.syncBranch,
    })
    expect(resumed).toMatchObject({ status: 'running', runId: stalled.runId })
    expect(persisted).toMatchObject({ transitions: 3, allowPublication: false })
    expect(persisted!.issuedAt).toBeGreaterThan(stalled.lifecycleAuthority!.issuedAt)
    expect(persisted!.expiresAt).toBeGreaterThan(stalled.lifecycleAuthority!.expiresAt)
  })

  it('hydrates a freshly persisted zero-consumption epoch before evaluating an open recovery circuit', async () => {
    const owner = agent('epoch-restart-owner')
    const updatedAt = Date.now() - 10_000
    const stalled = controller({
      autoRecoveryBlocked: true, detail: 'unchanged ordinary failure', updatedAt: new Date(updatedAt).toISOString(),
      lifecycleAuthority: {
        epoch: 2, sessionId: 'epoch-restart-owner', allowPublication: false, maxIterations: 64, maxRepairCycles: 3,
        maxTransitions: 16, transitions: 0, issuedAt: updatedAt + 1_000, expiresAt: updatedAt + 86_401_000,
      },
    })
    const jobs = new FakeJobs()
    let persisted: LifecycleAuthority | undefined
    const rt = runtime({
      inspectControllers: async () => [stalled],
      persistAuthority: async (_repo, _runId, authority) => { persisted = authority },
      run: async options => ({ ...completed, runId: options.recoverRunId! }),
    })
    await expect(executeLeppyLoopControl(context(jobs), rt, owner, {
      operation: 'continue', runId: stalled.runId, tasks: stalled.checklistRelative, syncBranch: stalled.syncBranch,
    })).resolves.toMatchObject({ status: 'running', runId: stalled.runId })
    expect(persisted).toMatchObject({ epoch: 2, transitions: 1 })
    await jobs.starts[0]!.hooks.done
  })

  it('does not treat a stale zero-consumption epoch as fresh circuit authority after restart', async () => {
    const owner = agent('stale-epoch-owner')
    const updatedAt = Date.now() - 10_000
    const stalled = controller({
      autoRecoveryBlocked: true, detail: 'unchanged ordinary failure', updatedAt: new Date(updatedAt).toISOString(),
      lifecycleAuthority: {
        epoch: 2, sessionId: 'stale-epoch-owner', allowPublication: false, maxIterations: 64, maxRepairCycles: 3,
        maxTransitions: 16, transitions: 0, issuedAt: updatedAt - 1_000, expiresAt: updatedAt + 86_399_000,
      },
    })
    const rt = runtime({ inspectControllers: async () => [stalled] })
    await expect(executeLeppyLoopControl(context(), rt, owner, {
      operation: 'continue', runId: stalled.runId, tasks: stalled.checklistRelative, syncBranch: stalled.syncBranch,
    })).rejects.toThrow('fresh direct human')
  })

  it('reuses persisted authority when an exact-lock dependency bridge changes an ENOTCACHED condition', async () => {
    const fixture = dependencyRecoveryRepository()
    const owner = agent('dependency-owner', () => {}, () => {}, fixture.root)
    const stalled = controller({
      repoRoot: fixture.root,
      worktree: fixture.worktree,
      checklistRelative: 'tasks.task.md',
      syncBranch: 'main',
      autoRecoveryBlocked: true,
      detail: 'npm error code ENOTCACHED; cache mode is only-if-cached',
      lifecycleAuthority: {
        sessionId: 'dependency-owner', allowPublication: false, maxIterations: 64, maxRepairCycles: 3,
        maxTransitions: 16, transitions: 2, issuedAt: Date.now() - 60_000, expiresAt: Date.now() + 60_000,
      },
    })
    const jobs = new FakeJobs()
    let received: LeppyLoopOptions | undefined
    const rt = runtime({
      inspectControllers: async () => [stalled],
      run: async options => { received = options; return { ...completed, runId: stalled.runId } },
    })

    const resumed = await executeLeppyLoopControl(context(jobs), rt, owner, {
      operation: 'continue', runId: stalled.runId, tasks: stalled.checklistRelative, syncBranch: stalled.syncBranch,
    })
    expect(resumed).toMatchObject({ status: 'running', runId: stalled.runId })
    expect(jobs.starts).toHaveLength(1)
    await jobs.starts[0]!.hooks.done
    expect(received?.dependencyHydrationRequired).toBe(true)
    expect(received?.dependencyRecoveryDigest).toMatch(/^[0-9a-f]{64}$/u)
    expect(rt.grants.permits(owner, fixture.root)[0]).toMatchObject({ transitions: 3 })
  })

  it('reuses persisted authority when a disappeared tree has integrity-covered bundled packages', async () => {
    const fixture = dependencyRecoveryRepository()
    rmSync(join(fixture.root, 'node_modules'), { recursive: true, force: true })
    const lock = JSON.parse(readFileSync(join(fixture.worktree, 'package-lock.json'), 'utf8')) as { packages: Record<string, unknown> }
    lock.packages['node_modules/bundled-parent'] = {
      version: '1.0.0', resolved: 'https://registry.npmjs.org/bundled-parent/-/bundled-parent-1.0.0.tgz',
      integrity: 'sha512-YWJjZA==', bundleDependencies: ['bundled-child'],
    }
    lock.packages['node_modules/bundled-parent/node_modules/bundled-child'] = { version: '2.0.0', inBundle: true }
    writeFileSync(join(fixture.worktree, 'package-lock.json'), `${JSON.stringify(lock)}\n`)
    const owner = agent('module-miss-owner', () => {}, () => {}, fixture.root)
    const stalled = controller({
      repoRoot: fixture.root, worktree: fixture.worktree, checklistRelative: 'tasks.task.md', syncBranch: 'main',
      autoRecoveryBlocked: true,
      detail: "worker dependency unavailable after one tool failure; code: MODULE_NOT_FOUND; Cannot find module 'worktree/node_modules/typescript/bin/tsc'",
      lifecycleAuthority: {
        sessionId: 'module-miss-owner', allowPublication: false, maxIterations: 64, maxRepairCycles: 3,
        maxTransitions: 16, transitions: 4, issuedAt: Date.now() - 60_000, expiresAt: Date.now() + 60_000,
      },
    })
    const jobs = new FakeJobs()
    let received: LeppyLoopOptions | undefined
    const rt = runtime({
      inspectControllers: async () => [stalled],
      run: async options => { received = options; return { ...completed, runId: stalled.runId } },
    })
    await expect(executeLeppyLoopControl(context(jobs), rt, owner, {
      operation: 'continue', runId: stalled.runId, tasks: stalled.checklistRelative, syncBranch: stalled.syncBranch,
    })).resolves.toMatchObject({ status: 'running' })
    await jobs.starts[0]!.hooks.done
    expect(received?.dependencyHydrationRequired).toBe(true)
    expect(received?.dependencyRecoveryDigest).toMatch(/^[0-9a-f]{64}$/u)
  })

  it('forwards the authenticated dependency digest even when the unlocked hydration probe is unavailable', async () => {
    const owner = agent('unlocked-probe-owner')
    const stalled = controller({
      autoRecoveryBlocked: true,
      detail: "pre-worker setup failed: an authenticated dependency recovery digest and a newly published tree are required before another worker; prior dependency error: worker dependency unavailable after one tool failure; code: MODULE_NOT_FOUND; Cannot find module 'worktree/node_modules/typescript/bin/tsc'",
      lifecycleAuthority: {
        sessionId: 'unlocked-probe-owner', allowPublication: false, maxIterations: 64, maxRepairCycles: 3,
        maxTransitions: 16, transitions: 5, issuedAt: Date.now() - 60_000, expiresAt: Date.now() + 60_000,
      },
    })
    const jobs = new FakeJobs()
    let received: LeppyLoopOptions | undefined
    const rt = runtime({
      inspectControllers: async () => [stalled],
      run: async options => { received = options; return { ...completed, runId: stalled.runId } },
    })

    await expect(executeLeppyLoopControl(context(jobs), rt, owner, {
      operation: 'continue', runId: stalled.runId, tasks: stalled.checklistRelative, syncBranch: stalled.syncBranch,
    })).resolves.toMatchObject({ status: 'running', runId: stalled.runId })
    await jobs.starts[0]!.hooks.done
    expect(received?.dependencyHydrationRequired).toBeUndefined()
    expect(received?.dependencyRecoveryDigest).toMatch(/^[0-9a-f]{64}$/u)
    expect(rt.grants.permits(owner, cwd)[0]).toMatchObject({ transitions: 6 })
  })

  it('reuses persisted authority once for the authenticated Windows quoted-executable failure', async () => {
    const owner = agent('windows-argv-owner')
    const stalled = controller({
      autoRecoveryBlocked: true,
      detail: "worker tool failure budget exhausted after 8 failures; last=leppy_exec: 'node_modules' não é reconhecido como um comando interno ou externo",
      lifecycleAuthority: {
        sessionId: 'windows-argv-owner', allowPublication: false, maxIterations: 64, maxRepairCycles: 3,
        maxTransitions: 16, transitions: 2, issuedAt: Date.now() - 60_000, expiresAt: Date.now() + 60_000,
      },
    })
    const jobs = new FakeJobs()
    let received: LeppyLoopOptions | undefined
    const rt = runtime({
      inspectControllers: async () => [stalled],
      run: async options => { received = options; return { ...completed, runId: stalled.runId } },
    })

    await expect(executeLeppyLoopControl(context(jobs), rt, owner, {
      operation: 'continue', runId: stalled.runId, tasks: stalled.checklistRelative, syncBranch: stalled.syncBranch,
    })).resolves.toMatchObject({ status: 'running', runId: stalled.runId })
    await jobs.starts[0]!.hooks.done
    expect(received?.windowsArgvRecoveryDigest).toMatch(/^[0-9a-f]{64}$/u)
    expect(rt.grants.permits(owner, cwd)[0]).toMatchObject({ transitions: 3 })
  })

  it('binds legacy npm cache quarantine to the exact authenticated controller error', async () => {
    const owner = agent('npm-cache-owner')
    const stalled = controller({
      autoRecoveryBlocked: true,
      detail: 'npx is unavailable and leppy_commit rejected .npm-cache/_logs/attempt.log outside this task write scope',
      lifecycleAuthority: {
        sessionId: 'npm-cache-owner', allowPublication: false, maxIterations: 64, maxRepairCycles: 3,
        maxTransitions: 16, transitions: 4, issuedAt: Date.now() - 60_000, expiresAt: Date.now() + 60_000,
      },
    })
    const jobs = new FakeJobs()
    let received: LeppyLoopOptions | undefined
    const rt = runtime({
      inspectControllers: async () => [stalled],
      run: async options => { received = options; return { ...completed, runId: stalled.runId } },
    })

    await expect(executeLeppyLoopControl(context(jobs), rt, owner, {
      operation: 'continue', runId: stalled.runId, tasks: stalled.checklistRelative, syncBranch: stalled.syncBranch,
    })).resolves.toMatchObject({ status: 'running', runId: stalled.runId })
    await jobs.starts[0]!.hooks.done
    expect(received?.workerArtifactRecoveryDigest).toMatch(/^[0-9a-f]{64}$/u)
    expect(rt.grants.permits(owner, cwd)[0]).toMatchObject({ transitions: 5 })
  })

  it.each([
    ['missing manifest', 'worker ignored artifact recovery lacks its authenticated pre-attempt baseline'],
    ['three-addition search', 'worker ignored artifact recovery cannot prove its legacy non-empty baseline from current fingerprints'],
    ['whitespace-normalized three-addition search', '\r\n worker ignored artifact recovery cannot prove its legacy non-empty baseline from current fingerprints\t'],
    ['ignored-only four-addition search', 'worker ignored artifact recovery cannot prove its legacy non-empty baseline from current fingerprints within 4 additions and 3 candidates'],
  ] as const)('status then reuses persisted authority once when the installed controller supersedes %s recovery', async (_label, detail) => {
    const owner = agent('ignored-baseline-owner')
    const updatedAt = Date.now() - 30_000
    const stalled = controller({
      autoRecoveryBlocked: true, detail, updatedAt: new Date(updatedAt).toISOString(), activeTaskAttempt: activeAttempt(),
      lifecycleAuthority: {
        sessionId: 'ignored-baseline-owner', allowPublication: false, maxIterations: 64, maxRepairCycles: 3,
        maxTransitions: 16, transitions: 5, issuedAt: updatedAt - 30_000, expiresAt: Date.now() + 60_000,
      },
    })
    const jobs = new FakeJobs()
    const rt = runtime({
      inspectControllers: async () => [stalled],
      run: async () => ({ ...completed, runId: stalled.runId }),
    })

    await expect(executeLeppyLoopControl(context(jobs), rt, owner, {
      operation: 'status', runId: stalled.runId,
    })).resolves.toMatchObject({ status: 'stalled', runId: stalled.runId, detail })
    expect(rt.grants.permits(owner, cwd)).toHaveLength(0)
    await expect(executeLeppyLoopControl(context(jobs), rt, owner, {
      operation: 'continue', runId: stalled.runId, tasks: stalled.checklistRelative, syncBranch: stalled.syncBranch,
    })).resolves.toMatchObject({ status: 'running', runId: stalled.runId })
    await jobs.starts[0]!.hooks.done
    expect(rt.grants.permits(owner, cwd)[0]).toMatchObject({ transitions: 6 })
  })

  it('fails closed when the legacy detail has no active attempt or is a current near-match', async () => {
    const owner = agent('ignored-baseline-negative-owner')
    const updatedAt = Date.now() - 30_000
    const authority: LifecycleAuthority = {
      sessionId: 'ignored-baseline-negative-owner', allowPublication: false, maxIterations: 64, maxRepairCycles: 3,
      maxTransitions: 16, transitions: 5, issuedAt: updatedAt - 30_000, expiresAt: Date.now() + 60_000,
    }
    const exact = 'worker ignored artifact recovery cannot prove its legacy non-empty baseline from current fingerprints'
    const missingAttempt = controller({
      autoRecoveryBlocked: true, detail: exact, updatedAt: new Date(updatedAt).toISOString(), lifecycleAuthority: authority,
    })
    await expect(executeLeppyLoopControl(context(), runtime({ inspectControllers: async () => [missingAttempt] }), owner, {
      operation: 'continue', runId: missingAttempt.runId, tasks: missingAttempt.checklistRelative, syncBranch: missingAttempt.syncBranch,
    })).rejects.toThrow('[condition=a8c80a08d394598c; bytes=101; activeAttempt=no]')

    const nearMatch = controller({
      autoRecoveryBlocked: true, detail: `${exact} after exact newly tracked promotion inference within 4 additions and 3 candidates`,
      updatedAt: new Date(updatedAt).toISOString(), activeTaskAttempt: activeAttempt(), lifecycleAuthority: authority,
    })
    await expect(executeLeppyLoopControl(context(), runtime({ inspectControllers: async () => [nearMatch] }), owner, {
      operation: 'continue', runId: nearMatch.runId, tasks: nearMatch.checklistRelative, syncBranch: nearMatch.syncBranch,
    })).rejects.toThrow(/\[condition=[0-9a-f]{16}; bytes=183; activeAttempt=yes\]/u)

    const multibyte = controller({
      autoRecoveryBlocked: true, detail: 'falha ç', updatedAt: new Date(updatedAt).toISOString(),
      activeTaskAttempt: activeAttempt(), lifecycleAuthority: authority,
    })
    await expect(executeLeppyLoopControl(context(), runtime({ inspectControllers: async () => [multibyte] }), owner, {
      operation: 'continue', runId: multibyte.runId, tasks: multibyte.checklistRelative, syncBranch: multibyte.syncBranch,
    })).rejects.toThrow(/\[condition=[0-9a-f]{16}; bytes=8; activeAttempt=yes\]/u)
  })

  it('retries transient automatic follow-up handoff failures within the lifecycle', async () => {
    const followup = vi.fn()
    const owner = agent('followup-retry-agent', followup)
    const jobs = new FakeJobs()
    let inspections = 0
    const rt = runtime({
      inspectControllers: async () => {
        inspections += 1
        if (inspections === 2 || inspections === 3) throw new Error('transient inspection failure')
        return [controller()]
      },
      run: async () => ({ runId: '44c85fb806c6', status: 'stalled', completedTasks: 5, diagnostics: [], detail: 'retry me' }),
    })
    issueGrant(rt, owner, { runId: '44c85fb806c6' })
    await executeLeppyLoopControl(context(jobs), rt, owner, {
      operation: 'continue', runId: '44c85fb806c6', tasks: 'examples/feature.task.md', syncBranch: 'origin/plugins', fetch: false,
    })
    await jobs.starts[0]!.hooks.done
    await vi.waitFor(() => { expect(followup).toHaveBeenCalledOnce() }, { timeout: 2_000 })
    expect(inspections).toBe(4)
  })

  it('preserves actionable detail for a resolved publication stall in the Jobs outcome', async () => {
    const owner = agent('job-detail-agent')
    const jobs = new FakeJobs()
    const rt = runtime({ run: async () => ({
      runId: 'detail-run', status: 'stalled', completedTasks: 18, diagnostics: [], detail: 'publication conflict worker changed the Git index',
    }) })
    issueGrant(rt, owner)
    await executeLeppyLoopControl(context(jobs), rt, owner, {
      operation: 'start', tasks: 'examples/feature.task.md', syncBranch: 'origin/main', fetch: false,
    })
    await expect(jobs.starts[0]!.hooks.done).resolves.toMatchObject({
      status: 'failed',
      detail: expect.stringContaining('publication conflict worker changed the Git index'),
      output: expect.stringContaining('detail=publication conflict worker changed the Git index'),
    })
  })

  it('status reports the exact active background run before durable controller state exists', async () => {
    const owner = agent('active-status-agent')
    const jobs = new FakeJobs()
    const rt = runtime({
      run: async () => await new Promise<RunResult>(() => {}),
      inspectControllers: async () => { throw new Error('transient durable inspection failure') },
    })
    issueGrant(rt, owner)
    const started = await executeLeppyLoopControl(context(jobs), rt, owner, {
      operation: 'start', tasks: 'examples/feature.task.md', syncBranch: 'origin/main', fetch: false,
    })
    const value = await executeLeppyLoopControl(context(jobs), rt, owner, { operation: 'status' })
    expect(value).toMatchObject({ status: 'running', jobStatus: 'running', jobId: 'leppy-loop-1', runId: started.runId })
    const explicit = await executeLeppyLoopControl(context(jobs), rt, owner, { operation: 'status', runId: started.runId! })
    expect(explicit).toMatchObject({ status: 'running', jobStatus: 'running', jobId: 'leppy-loop-1', runId: started.runId })
    expect(value.runId).not.toBe('606090827cf1')
  })

  it('rejects a duplicate live controller before repository-lock races', async () => {
    const owner = agent('duplicate-agent')
    const jobs = new FakeJobs()
    const rt = runtime({ run: async () => await new Promise<RunResult>(() => {}) })
    const grant = () => issueGrant(rt, owner)
    grant()
    await executeLeppyLoopControl(context(jobs), rt, owner, { operation: 'start', tasks: 'examples/feature.task.md', syncBranch: 'origin/main', fetch: false })
    grant()
    await expect(executeLeppyLoopControl(context(jobs), rt, owner, {
      operation: 'start', tasks: 'examples/feature.task.md', syncBranch: 'origin/main', fetch: false,
    })).rejects.toThrow('already active')
    expect(jobs.starts).toHaveLength(1)
  })

  it('rejects a second Agent before it can reach recovery lease termination', async () => {
    const first = agent('first-session')
    const second = agent('second-session')
    const jobs = new FakeJobs()
    const rt = runtime({ run: async () => await new Promise<RunResult>(() => {}) })
    issueGrant(rt, first)
    await executeLeppyLoopControl(context(jobs), rt, first, { operation: 'start', tasks: 'examples/feature.task.md', syncBranch: 'origin/main', fetch: false })
    issueGrant(rt, second)
    await expect(executeLeppyLoopControl(context(jobs), rt, second, {
      operation: 'start', tasks: 'examples/feature.task.md', syncBranch: 'origin/main', fetch: false,
    })).rejects.toThrow('already active')
    expect(jobs.starts).toHaveLength(1)
  })

  it('denies retry and repair without matching direct human authority', async () => {
    const owner = agent('no-grant')
    const rt = runtime({ inspectControllers: async () => [controller()] })
    await expect(executeLeppyLoopControl(context(), rt, owner, {
      operation: 'continue', recovery: 'repair-gate', runId: '44c85fb806c6',
      tasks: 'examples/feature.task.md', syncBranch: 'origin/plugins',
    })).rejects.toThrow('no direct human lifecycle permit')
  })

  it('denies technical controller facts that differ from the live authenticated run', async () => {
    const owner = agent('changed-controller')
    const rt = runtime({ inspectControllers: async () => [controller()] })
    issueGrant(rt, owner, { runId: '44c85fb806c6' })
    await expect(executeLeppyLoopControl(context(), rt, owner, {
      operation: 'continue', recovery: 'resume', runId: '44c85fb806c6',
      tasks: 'examples/feature.task.md', syncBranch: 'attacker/base',
    })).rejects.toThrow('tool base does not match')
  })

  it('reaches current run task 11 through exact recovery options without editing the worktree', async () => {
    const owner = agent('recovery-agent')
    let observed: LeppyLoopOptions | undefined
    const rt = runtime({
      inspectControllers: async () => [controller()],
      run: async options => { observed = options; return { ...completed, runId: '44c85fb806c6', status: 'stalled', currentTask: 11 } },
    })
    issueGrant(rt, owner, { runId: '44c85fb806c6' })
    const value = await executeLeppyLoopControl(context(), rt, owner, {
      operation: 'continue', recovery: 'resume', runId: '44c85fb806c6',
      tasks: 'examples/feature.task.md', syncBranch: 'origin/plugins', fetch: false,
    })
    expect(value).toMatchObject({ status: 'running', runId: '44c85fb806c6' })
    expect(observed).toMatchObject({ recoverExistingWip: true, recoverRunId: '44c85fb806c6', retryGate: false, repairGate: false, openPullRequest: false })
  })

  it('derives remote publication only from explicit human intent', async () => {
    const owner = agent('publish-agent')
    const seen: boolean[] = []
    const rt = runtime({ run: async options => { seen.push(Boolean(options.openPullRequest)); return completed } })
    issueGrant(rt, owner)
    await executeLeppyLoopControl(context(), rt, owner, { operation: 'start', tasks: 'examples/feature.task.md', syncBranch: 'origin/main', fetch: false })
    issueGrant(rt, owner, { allowPublication: true })
    await executeLeppyLoopControl(context(), rt, owner, { operation: 'start', publish: true, tasks: 'examples/feature.task.md', syncBranch: 'origin/main', fetch: false })
    expect(seen).toEqual([false, true])
  })

  it('stops the owned background job through a one-shot stop grant', async () => {
    const owner = agent('stop-agent')
    const jobs = new FakeJobs()
    const order: string[] = []
    const originalKill = jobs.kill.bind(jobs)
    jobs.kill = (...args) => { order.push('kill'); return originalKill(...args) }
    const rt = runtime({
      inspectControllers: async () => [controller()],
      persistAuthority: async (_repo, _runId, authority) => { order.push(authority.revokedAt === undefined ? 'admission' : 'revocation') },
      run: async (_options, dependencies) => await new Promise<RunResult>(resolveRun => {
        dependencies.signal!.addEventListener('abort', () => resolveRun({
          runId: '44c85fb806c6', status: 'interrupted', completedTasks: 5, currentTask: 11, diagnostics: [],
        }), { once: true })
      }),
    })
    issueGrant(rt, owner, { runId: '44c85fb806c6' })
    await executeLeppyLoopControl(context(jobs), rt, owner, {
      operation: 'continue', recovery: 'resume', runId: '44c85fb806c6', tasks: 'examples/feature.task.md', syncBranch: 'origin/plugins', fetch: false,
    })
    const stopped = await executeLeppyLoopControl(context(jobs), rt, owner, { operation: 'stop', runId: '44c85fb806c6' })
    expect(stopped.status).toBe('stopping')
    expect(order).toEqual(['admission', 'revocation', 'kill'])
    await expect(jobs.starts[0]!.hooks.done).resolves.toMatchObject({ status: 'killed' })
  })
})
