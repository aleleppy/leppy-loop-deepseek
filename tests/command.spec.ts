import { resolve } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { CommandDefinition, CommandInvocation } from '@deepseek-ai/dsh-commands'
import type { JobHooks, JobId, JobStart } from '@deepseek-ai/dsh-jobs'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import {
  apply, createChatProgressReporter, executeLeppyLoopCommand, executeLeppyLoopControl,
} from '../src/command.js'
import type { AuthenticatedController } from '../src/controller-auth.js'
import { HumanGrantStore } from '../src/human-grant.js'
import { parseLeppyLoopCommandInput, tokenizeLeppyLoopCommandInput } from '../src/options.js'
import type { LeppyLoopRuntime } from '../src/command.js'
import type { LeppyLoopOptions, RunProgress, RunResult } from '../src/types.js'

const cwd = process.cwd()

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

function agent(id = 'session-a', followup: (message: unknown) => void = () => {}, append: (type: string, data: unknown) => void = () => {}): Agent {
  const tools = { register: vi.fn(() => () => {}) }
  return {
    id,
    ctx: { tools },
    session: { header: { cwd }, append },
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
    grants: new HumanGrantStore(), jobs: [], registeredAgents: new WeakSet(), lifetime: new AbortController(), hooks,
  }
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
  it('publishes attempt metadata in one durable start/terminal card pair', () => {
    const events: Array<{ type: string; data: unknown }> = []
    const report = createChatProgressReporter(agent('session', () => {}, (type, data) => { events.push({ type, data }) }))
    const base: RunProgress = {
      type: 'task-start', runId: 'run-1', taskIndex: 2, attempt: 15, kind: 'task', phase: 'Phase 6',
      text: 'A very long task label', completedTasks: 5, totalTasks: 14, elapsedMs: 0,
    }
    report(base)
    report({ ...base, type: 'task-done', completedTasks: 6, elapsedMs: 65_000 })
    expect(events[0]).toMatchObject({ type: 'command/run', data: { args: expect.stringContaining('leppy-attempt=15') } })
    expect(events[1]).toMatchObject({ type: 'command/done', data: { text: 'Task completed — 6/14 — 1m 5s elapsed.' } })
  })
})

describe('simple human slash surface', () => {
  it('registers only the simple command globally and creates the private tool in agent scope', async () => {
    let definition: CommandDefinition | undefined
    let globalTool: ToolDefinition | undefined
    const ctx = {
      commands: { register: (value: CommandDefinition) => { definition = value; return () => {} } },
      tools: { register: (value: ToolDefinition) => { globalTool = value; return () => {} } },
      effect: (setup: () => (() => void)) => setup(),
    } as unknown as Context
    apply(ctx)
    expect(definition?.input).toEqual({ hint: '[continuar|parar|status|continuar e publicar quando tudo passar]' })
    expect(globalTool).toBeUndefined()

    const messages: unknown[] = []
    const owner = agent('scope-agent', message => { messages.push(message) })
    const result = await definition!.handler(invocation(owner, ''))
    expect(result).toMatchObject({ kind: 'success', text: expect.stringContaining('background job') })
    expect(messages).toHaveLength(1)
    const register = owner.ctx.tools.register as ReturnType<typeof vi.fn>
    expect(register).toHaveBeenCalledOnce()
    const scopedTool = register.mock.calls[0]![0] as ToolDefinition
    expect(scopedTool.name).toBe('leppy_loop_control')
    expect(scopedTool.parameters).not.toHaveProperty('phaseGateCommand')
    expect(scopedTool.parameters).not.toHaveProperty('repairPaths')
    expect(scopedTool.parameters).not.toHaveProperty('repairCycles')
  })

  it('/leppy-loop continuar returns before the controller and gives the AI exact authenticated facts', async () => {
    const messages: unknown[] = []
    const owner = agent('continue-agent', message => { messages.push(message) })
    const rt = runtime({ inspectControllers: async () => [controller()] })
    const result = await executeLeppyLoopCommand(context(), invocation(owner, 'continuar'), rt)
    expect(result).toMatchObject({ kind: 'success', text: expect.stringContaining('44c85fb806c6') })
    const prompt = JSON.stringify(messages[0])
    expect(prompt).toContain('leppy_loop_control')
    expect(prompt).toContain('currentTask: 11')
    expect(prompt).toContain('attempt: 15')
    expect(prompt).toContain('examples/feature.task.md')
  })

  it('rejects the old technical flag UX instead of awaiting a foreground loop', async () => {
    const result = await executeLeppyLoopCommand(context(), invocation(agent(), '--tasks huge/path --sync-branch origin/main'), runtime())
    expect(result).toMatchObject({ kind: 'error', text: expect.stringContaining('technical flags are private') })
  })

  it('never treats negated or ambiguous publication language as authority', async () => {
    const followup = vi.fn()
    for (const text of ['nao publicar', 'do not publish', 'continuar sem publicar']) {
      const result = await executeLeppyLoopCommand(context(), invocation(agent(`negated-${text}`, followup), text), runtime())
      expect(result).toMatchObject({ kind: 'error', text: expect.stringContaining('unrecognized Leppy intent') })
    }
    expect(followup).not.toHaveBeenCalled()
  })
})

