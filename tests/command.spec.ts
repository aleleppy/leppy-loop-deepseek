import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { CommandDefinition, CommandInvocation } from '@deepseek-ai/dsh-commands'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import { apply, createChatProgressReporter, executeLeppyLoopCommand, executeLeppyLoopTool } from '../src/command.js'
import { parseLeppyLoopCommandInput, tokenizeLeppyLoopCommandInput } from '../src/options.js'
import type { RunProgress, RunResult } from '../src/types.js'

function invocation(rawInput: string, cwd: string | undefined, signal = new AbortController().signal, followup: (message: unknown) => void = () => {}): CommandInvocation {
  return {
    commandId: 'command-test' as CommandInvocation['commandId'],
    agent: { session: { header: { ...(cwd ? { cwd } : {}) } }, followup } as unknown as CommandInvocation['agent'],
    rawInput,
    attachments: [],
    signal,
  }
}

const completed: RunResult = {
  runId: 'run-web',
  status: 'completed',
  branch: 'leppy-loop/task-run-web',
  worktree: 'worktree',
  stateDir: 'state',
  completedTasks: 3,
  diagnostics: [],
}

describe('Web command input', () => {
  it('tokenizes quoted values without evaluating shell syntax or damaging Windows paths', () => {
    expect(tokenizeLeppyLoopCommandInput(String.raw` --tasks "\\server\share\my task.md" --phase-gate-command "pnpm test --filter api" --artifacts-dir 'C:\runs\' `)).toEqual([
      '--tasks', String.raw`\\server\share\my task.md`,
      '--phase-gate-command', 'pnpm test --filter api',
      '--artifacts-dir', 'C:\\runs\\',
    ])
  })

  it('parses the CLI option vocabulary from exact slash-command input', () => {
    const options = parseLeppyLoopCommandInput('--tasks "tasks/my task.md" --sync-branch origin/main --worker-timeout 2 --no-fetch')
    expect(options).toMatchObject({
      tasks: 'tasks/my task.md',
      syncBranch: 'origin/main',
      workerTimeoutMs: 120_000,
      workerTranscriptLimitBytes: 8 * 1024 * 1024,
      workerPolicy: 'adaptive',
      openPullRequest: false,
      fetch: false,
    })
    expect(parseLeppyLoopCommandInput('--tasks tasks/a.md --sync-branch main --no-open-pr').openPullRequest).toBe(false)
    expect(parseLeppyLoopCommandInput('--tasks tasks/a.md --sync-branch main --open-pr').openPullRequest).toBe(true)
    expect(parseLeppyLoopCommandInput('--tasks tasks/a.md --sync-branch main --recover-run abc --retry-gate')).toMatchObject({ recoverRunId: 'abc', recoverExistingWip: true, retryGate: true })
  })

  it('returns actionable usage for malformed input', () => {
    expect(() => parseLeppyLoopCommandInput('--tasks tasks/a.md')).toThrow('/leppy-loop --tasks <path> --sync-branch <ref>')
    expect(() => tokenizeLeppyLoopCommandInput('--tasks "open')).toThrow('unterminated')
  })
})

describe('chat progress reporter', () => {
  it('opens and settles a durable model-invisible command card for each task', () => {
    const events: Array<{ type: string; data: unknown }> = []
    const agent = {
      session: { append: (type: string, data: unknown) => { events.push({ type, data }) } },
    } as unknown as CommandInvocation['agent']
    const report = createChatProgressReporter(agent)
    const base: RunProgress = {
      type: 'task-start', runId: 'run-1', taskIndex: 2, attempt: 3, kind: 'task',
      phase: 'Phase 1', text: 'Implement storage', completedTasks: 2, totalTasks: 8, elapsedMs: 0,
    }
    report(base)
    report({ ...base, type: 'task-done', completedTasks: 3, elapsedMs: 346_000 })
    expect(events).toEqual([
      {
        type: 'command/run',
        data: {
          commandId: 'leppy-progress-run-1-2-3',
          name: 'leppy-loop-task',
          args: ' [3/8] Implement storage\nleppy-elapsed-ms=0',
          source: { kind: 'plugin', plugin: 'leppy-loop' },
        },
      },
      {
        type: 'command/done',
        data: {
          commandId: 'leppy-progress-run-1-2-3',
          kind: 'success',
          text: 'Task completed — 3/8 — 5m 46s elapsed.',
        },
      },
    ])
  })
})

