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
import { selectControllerForPublication, selectControllerForStatus } from '../src/controller-auth.js'
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
    grants: new HumanGrantStore(), jobs: [], activeRepositories: new Set(), registeredAgents: new WeakSet(), lifetime: new AbortController(), hooks,
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
  it('registers only the simple command globally and creates the private tool in agent scope', async () => {
    let definition: CommandDefinition | undefined
    let globalTool: ToolDefinition | undefined
    const ctx = {
      commands: { register: (value: CommandDefinition) => { definition = value; return () => {} } },
      tools: { register: (value: ToolDefinition) => { globalTool = value; return () => {} } },
      effect: (setup: () => (() => void)) => setup(),
    } as unknown as Context
    apply(ctx)
    expect(definition?.input).toEqual({ hint: '[natural-language intent|status|parar]' })
    expect(globalTool).toBeUndefined()

    const messages: unknown[] = []
    const owner = agent('scope-agent', message => { messages.push(message) })
    const result = await definition!.handler(invocation(owner, ''))
    expect(result).toMatchObject({ kind: 'success', text: expect.stringContaining('lifecycle authorized') })
    expect(messages).toHaveLength(1)
    const register = owner.ctx.tools.register as ReturnType<typeof vi.fn>
    expect(register).toHaveBeenCalledOnce()
    const scopedTool = register.mock.calls[0]![0] as ToolDefinition
    expect(scopedTool.name).toBe('leppy_loop_control')
    const toolProperties = (scopedTool.parameters as { properties: Record<string, { enum?: string[] }> }).properties
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
    expect(prompt).toContain('currentTask: 11')
    expect(prompt).toContain('attempt: 15')
    expect(prompt).toContain('examples/feature.task.md')
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
      context(), invocation(agent('status-agent'), 'status'), runtime({ inspectControllers: async () => [oldOpen, publicationStall] }),
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
})

describe('grant-validated background controller tool', () => {
  it('starts a jobs-owned controller immediately without awaiting its promise', async () => {
    const owner = agent('background-agent')
    const jobs = new FakeJobs()
    let settle!: (result: RunResult) => void
    const run = new Promise<RunResult>(resolveRun => { settle = resolveRun })
    const rt = runtime({ run: async () => await run })
    issueGrant(rt, owner)

    const value = await executeLeppyLoopControl(context(jobs), rt, owner, {
      operation: 'start', tasks: 'examples/feature.task.md', syncBranch: 'origin/main', fetch: false,
    })
    expect(value).toMatchObject({ status: 'running', jobId: 'leppy-loop-1' })
    expect(jobs.starts).toHaveLength(1)
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
    const rt = runtime({
      inspectControllers: async () => [controller()],
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
    await expect(jobs.starts[0]!.hooks.done).resolves.toMatchObject({ status: 'killed' })
  })
})
