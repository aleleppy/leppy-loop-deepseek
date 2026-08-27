import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runLeppyLoop } from '../src/runner.js'
import type { RunProgress, WorkerAdapter, WorkerOutcome, WorkerRequest } from '../src/types.js'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function repository(checklist: string): { root: string; tasks: string } {
  const root = mkdtempSync(join(tmpdir(), 'leppy-runner-'))
  mkdirSync(join(root, 'src'))
  const tasks = join(root, 'tasks.task.md')
  writeFileSync(tasks, checklist)
  writeFileSync(join(root, 'src', 'value.txt'), 'before\n')
  git(root, 'init', '-b', 'main')
  git(root, 'config', 'user.email', 'tests@example.invalid')
  git(root, 'config', 'user.name', 'Leppy Tests')
  git(root, 'add', '--', 'tasks.task.md', 'src/value.txt')
  git(root, 'commit', '-m', 'chore: seed')
  return { root, tasks }
}

class FakeWorker implements WorkerAdapter {
  calls: WorkerRequest[] = []
  constructor(private readonly outcomes: WorkerOutcome[] = []) {}
  async run(request: WorkerRequest): Promise<WorkerOutcome> {
    this.calls.push(request)
    const outcome = this.outcomes.shift()
    if (outcome) return outcome
    if (request.task.kind === 'task') {
      writeFileSync(join(request.worktree, 'src', 'value.txt'), `done-${request.task.index}\n`)
      git(request.worktree, 'add', '--', 'src/value.txt')
      git(request.worktree, 'commit', '-m', `feat: finish task ${request.task.index}`)
    }
    return { status: 'completed', output: 'done' }
  }
}

const modelDeps = {
  defaultModel: async () => ({ provider: 'fake', model: 'fake-model', effort: 'high' }),
  modelCatalog: async (provider: string) => {
    if (provider !== 'fake') throw new Error(`unexpected provider ${provider}`)
    return [{ id: 'fake-model', reasoningEfforts: ['high'] }, { id: 'fallback', reasoningEfforts: ['high'] }]
  },
  runId: () => `test${Math.random().toString(16).slice(2, 8)}`,
}

const adaptiveDeps = {
  defaultModel: async () => ({ provider: 'openai-codex', model: 'gpt-5.6-sol', effort: 'high' }),
  modelCatalog: async () => [
    { id: 'gpt-5.6-terra', reasoningEfforts: ['low', 'high'] },
    { id: 'gpt-5.6-sol', reasoningEfforts: ['low', 'high'] },
  ],
  runId: () => `adaptive${Math.random().toString(16).slice(2, 8)}`,
}

