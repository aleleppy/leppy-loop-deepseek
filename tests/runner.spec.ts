import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runLeppyLoop } from '../src/runner.js'
import type { WorkerAdapter, WorkerOutcome, WorkerRequest } from '../src/types.js'

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
  modelCatalog: async () => [{ id: 'fake-model', reasoningEfforts: ['high'] }, { id: 'fallback', reasoningEfforts: ['high'] }],
  runId: () => `test${Math.random().toString(16).slice(2, 8)}`,
}

describe('controller state machine', () => {
  it('runs task, closure and gate once, amending checkbox into the worker commit', async () => {
    const repo = repository(`## Phase
- [ ] Change \`src/value.txt\` | Done: value says done
- [?] Closure: inspect src | paths=src
- [~] Gate: node version
`)
    const worker = new FakeWorker()
    const result = await runLeppyLoop({ tasks: repo.tasks, syncBranch: 'main', fetch: false, phaseGateCommand: 'node --version' }, { ...modelDeps, worker })
    expect(result.status).toBe('completed')
    expect(worker.calls).toHaveLength(2)
    expect(readFileSync(join(result.worktree!, 'tasks.task.md'), 'utf8').match(/\[x\]/g)).toHaveLength(3)
    expect(git(result.worktree!, 'rev-list', '--count', 'main..HEAD')).toBe('3')
    const eventTypes = readFileSync(join(result.stateDir!, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line).type)
    expect(eventTypes).toEqual(['run-start', 'start', 'done', 'start', 'done', 'gate-start', 'gate-end', 'run-end'])
  }, 30_000)

  it('preserves WIP and the same open row after timeout', async () => {
    const repo = repository('- [ ] Change `src/value.txt` | Done: value says done\n')
    const worker = new FakeWorker([{ status: 'timeout', output: '', error: 'timeout' }])
    const result = await runLeppyLoop({ tasks: repo.tasks, syncBranch: 'main', fetch: false }, { ...modelDeps, worker })
    expect(result.status).toBe('stalled')
    expect(readFileSync(join(result.worktree!, 'tasks.task.md'), 'utf8')).toContain('[ ]')
    expect(readFileSync(join(result.stateDir!, 'resume.json'), 'utf8')).toContain('recover-existing-wip')
  })

  it('uses fallback once only for availability failures', async () => {
    const repo = repository('- [ ] Change `src/value.txt` | Done: value says done\n')
    const worker = new FakeWorker([{ status: 'unavailable', output: '', error: '429' }])
    const result = await runLeppyLoop({ tasks: repo.tasks, syncBranch: 'main', fetch: false, fallbackModel: 'fallback' }, { ...modelDeps, worker })
    expect(result.status).toBe('completed')
    expect(worker.calls.map(call => call.model)).toEqual(['fake-model', 'fallback'])
  })

  it('dry-run selects one literal line without starting a worker or creating a worktree', async () => {
    const repo = repository('- [ ] Alpha `src/value.txt` | Done: alpha\n- [ ] Beta `src/value.txt` | Done: beta\n')
    const worker = new FakeWorker()
    const result = await runLeppyLoop({ tasks: repo.tasks, syncBranch: 'main', fetch: false, dryRun: true, taskMatch: 'Beta' }, { ...modelDeps, worker })
    expect(result.status).toBe('dry-run')
    expect(result.currentTask).toBe(1)
    expect(worker.calls).toHaveLength(0)
  })
})