describe('/leppy-loop command', () => {
  it('registers an actionable global command and aborts its lifetime on disposal', () => {
    let definition: CommandDefinition | undefined
    let tool: ToolDefinition | undefined
    let cleanup: (() => void) | undefined
    const ctx = {
      commands: { register: (value: CommandDefinition) => { definition = value; return () => {} } },
      tools: { register: (value: ToolDefinition) => { tool = value; return () => {} } },
      effect: (setup: () => (() => void)) => { cleanup = setup(); return cleanup },
    } as unknown as Context
    apply(ctx)
    expect(definition).toMatchObject({
      name: 'leppy-loop',
      input: { hint: '[--tasks <path> --sync-branch <ref> [options]]' },
    })
    expect(tool).toMatchObject({ name: 'leppy_loop_start' })
    expect(JSON.stringify(tool)).not.toContain('openPullRequest')
    expect(JSON.stringify(tool)).not.toContain('retryGate')
    cleanup?.()
  })

  it('delegates a bare invocation to an autonomous model turn', async () => {
    const messages: unknown[] = []
    const result = await executeLeppyLoopCommand(
      {} as Context,
      invocation('', process.cwd(), new AbortController().signal, message => messages.push(message)),
    )
    expect(result).toMatchObject({ kind: 'success', text: expect.stringContaining('delegated to the AI') })
    expect(messages).toHaveLength(1)
    const prompt = JSON.stringify(messages[0])
    expect(prompt).toContain('leppy_loop_start')
    expect(prompt).toContain('every open ordinary row has a non-empty Done: contract and explicit repo-relative paths')
    expect(prompt).toContain('at least one open executable row')
    expect(prompt).toContain('zero open rows is already finished')
    expect(prompt).toContain('invalid legacy controller')
    expect(prompt).toContain('instead of guessing or calling leppy_loop_start')
  })

  it('treats natural language after the slash command as AI intent, not argv', async () => {
    const messages: unknown[] = []
    const result = await executeLeppyLoopCommand(
      {} as Context,
      invocation(' e agora?', process.cwd(), new AbortController().signal, message => messages.push(message)),
    )
    expect(result).toMatchObject({ kind: 'success', text: expect.stringContaining('delegated to the AI') })
    expect(JSON.stringify(messages[0])).toContain('e agora?')
  })

  it('resolves paths from the receiving session cwd and formats completion', async () => {
    const cwd = resolve('workspace with spaces')
    let tasks = ''
    let artifactsDir = ''
    const result = await executeLeppyLoopCommand(
      {} as Context,
      invocation('--tasks "tasks/feature task.md" --sync-branch origin/main --artifacts-dir .state', cwd),
      undefined,
      {
        dependencies: (_ctx, signal) => ({ signal }),
        run: async options => {
          tasks = options.tasks
          artifactsDir = options.artifactsDir!
          return completed
        },
      },
    )
    expect(tasks).toBe(resolve(cwd, 'tasks/feature task.md'))
    expect(artifactsDir).toBe(resolve(cwd, '.state'))
    expect(result).toMatchObject({ kind: 'success' })
    expect(result.text).toContain('run=run-web')
  })

  it('starts the same controller through model-selected tool arguments', async () => {
    let observed: string | undefined
    let policy: string | undefined
    let openPullRequest: boolean | undefined
    const agent = invocation('', process.cwd()).agent
    const value = await executeLeppyLoopTool(
      {} as Context,
      agent,
      { tasks: 'tasks/feature.task.md', syncBranch: 'origin/main' },
      new AbortController().signal,
      {
        dependencies: (_ctx, signal) => ({ signal }),
        run: async options => { observed = options.tasks; policy = options.workerPolicy; openPullRequest = options.openPullRequest; return completed },
      },
    )
    expect(observed).toBe(resolve(process.cwd(), 'tasks/feature.task.md'))
    expect(policy).toBe('adaptive')
    expect(openPullRequest).toBe(false)
    expect(value).toMatchObject({ status: 'completed', runId: 'run-web' })
  })

  it('refuses sessions without an absolute workspace cwd', async () => {
    const missing = await executeLeppyLoopCommand({} as Context, invocation('--tasks tasks/a.md --sync-branch main', undefined))
    expect(missing).toMatchObject({ kind: 'error', text: expect.stringContaining('workspace cwd') })
  })

  it('renders stalled runs as command errors with recovery facts', async () => {
    const result = await executeLeppyLoopCommand(
      {} as Context,
      invocation('--tasks tasks/a.md --sync-branch main', process.cwd()),
      undefined,
      {
        dependencies: () => ({}),
        run: async () => ({ ...completed, status: 'stalled', currentTask: 4 }),
      },
    )
    expect(result).toMatchObject({ kind: 'error', text: expect.stringContaining('currentTask=4') })
  })

  it('propagates UI cancellation into the controller dependency signal', async () => {
    const request = new AbortController()
    const running = executeLeppyLoopCommand(
      {} as Context,
      invocation('--tasks tasks/a.md --sync-branch main', process.cwd(), request.signal),
      undefined,
      {
        dependencies: (_ctx, signal) => ({ signal }),
        run: async (_options, dependencies) => await new Promise<RunResult>((_resolve, reject) => {
          dependencies.signal!.addEventListener('abort', () => reject(dependencies.signal!.reason), { once: true })
        }),
      },
    )
    request.abort(new Error('request canceled'))
    await expect(running).rejects.toThrow('request canceled')
  })
})