describe('controller state machine', () => {
  it('refuses a fresh no-op run when the checklist has no open rows', async () => {
    const repo = repository('- [x] Already done `src/value.txt` | Done: value says done\n')
    const worker = new FakeWorker()
    await expect(runLeppyLoop(
      { tasks: repo.tasks, syncBranch: 'main', fetch: false },
      { ...modelDeps, worker },
    )).rejects.toThrow('checklist contains no open executable rows')
    expect(worker.calls).toHaveLength(0)
    expect(git(repo.root, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1)
  })

  it('refuses and rolls back when only the source checkout has an open row', async () => {
    const repo = repository('- [x] Already done `src/value.txt` | Done: value says done\n')
    git(repo.root, 'branch', 'closed-base')
    writeFileSync(repo.tasks, '- [ ] Source-only work `src/value.txt` | Done: value says done\n')
    git(repo.root, 'add', '--', 'tasks.task.md')
    git(repo.root, 'commit', '-m', 'chore: reopen task only in source')
    const worker = new FakeWorker()

    await expect(runLeppyLoop(
      { tasks: repo.tasks, syncBranch: 'closed-base', fetch: false },
      { ...modelDeps, worker },
    )).rejects.toThrow('authoritative base checklist contains no open executable rows')

    expect(worker.calls).toHaveLength(0)
    expect(git(repo.root, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1)
    expect(git(repo.root, 'branch', '--list', 'leppy-loop/*')).toBe('')
  })

  it('runs task, closure and gate once, amending checkbox into the worker commit', async () => {
    const repo = repository(`## Phase
- [ ] Change \`src/value.txt\` | Done: value says done
- [?] Closure: inspect src | paths=src
- [~] Gate: node version
`)
    const worker = new FakeWorker()
    const progress: RunProgress[] = []
    let now = Date.parse('2026-08-26T12:00:00.000Z')
    const result = await runLeppyLoop(
      { tasks: repo.tasks, syncBranch: 'main', fetch: false, phaseGateCommand: 'node --version' },
      {
        ...modelDeps,
        worker,
        now: () => new Date(now),
        onProgress: update => {
          progress.push(update)
          if (update.type === 'task-start') now += 65_000
        },
      },
    )
    expect(result.status).toBe('completed')
    expect(worker.calls).toHaveLength(2)
    expect(worker.calls.every(call => call.provider === 'fake')).toBe(true)
    expect(readFileSync(join(result.worktree!, 'tasks.task.md'), 'utf8').match(/\[x\]/g)).toHaveLength(3)
    expect(git(result.worktree!, 'rev-list', '--count', 'main..HEAD')).toBe('3')
    const eventTypes = readFileSync(join(result.stateDir!, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line).type)
    expect(eventTypes).toEqual(['run-start', 'start', 'done', 'start', 'done', 'gate-start', 'gate-end', 'run-end'])
    expect(progress.map(update => [update.type, update.taskIndex, update.completedTasks, update.totalTasks])).toEqual([
      ['task-start', 0, 0, 3],
      ['task-done', 0, 1, 3],
      ['task-start', 1, 1, 3],
      ['task-done', 1, 2, 3],
      ['task-start', 2, 2, 3],
      ['task-done', 2, 3, 3],
    ])
    expect(progress.filter(update => update.type === 'task-done').map(update => update.elapsedMs)).toEqual([
      65_000, 65_000, 65_000,
    ])
  }, 90_000)

  it('retries a failed gate only after direct exact-run authorization', async () => {
    const suffix = Math.random().toString(16).slice(2)
    const flag = join(tmpdir(), `leppy-gate-${suffix}.flag`).replaceAll('\\', '/')
    const gateScript = join(tmpdir(), `leppy-gate-${suffix}.cjs`).replaceAll('\\', '/')
    writeFileSync(gateScript, `process.exit(require('fs').existsSync('${flag}') ? 0 : 1)\n`)
    const repo = repository(`- [~] Gate: controlled retry | gate=\`node ${gateScript}\`\n`)
    const worker = new FakeWorker()
    try {
      const first = await runLeppyLoop({ tasks: repo.tasks, syncBranch: 'main', fetch: false }, { ...modelDeps, worker })
      expect(first.status).toBe('stalled')
      expect(readFileSync(join(first.stateDir!, 'resume.json'), 'utf8')).toContain('--retry-gate')

      const unauthorized = await runLeppyLoop({
        tasks: repo.tasks, syncBranch: 'main', fetch: false, recoverExistingWip: true, recoverRunId: first.runId,
      }, { ...modelDeps, worker })
      expect(unauthorized.status).toBe('stalled')
      expect(readFileSync(join(first.stateDir!, 'resume.json'), 'utf8')).toContain('gate-retry-authorization-required')

      await expect(runLeppyLoop({ tasks: repo.tasks, syncBranch: 'main', fetch: false, retryGate: true }, { ...modelDeps, worker }))
        .rejects.toThrow('--retry-gate requires')
      writeFileSync(flag, 'pass')
      const retried = await runLeppyLoop({
        tasks: repo.tasks, syncBranch: 'main', fetch: false, recoverExistingWip: true, recoverRunId: first.runId, retryGate: true,
      }, { ...modelDeps, worker })
      expect(retried.status, readFileSync(join(first.stateDir!, 'receipts', 'gate-0-3.json'), 'utf8')).toBe('completed')
      const events = readFileSync(join(first.stateDir!, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
      expect(events.filter(entry => entry.type === 'gate-start')).toHaveLength(2)
      expect(events.filter(entry => entry.type === 'gate-start').at(-1)?.data.retry).toBe(true)
    } finally {
      // The unique temp flag is intentionally harmless and cannot affect another test.
    }
  }, 90_000)

  it('rejects a changed recovered gate command instead of bypassing its recorded fingerprint', async () => {
    const repo = repository('- [~] Gate: configured externally\n')
    const worker = new FakeWorker()
    const first = await runLeppyLoop({
      tasks: repo.tasks, syncBranch: 'main', fetch: false, phaseGateCommand: 'node definitely-missing-leppy-gate.cjs',
    }, { ...modelDeps, worker })
    expect(first.status).toBe('stalled')
    await expect(runLeppyLoop({
      tasks: repo.tasks,
      syncBranch: 'main',
      fetch: false,
      phaseGateCommand: 'node --version',
      recoverExistingWip: true,
      recoverRunId: first.runId,
      retryGate: true,
    }, { ...modelDeps, worker })).rejects.toThrow('fingerprint differs')
  }, 90_000)

  it('forwards bounded tracked legacy custom instructions to the worker', async () => {
    const repo = repository('- [ ] Change `src/value.txt` | Done: value says done\n')
    writeFileSync(join(repo.root, '.leppy-loop.json'), JSON.stringify({ customInstructions: 'Run the focal command literally.' }))
    git(repo.root, 'add', '--', '.leppy-loop.json')
    git(repo.root, 'commit', '-m', 'chore: add leppy instructions')
    const worker = new FakeWorker()

    const result = await runLeppyLoop(
      { tasks: repo.tasks, syncBranch: 'main', fetch: false },
      { ...modelDeps, worker },
    )

    expect(result.status).toBe('completed')
    expect(worker.calls[0]?.instructions).toContain('Applicable tracked legacy instructions from .leppy-loop.json:\nRun the focal command literally.')
  }, 90_000)

  it('stalls at a human checkpoint without starting a worker', async () => {
    const repo = repository('- [?] [human/live] Confirm behavior in the release client.\n')
    const worker = new FakeWorker()

    const result = await runLeppyLoop(
      { tasks: repo.tasks, syncBranch: 'main', fetch: false },
      { ...modelDeps, worker },
    )

    expect(result.status).toBe('stalled')
    expect(result.currentTask).toBe(0)
    expect(worker.calls).toHaveLength(0)
    expect(readFileSync(join(result.stateDir!, 'resume.json'), 'utf8')).toContain('"status": "human"')
  }, 90_000)

  it('preserves WIP and the same open row after timeout', async () => {
    const repo = repository('- [ ] Change `src/value.txt` | Done: value says done\n')
    const worker = new FakeWorker([{ status: 'timeout', output: '', error: 'timeout' }])
    const progress: RunProgress[] = []
    const result = await runLeppyLoop(
      { tasks: repo.tasks, syncBranch: 'main', fetch: false },
      { ...modelDeps, worker, onProgress: update => { progress.push(update) } },
    )
    expect(result.status).toBe('stalled')
    expect(readFileSync(join(result.worktree!, 'tasks.task.md'), 'utf8')).toContain('[ ]')
    const resume = JSON.parse(readFileSync(join(result.stateDir!, 'resume.json'), 'utf8')) as { command: string }
    expect(resume.command).toMatch(/^\/leppy-loop --tasks "tasks\.task\.md" --sync-branch "main" --recover-existing-wip --recover-run "test[0-9a-f]+"$/)
    expect(progress.map(update => update.type)).toEqual(['task-start', 'task-failed'])
    expect(progress.at(-1)).toMatchObject({ error: 'timeout', completedTasks: 0, totalTasks: 1 })
  }, 90_000)

  it('retries one clean no-commit completion with the recovery model', async () => {
    const repo = repository('- [ ] Change `src/value.txt` | Done: value says done\n')
    const worker = new FakeWorker([{ status: 'completed', output: 'done without a commit' }])
    const progress: RunProgress[] = []

    const result = await runLeppyLoop(
      { tasks: repo.tasks, syncBranch: 'main', fetch: false },
      { ...adaptiveDeps, worker, onProgress: update => { progress.push(update) } },
    )

    expect(result.status).toBe('completed')
    expect(worker.calls).toHaveLength(2)
    expect(worker.calls.map(call => [call.model, call.effort])).toEqual([
      ['gpt-5.6-terra', 'high'],
      ['gpt-5.6-sol', 'low'],
    ])
    expect(worker.calls[1]?.instructions.at(-1)).toContain('produced no commit')
    const events = readFileSync(join(result.stateDir!, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(events.filter(entry => entry.type === 'start').map(entry => entry.data.retry ?? null)).toEqual([null, 'no-commit'])
    expect(progress.map(update => [update.type, update.attempt])).toEqual([
      ['task-start', 1],
      ['task-done', 1],
    ])
    expect(git(result.worktree!, 'rev-list', '--count', 'main..HEAD')).toBe('1')
  }, 90_000)

  it('closes an independently verified already-satisfied task without manufacturing a worker commit', async () => {
    const repo = repository('- [ ] Verify `src/value.txt` | Done: value already says before\n')
    const worker = new FakeWorker([
      { status: 'completed', output: 'no commit from first attempt' },
      { status: 'completed', output: 'Checked src/value.txt.\nLEPPY_ALREADY_SATISFIED: src/value.txt already contains before' },
    ])

    const result = await runLeppyLoop(
      { tasks: repo.tasks, syncBranch: 'main', fetch: false },
      { ...adaptiveDeps, worker },
    )

    expect(result.status).toBe('completed')
    expect(worker.calls).toHaveLength(2)
    expect(git(result.worktree!, 'rev-list', '--count', 'main..HEAD')).toBe('1')
    expect(git(result.worktree!, 'show', '--pretty=format:', '--name-only', 'HEAD')).toBe('tasks.task.md')
    const events = readFileSync(join(result.stateDir!, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(events.find(entry => entry.type === 'done')?.data.verifiedAlreadySatisfied).toBe(true)
  }, 90_000)

  it('fails closed after one repeated clean no-commit completion', async () => {
    const repo = repository('- [ ] Change `src/value.txt` | Done: value says done\n')
    const worker = new FakeWorker([
      { status: 'completed', output: 'first no-op' },
      { status: 'completed', output: 'second no-op' },
    ])

    await expect(runLeppyLoop(
      { tasks: repo.tasks, syncBranch: 'main', fetch: false },
      { ...adaptiveDeps, worker },
    )).rejects.toThrow('worker must create exactly one commit; observed 0')
    expect(worker.calls).toHaveLength(2)
  }, 90_000)

  it('uses Terra high for ordinary work and Sol low for closures by default', async () => {
    const taskRepo = repository('- [ ] Change `src/value.txt` | Done: value says done\n')
    const task = await runLeppyLoop({ tasks: taskRepo.tasks, syncBranch: 'main', fetch: false, dryRun: true }, adaptiveDeps)
    expect(task.preview?.model).toEqual({ provider: 'openai-codex', model: 'gpt-5.6-terra', effort: 'high' })
    const overridden = await runLeppyLoop({ tasks: taskRepo.tasks, syncBranch: 'main', fetch: false, dryRun: true, model: 'gpt-5.6-sol', effort: 'high' }, adaptiveDeps)
    expect(overridden.preview?.model).toEqual({ provider: 'openai-codex', model: 'gpt-5.6-sol', effort: 'high' })

    const closureRepo = repository('- [?] Closure: inspect `src/value.txt`\n')
    const closure = await runLeppyLoop({ tasks: closureRepo.tasks, syncBranch: 'main', fetch: false, dryRun: true }, adaptiveDeps)
    expect(closure.preview?.model).toEqual({ provider: 'openai-codex', model: 'gpt-5.6-sol', effort: 'low' })
  }, 90_000)

  it('uses Sol low when recovering the same stalled task', async () => {
    const repo = repository('- [ ] Change `src/value.txt` | Done: value says done\n')
    const worker = new FakeWorker([{ status: 'transcript-limit', output: '', error: 'limit' }])
    const progress: RunProgress[] = []
    const dependencies = { ...adaptiveDeps, worker, onProgress: (update: RunProgress) => { progress.push(update) } }
    const first = await runLeppyLoop({ tasks: repo.tasks, syncBranch: 'main', fetch: false }, dependencies)
    expect(first.status).toBe('stalled')
    const failedWorker: WorkerAdapter = { run: async () => ({ status: 'completed', output: 'no commit' }) }
    await expect(runLeppyLoop({ tasks: repo.tasks, syncBranch: 'main', fetch: false }, { ...adaptiveDeps, worker: failedWorker })).rejects.toThrow('exactly one commit')
    const resumed = await runLeppyLoop({ tasks: repo.tasks, syncBranch: 'main', fetch: false, recoverExistingWip: true }, dependencies)
    expect(resumed.status).toBe('completed')
    expect(resumed.runId).toBe(first.runId)
    expect(worker.calls.map(call => [call.model, call.effort])).toEqual([
      ['gpt-5.6-terra', 'high'],
      ['gpt-5.6-sol', 'low'],
    ])
    expect(progress.map(update => update.type)).toEqual([
      'task-start', 'task-failed', 'task-start', 'task-done',
    ])
    expect(progress[0]?.attempt).not.toBe(progress[2]?.attempt)
  }, 90_000)

  it('continues an exact completed selective run on its next open row', async () => {
    const repo = repository('- [ ] Alpha `src/value.txt` | Done: alpha\n- [ ] Beta `src/value.txt` | Done: beta\n')
    const worker = new FakeWorker()
    const first = await runLeppyLoop({ tasks: repo.tasks, syncBranch: 'main', fetch: false, taskMatch: 'Alpha' }, { ...adaptiveDeps, worker })
    expect(first.status).toBe('completed')
    expect(first.completedTasks).toBe(1)
    const continued = await runLeppyLoop({ tasks: repo.tasks, syncBranch: 'main', fetch: false, recoverExistingWip: true, recoverRunId: first.runId }, { ...adaptiveDeps, worker })
    expect(continued.status).toBe('completed')
    expect(continued.runId).toBe(first.runId)
    expect(continued.completedTasks).toBe(2)
    expect(worker.calls.map(call => [call.task.index, call.model, call.effort])).toEqual([
      [0, 'gpt-5.6-terra', 'high'],
      [1, 'gpt-5.6-terra', 'high'],
    ])
    expect(readFileSync(join(continued.worktree!, 'tasks.task.md'), 'utf8').match(/\[x\]/g)).toHaveLength(2)
    expect(readFileSync(join(continued.stateDir!, 'events.jsonl'), 'utf8')).toContain('"previousStatus":"completed"')
  }, 90_000)

  it('publishes once after completion and returns the pull request URL', async () => {
    const repo = repository('- [ ] Change `src/value.txt` | Done: value says done\n')
    const worker = new FakeWorker()
    const published: string[] = []
    const dependencies = {
      ...modelDeps,
      worker,
      publishPullRequest: async (request: { branch: string }) => {
        published.push(request.branch)
        return 'https://github.com/example/repo/pull/7'
      },
    }
    const result = await runLeppyLoop({ tasks: repo.tasks, syncBranch: 'main', fetch: false, openPullRequest: true }, dependencies)
    expect(result.pullRequestUrl).toBe('https://github.com/example/repo/pull/7')
    expect(published).toEqual([result.branch])
    const repeated = await runLeppyLoop({ tasks: repo.tasks, syncBranch: 'main', fetch: false, openPullRequest: true, recoverExistingWip: true, recoverRunId: result.runId }, dependencies)
    expect(repeated.pullRequestUrl).toBe('https://github.com/example/repo/pull/7')
    expect(published).toHaveLength(1)
    const events = readFileSync(join(result.stateDir!, 'events.jsonl'), 'utf8')
    expect(events).toContain('"type":"publish-start"')
    expect(events).toContain('"type":"publish-done"')
  }, 90_000)

  it('uses fallback once only for availability failures', async () => {
    const repo = repository('- [ ] Change `src/value.txt` | Done: value says done\n')
    const worker = new FakeWorker([{ status: 'unavailable', output: '', error: '429' }])
    const result = await runLeppyLoop({ tasks: repo.tasks, syncBranch: 'main', fetch: false, fallbackModel: 'fallback' }, { ...modelDeps, worker })
    expect(result.status).toBe('completed')
    expect(worker.calls.map(call => call.model)).toEqual(['fake-model', 'fallback'])
  }, 90_000)

  it('dry-run selects one literal line without starting a worker or creating a worktree', async () => {
    const repo = repository('- [ ] Alpha `src/value.txt` | Done: alpha\n- [ ] Beta `src/value.txt` | Done: beta\n')
    const worker = new FakeWorker()
    const result = await runLeppyLoop({ tasks: repo.tasks, syncBranch: 'main', fetch: false, dryRun: true, taskMatch: 'Beta' }, { ...modelDeps, worker })
    expect(result.status).toBe('dry-run')
    expect(result.currentTask).toBe(1)
    expect(result.preview).toMatchObject({ selectedLine: expect.stringContaining('Beta') })
    expect(worker.calls).toHaveLength(0)
  }, 90_000)

  it('honors a pre-aborted command signal before repository mutation', async () => {
    const repo = repository('- [ ] Alpha `src/value.txt` | Done: alpha\n')
    const control = new AbortController()
    control.abort(new Error('request canceled'))
    await expect(runLeppyLoop(
      { tasks: repo.tasks, syncBranch: 'main', fetch: false },
      { ...modelDeps, signal: control.signal },
    )).rejects.toThrow('request canceled')
    expect(git(repo.root, 'branch', '--show-current')).toBe('main')
  }, 90_000)

  it('canonicalizes a symlinked repository path before containment checks', async () => {
    const repo = repository('- [ ] Alpha `src/value.txt` | Done: alpha\n')
    const alias = `${repo.root}-alias`
    symlinkSync(repo.root, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const result = await runLeppyLoop({ tasks: join(alias, 'tasks.task.md'), syncBranch: 'main', fetch: false, dryRun: true }, modelDeps)
    expect(result.status).toBe('dry-run')
    expect(result.currentTask).toBe(0)
  }, 90_000)
})