describe('grant-validated background controller tool', () => {
  it('starts a jobs-owned controller immediately without awaiting its promise', async () => {
    const owner = agent('background-agent')
    const jobs = new FakeJobs()
    let settle!: (result: RunResult) => void
    const run = new Promise<RunResult>(resolveRun => { settle = resolveRun })
    const rt = runtime({ run: async () => await run })
    rt.grants.issue({ agent: owner, repoRoot: cwd, operation: 'start', recovery: 'none', publishRemote: false, maxIterations: 64, maxRepairCycles: 3 })

    const value = await executeLeppyLoopControl(context(jobs), rt, owner, {
      operation: 'start', tasks: 'examples/feature.task.md', syncBranch: 'origin/main', fetch: false,
    })
    expect(value).toMatchObject({ status: 'running', jobId: 'leppy-loop-1' })
    expect(jobs.starts).toHaveLength(1)
    settle({ ...completed, runId: value.runId! })
    await expect(jobs.starts[0]!.hooks.done).resolves.toMatchObject({ status: 'completed' })
  })

  it('rejects a duplicate live controller before repository-lock races', async () => {
    const owner = agent('duplicate-agent')
    const jobs = new FakeJobs()
    const rt = runtime({ run: async () => await new Promise<RunResult>(() => {}) })
    const grant = () => rt.grants.issue({ agent: owner, repoRoot: cwd, operation: 'start', recovery: 'none', publishRemote: false, maxIterations: 64, maxRepairCycles: 3 })
    grant()
    await executeLeppyLoopControl(context(jobs), rt, owner, { operation: 'start', tasks: 'examples/feature.task.md', syncBranch: 'origin/main', fetch: false })
    grant()
    await expect(executeLeppyLoopControl(context(jobs), rt, owner, {
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
    })).rejects.toThrow('no direct human capability')
  })

  it('denies a controller snapshot changed after the human authorized it', async () => {
    const owner = agent('changed-controller')
    const changed = controller({ authorityDigest: 'changed-digest', syncBranch: 'attacker/base' })
    const rt = runtime({ inspectControllers: async () => [changed] })
    rt.grants.issue({
      agent: owner, repoRoot: cwd, runId: '44c85fb806c6', controllerDigest: 'controller-digest',
      operation: 'continue', recovery: 'resume', publishRemote: false, maxIterations: 64, maxRepairCycles: 3,
    })
    await expect(executeLeppyLoopControl(context(), rt, owner, {
      operation: 'continue', recovery: 'resume', runId: '44c85fb806c6',
      tasks: 'examples/feature.task.md', syncBranch: 'attacker/base',
    })).rejects.toThrow('authenticated controller changed after human authorization')
  })

  it('reaches current run task 11 through exact recovery options without editing the worktree', async () => {
    const owner = agent('recovery-agent')
    let observed: LeppyLoopOptions | undefined
    const rt = runtime({
      inspectControllers: async () => [controller()],
      run: async options => { observed = options; return { ...completed, runId: '44c85fb806c6', status: 'stalled', currentTask: 11 } },
    })
    rt.grants.issue({
      agent: owner, repoRoot: cwd, runId: '44c85fb806c6', controllerDigest: 'controller-digest', operation: 'continue', recovery: 'resume',
      publishRemote: false, maxIterations: 64, maxRepairCycles: 3,
    })
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
    rt.grants.issue({ agent: owner, repoRoot: cwd, operation: 'start', recovery: 'none', publishRemote: false, maxIterations: 64, maxRepairCycles: 3 })
    await executeLeppyLoopControl(context(), rt, owner, { operation: 'start', tasks: 'examples/feature.task.md', syncBranch: 'origin/main', fetch: false })
    rt.grants.issue({ agent: owner, repoRoot: cwd, operation: 'start', recovery: 'none', publishRemote: true, maxIterations: 64, maxRepairCycles: 3 })
    await executeLeppyLoopControl(context(), rt, owner, { operation: 'start', tasks: 'examples/feature.task.md', syncBranch: 'origin/main', fetch: false })
    expect(seen).toEqual([false, true])
  })

  it('stops the owned background job through a one-shot stop grant', async () => {
    const owner = agent('stop-agent')
    const jobs = new FakeJobs()
    const rt = runtime({
      inspectControllers: async () => [controller()],
      run: async (_options, dependencies) => await new Promise<RunResult>(resolveRun => {
        dependencies.signal!.addEventListener('abort', () => resolveRun({
          runId: '44c85fb806c6', status: 'interrupted', completedTasks: 5, currentTask: 11, diagnostics: [],
        }), { once: true })
      }),
    })
    rt.grants.issue({ agent: owner, repoRoot: cwd, runId: '44c85fb806c6', controllerDigest: 'controller-digest', operation: 'continue', recovery: 'resume', publishRemote: false, maxIterations: 64, maxRepairCycles: 3 })
    await executeLeppyLoopControl(context(jobs), rt, owner, {
      operation: 'continue', recovery: 'resume', runId: '44c85fb806c6', tasks: 'examples/feature.task.md', syncBranch: 'origin/plugins', fetch: false,
    })
    rt.grants.issue({ agent: owner, repoRoot: cwd, runId: '44c85fb806c6', operation: 'stop', recovery: 'none', publishRemote: false, maxIterations: 1, maxRepairCycles: 1 })
    const stopped = await executeLeppyLoopControl(context(jobs), rt, owner, { operation: 'stop', runId: '44c85fb806c6' })
    expect(stopped.status).toBe('stopping')
    await expect(jobs.starts[0]!.hooks.done).resolves.toMatchObject({ status: 'killed' })
  })
})
