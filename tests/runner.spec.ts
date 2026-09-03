import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import * as gitModule from '../src/git.js'
import { workerIgnoredBaselineBridgeIdentity } from '../src/ignored-artifacts.js'
import { parseChecklist, selectTask } from '../src/checklist.js'
import { awaitAuthenticatedLeaseSettlement, runLeppyLoop } from '../src/runner.js'
import { createLeaseKey, signLease } from '../src/state.js'
import { persistRunStateProof } from '../src/run-state-proof.js'
import { acquireLifecycleAuthorityMutex, appendLifecycleAuthorityReceipt, lifecycleStateDir } from '../src/lifecycle-authority.js'
import { PublicationConflictError } from '../src/publish.js'
import type { LifecycleAuthority, PublicationHooks, PullRequestRequest, RunProgress, WorkerAdapter, WorkerOutcome, WorkerRequest } from '../src/types.js'

function completedOutcome(output = 'done'): WorkerOutcome {
  return {
    status: 'completed', output,
    report: { status: 'completed', summary: output, validation: { status: 'passed', evidence: 'focused validation passed' } },
  }
}

function blockedNotRunOutcome(detail: string): WorkerOutcome {
  return {
    status: 'blocked', output: detail, error: detail,
    report: { status: 'blocked', summary: detail, validation: { status: 'not-run', evidence: detail } },
  }
}

function implementationImpossibleOutcome(detail: string): WorkerOutcome {
  return {
    status: 'blocked', output: detail, error: detail,
    report: {
      status: 'blocked', disposition: 'implementation-impossible', summary: detail,
      validation: { status: 'not-run', evidence: detail },
    },
  }
}

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
  git(root, 'config', 'core.autocrlf', 'false')
  git(root, 'add', '--', 'tasks.task.md', 'src/value.txt')
  git(root, 'commit', '-m', 'chore: seed')
  return { root, tasks }
}

async function fakeNpmInstall(installRoot: string): Promise<void> {
  mkdirSync(join(installRoot, 'node_modules', '.bin'), { recursive: true })
  mkdirSync(join(installRoot, 'node_modules', 'typescript'), { recursive: true })
  writeFileSync(join(installRoot, 'node_modules', 'typescript', 'package.json'), '{"name":"typescript","version":"5.9.3","resolved":"https://registry.npmjs.org/typescript/-/typescript-5.9.3.tgz","integrity":"sha512-jl1vZzPDinLr9eUt3J/t7V6FgNEw9QjvBPdysz9KfQDD41fQrC2Y4vKQdiaUpFT4bXlb1RHhLpp8wtm6M5TgSw==","bin":{"tsc":"bin/tsc"}}\n')
  writeFileSync(join(installRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc'), 'fixture shim\n')
  writeFileSync(join(installRoot, 'node_modules', '.package-lock.json'), '{"lockfileVersion":3,"packages":{"node_modules/typescript":{"version":"5.9.3","resolved":"https://registry.npmjs.org/typescript/-/typescript-5.9.3.tgz","integrity":"sha512-jl1vZzPDinLr9eUt3J/t7V6FgNEw9QjvBPdysz9KfQDD41fQrC2Y4vKQdiaUpFT4bXlb1RHhLpp8wtm6M5TgSw==","bin":{"tsc":"bin/tsc"}}}}\n')
}

class FakeWorker implements WorkerAdapter {
  calls: WorkerRequest[] = []
  constructor(private readonly outcomes: WorkerOutcome[] = []) {}
  async run(request: WorkerRequest): Promise<WorkerOutcome> {
    this.calls.push(request)
    const outcome = this.outcomes.shift()
    if (outcome) return outcome.status === 'completed' && !outcome.report ? { ...outcome, report: completedOutcome(outcome.output).report! } : outcome
    if (request.mode === 'publication-conflict') {
      for (const path of request.allowedPaths) writeFileSync(join(request.worktree, path), 'authoritative-base\ndone-0\n')
      return completedOutcome('resolved without staging or committing')
    }
    if (request.task.kind === 'task') {
      writeFileSync(join(request.worktree, 'src', 'value.txt'), `done-${request.task.index}\n`)
      git(request.worktree, 'add', '--', 'src/value.txt')
      git(request.worktree, 'commit', '-m', `feat: finish task ${request.task.index}`)
    }
    return completedOutcome()
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

async function seedLegacyFailedGate(): Promise<{ repo: { root: string; tasks: string }; runId: string; stateDir: string; worktree: string; command: string }> {
  const gateScript = join(tmpdir(), `leppy-legacy-advisory-${Math.random().toString(16).slice(2)}.cjs`).replaceAll('\\', '/')
  writeFileSync(gateScript, "process.exit(1)\n")
  const command = `node ${gateScript}`
  const repo = repository(`- [~] Gate: legacy advisory recovery | gate=\`${command}\`\n`)
  const completed = await runLeppyLoop({ tasks: repo.tasks, syncBranch: 'main', fetch: false }, { ...modelDeps, worker: new FakeWorker() })
  git(completed.worktree!, 'reset', '--hard', 'HEAD^')
  const receiptName = readdirSync(join(completed.stateDir!, 'receipts')).find(name => /^gate-0-\d+\.json$/u.test(name))!
  const receiptPath = join(completed.stateDir!, 'receipts', receiptName)
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'))
  delete receipt.targetHead
  delete receipt.checklistDigest
  writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`)
  const statePath = join(completed.stateDir!, 'run.json')
  const state = JSON.parse(readFileSync(statePath, 'utf8'))
  state.status = 'stalled'
  state.currentTask = 0
  state.completedTasks = 0
  state.lastError = `gate exited with code ${receipt.exitCode}`
  delete state.gateEvidence
  delete state.stateProof
  writeFileSync(statePath, `${JSON.stringify(state)}\n`)
  persistRunStateProof(completed.stateDir!, state, Buffer.from(readFileSync(join(completed.stateDir!, 'lease.key'), 'utf8').trim(), 'base64'))
  return { repo, runId: completed.runId, stateDir: completed.stateDir!, worktree: completed.worktree!, command }
}

async function seedAuthenticatedGateEvidenceCrash(): Promise<{ repo: { root: string; tasks: string }; runId: string; stateDir: string; worktree: string; receiptPath: string }> {
  const gateScript = join(tmpdir(), `leppy-authenticated-gate-${Math.random().toString(16).slice(2)}.cjs`).replaceAll('\\', '/')
  writeFileSync(gateScript, "console.error('AUTHENTICATED_GATE_FAILURE');process.exit(1)\n")
  const repo = repository(`- [~] Gate: authenticated crash recovery | gate=\`node ${gateScript}\`\n`)
  let receiptPath = ''
  await expect(runLeppyLoop(
    { tasks: repo.tasks, syncBranch: 'main', fetch: false },
    {
      ...modelDeps, worker: new FakeWorker(),
      afterGateEvidencePersisted: path => { receiptPath = path; throw new Error('crash after authenticated gate evidence') },
    },
  )).rejects.toThrow('crash after authenticated gate evidence')
  const stateDir = resolve(receiptPath, '..', '..')
  const state = JSON.parse(readFileSync(join(stateDir, 'run.json'), 'utf8'))
  return { repo, runId: state.runId, stateDir, worktree: state.worktree, receiptPath }
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
  }, 90_000)

  it('runs task, closure and gate once, amending checkbox into the worker commit', async () => {
    const repo = repository(`## Phase
- [ ] Change \`src/value.txt\` | Done: value says done
- [?] Closure: inspect src | paths=src
- [~] Gate: node version | gate=\`node --version\`
`)
    const worker = new FakeWorker()
    const progress: RunProgress[] = []
    let now = Date.parse('2026-08-26T12:00:00.000Z')
    const result = await runLeppyLoop(
      { tasks: repo.tasks, syncBranch: 'main', fetch: false },
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
    expect(worker.calls.every(call => call.gateFingerprint?.length === 64)).toBe(true)
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
    expect(progress.filter(update => update.type === 'task-start').map(update => [update.attempt, update.taskAttempt])).toEqual([
      [1, 1], [2, 1], [3, 1],
    ])
    expect(progress.filter(update => update.type === 'task-done').map(update => update.elapsedMs)).toEqual([
      65_000, 65_000, 65_000,
    ])
  }, 90_000)

  it('discards untracked svelte-check cache after a clean closure without a commit', async () => {
    const repo = repository('- [?] Closure: inspect `src` | paths=src\n')
    const worker: WorkerAdapter = { async run(request) {
      mkdirSync(join(request.worktree, '.svelte-check'))
      writeFileSync(join(request.worktree, '.svelte-check', 'manifest.json'), '{"generated":true}\n')
      return completedOutcome('closure inspected with advisory validation')
    } }

    const result = await runLeppyLoop({ tasks: repo.tasks, syncBranch: 'main', fetch: false }, { ...modelDeps, worker })
    expect(result).toMatchObject({ status: 'completed', completedTasks: 1 })
    expect(existsSync(join(result.worktree!, '.svelte-check'))).toBe(false)
    expect(readFileSync(join(result.worktree!, 'tasks.task.md'), 'utf8')).toContain('- [x] Closure')
  }, 90_000)

  it('automatically commits completed closure changes left dirty inside authenticated scope', async () => {
    const repo = repository('- [?] Closure: repair `src` | paths=src\n')
    const worker: WorkerAdapter = { async run(request) {
      writeFileSync(join(request.worktree, 'src', 'value.txt'), 'closure repair\n')
      writeFileSync(join(request.worktree, 'src', 'empty.ts'), '')
      git(request.worktree, 'add', '-N', '--', 'src/empty.ts')
      return completedOutcome('closure repair complete; controller owns adoption')
    } }

    const result = await runLeppyLoop({ tasks: repo.tasks, syncBranch: 'main', fetch: false }, { ...modelDeps, worker })
    expect(result).toMatchObject({ status: 'completed', completedTasks: 1 })
    expect(readFileSync(join(result.worktree!, 'src', 'value.txt'), 'utf8')).toBe('closure repair\n')
    expect(existsSync(join(result.worktree!, 'src', 'empty.ts'))).toBe(true)
    expect(git(result.worktree!, 'ls-tree', '-r', '--name-only', 'HEAD')).toContain('src/empty.ts')
    expect(git(result.worktree!, 'status', '--short')).toBe('')
    expect(git(result.worktree!, 'rev-list', '--count', 'main..HEAD')).toBe('1')
    expect(git(result.worktree!, 'log', '-1', '--pretty=%s')).toContain('fix(leppy-loop): apply')
    expect(readFileSync(join(result.stateDir!, 'events.jsonl'), 'utf8')).toContain('completed-worker-changes')
  }, 90_000)

  it('restores out-of-scope validation side effects before and after a recovered closure worker', async () => {
    const repo = repository('- [?] Closure: inspect `src` | paths=src\n')
    mkdirSync(join(repo.root, 'generated'), { recursive: true })
    writeFileSync(join(repo.root, 'generated', 'settings.json'), '{"stable":true}\n')
    git(repo.root, 'add', '--', 'generated/settings.json')
    git(repo.root, 'commit', '-m', 'chore: seed generated settings')
    const blocked = new FakeWorker([{
      status: 'blocked', output: 'controller cleanup checkpoint', error: 'cleanup checkpoint',
      report: {
        status: 'blocked', disposition: 'implementation-impossible', summary: 'cleanup checkpoint',
        validation: { status: 'not-run', evidence: 'test pauses before recovered controller cleanup' },
      },
    }])
    const first = await runLeppyLoop({ tasks: repo.tasks, syncBranch: 'main', fetch: false }, { ...modelDeps, worker: blocked })
    rmSync(join(first.worktree!, 'generated', 'settings.json'))
    writeFileSync(join(first.worktree!, 'generated', 'temporary.txt'), 'transient\n')

    const recoveredWorker: WorkerAdapter = { async run(request) {
      expect(readFileSync(join(request.worktree, 'generated', 'settings.json'), 'utf8')).toBe('{"stable":true}\n')
      expect(existsSync(join(request.worktree, 'generated', 'temporary.txt'))).toBe(false)
      writeFileSync(join(request.worktree, 'generated', 'settings.json'), '{"mutated":true}\n')
      writeFileSync(join(request.worktree, 'generated', 'temporary.txt'), 'transient again\n')
      return completedOutcome('closure completed despite generated validation side effects')
    } }
    const recovered = await runLeppyLoop({
      tasks: repo.tasks, syncBranch: 'main', fetch: false, recoverExistingWip: true, recoverRunId: first.runId,
    }, { ...modelDeps, worker: recoveredWorker })

    expect(recovered).toMatchObject({ status: 'completed', completedTasks: 1 })
    expect(readFileSync(join(recovered.worktree!, 'generated', 'settings.json'), 'utf8')).toBe('{"stable":true}\n')
    expect(existsSync(join(recovered.worktree!, 'generated', 'temporary.txt'))).toBe(false)
    expect(git(recovered.worktree!, 'status', '--short')).toBe('')
    expect(readFileSync(join(recovered.stateDir!, 'events.jsonl'), 'utf8')).toContain('out-of-scope-validation-side-effects')
  }, 90_000)

  it('stalls a blocked closure without marking the controller row done', async () => {
    const repo = repository('- [?] Closure: inspect `src` | paths=src\n')
    const worker = new FakeWorker([{
      status: 'blocked', output: 'BLOQUEADO: validation unavailable', error: 'validation unavailable',
      report: {
        status: 'blocked', disposition: 'implementation-impossible', summary: 'required implementation cannot fit authenticated scope',
        validation: { status: 'not-run', evidence: 'required dependency is outside authenticated scope' },
      },
    }])
    const result = await runLeppyLoop({ tasks: repo.tasks, syncBranch: 'main', fetch: false }, { ...modelDeps, worker })
    expect(result).toMatchObject({ status: 'stalled', completedTasks: 0, currentTask: 0 })
    expect(readFileSync(join(result.worktree!, 'tasks.task.md'), 'utf8')).toContain('- [?] Closure')
    expect(readFileSync(join(result.stateDir!, 'events.jsonl'), 'utf8')).not.toContain('"type":"done"')
    expect(JSON.parse(readFileSync(join(result.stateDir!, 'run.json'), 'utf8'))).toMatchObject({ autoRecoveryBlocked: true, failureStreak: { count: 1 } })
    expect(git(result.worktree!, 'rev-list', '--count', 'main..HEAD')).toBe('0')
  }, 90_000)

  it('adopts a scoped committed task even when worker status follows advisory validation failure', async () => {
    const repo = repository('- [ ] Change `src/value.txt` | Done: focused validation passes\n')
    const worker: WorkerAdapter = {
      async run(request) {
        writeFileSync(join(request.worktree, 'src', 'value.txt'), 'partial\n')
        git(request.worktree, 'add', '--', 'src/value.txt')
        git(request.worktree, 'commit', '-m', 'feat: partial task result')
        return {
          status: 'blocked', output: 'Tests failed: 2 failing', error: 'tests failed',
          report: { status: 'blocked', summary: 'tests failed', validation: { status: 'failed', evidence: 'focused suite: 2 failing' } },
        }
      },
    }
    const result = await runLeppyLoop({ tasks: repo.tasks, syncBranch: 'main', fetch: false }, { ...modelDeps, worker })
    expect(result).toMatchObject({ status: 'completed', completedTasks: 1 })
    expect(readFileSync(join(result.worktree!, 'tasks.task.md'), 'utf8')).toContain('- [x] Change')
    expect(git(result.worktree!, 'log', '-1', '--pretty=%s')).toBe('feat: partial task result')
    expect(readFileSync(join(result.stateDir!, 'events.jsonl'), 'utf8')).toContain('advisory-worker-disposition')
  }, 90_000)

  it('adopts a committed task when the worker completes with advisory validation failure', async () => {
    const repo = repository('- [ ] Change `src/value.txt` | Done: implementation is correct by focused inspection\n')
    const advisory: WorkerAdapter = { async run(request) {
      writeFileSync(join(request.worktree, 'src', 'value.txt'), 'implemented\n')
      git(request.worktree, 'add', '--', 'src/value.txt')
      git(request.worktree, 'commit', '-m', 'feat: complete advisory candidate')
      return {
        status: 'completed', output: 'Vitest startup failed with spawn EPERM; implementation inspected',
        report: { status: 'completed', summary: 'implementation satisfies contract', validation: { status: 'failed', evidence: 'Vitest startup failed with spawn EPERM' } },
      }
    } }
    const result = await runLeppyLoop({ tasks: repo.tasks, syncBranch: 'main', fetch: false }, { ...modelDeps, worker: advisory })
    expect(result).toMatchObject({ status: 'completed', completedTasks: 1 })
    expect(readFileSync(join(result.worktree!, 'tasks.task.md'), 'utf8')).toContain('- [x] Change')
    expect(readFileSync(join(result.stateDir!, 'events.jsonl'), 'utf8')).toContain('Vitest startup failed with spawn EPERM')
  }, 90_000)

  it('adopts a blocked scoped candidate directly without detached ordinary verification', async () => {
    const repo = repository('- [ ] Change `src/value.txt` | paths=src/value.txt | Done: focused validation passes\n')
    const calls: WorkerRequest[] = []
    let durableRoot = ''
    let verificationRoot = ''
    const worker: WorkerAdapter = { async run(request) {
      calls.push(request)
      if (request.mode === 'verification') {
        verificationRoot = request.worktree
        expect(request.allowedPaths).toEqual([])
        expect(request.worktree).not.toBe(durableRoot)
        expect(request.worktree).toBe(join(request.stateDir, 'verification-worktree'))
        expect(git(request.worktree, 'branch', '--show-current')).toBe('')
        return completedOutcome('independent focused validation passed')
      }
      durableRoot = request.worktree
      writeFileSync(join(request.worktree, 'src', 'value.txt'), 'candidate\n')
      git(request.worktree, 'add', '--', 'src/value.txt')
      git(request.worktree, 'commit', '-m', 'feat: committed candidate')
      return blockedNotRunOutcome('validator unavailable after implementation commit')
    } }

    const result = await runLeppyLoop({ tasks: repo.tasks, syncBranch: 'main', fetch: false }, { ...modelDeps, worker })
    expect(result).toMatchObject({ status: 'completed', completedTasks: 1 })
    expect(calls.map(call => call.mode ?? 'task')).toEqual(['task'])
    expect(verificationRoot).toBe('')
    expect(readFileSync(join(result.worktree!, 'tasks.task.md'), 'utf8')).toContain('- [x] Change')
    expect(readFileSync(join(result.worktree!, 'src', 'value.txt'), 'utf8')).toBe('candidate\n')
    expect(git(result.worktree!, 'rev-list', '--count', 'main..HEAD')).toBe('1')
    const adoptedHead = git(result.worktree!, 'rev-parse', 'HEAD')
    const state = JSON.parse(readFileSync(join(result.stateDir!, 'run.json'), 'utf8'))
    expect(state).not.toHaveProperty('activeTaskAttempt')
    expect(state).not.toHaveProperty('pendingTaskValidation')
    expect((readFileSync(join(result.stateDir!, 'events.jsonl'), 'utf8').match(/"type":"done"/gu) ?? [])).toHaveLength(1)

    const forbidden = new FakeWorker()
    const repeated = await runLeppyLoop({
      tasks: repo.tasks, syncBranch: 'main', fetch: false, recoverExistingWip: true, recoverRunId: result.runId,
    }, { ...modelDeps, worker: forbidden })
    expect(repeated).toMatchObject({ status: 'completed', completedTasks: 1 })
    expect(forbidden.calls).toHaveLength(0)
    expect(git(result.worktree!, 'rev-parse', 'HEAD')).toBe(adoptedHead)
    expect((readFileSync(join(result.stateDir!, 'events.jsonl'), 'utf8').match(/"type":"done"/gu) ?? [])).toHaveLength(1)
  }, 90_000)

  it('normalizes multiple nonconventional ordinary commits instead of stopping on ceremony', async () => {
    const repo = repository('- [ ] Change `src` | paths=src | Done: scoped files are updated\n')
    const worker: WorkerAdapter = { async run(request) {
      writeFileSync(join(request.worktree, 'src', 'value.txt'), 'first\n')
      git(request.worktree, 'add', '--', 'src/value.txt')
      git(request.worktree, 'commit', '-m', 'first informal commit')
      writeFileSync(join(request.worktree, 'src', 'second.txt'), 'second\n')
      git(request.worktree, 'add', '--', 'src/second.txt')
      git(request.worktree, 'commit', '-m', 'second informal commit')
      return completedOutcome('implementation complete despite commit ceremony')
    } }

    const result = await runLeppyLoop(
      { tasks: repo.tasks, syncBranch: 'main', fetch: false },
      { ...modelDeps, worker },
    )
    expect(result).toMatchObject({ status: 'completed', completedTasks: 1 })
    expect(git(result.worktree!, 'rev-list', '--count', 'main..HEAD')).toBe('1')
    expect(git(result.worktree!, 'log', '-1', '--pretty=%s')).toContain('fix(leppy-loop): consolidate')
    expect(readFileSync(join(result.stateDir!, 'events.jsonl'), 'utf8')).toContain('worker-commit-ceremony')
  }, 90_000)

  it('keeps an unmerged ordinary Git index as a hard stop', async () => {
    const repo = repository('- [ ] Change `src/value.txt` | paths=src/value.txt | Done: resolve implementation\n')
    const worker: WorkerAdapter = { async run(request) {
      const oursPath = join(request.worktree, 'ours.txt')
      const theirsPath = join(request.worktree, 'theirs.txt')
      writeFileSync(oursPath, 'ours\n')
      writeFileSync(theirsPath, 'theirs\n')
      const base = git(request.worktree, 'rev-parse', 'HEAD:src/value.txt')
      const ours = git(request.worktree, 'hash-object', '-w', oursPath)
      const theirs = git(request.worktree, 'hash-object', '-w', theirsPath)
      rmSync(oursPath)
      rmSync(theirsPath)
      execFileSync('git', ['update-index', '--index-info'], {
        cwd: request.worktree,
        input: `100644 ${base} 1\tsrc/value.txt\n100644 ${ours} 2\tsrc/value.txt\n100644 ${theirs} 3\tsrc/value.txt\n`,
      })
      return completedOutcome('left unresolved index')
    } }

    await expect(runLeppyLoop(
      { tasks: repo.tasks, syncBranch: 'main', fetch: false },
      { ...modelDeps, worker },
    )).rejects.toThrow('unmerged Git index')
  }, 90_000)

  it('hard-stops checklist tampering before automatic out-of-scope cleanup', async () => {
    const repo = repository('- [ ] Change `src/value.txt` | paths=src/value.txt | Done: preserve controller ownership\n')
    const worker: WorkerAdapter = { async run(request) {
      writeFileSync(join(request.worktree, 'tasks.task.md'), '- [x] worker-owned mutation\n')
      writeFileSync(join(request.worktree, 'outside.txt'), 'tamper evidence\n')
      return completedOutcome('attempted controller mutation')
    } }

    await expect(runLeppyLoop(
      { tasks: repo.tasks, syncBranch: 'main', fetch: false },
      { ...modelDeps, worker },
    )).rejects.toThrow('worker altered the controlling checklist')
    const stateRoot = join(repo.root, '.git', 'leppy-loop', 'runs')
    const [runId] = readdirSync(stateRoot)
    const state = JSON.parse(readFileSync(join(stateRoot, runId!, 'run.json'), 'utf8'))
    expect(state.status).toBe('failed')
    expect(readFileSync(join(state.worktree, 'outside.txt'), 'utf8')).toBe('tamper evidence\n')
  }, 90_000)

  it('hard-stops an out-of-scope unmerged index before cleanup can erase it', async () => {
    const repo = repository('- [ ] Change `src/value.txt` | paths=src/value.txt | Done: preserve unmerged evidence\n')
    const worker: WorkerAdapter = { async run(request) {
      const oursPath = join(request.worktree, 'ours.txt')
      const theirsPath = join(request.worktree, 'theirs.txt')
      writeFileSync(oursPath, 'ours\n')
      writeFileSync(theirsPath, 'theirs\n')
      const base = git(request.worktree, 'rev-parse', 'HEAD:outside.txt')
      const ours = git(request.worktree, 'hash-object', '-w', oursPath)
      const theirs = git(request.worktree, 'hash-object', '-w', theirsPath)
      rmSync(oursPath)
      rmSync(theirsPath)
      execFileSync('git', ['update-index', '--index-info'], {
        cwd: request.worktree,
        input: `100644 ${base} 1\toutside.txt\n100644 ${ours} 2\toutside.txt\n100644 ${theirs} 3\toutside.txt\n`,
      })
      return completedOutcome('left out-of-scope unmerged index')
    } }
    writeFileSync(join(repo.root, 'outside.txt'), 'base\n')
    git(repo.root, 'add', '--', 'outside.txt')
    git(repo.root, 'commit', '-m', 'test: add out-of-scope base')

    await expect(runLeppyLoop(
      { tasks: repo.tasks, syncBranch: 'main', fetch: false },
      { ...modelDeps, worker },
    )).rejects.toThrow('unmerged Git index')
  }, 90_000)

  it('hard-stops an index-only checklist mutation before cleanup can erase it', async () => {
    const repo = repository('- [ ] Change `src/value.txt` | paths=src/value.txt | Done: preserve checklist index\n')
    const worker: WorkerAdapter = { async run(request) {
      const malicious = execFileSync('git', ['hash-object', '-w', '--stdin'], {
        cwd: request.worktree, input: '- [x] staged-only worker mutation\n', encoding: 'utf8',
      }).trim()
      git(request.worktree, 'update-index', '--cacheinfo', `100644,${malicious},tasks.task.md`)
      expect(readFileSync(join(request.worktree, 'tasks.task.md'), 'utf8')).toContain('- [ ] Change')
      return completedOutcome('staged only checklist mutation')
    } }

    await expect(runLeppyLoop(
      { tasks: repo.tasks, syncBranch: 'main', fetch: false },
      { ...modelDeps, worker },
    )).rejects.toThrow('worker altered controller-owned Git paths: tasks.task.md')
  }, 90_000)

  it('waits fail-closed for a live authenticated lease without killing a reusable PID', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'leppy-live-lease-'))
    const leaseDir = join(stateDir, 'leases')
    mkdirSync(leaseDir)
    const key = createLeaseKey(stateDir)
    const lease = signLease({
      schemaVersion: 1, runId: 'lease-run', taskIndex: 0, attempt: 1,
      pid: 4242, processStart: 'still-live', heartbeat: new Date().toISOString(),
    }, key)
    writeFileSync(join(leaseDir, '0-1.json'), `${JSON.stringify(lease)}\n`)

    await expect(awaitAuthenticatedLeaseSettlement(stateDir, 'lease-run', {
      inspect: async () => ({ status: 'found', identity: 'still-live' }), wait: async () => {}, maxChecks: 2,
    })).rejects.toThrow('will not terminate a reusable PID')

    let checks = 0
    await expect(awaitAuthenticatedLeaseSettlement(stateDir, 'lease-run', {
      inspect: async () => {
        checks += 1
        return { status: 'found', identity: checks === 1 ? 'still-live' : 'reused-by-unrelated-process' }
      },
      wait: async () => {}, maxChecks: 2,
    })).resolves.toBeUndefined()
    expect(checks).toBe(2)

    checks = 0
    await expect(awaitAuthenticatedLeaseSettlement(stateDir, 'lease-run', {
      inspect: async () => {
        checks += 1
        return checks === 1
          ? { status: 'error', detail: 'transient inspection failure' }
          : { status: 'found', identity: 'still-live' }
      },
      wait: async () => {}, maxChecks: 2,
    })).rejects.toThrow('will not terminate a reusable PID')

    await expect(awaitAuthenticatedLeaseSettlement(stateDir, 'lease-run', {
      inspect: async () => ({ status: 'error', detail: 'persistent inspection failure' }),
      wait: async () => {}, maxChecks: 2,
    })).rejects.toThrow('identity inspection failed closed')
  })

  it('quarantines a baseline-absent ignored side effect before directly adopting the candidate', async () => {
    const repo = repository('- [ ] Change `src/value.txt` | paths=src/value.txt | Done: focused validation passes\n')
    writeFileSync(join(repo.root, '.gitignore'), 'ignored-worker-output/\n')
    git(repo.root, 'add', '--', '.gitignore')
    git(repo.root, 'commit', '-m', 'chore: ignore worker-local output')
    let candidateHead = ''
    const worker: WorkerAdapter = { async run(request) {
      if (request.mode === 'verification') {
        expect(existsSync(join(request.worktree, 'ignored-worker-output', 'report.json'))).toBe(false)
        return completedOutcome('focused validation passed without quarantined output')
      }
      mkdirSync(join(request.worktree, 'ignored-worker-output'), { recursive: true })
      writeFileSync(join(request.worktree, 'ignored-worker-output', 'report.json'), '{"forged":true}\n')
      writeFileSync(join(request.worktree, 'src', 'value.txt'), 'candidate plus ignored artifact\n')
      git(request.worktree, 'add', '--', 'src/value.txt')
      git(request.worktree, 'commit', '-m', 'feat: candidate with ignored side effect')
      candidateHead = git(request.worktree, 'rev-parse', 'HEAD')
      return blockedNotRunOutcome('focused validator unavailable')
    } }

    const result = await runLeppyLoop(
      { tasks: repo.tasks, syncBranch: 'main', fetch: false },
      { ...modelDeps, runId: () => 'ignoredpath01', worker },
    )
    expect(result).toMatchObject({ status: 'completed', completedTasks: 1 })
    const stateDir = join(repo.root, '.git', 'leppy-loop', 'runs', 'ignoredpath01')
    const state = JSON.parse(readFileSync(join(stateDir, 'run.json'), 'utf8'))
    expect(state).not.toHaveProperty('activeTaskAttempt')
    expect(state).not.toHaveProperty('pendingTaskValidation')
    expect(git(state.worktree, 'rev-parse', 'HEAD')).not.toBe(candidateHead)
    expect(existsSync(join(state.worktree, 'ignored-worker-output', 'report.json'))).toBe(false)
    const receipt = JSON.parse(readFileSync(join(stateDir, 'worker-ignored-path-recovery', '0-1.json'), 'utf8'))
    expect(receipt).toMatchObject({ phase: 'quarantined', baselineDigest: expect.stringMatching(/^[0-9a-f]{64}$/u) })
    expect(readFileSync(join(receipt.quarantineRoot, 'ignored-worker-output', 'report.json'), 'utf8')).toBe('{"forged":true}\n')
  }, 90_000)

  it('recovers a legacy active attempt when its authenticated digest proves an empty ignored baseline', async () => {
    const repo = repository('- [ ] Change `src/value.txt` | paths=src/value.txt | Done: implementation committed\n')
    writeFileSync(join(repo.root, '.gitignore'), 'ignored-worker-output/\n')
    git(repo.root, 'add', '--', '.gitignore')
    git(repo.root, 'commit', '-m', 'chore: ignore worker-local output')
    const first = await runLeppyLoop(
      { tasks: repo.tasks, syncBranch: 'main', fetch: false },
      { ...modelDeps, runId: () => 'legacyignored01', worker: new FakeWorker([implementationImpossibleOutcome('seed legacy active state')]) },
    )
    const statePath = join(first.stateDir!, 'run.json')
    const state = JSON.parse(readFileSync(statePath, 'utf8'))
    const checklistSource = readFileSync(join(first.worktree!, 'tasks.task.md'), 'utf8')
    const task = selectTask(parseChecklist(checklistSource, join(first.worktree!, 'tasks.task.md')))!
    state.activeTaskAttempt = {
      schemaVersion: 1,
      taskKey: createHash('sha256').update(JSON.stringify({ index: task.index, phase: task.phase, kind: task.kind, raw: task.raw })).digest('hex'),
      taskIndex: task.index,
      baseHead: git(first.worktree!, 'rev-parse', 'HEAD'),
      checklistDigest: createHash('sha256').update(checklistSource).digest('hex'),
      ignoredPathsDigest: createHash('sha256').update(JSON.stringify([])).digest('hex'),
      attempt: state.attempt,
    }
    delete state.stateProof
    writeFileSync(statePath, `${JSON.stringify(state)}\n`)
    persistRunStateProof(first.stateDir!, state, Buffer.from(readFileSync(join(first.stateDir!, 'lease.key'), 'utf8').trim(), 'base64'))
    rmSync(join(first.stateDir!, 'worker-ignored-path-baselines'), { recursive: true, force: true })
    mkdirSync(join(first.worktree!, 'ignored-worker-output'), { recursive: true })
    writeFileSync(join(first.worktree!, 'ignored-worker-output', 'attempt-12.log'), 'legacy worker output\n')

    const worker: WorkerAdapter = { async run(request) {
      expect(existsSync(join(request.worktree, 'ignored-worker-output', 'attempt-12.log'))).toBe(false)
      writeFileSync(join(request.worktree, 'src', 'value.txt'), 'completed after legacy ignored recovery\n')
      git(request.worktree, 'add', '--', 'src/value.txt')
      git(request.worktree, 'commit', '-m', 'fix: complete after ignored recovery')
      return completedOutcome('implementation committed after safe quarantine')
    } }
    const recovered = await runLeppyLoop({
      tasks: repo.tasks, syncBranch: 'main', fetch: false, recoverExistingWip: true, recoverRunId: first.runId,
    }, { ...modelDeps, worker })
    expect(recovered).toMatchObject({ status: 'completed', completedTasks: 1 })
    const receipt = JSON.parse(readFileSync(join(first.stateDir!, 'worker-ignored-path-recovery', `0-${state.attempt}.json`), 'utf8'))
    expect(receipt).toMatchObject({ phase: 'quarantined' })
    expect(readFileSync(join(receipt.quarantineRoot, 'ignored-worker-output', 'attempt-12.log'), 'utf8')).toBe('legacy worker output\n')
  }, 90_000)

  it('recovers a committed legacy attempt with an exact base-ignored tracked promotion plus four additions', async () => {
    const repo = repository('- [ ] Change `src/value.txt` | paths=src/value.txt,config | Done: implementation committed\n')
    mkdirSync(join(repo.root, 'config'))
    writeFileSync(join(repo.root, 'config', '.gitignore'), 'worker-output/\n')
    git(repo.root, 'add', '--', 'config/.gitignore')
    git(repo.root, 'commit', '-m', 'chore: ignore worker-local output')
    const first = await runLeppyLoop(
      { tasks: repo.tasks, syncBranch: 'main', fetch: false },
      { ...modelDeps, runId: () => 'legacysubset01', worker: new FakeWorker([implementationImpossibleOutcome('seed legacy state')]) },
    )
    const statePath = join(first.stateDir!, 'run.json')
    const state = JSON.parse(readFileSync(statePath, 'utf8'))
    const checklistSource = readFileSync(join(first.worktree!, 'tasks.task.md'), 'utf8')
    const task = selectTask(parseChecklist(checklistSource, join(first.worktree!, 'tasks.task.md')))!
    mkdirSync(join(first.worktree!, 'config', 'worker-output'), { recursive: true })
    const preserved = join(first.worktree!, 'config', 'worker-output', 'pre-existing.env')
    writeFileSync(preserved, 'pre-existing ignored WIP\n')
    const authenticatedBaseline = await gitModule.ignoredPathSnapshot(first.worktree!)
    const baseHead = git(first.worktree!, 'rev-parse', 'HEAD')
    writeFileSync(join(first.worktree!, 'src', 'value.txt'), 'committed candidate\n')
    writeFileSync(join(first.worktree!, 'config', '.gitignore'), 'worker-output/worker-report-*.json\n')
    git(first.worktree!, 'add', '--', 'src/value.txt', 'config/.gitignore')
    git(first.worktree!, 'add', '-f', '--', 'config/worker-output/pre-existing.env')
    git(first.worktree!, 'commit', '-m', 'feat: committed legacy candidate')
    state.activeTaskAttempt = {
      schemaVersion: 1,
      taskKey: createHash('sha256').update(JSON.stringify({ index: task.index, phase: task.phase, kind: task.kind, raw: task.raw })).digest('hex'),
      taskIndex: task.index, baseHead,
      checklistDigest: createHash('sha256').update(checklistSource).digest('hex'),
      ignoredPathsDigest: authenticatedBaseline.digest,
      attempt: state.attempt,
    }
    state.lastError = 'worker ignored artifact recovery cannot prove its legacy non-empty baseline from current fingerprints after exact tracked and untracked base-ignore inference within 4 additions and 3 candidates'
    state.autoRecoveryBlocked = true
    const bridgeIdentity = workerIgnoredBaselineBridgeIdentity(state.lastError, state.activeTaskAttempt)!
    state.ignoredBaselineBridge = { ...bridgeIdentity, phase: 'prepared', authorityEpoch: 1, authorityTransition: 1, requestDigest: 'c'.repeat(64) }
    delete state.stateProof
    writeFileSync(statePath, `${JSON.stringify(state)}\n`)
    persistRunStateProof(first.stateDir!, state, Buffer.from(readFileSync(join(first.stateDir!, 'lease.key'), 'utf8').trim(), 'base64'))
    rmSync(join(first.stateDir!, 'worker-ignored-path-baselines'), { recursive: true, force: true })
    const outputs = Array.from({ length: 4 }, (_value, index) => {
      const path = join(first.worktree!, 'config', 'worker-output', `worker-report-${index}.json`)
      writeFileSync(path, `{"worker":${index}}\n`)
      return path
    })

    let verifierCalls = 0
    const verifier: WorkerAdapter = { async run(request) {
      verifierCalls += 1
      expect(request.mode).toBe('verification')
      expect(outputs.every(path => !existsSync(path))).toBe(true)
      expect(readFileSync(preserved, 'utf8')).toBe('pre-existing ignored WIP\n')
      return completedOutcome('candidate independently verified')
    } }
    const recovered = await runLeppyLoop({
      tasks: repo.tasks, syncBranch: 'main', fetch: false, recoverExistingWip: true, recoverRunId: first.runId,
      ignoredBaselineRecovery: bridgeIdentity,
    }, { ...modelDeps, worker: verifier })
    expect(recovered).toMatchObject({ status: 'completed', completedTasks: 1 })
    expect(verifierCalls).toBe(0)
    expect(readFileSync(preserved, 'utf8')).toBe('pre-existing ignored WIP\n')
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({ ignoredBaselineBridge: { ...bridgeIdentity, phase: 'consumed', authorityEpoch: 1, authorityTransition: 1, requestDigest: 'c'.repeat(64) } })
    const baselineReceipt = JSON.parse(readFileSync(join(first.stateDir!, 'worker-ignored-path-baselines', `0-${state.attempt}.json`), 'utf8'))
    expect(baselineReceipt).toMatchObject({
      basis: 'authenticated-subset-digest', digest: authenticatedBaseline.digest,
      entries: [{ path: 'config/worker-output/pre-existing.env' }],
    })
    const receipt = JSON.parse(readFileSync(join(first.stateDir!, 'worker-ignored-path-recovery', `0-${state.attempt}.json`), 'utf8'))
    for (let index = 0; index < 4; index += 1) {
      expect(readFileSync(join(receipt.quarantineRoot, 'config', 'worker-output', `worker-report-${index}.json`), 'utf8')).toBe(`{"worker":${index}}\n`)
    }
  }, 90_000)

  it('discards non-ignored out-of-scope WIP but leaves ignored bytes when legacy proof fails', async () => {
    const repo = repository('- [ ] Change `src/value.txt` | paths=src/value.txt | Done: implementation committed\n')
    writeFileSync(join(repo.root, '.gitignore'), 'generated/\n')
    git(repo.root, 'add', '--', '.gitignore')
    git(repo.root, 'commit', '-m', 'chore: ignore generated output')
    const first = await runLeppyLoop(
      { tasks: repo.tasks, syncBranch: 'main', fetch: false },
      { ...modelDeps, runId: () => 'legacyordinary1', worker: new FakeWorker([implementationImpossibleOutcome('seed legacy state')]) },
    )
    const statePath = join(first.stateDir!, 'run.json')
    const state = JSON.parse(readFileSync(statePath, 'utf8'))
    const checklistSource = readFileSync(join(first.worktree!, 'tasks.task.md'), 'utf8')
    const task = selectTask(parseChecklist(checklistSource, join(first.worktree!, 'tasks.task.md')))!
    const exclude = resolve(first.worktree!, git(first.worktree!, 'rev-parse', '--git-path', 'info/exclude'))
    writeFileSync(exclude, 'private/\n')
    mkdirSync(join(first.worktree!, 'private'))
    const preserved = join(first.worktree!, 'private', 'pre-existing.env')
    writeFileSync(preserved, 'pre-existing ignored WIP\n')
    const authenticatedBaseline = await gitModule.ignoredPathSnapshot(first.worktree!)
    const baseHead = git(first.worktree!, 'rev-parse', 'HEAD')
    writeFileSync(exclude, '')
    writeFileSync(join(first.worktree!, 'src', 'value.txt'), 'committed candidate\n')
    git(first.worktree!, 'add', '--', 'src/value.txt')
    git(first.worktree!, 'commit', '-m', 'feat: committed candidate')
    state.activeTaskAttempt = {
      schemaVersion: 1,
      taskKey: createHash('sha256').update(JSON.stringify({ index: task.index, phase: task.phase, kind: task.kind, raw: task.raw })).digest('hex'),
      taskIndex: task.index, baseHead,
      checklistDigest: createHash('sha256').update(checklistSource).digest('hex'),
      ignoredPathsDigest: authenticatedBaseline.digest,
      attempt: state.attempt,
    }
    state.lastError = 'worker ignored artifact recovery cannot prove its legacy non-empty baseline from current fingerprints after exact tracked and untracked base-ignore inference within 4 additions and 3 candidates'
    state.autoRecoveryBlocked = true
    const bridgeIdentity = workerIgnoredBaselineBridgeIdentity(state.lastError, state.activeTaskAttempt)!
    state.ignoredBaselineBridge = {
      ...bridgeIdentity, phase: 'prepared', authorityEpoch: 1, authorityTransition: 1, requestDigest: 'c'.repeat(64),
    }
    delete state.stateProof
    writeFileSync(statePath, `${JSON.stringify(state)}\n`)
    persistRunStateProof(first.stateDir!, state, Buffer.from(readFileSync(join(first.stateDir!, 'lease.key'), 'utf8').trim(), 'base64'))
    rmSync(join(first.stateDir!, 'worker-ignored-path-baselines'), { recursive: true, force: true })
    mkdirSync(join(first.worktree!, 'generated'))
    const ignoredOutput = join(first.worktree!, 'generated', 'worker-report.json')
    const ordinaryOutput = join(first.worktree!, 'private', 'unproven-worker-report.json')
    writeFileSync(ignoredOutput, '{"worker":"ignored"}\n')
    writeFileSync(ordinaryOutput, '{"worker":"ordinary-unproven"}\n')
    const verifier = new FakeWorker([completedOutcome('must not verify dirty preserved WIP')])

    await expect(runLeppyLoop({
      tasks: repo.tasks, syncBranch: 'main', fetch: false, recoverExistingWip: true, recoverRunId: first.runId,
      ignoredBaselineRecovery: bridgeIdentity,
    }, { ...modelDeps, worker: verifier })).rejects.toThrow('worker ignored artifact recovery cannot prove its legacy non-empty baseline')
    expect(verifier.calls).toHaveLength(0)
    expect(JSON.parse(readFileSync(statePath, 'utf8')).ignoredBaselineBridge).toMatchObject({
      ...bridgeIdentity, phase: 'consumed',
    })
    expect(existsSync(preserved)).toBe(false)
    expect(existsSync(ordinaryOutput)).toBe(false)
    expect(readFileSync(ignoredOutput, 'utf8')).toBe('{"worker":"ignored"}\n')
    expect(existsSync(join(first.stateDir!, 'worker-ignored-path-recovery', `0-${state.attempt}.json`))).toBe(false)
  }, 90_000)

  it('does not infer or move legacy ignored state while an authenticated lease remains live', async () => {
    const repo = repository('- [ ] Change `src/value.txt` | paths=src/value.txt | Done: implementation committed\n')
    writeFileSync(join(repo.root, '.gitignore'), 'ignored-worker-output/\n')
    git(repo.root, 'add', '--', '.gitignore')
    git(repo.root, 'commit', '-m', 'chore: ignore worker-local output')
    const first = await runLeppyLoop(
      { tasks: repo.tasks, syncBranch: 'main', fetch: false },
      { ...modelDeps, runId: () => 'legacylive01', worker: new FakeWorker([implementationImpossibleOutcome('seed live lease recovery')]) },
    )
    const statePath = join(first.stateDir!, 'run.json')
    const state = JSON.parse(readFileSync(statePath, 'utf8'))
    const checklistSource = readFileSync(join(first.worktree!, 'tasks.task.md'), 'utf8')
    const task = selectTask(parseChecklist(checklistSource, join(first.worktree!, 'tasks.task.md')))!
    mkdirSync(join(first.worktree!, 'ignored-worker-output'), { recursive: true })
    writeFileSync(join(first.worktree!, 'ignored-worker-output', 'pre-existing.txt'), 'baseline\n')
    const authenticatedBaseline = await gitModule.ignoredPathSnapshot(first.worktree!)
    state.activeTaskAttempt = {
      schemaVersion: 1,
      taskKey: createHash('sha256').update(JSON.stringify({ index: task.index, phase: task.phase, kind: task.kind, raw: task.raw })).digest('hex'),
      taskIndex: task.index, baseHead: git(first.worktree!, 'rev-parse', 'HEAD'),
      checklistDigest: createHash('sha256').update(checklistSource).digest('hex'),
      ignoredPathsDigest: authenticatedBaseline.digest, attempt: state.attempt,
    }
    delete state.stateProof
    writeFileSync(statePath, `${JSON.stringify(state)}\n`)
    persistRunStateProof(first.stateDir!, state, Buffer.from(readFileSync(join(first.stateDir!, 'lease.key'), 'utf8').trim(), 'base64'))
    rmSync(join(first.stateDir!, 'worker-ignored-path-baselines'), { recursive: true, force: true })
    const workerOutput = join(first.worktree!, 'ignored-worker-output', 'live-worker.log')
    writeFileSync(workerOutput, 'still writing\n')
    const worker = new FakeWorker()

    await expect(runLeppyLoop({
      tasks: repo.tasks, syncBranch: 'main', fetch: false, recoverExistingWip: true, recoverRunId: first.runId,
    }, {
      ...modelDeps, worker,
      awaitAuthenticatedLeaseSettlement: async () => { throw new Error('authenticated worker lease process remains live; recovery will not terminate a reusable PID: 4242') },
    })).rejects.toThrow('will not terminate a reusable PID')
    expect(worker.calls).toHaveLength(0)
    expect(readFileSync(workerOutput, 'utf8')).toBe('still writing\n')
    expect(existsSync(join(first.stateDir!, 'worker-ignored-path-recovery', `0-${state.attempt}.json`))).toBe(false)
    expect(JSON.parse(readFileSync(statePath, 'utf8')).activeTaskAttempt).toMatchObject({ ignoredPathsDigest: authenticatedBaseline.digest })
  }, 90_000)

  it('automatically quarantines task-generated ignored npm cache while preserving bytes in private state', async () => {
    const repo = repository('- [ ] Change `src/value.txt` | paths=src/value.txt | Done: implementation committed\n')
    writeFileSync(join(repo.root, '.gitignore'), '.npm-cache/\n')
    git(repo.root, 'add', '--', '.gitignore')
    git(repo.root, 'commit', '-m', 'chore: ignore task npm cache')
    const worker: WorkerAdapter = { async run(request) {
      mkdirSync(join(request.worktree, '.npm-cache', '_logs'), { recursive: true })
      writeFileSync(join(request.worktree, '.npm-cache', '_logs', 'task.log'), 'task-generated cache bytes\n')
      writeFileSync(join(request.worktree, 'src', 'value.txt'), 'completed without cache pollution\n')
      git(request.worktree, 'add', '--', 'src/value.txt')
      git(request.worktree, 'commit', '-m', 'feat: complete task before cache quarantine')
      return completedOutcome('implementation committed')
    } }

    const result = await runLeppyLoop({ tasks: repo.tasks, syncBranch: 'main', fetch: false }, { ...modelDeps, worker })
    expect(result).toMatchObject({ status: 'completed', completedTasks: 1 })
    expect(existsSync(join(result.worktree!, '.npm-cache'))).toBe(false)
    expect(git(result.worktree!, 'status', '--porcelain')).toBe('')
    const receipt = JSON.parse(readFileSync(join(result.stateDir!, 'worker-npm-cache-recovery.json'), 'utf8'))
    expect(receipt).toMatchObject({ runId: result.runId, phase: 'quarantined', basis: 'baseline-absent' })
    expect(readFileSync(join(receipt.quarantine, '_logs', 'task.log'), 'utf8')).toBe('task-generated cache bytes\n')
    expect(readFileSync(join(result.stateDir!, 'events.jsonl'), 'utf8')).toContain('"automatic":true')
  }, 90_000)

  it('does not create a detached verifier or pollute the durable worktree after advisory validation', async () => {
    const repo = repository('- [ ] Change `src/value.txt` | paths=src/value.txt | Done: focused validation passes\n')
    writeFileSync(join(repo.root, '.gitignore'), '.npm-cache/\n')
    git(repo.root, 'add', '--', '.gitignore')
    git(repo.root, 'commit', '-m', 'chore: ignore local cache')
    let durableRoot = ''
    let verificationRoot = ''
    const worker: WorkerAdapter = { async run(request) {
      if (request.mode === 'verification') {
        verificationRoot = request.worktree
        mkdirSync(join(request.worktree, '.npm-cache', '_logs'), { recursive: true })
        writeFileSync(join(request.worktree, '.npm-cache', '_logs', 'verifier.log'), 'disposable verifier cache\n')
        expect(git(request.worktree, 'status', '--porcelain')).toBe('')
        return completedOutcome('validation passed despite disposable cache')
      }
      durableRoot = request.worktree
      writeFileSync(join(request.worktree, 'src', 'value.txt'), 'isolated-candidate\n')
      git(request.worktree, 'add', '--', 'src/value.txt')
      git(request.worktree, 'commit', '-m', 'feat: isolated candidate')
      return blockedNotRunOutcome('focused validator was unavailable in task worker')
    } }

    const result = await runLeppyLoop({ tasks: repo.tasks, syncBranch: 'main', fetch: false }, { ...modelDeps, worker })
    expect(result.status).toBe('completed')
    expect(result.worktree).toBe(durableRoot)
    expect(verificationRoot).toBe('')
    expect(existsSync(join(durableRoot, '.npm-cache'))).toBe(false)
    expect(readFileSync(join(durableRoot, 'src', 'value.txt'), 'utf8')).toBe('isolated-candidate\n')
    expect(git(durableRoot, 'status', '--porcelain')).toBe('')
    expect(git(repo.root, 'worktree', 'list', '--porcelain').match(/^worktree /gmu)).toHaveLength(2)
  }, 90_000)

  it.skip('obsolete: detached ordinary verification no longer creates pending candidates', async () => {
    const repo = repository('- [ ] Change `src/value.txt` | paths=src/value.txt | Done: focused validation passes\n')
    const calls: WorkerRequest[] = []
    let candidateHead = ''
    const worker: WorkerAdapter = { async run(request) {
      calls.push(request)
      if (request.mode === 'verification') return blockedNotRunOutcome('independent verifier unavailable')
      writeFileSync(join(request.worktree, 'src', 'value.txt'), 'pending-candidate\n')
      git(request.worktree, 'add', '--', 'src/value.txt')
      git(request.worktree, 'commit', '-m', 'feat: pending candidate')
      candidateHead = git(request.worktree, 'rev-parse', 'HEAD')
      return blockedNotRunOutcome('task worker could not run validation')
    } }

    const result = await runLeppyLoop({ tasks: repo.tasks, syncBranch: 'main', fetch: false }, { ...modelDeps, worker })
    expect(result).toMatchObject({ status: 'stalled', completedTasks: 0, currentTask: 0 })
    expect(calls.map(call => call.mode ?? 'task')).toEqual(['task', 'verification'])
    expect(git(result.worktree!, 'rev-parse', 'HEAD')).toBe(candidateHead)
    expect(readFileSync(join(result.worktree!, 'tasks.task.md'), 'utf8')).toContain('- [ ] Change')
    expect(existsSync(join(result.stateDir!, 'verification-worktree'))).toBe(false)
    const state = JSON.parse(readFileSync(join(result.stateDir!, 'run.json'), 'utf8'))
    expect(state).toMatchObject({
      status: 'stalled', autoRecoveryBlocked: true, failureStreak: { count: 1 },
      pendingTaskValidation: { phase: 'pending', commitHead: candidateHead, verifierAttempts: 1 },
    })
    expect(state).not.toHaveProperty('activeTaskAttempt')
    expect(state.lastError).toContain('independent verifier unavailable')
    expect(readFileSync(join(result.stateDir!, 'events.jsonl'), 'utf8')).not.toContain('"type":"done"')
  }, 90_000)

  it('adopts safe scoped WIP after a generic worker failure instead of opening a circuit', async () => {
    const repo = repository('- [ ] Change `src/value.txt` | paths=src/value.txt | Done: focused validation passes\n')
    const calls: WorkerRequest[] = []
    const worker: WorkerAdapter = { async run(request) {
      calls.push(request)
      writeFileSync(join(request.worktree, 'src', 'value.txt'), 'failed-candidate\n')
      git(request.worktree, 'add', '--', 'src/value.txt')
      git(request.worktree, 'commit', '-m', 'feat: failed candidate must remain unadopted')
      return { status: 'failed', output: '', error: 'ordinary worker failure' }
    } }

    const result = await runLeppyLoop({ tasks: repo.tasks, syncBranch: 'main', fetch: false }, { ...modelDeps, worker })
    expect(result).toMatchObject({ status: 'completed', completedTasks: 1 })
    expect(calls).toHaveLength(1)
    const state = JSON.parse(readFileSync(join(result.stateDir!, 'run.json'), 'utf8'))
    expect(state).not.toHaveProperty('pendingTaskValidation')
    expect(state).not.toHaveProperty('activeTaskAttempt')
    expect(readFileSync(join(result.worktree!, 'tasks.task.md'), 'utf8')).toContain('- [x] Change')
    expect(git(result.worktree!, 'rev-list', '--count', 'main..HEAD')).toBe('1')
  }, 90_000)

  it('recovers a scoped committed active attempt without requiring semantic terminal receipts', async () => {
    const repo = repository('- [ ] Change `src/value.txt` | paths=src/value.txt | Done: focused validation passes\n')
    const control = new AbortController()
    let firstRequest: WorkerRequest | undefined
    const interruptedWorker: WorkerAdapter = { async run(request) {
      firstRequest = request
      writeFileSync(join(request.worktree, 'src', 'value.txt'), 'committed-before-interrupt\n')
      git(request.worktree, 'add', '--', 'src/value.txt')
      git(request.worktree, 'commit', '-m', 'feat: committed before interruption')
      control.abort(new Error('simulated interruption after committed task'))
      return { status: 'interrupted', output: '', error: 'simulated interruption after committed task' }
    } }

    await expect(runLeppyLoop(
      { tasks: repo.tasks, syncBranch: 'main', fetch: false },
      { ...modelDeps, worker: interruptedWorker, signal: control.signal },
    )).rejects.toThrow('simulated interruption after committed task')
    expect(firstRequest).toBeDefined()
    const stateDir = firstRequest!.stateDir
    const interruptedState = JSON.parse(readFileSync(join(stateDir, 'run.json'), 'utf8'))
    expect(interruptedState).toMatchObject({
      status: 'interrupted', activeTaskAttempt: { taskIndex: 0, baseHead: expect.any(String), attempt: 1 },
    })
    expect(interruptedState).not.toHaveProperty('pendingTaskValidation')
    expect(readFileSync(join(firstRequest!.worktree, 'tasks.task.md'), 'utf8')).toContain('- [ ] Change')
    expect(git(firstRequest!.worktree, 'rev-list', '--count', 'main..HEAD')).toBe('1')

    expect(interruptedState.activeTaskAttempt).toMatchObject({
      schemaVersion: 2,
      terminalOutcome: { disposition: 'failed-or-unknown', outcomeDigest: expect.any(String) },
    })
    const verificationWorker = { run: vi.fn(async () => completedOutcome('must not run')) }
    const recovered = await runLeppyLoop({
      tasks: repo.tasks, syncBranch: 'main', fetch: false, recoverExistingWip: true, recoverRunId: firstRequest!.runId,
    }, { ...modelDeps, worker: verificationWorker })
    expect(recovered).toMatchObject({ status: 'completed', completedTasks: 1 })
    expect(verificationWorker.run).not.toHaveBeenCalled()
    expect(existsSync(join(stateDir, 'verification-worktree'))).toBe(false)
    expect(readFileSync(join(firstRequest!.worktree, 'tasks.task.md'), 'utf8')).toContain('- [x] Change')
  }, 90_000)

  it('adopts a recovered unavailable worker commit directly by Git invariants', async () => {
    const repo = repository('- [ ] Change `src/value.txt` | paths=src/value.txt | Done: focused validation passes\n')
    const control = new AbortController()
    let firstRequest: WorkerRequest | undefined
    const unavailableWorker: WorkerAdapter = { async run(request) {
      firstRequest = request
      writeFileSync(join(request.worktree, 'src', 'value.txt'), 'committed-before-unavailable\n')
      git(request.worktree, 'add', '--', 'src/value.txt')
      git(request.worktree, 'commit', '-m', 'feat: committed before unavailable validation')
      control.abort(new Error('simulated host interruption after unavailable validation'))
      return { status: 'unavailable', output: '', error: 'LEPPY_WINDOWS_NAMED_PIPE_UNAVAILABLE' }
    } }
    await expect(runLeppyLoop(
      { tasks: repo.tasks, syncBranch: 'main', fetch: false },
      { ...modelDeps, worker: unavailableWorker, signal: control.signal },
    )).rejects.toThrow('simulated host interruption')
    const stateDir = firstRequest!.stateDir
    const interrupted = JSON.parse(readFileSync(join(stateDir, 'run.json'), 'utf8'))
    expect(interrupted.activeTaskAttempt).toMatchObject({
      schemaVersion: 2,
      terminalOutcome: { disposition: 'validation-unavailable', outcomeDigest: expect.any(String) },
    })

    const calls: WorkerRequest[] = []
    const verifier: WorkerAdapter = { async run(request) { calls.push(request); return completedOutcome('recovered safely') } }
    const recovered = await runLeppyLoop({
      tasks: repo.tasks, syncBranch: 'main', fetch: false, recoverExistingWip: true, recoverRunId: firstRequest!.runId,
    }, { ...modelDeps, worker: verifier })
    expect(recovered).toMatchObject({ status: 'completed', completedTasks: 1 })
    expect(calls).toHaveLength(0)
  }, 90_000)

  it.skip('legacy staged pending candidate fixture retired with advisory adoption', async () => {
    const repo = repository('- [ ] Change `src/value.txt` | paths=src/value.txt | Done: focused validation passes\n')
    const worker: WorkerAdapter = { async run(request) {
      if (request.mode === 'verification') return blockedNotRunOutcome('pause before controller adoption')
      writeFileSync(join(request.worktree, 'src', 'value.txt'), 'validated candidate\n')
      git(request.worktree, 'add', '--', 'src/value.txt')
      git(request.worktree, 'commit', '-m', 'feat: validated candidate before staged adoption')
      return blockedNotRunOutcome('task validator unavailable')
    } }
    const first = await runLeppyLoop({ tasks: repo.tasks, syncBranch: 'main', fetch: false }, { ...modelDeps, worker })
    const statePath = join(first.stateDir!, 'run.json')
    const state = JSON.parse(readFileSync(statePath, 'utf8'))
    expect(state.pendingTaskValidation).toMatchObject({ phase: 'pending', ignoredPathsDigest: expect.stringMatching(/^[0-9a-f]{64}$/u) })

    const completedChecklist = readFileSync(join(first.worktree!, 'tasks.task.md'), 'utf8').replace('- [ ] Change', '- [x] Change')
    writeFileSync(join(first.worktree!, 'tasks.task.md'), completedChecklist)
    git(first.worktree!, 'add', '--', 'tasks.task.md')
    expect(git(first.worktree!, 'diff', '--cached', '--name-only')).toBe('tasks.task.md')
    state.pendingTaskValidation = {
      ...state.pendingTaskValidation,
      phase: 'validated', verifierAttempts: 1,
      validatedChecklistDigest: createHash('sha256').update(completedChecklist).digest('hex'),
      validationEvidenceDigest: '6'.repeat(64),
    }
    delete state.stateProof
    writeFileSync(statePath, `${JSON.stringify(state)}\n`)
    const key = Buffer.from(readFileSync(join(first.stateDir!, 'lease.key'), 'utf8').trim(), 'base64')
    persistRunStateProof(first.stateDir!, state, key)

    const forbidden = new FakeWorker()
    const recovered = await runLeppyLoop({
      tasks: repo.tasks, syncBranch: 'main', fetch: false, recoverExistingWip: true, recoverRunId: first.runId,
    }, { ...modelDeps, worker: forbidden })
    expect(recovered).toMatchObject({ status: 'completed', completedTasks: 1 })
    expect(forbidden.calls).toHaveLength(0)
    expect(git(recovered.worktree!, 'rev-list', '--count', 'main..HEAD')).toBe('1')
    expect(git(recovered.worktree!, 'status', '--porcelain')).toBe('')
    expect(readFileSync(join(recovered.worktree!, 'tasks.task.md'), 'utf8')).toContain('- [x] Change')
    const adoptedHead = git(recovered.worktree!, 'rev-parse', 'HEAD')
    expect((readFileSync(join(first.stateDir!, 'events.jsonl'), 'utf8').match(/"type":"done"/gu) ?? [])).toHaveLength(1)

    const repeated = await runLeppyLoop({
      tasks: repo.tasks, syncBranch: 'main', fetch: false, recoverExistingWip: true, recoverRunId: first.runId,
    }, { ...modelDeps, worker: forbidden })
    expect(repeated).toMatchObject({ status: 'completed', completedTasks: 1 })
    expect(forbidden.calls).toHaveLength(0)
    expect(git(repeated.worktree!, 'rev-parse', 'HEAD')).toBe(adoptedHead)
    expect((readFileSync(join(first.stateDir!, 'events.jsonl'), 'utf8').match(/"type":"done"/gu) ?? [])).toHaveLength(1)
  }, 90_000)

  it.skip('obsolete: detached verifier registration is no longer created for ordinary work', async () => {
    const repo = repository('- [ ] Change `src/value.txt` | paths=src/value.txt | Done: focused validation passes\n')
    const seedWorker: WorkerAdapter = { async run(request) {
      if (request.mode === 'verification') return blockedNotRunOutcome('seed pending verifier state')
      writeFileSync(join(request.worktree, 'src', 'value.txt'), 'candidate before verifier registration crash\n')
      git(request.worktree, 'add', '--', 'src/value.txt')
      git(request.worktree, 'commit', '-m', 'feat: candidate before verifier registration crash')
      return blockedNotRunOutcome('task validator unavailable')
    } }
    const first = await runLeppyLoop({ tasks: repo.tasks, syncBranch: 'main', fetch: false }, { ...modelDeps, worker: seedWorker })
    const pending = JSON.parse(readFileSync(join(first.stateDir!, 'run.json'), 'utf8')).pendingTaskValidation
    expect(pending).toMatchObject({ phase: 'pending', commitHead: expect.stringMatching(/^[0-9a-f]{40}$/u) })
    const verificationRoot = join(first.stateDir!, 'verification-worktree')
    git(repo.root, 'worktree', 'add', '--detach', verificationRoot, pending.commitHead)
    expect(git(repo.root, 'worktree', 'list', '--porcelain')).toContain(verificationRoot.replaceAll('\\', '/'))
    rmSync(verificationRoot, { recursive: true, force: true })
    expect(existsSync(verificationRoot)).toBe(false)

    const calls: WorkerRequest[] = []
    const verifier: WorkerAdapter = { async run(request) {
      calls.push(request)
      expect(request.mode).toBe('verification')
      expect(request.worktree).toBe(verificationRoot)
      return completedOutcome('verification resumed after exact registration reconciliation')
    } }
    const recovered = await runLeppyLoop({
      tasks: repo.tasks, syncBranch: 'main', fetch: false, recoverExistingWip: true, recoverRunId: first.runId,
    }, { ...modelDeps, worker: verifier })
    expect(recovered).toMatchObject({ status: 'completed', completedTasks: 1 })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.mode).toBe('verification')
    expect(existsSync(verificationRoot)).toBe(false)
    expect(git(repo.root, 'worktree', 'list', '--porcelain')).not.toContain(verificationRoot.replaceAll('\\', '/'))
  }, 90_000)

  it.skip('obsolete: partial detached verifier roots are no longer created for ordinary work', async () => {
    const repo = repository('- [ ] Change `src/value.txt` | paths=src/value.txt | Done: focused validation passes\n')
    const seedWorker: WorkerAdapter = { async run(request) {
      if (request.mode === 'verification') return blockedNotRunOutcome('seed pending verifier state')
      writeFileSync(join(request.worktree, 'src', 'value.txt'), 'candidate before unregistered verifier crash\n')
      git(request.worktree, 'add', '--', 'src/value.txt')
      git(request.worktree, 'commit', '-m', 'feat: candidate before unregistered verifier crash')
      return blockedNotRunOutcome('task validator unavailable')
    } }
    const first = await runLeppyLoop({ tasks: repo.tasks, syncBranch: 'main', fetch: false }, { ...modelDeps, worker: seedWorker })
    const verificationRoot = join(first.stateDir!, 'verification-worktree')
    mkdirSync(verificationRoot)
    writeFileSync(join(verificationRoot, 'partial.tmp'), 'interrupted git worktree add\n')
    expect(git(repo.root, 'worktree', 'list', '--porcelain')).not.toContain(verificationRoot.replaceAll('\\', '/'))

    const verifier: WorkerAdapter = { async run(request) {
      expect(request.mode).toBe('verification')
      expect(request.worktree).toBe(verificationRoot)
      expect(existsSync(join(request.worktree, 'partial.tmp'))).toBe(false)
      return completedOutcome('verification resumed after exact partial-target reconciliation')
    } }
    const recovered = await runLeppyLoop({
      tasks: repo.tasks, syncBranch: 'main', fetch: false, recoverExistingWip: true, recoverRunId: first.runId,
    }, { ...modelDeps, worker: verifier })
    expect(recovered).toMatchObject({ status: 'completed', completedTasks: 1 })
    expect(existsSync(verificationRoot)).toBe(false)
  }, 90_000)

  it.skip('legacy pending tamper fixture superseded by direct Git-invariant adoption', async () => {
    const seedPending = async (label: string): Promise<{ repo: ReturnType<typeof repository>; result: Awaited<ReturnType<typeof runLeppyLoop>> }> => {
      const repo = repository(`- [ ] Change \`src/value.txt\` | paths=src/value.txt | Done: ${label} focused validation passes\n`)
      let calls = 0
      const worker: WorkerAdapter = { async run(request) {
        calls += 1
        if (request.mode === 'verification') return blockedNotRunOutcome(`${label} verifier blocked`)
        writeFileSync(join(request.worktree, 'src', 'value.txt'), `${label}-candidate\n`)
        git(request.worktree, 'add', '--', 'src/value.txt')
        git(request.worktree, 'commit', '-m', `feat: ${label} candidate`)
        return blockedNotRunOutcome(`${label} task validator unavailable`)
      } }
      const result = await runLeppyLoop({ tasks: repo.tasks, syncBranch: 'main', fetch: false }, { ...modelDeps, worker })
      expect(calls).toBe(2)
      expect(JSON.parse(readFileSync(join(result.stateDir!, 'run.json'), 'utf8'))).toMatchObject({
        pendingTaskValidation: { phase: 'pending', commitHead: git(result.worktree!, 'rev-parse', 'HEAD') },
      })
      return { repo, result }
    }

    const headCase = await seedPending('head-tamper')
    git(headCase.result.worktree!, 'commit', '--allow-empty', '-m', 'chore: tamper pending candidate head')
    const headWorker = new FakeWorker()
    await expect(runLeppyLoop({
      tasks: headCase.repo.tasks, syncBranch: 'main', fetch: false, recoverExistingWip: true, recoverRunId: headCase.result.runId,
    }, { ...modelDeps, worker: headWorker })).rejects.toThrow('pending committed-task HEAD changed before verification')
    expect(headWorker.calls).toHaveLength(0)

    const checklistCase = await seedPending('checklist-tamper')
    writeFileSync(join(checklistCase.result.worktree!, 'tasks.task.md'), '- [ ] Replaced pending task `src/value.txt` | paths=src/value.txt | Done: different contract\n')
    const checklistWorker = new FakeWorker()
    await expect(runLeppyLoop({
      tasks: checklistCase.repo.tasks, syncBranch: 'main', fetch: false, recoverExistingWip: true, recoverRunId: checklistCase.result.runId,
    }, { ...modelDeps, worker: checklistWorker })).rejects.toThrow('authenticated pending task identity no longer matches the controlling checklist')
    expect(checklistWorker.calls).toHaveLength(0)
  }, 90_000)

  it('accepts a clean ordinary closure that omits structured report ceremony', async () => {
    const repo = repository('- [?] Closure: inspect `src` | paths=src\n')
    const worker: WorkerAdapter = { run: async () => ({ status: 'completed', output: 'looks good' }) }
    const result = await runLeppyLoop({ tasks: repo.tasks, syncBranch: 'main', fetch: false }, { ...modelDeps, worker })
    expect(result).toMatchObject({ status: 'completed', completedTasks: 1 })
    expect(readFileSync(join(result.worktree!, 'tasks.task.md'), 'utf8')).toContain('- [x] Closure')
  }, 90_000)

  it('records an unrepairable local gate failure as advisory and advances in the same run', async () => {
    const suffix = Math.random().toString(16).slice(2)
    const gateScript = join(tmpdir(), `leppy-advisory-gate-${suffix}.cjs`).replaceAll('\\', '/')
    writeFileSync(gateScript, "const fs=require('fs');fs.mkdirSync('.svelte-kit',{recursive:true});fs.writeFileSync('.svelte-kit/generated.txt','cache');console.error('GATE_EVIDENCE');process.exit(1)\n")
    const repo = repository(`## Validation\n- [~] Gate: advisory evidence | gate=\`node ${gateScript}\`\n## Follow-up\n- [ ] Change \`src/value.txt\` | Done: value says done\n`)
    writeFileSync(join(repo.root, '.gitignore'), '.svelte-kit/\n')
    git(repo.root, 'add', '--', '.gitignore')
    git(repo.root, 'commit', '-m', 'chore: ignore gate cache')
    const worker: WorkerAdapter = {
      run: async request => {
        writeFileSync(join(request.worktree, 'src', 'value.txt'), 'done\n')
        git(request.worktree, 'add', '--', 'src/value.txt')
        git(request.worktree, 'commit', '-m', 'feat: finish task after advisory gate')
        return completedOutcome()
      },
    }
    const result = await runLeppyLoop({ tasks: repo.tasks, syncBranch: 'main', fetch: false }, { ...modelDeps, worker })
    expect(result).toMatchObject({ status: 'completed', completedTasks: 2 })
    expect(readFileSync(join(result.worktree!, 'tasks.task.md'), 'utf8').match(/\[x\]/g)).toHaveLength(2)
    const receipt = JSON.parse(readFileSync(join(result.worktree!, '.leppy-loop-receipts', 'gate-0.json'), 'utf8'))
    expect(receipt).toMatchObject({ exitCode: 1, advisory: true, advisoryReason: expect.stringContaining('GATE_EVIDENCE') })
    const events = readFileSync(join(result.stateDir!, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(events.filter(entry => entry.type === 'gate-failed')).toHaveLength(1)
    expect(events.filter(entry => entry.type === 'gate-end').at(-1)?.data).toMatchObject({ exitCode: 1, advisory: true })
    expect(events.some(entry => entry.type === 'recovery-done' && entry.data.workerArtifact === 'local-gate-ignored-side-effects')).toBe(true)
    expect(existsSync(join(result.worktree!, '.svelte-kit'))).toBe(false)
    expect(existsSync(join(result.stateDir!, 'resume.json'))).toBe(false)
    expect(git(result.worktree!, 'status', '--short')).toBe('')
  }, 90_000)

  it('keeps explicit gate recovery option validation fail-closed', async () => {
    const repo = repository('- [~] Gate: validation only | gate=`node --version`\n')
    const worker = new FakeWorker()
    await expect(runLeppyLoop({ tasks: repo.tasks, syncBranch: 'main', fetch: false, retryGate: true }, { ...modelDeps, worker }))
      .rejects.toThrow('--retry-gate/--repair-gate require')
    await expect(runLeppyLoop({ tasks: repo.tasks, syncBranch: 'main', fetch: false, repairPaths: ['src'] }, { ...modelDeps, worker }))
      .rejects.toThrow('--repair-path requires --repair-gate')
    await expect(runLeppyLoop({ tasks: repo.tasks, syncBranch: 'main', fetch: false, repairCycles: 2 }, { ...modelDeps, worker }))
      .rejects.toThrow('--repair-cycles requires --repair-gate')
  }, 90_000)

  it('automatically repairs a local gate within bounds, then records advisory evidence and continues', async () => {
    const suffix = Math.random().toString(16).slice(2)
    const gateScript = join(tmpdir(), `leppy-repair-gate-${suffix}.cjs`).replaceAll('\\', '/')
    writeFileSync(gateScript, "const fs=require('fs');const flag='.gate-cache/pass';if(fs.existsSync(flag))process.exit(0);fs.mkdirSync('.gate-cache',{recursive:true});fs.writeFileSync(flag,'poison');console.error('REPAIR_ME');process.exit(1)\n")
    const repo = repository(`## Phase\n- [ ] Change \`src/value.txt\` | Done: value says done\n- [?] Closure: inspect and repair src | paths=src\n- [~] Gate: controlled repair | gate=\`node ${gateScript}\`\n`)
    writeFileSync(join(repo.root, '.gitignore'), '.gate-cache/\n')
    git(repo.root, 'add', '--', '.gitignore')
    git(repo.root, 'commit', '-m', 'chore: ignore gate sentinel')
    let closureCalls = 0
    const calls: WorkerRequest[] = []
    const worker: WorkerAdapter = {
      run: async request => {
        calls.push(request)
        if (request.task.kind === 'task') {
          writeFileSync(join(request.worktree, 'src', 'value.txt'), 'done\n')
          git(request.worktree, 'add', '--', 'src/value.txt')
          git(request.worktree, 'commit', '-m', 'feat: finish ordinary task')
        } else {
          closureCalls += 1
        }
        return completedOutcome()
      },
    }
    const result = await runLeppyLoop({ tasks: repo.tasks, syncBranch: 'main', fetch: false }, { ...modelDeps, worker })
    expect(result).toMatchObject({ status: 'completed', completedTasks: 3 })
    expect(closureCalls).toBe(4)
    expect(calls.map(call => call.task.kind)).toEqual(['task', 'closure', 'closure', 'closure', 'closure'])
    expect(calls.at(-1)?.instructions.join('\n')).toContain('REPAIR_ME')
    expect(readFileSync(join(result.worktree!, 'tasks.task.md'), 'utf8').match(/\[x\]/g)).toHaveLength(3)
    const receipt = JSON.parse(readFileSync(join(result.worktree!, '.leppy-loop-receipts', 'gate-2.json'), 'utf8'))
    expect(receipt).toMatchObject({ exitCode: 1, advisory: true, gateAttempts: 4, repairCyclesUsed: 3, repairCycleLimit: 3 })
    expect(git(result.worktree!, 'status', '--short')).toBe('')
    expect(existsSync(join(result.worktree!, '.gate-cache', 'pass'))).toBe(false)
    expect(existsSync(join(result.stateDir!, 'resume.json'))).toBe(false)
    const events = readFileSync(join(result.stateDir!, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(events.filter(entry => entry.type === 'gate-start')).toHaveLength(4)
    expect(events.filter(entry => entry.type === 'recovery-done' && entry.data.gateRepair === true)).toHaveLength(3)
    expect(events.filter(entry => entry.type === 'gate-end').at(-1)?.data).toMatchObject({ exitCode: 1, advisory: true })
  }, 90_000)

  it('reruns a legacy stalled gate exactly once to mint authenticated advisory evidence', async () => {
    const seeded = await seedLegacyFailedGate()
    const startsBefore = readFileSync(join(seeded.stateDir, 'events.jsonl'), 'utf8').split('\n').filter(line => line.includes('"type":"gate-start"')).length
    const worker = new FakeWorker()
    const result = await runLeppyLoop({
      tasks: seeded.repo.tasks, syncBranch: 'main', fetch: false,
      recoverExistingWip: true, recoverRunId: seeded.runId,
    }, { ...modelDeps, worker })
    expect(result).toMatchObject({ status: 'completed', completedTasks: 1 })
    expect(worker.calls).toHaveLength(0)
    const startsAfter = readFileSync(join(seeded.stateDir, 'events.jsonl'), 'utf8').split('\n').filter(line => line.includes('"type":"gate-start"')).length
    expect(startsAfter).toBe(startsBefore + 1)
    expect(JSON.parse(readFileSync(join(seeded.worktree, '.leppy-loop-receipts', 'gate-0.json'), 'utf8')))
      .toMatchObject({ exitCode: 1, advisory: true })
    expect(JSON.parse(readFileSync(join(seeded.stateDir, 'run.json'), 'utf8')).gateEvidence).toMatchObject({ exitCode: 1 })
    expect(git(seeded.worktree, 'status', '--short')).toBe('')
  }, 90_000)

  it('fails closed instead of adopting a legacy gate receipt with changed command identity', async () => {
    const seeded = await seedLegacyFailedGate()
    writeFileSync(join(seeded.worktree, 'tasks.task.md'), '- [~] Gate: changed command | gate=`node --version`\n')
    git(seeded.worktree, 'add', '--', 'tasks.task.md')
    git(seeded.worktree, 'commit', '-m', 'test: alter recovered gate command')
    await expect(runLeppyLoop({
      tasks: seeded.repo.tasks, syncBranch: 'main', fetch: false,
      recoverExistingWip: true, recoverRunId: seeded.runId,
    }, { ...modelDeps, worker: new FakeWorker() })).rejects.toThrow('fingerprint differs')
  }, 90_000)

  it('adopts HMAC-bound gate evidence after a crash without rerunning the gate', async () => {
    const seeded = await seedAuthenticatedGateEvidenceCrash()
    const startsBefore = readFileSync(join(seeded.stateDir, 'events.jsonl'), 'utf8').split('\n').filter(line => line.includes('"type":"gate-start"')).length
    const result = await runLeppyLoop({
      tasks: seeded.repo.tasks, syncBranch: 'main', fetch: false, recoverExistingWip: true, recoverRunId: seeded.runId,
    }, { ...modelDeps, worker: new FakeWorker() })
    const startsAfter = readFileSync(join(seeded.stateDir, 'events.jsonl'), 'utf8').split('\n').filter(line => line.includes('"type":"gate-start"')).length
    expect(result).toMatchObject({ status: 'completed', completedTasks: 1 })
    expect(startsAfter).toBe(startsBefore)
    expect(JSON.parse(readFileSync(join(seeded.worktree, '.leppy-loop-receipts', 'gate-0.json'), 'utf8')))
      .toMatchObject({ exitCode: 1, advisory: true })
  }, 90_000)

  it('fails closed on missing, malformed, forged, dirty, or moved authenticated gate evidence', async () => {
    const missing = await seedAuthenticatedGateEvidenceCrash()
    rmSync(missing.receiptPath)
    await expect(runLeppyLoop({
      tasks: missing.repo.tasks, syncBranch: 'main', fetch: false, recoverExistingWip: true, recoverRunId: missing.runId,
    }, { ...modelDeps, worker: new FakeWorker() })).rejects.toThrow('no durable receipt')
    expect(readFileSync(join(missing.worktree, 'tasks.task.md'), 'utf8')).toContain('[~]')

    const malformed = await seedAuthenticatedGateEvidenceCrash()
    writeFileSync(malformed.receiptPath, '{}\n')
    await expect(runLeppyLoop({
      tasks: malformed.repo.tasks, syncBranch: 'main', fetch: false, recoverExistingWip: true, recoverRunId: malformed.runId,
    }, { ...modelDeps, worker: new FakeWorker() })).rejects.toThrow('invalid durable receipt')
    expect(readFileSync(join(malformed.worktree, 'tasks.task.md'), 'utf8')).toContain('[~]')

    const forged = await seedAuthenticatedGateEvidenceCrash()
    const forgedReceipt = JSON.parse(readFileSync(forged.receiptPath, 'utf8'))
    forgedReceipt.exitCode = 0
    writeFileSync(forged.receiptPath, `${JSON.stringify(forgedReceipt)}\n`)
    await expect(runLeppyLoop({
      tasks: forged.repo.tasks, syncBranch: 'main', fetch: false, recoverExistingWip: true, recoverRunId: forged.runId,
    }, { ...modelDeps, worker: new FakeWorker() })).rejects.toThrow('does not match authenticated controller evidence')
    expect(readFileSync(join(forged.worktree, 'tasks.task.md'), 'utf8')).toContain('[~]')

    const dirty = await seedAuthenticatedGateEvidenceCrash()
    writeFileSync(join(dirty.worktree, 'intruder.txt'), 'untrusted worktree change\n')
    await expect(runLeppyLoop({
      tasks: dirty.repo.tasks, syncBranch: 'main', fetch: false, recoverExistingWip: true, recoverRunId: dirty.runId,
    }, { ...modelDeps, worker: new FakeWorker() })).rejects.toThrow('requires a clean worktree')
    expect(readFileSync(join(dirty.worktree, 'tasks.task.md'), 'utf8')).toContain('[~]')

    const moved = await seedAuthenticatedGateEvidenceCrash()
    git(moved.worktree, 'commit', '--allow-empty', '-m', 'test: move authenticated gate head')
    await expect(runLeppyLoop({
      tasks: moved.repo.tasks, syncBranch: 'main', fetch: false, recoverExistingWip: true, recoverRunId: moved.runId,
    }, { ...modelDeps, worker: new FakeWorker() })).rejects.toThrow('does not match authenticated controller evidence')
    expect(readFileSync(join(moved.worktree, 'tasks.task.md'), 'utf8')).toContain('[~]')
  }, 120_000)

  it('automatically chains bounded fresh repair closures while a gate reveals later failures', async () => {
    const suffix = Math.random().toString(16).slice(2)
    const gateScript = join(tmpdir(), `leppy-multistage-gate-${suffix}.cjs`).replaceAll('\\', '/')
    writeFileSync(gateScript, "const fs=require('fs'); const path=require('path'); const file=path.join(process.cwd(),'generated','stage.txt'); const stage=fs.existsSync(file)?Number(fs.readFileSync(file,'utf8').trim()):0; if(stage<3){console.error('NEED_STAGE_'+(stage+1));process.exit(1)}\n")
    const repo = repository(`## Phase\n- [ ] Change \`src/value.txt\` | Done: value says done\n- [?] Closure: repair sequential gate failures | paths=src,generated\n- [~] Gate: sequential repair | gate=\`node ${gateScript}\`\n`)
    mkdirSync(join(repo.root, 'generated'), { recursive: true })
    writeFileSync(join(repo.root, 'generated', '.keep'), 'generated scope\n')
    git(repo.root, 'add', '--', 'generated/.keep')
    git(repo.root, 'commit', '-m', 'chore: seed sequential repair scope')
    let closureCalls = 0
    const calls: WorkerRequest[] = []
    const worker: WorkerAdapter = {
      run: async request => {
        calls.push(request)
        if (request.task.kind === 'task') {
          writeFileSync(join(request.worktree, 'src', 'value.txt'), 'done\n')
          git(request.worktree, 'add', '--', 'src/value.txt')
          git(request.worktree, 'commit', '-m', 'feat: finish sequential task')
        } else {
          closureCalls += 1
          if (closureCalls > 1) {
            const stage = closureCalls - 1
            writeFileSync(join(request.worktree, 'generated', 'stage.txt'), `${stage}\n`)
            git(request.worktree, 'add', '--', 'generated/stage.txt')
            git(request.worktree, 'commit', '-m', `fix: repair gate stage ${stage}`)
          }
        }
        return completedOutcome()
      },
    }
    const result = await runLeppyLoop({ tasks: repo.tasks, syncBranch: 'main', fetch: false }, { ...modelDeps, worker })
    expect(result.status).toBe('completed')
    expect(calls.map(call => call.task.kind)).toEqual(['task', 'closure', 'closure', 'closure', 'closure'])
    expect(calls.at(-2)?.instructions.join('\n')).toContain('NEED_STAGE_2')
    expect(calls.at(-1)?.instructions.join('\n')).toContain('NEED_STAGE_3')
    const events = readFileSync(join(result.stateDir!, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(events.filter(entry => entry.type === 'gate-start')).toHaveLength(4)
    expect(events.filter(entry => entry.type === 'recovery-done' && entry.data.gateRepair === true).map(entry => entry.data.repairCycle)).toEqual([1, 2, 3])
    expect(git(result.worktree!, 'status', '--short')).toBe('')
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

  it('releases the repository lock when authenticated recovery metadata fails after acquisition', async () => {
    const repo = repository('- [?] [human/live] Confirm behavior in the release client.\n')
    const worker = new FakeWorker()
    const first = await runLeppyLoop({ tasks: repo.tasks, syncBranch: 'main', fetch: false }, { ...modelDeps, worker })
    writeFileSync(join(first.stateDir!, 'gate-repair.json'), '{"schemaVersion":')
    const recover = () => runLeppyLoop({
      tasks: repo.tasks, syncBranch: 'main', fetch: false, recoverExistingWip: true, recoverRunId: first.runId,
    }, { ...modelDeps, worker })
    await expect(recover()).rejects.toThrow(/JSON|Unexpected end/u)
    await expect(recover()).rejects.toThrow(/JSON|Unexpected end/u)
  }, 90_000)

  it('recovers an ordinary timeout with a fresh worker in the same controller job', async () => {
    const repo = repository('- [ ] Change `src/value.txt` | Done: value says done\n')
    const worker = new FakeWorker([{ status: 'timeout', output: '', error: 'timeout' }])
    const progress: RunProgress[] = []
    const result = await runLeppyLoop(
      { tasks: repo.tasks, syncBranch: 'main', fetch: false },
      { ...modelDeps, worker, onProgress: update => { progress.push(update) } },
    )
    expect(result.status).toBe('completed')
    expect(worker.calls).toHaveLength(2)
    expect(readFileSync(join(result.worktree!, 'tasks.task.md'), 'utf8')).toContain('[x]')
    expect(progress.map(update => update.type)).toEqual(['task-start', 'task-done'])
    expect(readFileSync(join(result.stateDir!, 'events.jsonl'), 'utf8')).toContain('ordinary-recovery')
  }, 90_000)

  it('adopts dirty in-scope task WIP without requiring worker commit ceremony', async () => {
    const repo = repository('- [ ] Change `src/value.txt` | paths=src/value.txt | Done: value says done\n')
    const worker: WorkerAdapter = { async run(request) {
      writeFileSync(join(request.worktree, 'src', 'value.txt'), 'done by worker\n')
      return completedOutcome('done without manual commit')
    } }
    const progress: RunProgress[] = []

    const result = await runLeppyLoop(
      { tasks: repo.tasks, syncBranch: 'main', fetch: false },
      { ...adaptiveDeps, worker, onProgress: update => { progress.push(update) } },
    )

    expect(result.status).toBe('completed')
    expect(readFileSync(join(result.worktree!, 'src', 'value.txt'), 'utf8')).toBe('done by worker\n')
    expect(progress.map(update => update.type)).toEqual(['task-start', 'task-done'])
    expect(git(result.worktree!, 'rev-list', '--count', 'main..HEAD')).toBe('1')
    expect(readFileSync(join(result.stateDir!, 'events.jsonl'), 'utf8')).toContain('completed-worker-changes')
  }, 90_000)

  it('replaces and persists the terminal receipt returned by ordinary autonomous recovery', async () => {
    const repo = repository('- [ ] Change `src/value.txt` | paths=src/value.txt | Done: value says done\n')
    const control = new AbortController()
    let calls = 0
    let stateDir = ''
    const worker: WorkerAdapter = { async run(request) {
      calls += 1
      stateDir = request.stateDir
      if (calls === 1) return { status: 'unavailable', output: '', error: 'worker transport unavailable' }
      writeFileSync(join(request.worktree, 'src', 'value.txt'), 'retry candidate\n')
      git(request.worktree, 'add', '--', 'src/value.txt')
      git(request.worktree, 'commit', '-m', 'fix: retry candidate before unavailable validation')
      control.abort(new Error('crash after no-commit retry outcome'))
      return { status: 'unavailable', output: '', error: 'LEPPY_WINDOWS_NAMED_PIPE_UNAVAILABLE' }
    } }

    await expect(runLeppyLoop(
      { tasks: repo.tasks, syncBranch: 'main', fetch: false },
      { ...adaptiveDeps, worker, signal: control.signal },
    )).rejects.toThrow('crash after no-commit retry outcome')
    expect(calls).toBe(2)
    const state = JSON.parse(readFileSync(join(stateDir, 'run.json'), 'utf8'))
    expect(state.activeTaskAttempt).toMatchObject({
      schemaVersion: 2, attempt: 2,
      terminalOutcome: { disposition: 'validation-unavailable', outcomeDigest: expect.any(String) },
    })
  }, 90_000)

  it('records a fresh ignored baseline before ordinary autonomous recovery', async () => {
    const repo = repository('- [ ] Change `src/value.txt` | paths=src/value.txt | Done: value says done\n')
    writeFileSync(join(repo.root, '.gitignore'), 'ignored-worker-output/\n')
    git(repo.root, 'add', '--', '.gitignore')
    git(repo.root, 'commit', '-m', 'chore: ignore worker-local output')
    let calls = 0
    const worker: WorkerAdapter = { async run(request) {
      calls += 1
      if (calls === 1) {
        mkdirSync(join(request.worktree, 'ignored-worker-output'), { recursive: true })
        writeFileSync(join(request.worktree, 'ignored-worker-output', 'first.log'), 'first attempt\n')
        return { status: 'unavailable', output: '', error: 'worker transport unavailable' }
      }
      expect(existsSync(join(request.worktree, 'ignored-worker-output', 'first.log'))).toBe(false)
      writeFileSync(join(request.worktree, 'src', 'value.txt'), 'done after retry\n')
      git(request.worktree, 'add', '--', 'src/value.txt')
      git(request.worktree, 'commit', '-m', 'fix: finish after no-commit retry')
      return completedOutcome('done with commit')
    } }
    const result = await runLeppyLoop({ tasks: repo.tasks, syncBranch: 'main', fetch: false }, { ...adaptiveDeps, worker })
    expect(result).toMatchObject({ status: 'completed', completedTasks: 1 })
    expect(calls).toBe(2)
    expect(existsSync(join(result.stateDir!, 'worker-ignored-path-baselines', '0-1.json'))).toBe(true)
    expect(existsSync(join(result.stateDir!, 'worker-ignored-path-baselines', '0-2.json'))).toBe(true)
    const receipt = JSON.parse(readFileSync(join(result.stateDir!, 'worker-ignored-path-recovery', '0-1.json'), 'utf8'))
    expect(readFileSync(join(receipt.quarantineRoot, 'ignored-worker-output', 'first.log'), 'utf8')).toBe('first attempt\n')
  }, 90_000)

  it('closes an already-satisfied task without a ceremonial second worker', async () => {
    const repo = repository('- [ ] Verify `src/value.txt` | Done: value already says before\n')
    const worker = new FakeWorker([
      completedOutcome('src/value.txt already contains before'),
    ])

    const result = await runLeppyLoop(
      { tasks: repo.tasks, syncBranch: 'main', fetch: false },
      { ...adaptiveDeps, worker },
    )

    expect(result.status).toBe('completed')
    expect(worker.calls).toHaveLength(1)
    expect(git(result.worktree!, 'rev-list', '--count', 'main..HEAD')).toBe('1')
    expect(git(result.worktree!, 'show', '--pretty=format:', '--name-only', 'HEAD')).toBe('tasks.task.md')
    const events = readFileSync(join(result.stateDir!, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(events.find(entry => entry.type === 'done')?.data.verifiedAlreadySatisfied).toBe(true)
  }, 90_000)

  it('stops ordinary work only for explicit implementation-impossible disposition', async () => {
    const repo = repository('- [ ] Change `src/value.txt` | Done: value says done\n')
    const worker = new FakeWorker([{
      status: 'blocked', output: 'required API is outside authenticated scope', error: 'scope excludes required API',
      report: {
        status: 'blocked', disposition: 'implementation-impossible', summary: 'scope excludes required API',
        validation: { status: 'not-run', evidence: 'required API is outside authenticated scope' },
      },
    }])

    const result = await runLeppyLoop(
      { tasks: repo.tasks, syncBranch: 'main', fetch: false },
      { ...adaptiveDeps, worker },
    )
    expect(result).toMatchObject({ status: 'stalled', completedTasks: 0, currentTask: 0 })
    expect(worker.calls).toHaveLength(1)
    expect(readFileSync(join(result.worktree!, 'tasks.task.md'), 'utf8')).toContain('- [ ] Change')
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
    const worker = new FakeWorker([implementationImpossibleOutcome('explicit recovery checkpoint')])
    const progress: RunProgress[] = []
    const dependencies = { ...adaptiveDeps, worker, onProgress: (update: RunProgress) => { progress.push(update) } }
    const first = await runLeppyLoop({ tasks: repo.tasks, syncBranch: 'main', fetch: false }, dependencies)
    expect(first.status).toBe('stalled')
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
    expect(progress.filter(update => update.type === 'task-start').map(update => update.taskAttempt)).toEqual([1, 2])
    const state = JSON.parse(readFileSync(join(resumed.stateDir!, 'run.json'), 'utf8')) as {
      attempt: number; taskAttempts: Record<string, number>
    }
    expect(state.attempt).toBe(2)
    expect(Object.values(state.taskAttempts)).toEqual([2])
  }, 90_000)

  it('starts split replacement tasks at attempt one without resetting the global identity', async () => {
    const repo = repository('- [ ] Large change `src/value.txt` | Done: value says done\n')
    const worker = new FakeWorker([implementationImpossibleOutcome('split requested by direct controller edit')])
    const progress: RunProgress[] = []
    const dependencies = { ...modelDeps, worker, onProgress: (update: RunProgress) => { progress.push(update) } }
    const first = await runLeppyLoop({ tasks: repo.tasks, syncBranch: 'main', fetch: false }, dependencies)
    expect(first.status).toBe('stalled')
    writeFileSync(join(first.worktree!, 'tasks.task.md'), [
      '- [ ] Split part A `src/value.txt` | Done: part A',
      '- [ ] Split part B `src/value.txt` | Done: part B',
      '',
    ].join('\n'))
    git(first.worktree!, 'add', '--', 'tasks.task.md')
    git(first.worktree!, 'commit', '-m', 'chore: split stalled controller task')

    const resumed = await runLeppyLoop({
      tasks: repo.tasks, syncBranch: 'main', fetch: false,
      recoverExistingWip: true, recoverRunId: first.runId,
    }, dependencies)

    expect(resumed.status).toBe('completed')
    expect(progress.filter(update => update.type === 'task-start').map(update => [
      update.attempt, update.taskAttempt, update.text,
    ])).toEqual([
      [1, 1, 'Large change `src/value.txt`'],
      [2, 1, 'Split part A `src/value.txt`'],
      [3, 1, 'Split part B `src/value.txt`'],
    ])
    const state = JSON.parse(readFileSync(join(resumed.stateDir!, 'run.json'), 'utf8')) as {
      attempt: number; taskAttempts: Record<string, number>
    }
    expect(state.attempt).toBe(3)
    expect(Object.values(state.taskAttempts).sort()).toEqual([1, 1, 1])
  }, 90_000)

  it('recovers from the authenticated worktree when the source branch removed the checklist and is dirty', async () => {
    const repo = repository('- [ ] Change `src/value.txt` | Done: value says done\n')
    const worker = new FakeWorker([implementationImpossibleOutcome('explicit recovery checkpoint')])
    const first = await runLeppyLoop({ tasks: repo.tasks, syncBranch: 'main', fetch: false }, { ...adaptiveDeps, worker })
    expect(first.status).toBe('stalled')

    git(repo.root, 'rm', '--', 'tasks.task.md')
    git(repo.root, 'commit', '-m', 'chore: remove controller from current source branch')
    writeFileSync(join(repo.root, 'src', 'value.txt'), 'unrelated dirty source checkout\n')

    const resumed = await runLeppyLoop({
      tasks: repo.tasks,
      syncBranch: 'main',
      fetch: false,
      recoverExistingWip: true,
      recoverRunId: first.runId,
    }, { ...adaptiveDeps, worker })
    expect(resumed.status).toBe('completed')
    expect(resumed.runId).toBe(first.runId)
    expect(readFileSync(join(resumed.worktree!, 'tasks.task.md'), 'utf8')).toContain('[x]')
    expect(readFileSync(join(repo.root, 'src', 'value.txt'), 'utf8')).toBe('unrelated dirty source checkout\n')
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
    const repo = repository('- [ ] Change `src/value.txt` | Done: value says done\n- [~] Gate: node version | gate=`node --version`\n')
    const worker = new FakeWorker()
    const published: string[] = []
    const dependencies = {
      ...modelDeps,
      worker,
      publishPullRequest: async (request: PullRequestRequest, _signal: AbortSignal, hooks: PublicationHooks) => {
        published.push(request.branch)
        const receipt = await hooks.validateBeforePush(git(request.worktree, 'rev-parse', request.syncBranch))
        return { url: 'https://github.com/example/repo/pull/7', validationReceipt: receipt.receipt }
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

  it('blocks remote mutation when publication authority downgrades after final validation', async () => {
    const repo = repository('- [ ] Change `src/value.txt` | Done: value says done\n- [~] Gate: node version | gate=`node --version`\n')
    const issuedAt = Date.now() - 1_000
    const authority: LifecycleAuthority = {
      sessionId: 'downgraded-before-push-owner', allowPublication: true, maxIterations: 64, maxRepairCycles: 3,
      maxTransitions: 16, transitions: 1, issuedAt, expiresAt: issuedAt + 86_400_000,
    }
    const downgraded: LifecycleAuthority = { ...authority, allowPublication: false }
    let publisherCalls = 0
    let remoteMutations = 0
    let authorizationError = ''

    const result = await runLeppyLoop(
      { tasks: repo.tasks, syncBranch: 'main', fetch: false, openPullRequest: true, lifecycleAuthority: authority },
      {
        ...modelDeps,
        worker: new FakeWorker(),
        publishPullRequest: async (request, _signal, hooks) => {
          publisherCalls += 1
          await hooks.validateBeforePush(git(request.worktree, 'rev-parse', request.syncBranch))
          const stateDir = await lifecycleStateDir(request.repoRoot, request.runId)
          appendLifecycleAuthorityReceipt(stateDir, request.runId, authority)
          appendLifecycleAuthorityReceipt(stateDir, request.runId, downgraded)
          if (!hooks.authorizeRemoteMutation) throw new Error('publisher did not receive remote mutation authorization hook')
          try {
            await hooks.authorizeRemoteMutation(async () => {
              remoteMutations += 1
            })
          } catch (error) {
            authorizationError = error instanceof Error ? error.message : String(error)
            throw error
          }
          throw new Error('remote mutation authorization unexpectedly succeeded')
        },
      },
    )

    expect(publisherCalls).toBe(1)
    expect(authorizationError).toMatch(/lifecycle authority|publication/u)
    expect(remoteMutations).toBe(0)
    expect(result.status).toBe('stalled')
    expect(result.pullRequestUrl).toBeUndefined()
    const state = JSON.parse(readFileSync(join(result.stateDir!, 'run.json'), 'utf8'))
    expect(state.status).toBe('stalled')
    expect(state.pullRequestUrl).toBeUndefined()
  }, 90_000)

  it('never lets a local advisory gate authorize publication', async () => {
    const suffix = Math.random().toString(16).slice(2)
    const gateScript = join(tmpdir(), `leppy-publication-advisory-${suffix}.cjs`).replaceAll('\\', '/')
    writeFileSync(gateScript, "console.error('PUBLICATION_MUST_STOP');process.exit(1)\n")
    const repo = repository(`- [~] Gate: local advisory only | gate=\`node ${gateScript}\`\n`)
    let publisherCalls = 0
    let remoteMutations = 0
    const result = await runLeppyLoop(
      { tasks: repo.tasks, syncBranch: 'main', fetch: false, openPullRequest: true },
      {
        ...modelDeps,
        worker: new FakeWorker(),
        publishPullRequest: async (request, _signal, hooks) => {
          publisherCalls += 1
          await hooks.validateBeforePush(git(request.worktree, 'rev-parse', request.syncBranch))
          remoteMutations += 1
          return { url: 'https://example.invalid/must-not-publish', validationReceipt: 'impossible' }
        },
      },
    )
    expect(result).toMatchObject({ status: 'stalled', detail: expect.stringContaining('post-rebase publication gate failed') })
    expect(publisherCalls).toBe(1)
    expect(remoteMutations).toBe(0)
    expect(result.pullRequestUrl).toBeUndefined()
    expect(JSON.parse(readFileSync(join(result.worktree!, '.leppy-loop-receipts', 'gate-0.json'), 'utf8')))
      .toMatchObject({ exitCode: 1, advisory: true })
    const publicationReceipt = readdirSync(join(result.stateDir!, 'receipts')).find(name => name.startsWith('publication-gate-'))!
    expect(JSON.parse(readFileSync(join(result.stateDir!, 'receipts', publicationReceipt), 'utf8')))
      .toMatchObject({ exitCode: 1, publicationValidation: true })
  }, 90_000)

  it('rejects ignored artifacts created by the strict publication gate', async () => {
    const suffix = Math.random().toString(16).slice(2)
    const gateScript = join(tmpdir(), `leppy-publication-ignored-${suffix}.cjs`).replaceAll('\\', '/')
    writeFileSync(gateScript, "const fs=require('fs');fs.mkdirSync('.publication-cache',{recursive:true});fs.writeFileSync('.publication-cache/poison','x');process.exit(0)\n")
    const repo = repository(`- [~] Gate: ignored publication side effect | gate=\`node ${gateScript}\`\n`)
    writeFileSync(join(repo.root, '.gitignore'), '.publication-cache/\n')
    git(repo.root, 'add', '--', '.gitignore')
    git(repo.root, 'commit', '-m', 'chore: ignore publication cache')
    let remoteMutations = 0
    const result = await runLeppyLoop(
      { tasks: repo.tasks, syncBranch: 'main', fetch: false, openPullRequest: true },
      {
        ...modelDeps,
        worker: new FakeWorker(),
        publishPullRequest: async (request, _signal, hooks) => {
          await hooks.validateBeforePush(git(request.worktree, 'rev-parse', request.syncBranch))
          remoteMutations += 1
          return { url: 'https://example.invalid/must-not-publish', validationReceipt: 'impossible' }
        },
      },
    )
    expect(result).toMatchObject({ status: 'stalled', detail: expect.stringContaining('created ignored artifacts') })
    expect(remoteMutations).toBe(0)
    expect(existsSync(join(result.worktree!, '.publication-cache'))).toBe(false)
  }, 90_000)

  it('reruns and rejects an advisory final gate before reconciling an existing pull request', async () => {
    const suffix = Math.random().toString(16).slice(2)
    const gateScript = join(tmpdir(), `leppy-reconciled-advisory-${suffix}.cjs`).replaceAll('\\', '/')
    writeFileSync(gateScript, "console.error('RECONCILIATION_MUST_STOP');process.exit(1)\n")
    const repo = repository(`- [~] Gate: advisory existing PR | gate=\`node ${gateScript}\`\n`)
    let publisherCalls = 0
    const result = await runLeppyLoop(
      { tasks: repo.tasks, syncBranch: 'main', fetch: false, openPullRequest: true },
      {
        ...modelDeps,
        worker: new FakeWorker(),
        publishPullRequest: async () => {
          publisherCalls += 1
          return { url: 'https://github.com/example/repo/pull/47', validationReceipt: 'reconciled-existing-pr', reconciledExisting: true }
        },
      },
    )
    expect(publisherCalls).toBe(1)
    expect(result).toMatchObject({ status: 'stalled', detail: expect.stringContaining('post-rebase publication gate failed') })
    expect(result.pullRequestUrl).toBeUndefined()
    const publicationReceipt = readdirSync(join(result.stateDir!, 'receipts')).find(name => name.startsWith('publication-gate-'))!
    expect(JSON.parse(readFileSync(join(result.stateDir!, 'receipts', publicationReceipt), 'utf8')))
      .toMatchObject({ exitCode: 1, publicationValidation: true })
  }, 90_000)

  it('reconciles an authenticated existing PR only after the controller reruns the final gate', async () => {
    const repo = repository('- [ ] Change `src/value.txt` | Done: value says done\n- [~] Gate: node version | gate=`node --version`\n')
    const result = await runLeppyLoop(
      { tasks: repo.tasks, syncBranch: 'main', fetch: false, openPullRequest: true },
      {
        ...modelDeps, worker: new FakeWorker(),
        publishPullRequest: async () => ({
          url: 'https://github.com/example/repo/pull/46', validationReceipt: 'reconciled-existing-pr', reconciledExisting: true,
        }),
      },
    )
    expect(result).toMatchObject({ status: 'completed', pullRequestUrl: 'https://github.com/example/repo/pull/46' })
    const events = readFileSync(join(result.stateDir!, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(events.some(entry => entry.type === 'gate-start' && entry.phase === 'publish' && entry.data.publicationValidation === true)).toBe(true)
  }, 90_000)

  it('rejects a publisher that ignores the mandatory final-gate receipt', async () => {
    const repo = repository('- [ ] Change `src/value.txt` | Done: value says done\n- [~] Gate: node version | gate=`node --version`\n')
    const result = await runLeppyLoop(
      { tasks: repo.tasks, syncBranch: 'main', fetch: false, openPullRequest: true },
      {
        ...modelDeps,
        worker: new FakeWorker(),
        publishPullRequest: async () => ({ url: 'https://example.invalid/unvalidated', validationReceipt: 'forged' }),
      },
    )
    expect(result.status).toBe('stalled')
    expect(result.pullRequestUrl).toBeUndefined()
    expect(result.detail).toContain('publisher did not consume')
    expect(JSON.parse(readFileSync(join(result.stateDir!, 'run.json'), 'utf8')).lastError).toContain('publisher did not consume')
  }, 90_000)

  it('rolls back the authenticated pre-publication HEAD after a post-gate publisher failure', async () => {
    const repo = repository('- [ ] Change `src/value.txt` | Done: value says done\n- [~] Gate: node version | gate=`node --version`\n')
    let originalHead = ''
    const result = await runLeppyLoop(
      { tasks: repo.tasks, syncBranch: 'main', fetch: false, openPullRequest: true },
      {
        ...modelDeps,
        worker: new FakeWorker(),
        publishPullRequest: async (request, _signal, hooks) => {
          originalHead = git(request.worktree, 'rev-parse', 'HEAD')
          git(request.worktree, 'commit', '--allow-empty', '-m', 'test: simulated publication rebase')
          await hooks.validateBeforePush(git(request.worktree, 'rev-parse', request.syncBranch))
          throw new Error('simulated push failure after final gate')
        },
      },
    )
    expect(result).toMatchObject({ status: 'stalled', detail: expect.stringContaining('simulated push failure') })
    expect(git(result.worktree!, 'rev-parse', 'HEAD')).toBe(originalHead)
    expect(git(result.worktree!, 'status', '--porcelain')).toBe('')
  }, 90_000)

  it('refuses publication without a completed authenticated final gate', async () => {
    const repo = repository('- [ ] Change `src/value.txt` | Done: value says done\n')
    const worker = new FakeWorker()
    let publishCalls = 0
    const result = await runLeppyLoop(
      { tasks: repo.tasks, syncBranch: 'main', fetch: false, openPullRequest: true },
      { ...modelDeps, worker, publishPullRequest: async () => { publishCalls += 1; return { url: 'https://example.invalid/should-not-open', validationReceipt: 'invalid' } } },
    )
    expect(result.status).toBe('stalled')
    expect(publishCalls).toBe(0)
  }, 90_000)

  it('rejects checklist mutation before the post-rebase gate and remote publication', async () => {
    const repo = repository(`- [ ] Change \`src/value.txt\` | Done: value says done
- [~] Gate: node version | gate=\`node --version\`
`)
    const worker = new FakeWorker()
    let remoteMutationReached = false
    const result = await runLeppyLoop(
      { tasks: repo.tasks, syncBranch: 'main', fetch: false, openPullRequest: true },
      {
        ...modelDeps,
        worker,
        publishPullRequest: async (request, _signal, hooks) => {
          writeFileSync(join(request.worktree, 'tasks.task.md'), '# unauthorized base mutation\n')
          const receipt = await hooks.validateBeforePush(git(request.worktree, 'rev-parse', request.syncBranch))
          remoteMutationReached = true
          return { url: 'https://example.invalid/should-not-open', validationReceipt: receipt.receipt }
        },
      },
    )
    expect(result.status).toBe('stalled')
    expect(remoteMutationReached).toBe(false)
    expect(readFileSync(join(result.worktree!, 'tasks.task.md'), 'utf8')).toContain('[x]')
    expect(git(result.worktree!, 'status', '--porcelain')).toBe('')
  }, 90_000)

  it('repairs bounded publication conflicts and reruns the final gate before push', async () => {
    const repo = repository(`- [ ] Change \`src/value.txt\` | Done: value says done
- [~] Gate: node version | gate=\`node --version\`
`)
    git(repo.root, 'remote', 'add', 'origin', repo.root)
    git(repo.root, 'fetch', 'origin')
    const worker = new FakeWorker()
    let publicationCalls = 0
    let validationCalls = 0
    const result = await runLeppyLoop(
      { tasks: repo.tasks, syncBranch: 'origin/main', fetch: false, openPullRequest: true, publicationRepairCycles: 2 },
      {
        ...modelDeps,
        worker,
        publishPullRequest: async (request, _signal, hooks) => {
          publicationCalls += 1
          writeFileSync(join(request.repoRoot, 'src', 'value.txt'), 'authoritative-base\n')
          git(request.repoRoot, 'add', '--', 'src/value.txt')
          git(request.repoRoot, 'commit', '-m', 'fix: advance publication base')
          git(request.repoRoot, 'fetch', 'origin')
          expect(() => git(request.worktree, 'rebase', 'origin/main')).toThrow()
          const paths = git(request.worktree, 'diff', '--name-only', '--diff-filter=U').split(/\r?\n/u).filter(Boolean)
          await hooks.repairConflict(new PublicationConflictError(paths, 'real rebase conflict'))
          git(request.worktree, 'add', '-A', '--', ...paths)
          git(request.worktree, '-c', 'core.editor=true', 'rebase', '--continue')
          validationCalls += 1
          const receipt = await hooks.validateBeforePush(git(request.worktree, 'rev-parse', 'origin/main'))
          return { url: 'https://github.com/example/repo/pull/8', validationReceipt: receipt.receipt }
        },
      },
    )
    if (result.status !== 'completed') throw new Error(readFileSync(join(result.stateDir!, 'events.jsonl'), 'utf8'))
    expect(result).toMatchObject({ status: 'completed', pullRequestUrl: 'https://github.com/example/repo/pull/8', completedTasks: 2 })
    expect(publicationCalls).toBe(1)
    expect(validationCalls).toBe(1)
    expect(worker.calls).toHaveLength(2)
    expect(worker.calls[1]).toMatchObject({ mode: 'publication-conflict', allowedPaths: [join('src', 'value.txt')], gateFingerprint: expect.any(String) })
    expect(worker.calls[1]!.instructions.join('\n')).toContain('authenticated Git rebase stopped by conflicts')
    expect(readdirSync(join(result.stateDir!, 'receipts'))).toContainEqual(expect.stringMatching(/^publication-gate-/u))
  }, 90_000)

  it('stalls only after bounded autonomous workers all remain unavailable', async () => {
    const repo = repository('- [ ] Change `src/value.txt` | Done: value says done\n')
    const worker = new FakeWorker([
      { status: 'unavailable', output: '', error: 'Codex servers overloaded' },
      { status: 'unavailable', output: '', error: 'Codex servers still overloaded' },
      { status: 'unavailable', output: '', error: 'Codex servers remain overloaded' },
      { status: 'unavailable', output: '', error: 'Codex servers remain unavailable after bounded recovery' },
    ])
    const result = await runLeppyLoop({ tasks: repo.tasks, syncBranch: 'main', fetch: false }, { ...adaptiveDeps, worker })
    expect(result.status).toBe('stalled')
    expect(worker.calls.map(call => [call.model, call.effort])).toEqual([
      ['gpt-5.6-terra', 'high'],
      ['gpt-5.6-sol', 'low'],
      ['gpt-5.6-sol', 'low'],
      ['gpt-5.6-sol', 'low'],
    ])
    const events = readFileSync(join(result.stateDir!, 'events.jsonl'), 'utf8')
    expect(events).toContain('"retry":"ordinary-recovery"')
    expect(events).not.toContain('"retry":"no-commit"')
    expect(readFileSync(join(result.stateDir!, 'resume.json'), 'utf8')).toContain('"status": "unavailable"')
  }, 90_000)

  it('uses fallback once only for availability failures', async () => {
    const repo = repository('- [ ] Change `src/value.txt` | Done: value says done\n')
    const worker = new FakeWorker([{ status: 'unavailable', output: '', error: '429' }])
    const result = await runLeppyLoop({ tasks: repo.tasks, syncBranch: 'main', fetch: false, fallbackModel: 'fallback' }, { ...modelDeps, worker })
    expect(result.status).toBe('completed')
    expect(worker.calls.map(call => call.model)).toEqual(['fake-model', 'fallback'])
  }, 90_000)

  it('records a fresh ignored baseline before an availability retry', async () => {
    const repo = repository('- [ ] Change `src/value.txt` | paths=src/value.txt | Done: value says done\n')
    writeFileSync(join(repo.root, '.gitignore'), 'ignored-worker-output/\n')
    git(repo.root, 'add', '--', '.gitignore')
    git(repo.root, 'commit', '-m', 'chore: ignore worker-local output')
    let calls = 0
    const worker: WorkerAdapter = { async run(request) {
      calls += 1
      if (calls === 1) {
        mkdirSync(join(request.worktree, 'ignored-worker-output'), { recursive: true })
        writeFileSync(join(request.worktree, 'ignored-worker-output', 'unavailable.log'), 'first model unavailable\n')
        return { status: 'unavailable', output: '', error: '429' }
      }
      expect(existsSync(join(request.worktree, 'ignored-worker-output', 'unavailable.log'))).toBe(false)
      writeFileSync(join(request.worktree, 'src', 'value.txt'), 'done after availability retry\n')
      git(request.worktree, 'add', '--', 'src/value.txt')
      git(request.worktree, 'commit', '-m', 'fix: finish after availability retry')
      return completedOutcome('done with fallback commit')
    } }
    const result = await runLeppyLoop(
      { tasks: repo.tasks, syncBranch: 'main', fetch: false, fallbackModel: 'fallback' },
      { ...modelDeps, worker },
    )
    expect(result).toMatchObject({ status: 'completed', completedTasks: 1 })
    expect(calls).toBe(2)
    expect(existsSync(join(result.stateDir!, 'worker-ignored-path-baselines', '0-1.json'))).toBe(true)
    expect(existsSync(join(result.stateDir!, 'worker-ignored-path-baselines', '0-2.json'))).toBe(true)
    const receipt = JSON.parse(readFileSync(join(result.stateDir!, 'worker-ignored-path-recovery', '0-1.json'), 'utf8'))
    expect(readFileSync(join(receipt.quarantineRoot, 'ignored-worker-output', 'unavailable.log'), 'utf8')).toBe('first model unavailable\n')
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

  it('stops an active worker, preserves its dirty WIP, and leaves the controller row open', async () => {
    const repo = repository('- [ ] Alpha `src/value.txt` | Done: alpha\n')
    const control = new AbortController()
    let started!: () => void
    const workerStarted = new Promise<void>(resolveStarted => { started = resolveStarted })
    const worker: WorkerAdapter = {
      run: async (request, signal) => {
        writeFileSync(join(request.worktree, 'src', 'value.txt'), 'preserved worker WIP\n')
        started()
        return await new Promise<WorkerOutcome>(resolveOutcome => {
          signal.addEventListener('abort', () => resolveOutcome({ status: 'interrupted', output: '', error: 'human stop' }), { once: true })
        })
      },
    }
    const running = runLeppyLoop(
      { tasks: repo.tasks, syncBranch: 'main', fetch: false },
      { ...modelDeps, worker, signal: control.signal },
    )
    await workerStarted
    control.abort(new Error('human stop'))
    await expect(running).rejects.toThrow('human stop')

    const worktrees = git(repo.root, 'worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree '))
    const worktree = worktrees.at(-1)!.slice('worktree '.length)
    expect(readFileSync(join(worktree, 'src', 'value.txt'), 'utf8')).toBe('preserved worker WIP\n')
    expect(readFileSync(join(worktree, 'tasks.task.md'), 'utf8')).toContain('- [ ] Alpha')
    expect(git(worktree, 'status', '--short')).toContain('src/value.txt')
    const stateRoot = join(repo.root, '.git', 'leppy-loop', 'runs')
    const stateDir = join(stateRoot, readdirSync(stateRoot)[0]!)
    expect(JSON.parse(readFileSync(join(stateDir, 'run.json'), 'utf8')).status).toBe('interrupted')
  }, 90_000)

  it('normalizes multiple scoped commits without persisting a false controller failure', async () => {
    const repo = repository('- [ ] Change `src/value.txt` | Done: value says done\n')
    const worker: WorkerAdapter = {
      async run(request) {
        writeFileSync(join(request.worktree, 'src', 'value.txt'), 'first\n')
        git(request.worktree, 'add', '--', 'src/value.txt')
        git(request.worktree, 'commit', '-m', 'feat: first unauthorized commit')
        writeFileSync(join(request.worktree, 'src', 'value.txt'), 'second\n')
        git(request.worktree, 'commit', '-am', 'feat: second unauthorized commit')
        return completedOutcome('two commits')
      },
    }
    const result = await runLeppyLoop(
      { tasks: repo.tasks, syncBranch: 'main', fetch: false },
      { ...modelDeps, runId: () => 'outerdetail', worker },
    )
    expect(result).toMatchObject({ status: 'completed', completedTasks: 1 })
    const stored = JSON.parse(readFileSync(join(repo.root, '.git', 'leppy-loop', 'runs', 'outerdetail', 'run.json'), 'utf8'))
    expect(stored.status).toBe('completed')
    expect(stored).not.toHaveProperty('lastError')
  }, 90_000)

  it.skip('obsolete: dependency repair no longer requires ENOTCACHED digest ceremony', async () => {
    const repo = repository('- [ ] Change `src/value.txt` | Done: value says done\n')
    writeFileSync(join(repo.root, '.gitignore'), 'node_modules/\n')
    writeFileSync(join(repo.root, 'package.json'), '{"name":"runner-fixture","private":true,"devDependencies":{"typescript":"5.9.3"}}\n')
    writeFileSync(join(repo.root, 'package-lock.json'), '{"name":"runner-fixture","lockfileVersion":3,"packages":{"":{"name":"runner-fixture","devDependencies":{"typescript":"5.9.3"}},"node_modules/typescript":{"version":"5.9.3","resolved":"https://registry.npmjs.org/typescript/-/typescript-5.9.3.tgz","integrity":"sha512-jl1vZzPDinLr9eUt3J/t7V6FgNEw9QjvBPdysz9KfQDD41fQrC2Y4vKQdiaUpFT4bXlb1RHhLpp8wtm6M5TgSw==","bin":{"tsc":"bin/tsc"}}}}\n')
    git(repo.root, 'add', '--', '.gitignore', 'package.json', 'package-lock.json')
    git(repo.root, 'commit', '-m', 'chore: add package metadata')
    const firstWorker = new FakeWorker([{ status: 'failed', output: '', error: 'worker tool failure budget exhausted: npm error code ENOTCACHED; cache mode is only-if-cached' }])
    const first = await runLeppyLoop(
      { tasks: repo.tasks, syncBranch: 'main', fetch: false },
      { ...modelDeps, installNpmDependencies: fakeNpmInstall, worker: firstWorker },
    )
    expect(first.status).toBe('stalled')
    const stalledState = JSON.parse(readFileSync(join(first.stateDir!, 'run.json'), 'utf8'))
    expect(stalledState).toMatchObject({ dependencyBridgeActive: true, autoRecoveryBlocked: true, lastError: expect.stringContaining('ENOTCACHED') })
    rmSync(join(first.worktree!, 'node_modules'), { recursive: true, force: true })

    const shim = join(repo.root, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc')
    mkdirSync(join(repo.root, 'node_modules', '.bin'), { recursive: true })
    mkdirSync(join(repo.root, 'node_modules', 'typescript'), { recursive: true })
    writeFileSync(join(repo.root, 'node_modules', 'typescript', 'package.json'), '{"name":"typescript","version":"5.9.3","resolved":"https://registry.npmjs.org/typescript/-/typescript-5.9.3.tgz","integrity":"sha512-jl1vZzPDinLr9eUt3J/t7V6FgNEw9QjvBPdysz9KfQDD41fQrC2Y4vKQdiaUpFT4bXlb1RHhLpp8wtm6M5TgSw==","bin":{"tsc":"bin/tsc"}}\n')
    writeFileSync(shim, 'fixture shim\n')
    writeFileSync(join(repo.root, 'node_modules', '.package-lock.json'), '{"lockfileVersion":3,"packages":{"node_modules/typescript":{"version":"5.9.3","resolved":"https://registry.npmjs.org/typescript/-/typescript-5.9.3.tgz","integrity":"sha512-jl1vZzPDinLr9eUt3J/t7V6FgNEw9QjvBPdysz9KfQDD41fQrC2Y4vKQdiaUpFT4bXlb1RHhLpp8wtm6M5TgSw==","bin":{"tsc":"bin/tsc"}}}}\n')
    const recoveredWorker = new FakeWorker()
    const recovered = await runLeppyLoop(
      {
        tasks: repo.tasks, syncBranch: 'main', fetch: false, recoverExistingWip: true, recoverRunId: first.runId,
        dependencyRecoveryDigest: createHash('sha256').update(stalledState.lastError).digest('hex'),
      },
      { ...modelDeps, worker: recoveredWorker },
    )

    expect(recovered.status).toBe('completed')
    expect(existsSync(join(recovered.worktree!, 'node_modules', 'typescript'))).toBe(true)
    expect(existsSync(join(repo.root, 'node_modules', 'typescript'))).toBe(true)
    const state = JSON.parse(readFileSync(join(first.stateDir!, 'run.json'), 'utf8'))
    expect(state.dependencyBridgeActive).toBe(true)
    expect(state.autoRecoveryBlocked).toBeUndefined()
    expect(state.failureStreak).toBeUndefined()
  }, 90_000)

  it.skip('obsolete: ordinary Windows argv failures use same-job advisory recovery', async () => {
    const repo = repository('- [ ] Change `src/value.txt` | Done: value says done\n')
    writeFileSync(join(repo.root, '.gitignore'), 'node_modules/\n')
    writeFileSync(join(repo.root, 'package.json'), '{"name":"runner-fixture","private":true,"devDependencies":{"typescript":"5.9.3"}}\n')
    writeFileSync(join(repo.root, 'package-lock.json'), '{"name":"runner-fixture","lockfileVersion":3,"packages":{"":{"name":"runner-fixture","devDependencies":{"typescript":"5.9.3"}},"node_modules/typescript":{"version":"5.9.3","resolved":"https://registry.npmjs.org/typescript/-/typescript-5.9.3.tgz","integrity":"sha512-jl1vZzPDinLr9eUt3J/t7V6FgNEw9QjvBPdysz9KfQDD41fQrC2Y4vKQdiaUpFT4bXlb1RHhLpp8wtm6M5TgSw==","bin":{"tsc":"bin/tsc"}}}}\n')
    git(repo.root, 'add', '--', '.gitignore', 'package.json', 'package-lock.json')
    git(repo.root, 'commit', '-m', 'chore: add package metadata')
    mkdirSync(join(repo.root, 'node_modules', '.bin'), { recursive: true })
    mkdirSync(join(repo.root, 'node_modules', 'typescript'), { recursive: true })
    writeFileSync(join(repo.root, 'node_modules', 'typescript', 'package.json'), '{"name":"typescript","version":"5.9.3","resolved":"https://registry.npmjs.org/typescript/-/typescript-5.9.3.tgz","integrity":"sha512-jl1vZzPDinLr9eUt3J/t7V6FgNEw9QjvBPdysz9KfQDD41fQrC2Y4vKQdiaUpFT4bXlb1RHhLpp8wtm6M5TgSw==","bin":{"tsc":"bin/tsc"}}\n')
    writeFileSync(join(repo.root, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc'), 'fixture shim\n')
    writeFileSync(join(repo.root, 'node_modules', '.package-lock.json'), '{"lockfileVersion":3,"packages":{"node_modules/typescript":{"version":"5.9.3","resolved":"https://registry.npmjs.org/typescript/-/typescript-5.9.3.tgz","integrity":"sha512-jl1vZzPDinLr9eUt3J/t7V6FgNEw9QjvBPdysz9KfQDD41fQrC2Y4vKQdiaUpFT4bXlb1RHhLpp8wtm6M5TgSw==","bin":{"tsc":"bin/tsc"}}}}\n')
    const firstWorker = new FakeWorker([{ status: 'failed', output: '', error: "worker Windows argv compatibility failure after one tool call: 'node_modules' não é reconhecido como um comando interno ou externo" }])
    const first = await runLeppyLoop({ tasks: repo.tasks, syncBranch: 'main', fetch: false }, { ...modelDeps, worker: firstWorker })
    expect(first.status).toBe('stalled')
    const stalled = JSON.parse(readFileSync(join(first.stateDir!, 'run.json'), 'utf8'))
    expect(stalled).toMatchObject({ dependencyBridgeActive: true, autoRecoveryBlocked: true })

    const recovered = await runLeppyLoop({
      tasks: repo.tasks, syncBranch: 'main', fetch: false, recoverExistingWip: true, recoverRunId: first.runId,
      windowsArgvRecoveryDigest: createHash('sha256').update(stalled.lastError).digest('hex'),
    }, { ...modelDeps, worker: new FakeWorker() })
    expect(recovered.status).toBe('completed')
    expect(JSON.parse(readFileSync(join(first.stateDir!, 'run.json'), 'utf8'))).toMatchObject({ windowsArgvBridgeActive: true })
  }, 90_000)

  it.skip('obsolete: dependency digests no longer gate automatic locked repair', async () => {
    const repo = repository('- [ ] Change `src/value.txt` | Done: value says done\n')
    writeFileSync(join(repo.root, '.gitignore'), 'node_modules/\n')
    writeFileSync(join(repo.root, 'package.json'), '{"name":"runner-fixture","private":true,"devDependencies":{"typescript":"5.9.3"}}\n')
    writeFileSync(join(repo.root, 'package-lock.json'), '{"name":"runner-fixture","lockfileVersion":3,"packages":{"":{"name":"runner-fixture","devDependencies":{"typescript":"5.9.3"}},"node_modules/typescript":{"version":"5.9.3","resolved":"https://registry.npmjs.org/typescript/-/typescript-5.9.3.tgz","integrity":"sha512-jl1vZzPDinLr9eUt3J/t7V6FgNEw9QjvBPdysz9KfQDD41fQrC2Y4vKQdiaUpFT4bXlb1RHhLpp8wtm6M5TgSw==","bin":{"tsc":"bin/tsc"}}}}\n')
    git(repo.root, 'add', '--', '.gitignore', 'package.json', 'package-lock.json')
    git(repo.root, 'commit', '-m', 'chore: add package metadata')
    await fakeNpmInstall(repo.root)
    const first = await runLeppyLoop({ tasks: repo.tasks, syncBranch: 'main', fetch: false }, {
      ...modelDeps,
      worker: new FakeWorker([{ status: 'failed', output: '', error: "worker dependency unavailable after one tool failure; code: MODULE_NOT_FOUND; Cannot find module 'worktree/node_modules/typescript/bin/tsc'" }]),
    })
    expect(first.status).toBe('stalled')
    const stalled = JSON.parse(readFileSync(join(first.stateDir!, 'run.json'), 'utf8'))
    expect(existsSync(join(first.worktree!, 'node_modules', 'typescript', 'package.json'))).toBe(true)
    const forbiddenWorker = new FakeWorker()
    const refused = await runLeppyLoop({
      tasks: repo.tasks, syncBranch: 'main', fetch: false, recoverExistingWip: true, recoverRunId: first.runId,
      dependencyRecoveryDigest: createHash('sha256').update(stalled.lastError).digest('hex'),
    }, { ...modelDeps, worker: forbiddenWorker })
    expect(refused.status).toBe('stalled')
    expect(refused.detail).toContain('did not publish a new isolated tree')
    expect(forbiddenWorker.calls).toHaveLength(0)
  }, 90_000)

  it('rematerializes a disappeared dependency tree automatically before recovery worker startup', async () => {
    const repo = repository('- [ ] Change `src/value.txt` | Done: value says done\n')
    writeFileSync(join(repo.root, '.gitignore'), 'node_modules/\n')
    writeFileSync(join(repo.root, 'package.json'), '{"name":"runner-fixture","private":true,"devDependencies":{"typescript":"5.9.3"}}\n')
    writeFileSync(join(repo.root, 'package-lock.json'), '{"name":"runner-fixture","lockfileVersion":3,"packages":{"":{"name":"runner-fixture","devDependencies":{"typescript":"5.9.3"}},"node_modules/typescript":{"version":"5.9.3","resolved":"https://registry.npmjs.org/typescript/-/typescript-5.9.3.tgz","integrity":"sha512-jl1vZzPDinLr9eUt3J/t7V6FgNEw9QjvBPdysz9KfQDD41fQrC2Y4vKQdiaUpFT4bXlb1RHhLpp8wtm6M5TgSw==","bin":{"tsc":"bin/tsc"}}}}\n')
    git(repo.root, 'add', '--', '.gitignore', 'package.json', 'package-lock.json')
    git(repo.root, 'commit', '-m', 'chore: add package metadata')
    await fakeNpmInstall(repo.root)
    const worker = new FakeWorker([implementationImpossibleOutcome('pause before dependency disappearance')])
    const first = await runLeppyLoop({ tasks: repo.tasks, syncBranch: 'main', fetch: false }, { ...modelDeps, worker })
    expect(first.status).toBe('stalled')
    rmSync(join(first.worktree!, 'node_modules'), { recursive: true, force: true })
    rmSync(join(repo.root, 'node_modules'), { recursive: true, force: true })

    const recovered = await runLeppyLoop({
      tasks: repo.tasks, syncBranch: 'main', fetch: false, recoverExistingWip: true, recoverRunId: first.runId,
    }, { ...modelDeps, installNpmDependencies: fakeNpmInstall, worker })
    expect(recovered.status).toBe('completed')
    expect(existsSync(join(first.worktree!, 'node_modules', 'typescript', 'package.json'))).toBe(true)
  }, 90_000)

  it('automatically replaces an invalid dependency tree under the controller lock', async () => {
    const repo = repository('- [ ] Change `src/value.txt` | Done: value says done\n')
    writeFileSync(join(repo.root, '.gitignore'), 'node_modules/\n')
    writeFileSync(join(repo.root, 'package.json'), '{"name":"runner-fixture","private":true,"devDependencies":{"typescript":"5.9.3"}}\n')
    writeFileSync(join(repo.root, 'package-lock.json'), '{"name":"runner-fixture","lockfileVersion":3,"packages":{"":{"name":"runner-fixture","devDependencies":{"typescript":"5.9.3"}},"node_modules/typescript":{"version":"5.9.3","resolved":"https://registry.npmjs.org/typescript/-/typescript-5.9.3.tgz","integrity":"sha512-jl1vZzPDinLr9eUt3J/t7V6FgNEw9QjvBPdysz9KfQDD41fQrC2Y4vKQdiaUpFT4bXlb1RHhLpp8wtm6M5TgSw==","bin":{"tsc":"bin/tsc"}}}}\n')
    git(repo.root, 'add', '--', '.gitignore', 'package.json', 'package-lock.json')
    git(repo.root, 'commit', '-m', 'chore: add package metadata')
    await fakeNpmInstall(repo.root)
    const worker = new FakeWorker([implementationImpossibleOutcome('pause before invalid dependency tree')])
    const first = await runLeppyLoop({ tasks: repo.tasks, syncBranch: 'main', fetch: false }, { ...modelDeps, worker })
    expect(first.status).toBe('stalled')
    rmSync(join(first.worktree!, 'node_modules'), { recursive: true, force: true })
    rmSync(join(repo.root, 'node_modules'), { recursive: true, force: true })
    mkdirSync(join(first.worktree!, 'node_modules'))
    writeFileSync(join(first.worktree!, 'node_modules', 'invalid-tree.txt'), 'invalid\n')

    const recovered = await runLeppyLoop({
      tasks: repo.tasks, syncBranch: 'main', fetch: false, recoverExistingWip: true, recoverRunId: first.runId,
    }, { ...modelDeps, installNpmDependencies: fakeNpmInstall, worker })
    expect(recovered.status).toBe('completed')
    expect(existsSync(join(first.worktree!, 'node_modules', 'invalid-tree.txt'))).toBe(false)
    expect(existsSync(join(first.worktree!, 'node_modules', 'typescript', 'package.json'))).toBe(true)
  }, 90_000)

  it('reconciles command-persisted renewal and next transition before one runner recovery while preserving WIP', async () => {
    const repo = repository('- [ ] Change `src/value.txt` | paths=src/value.txt | Done: value says done\n')
    const oldAuthority: LifecycleAuthority = {
      sessionId: 'renewed-run-owner', allowPublication: false, maxIterations: 64, maxRepairCycles: 3,
      maxTransitions: 16, transitions: 1, issuedAt: 1_000, expiresAt: 86_401_000,
    }
    const renewedAuthority: LifecycleAuthority = {
      ...oldAuthority, issuedAt: 90_000_000, expiresAt: 176_400_000,
    }
    const admittedAuthority: LifecycleAuthority = { ...renewedAuthority, transitions: 2 }
    let workerCalls = 0
    const observedWip: string[] = []
    const worker: WorkerAdapter = { async run(request) {
      workerCalls += 1
      const valuePath = join(request.worktree, 'src', 'value.txt')
      if (workerCalls === 1) {
        writeFileSync(valuePath, 'preserved renewal WIP\n')
        return { status: 'interrupted', output: '', error: 'simulated interruption before permit renewal' }
      }
      observedWip.push(readFileSync(valuePath, 'utf8'))
      writeFileSync(valuePath, `${readFileSync(valuePath, 'utf8')}completed after next transition\n`)
      git(request.worktree, 'add', '--', 'src/value.txt')
      git(request.worktree, 'commit', '-m', 'test: continue after lifecycle renewal')
      return completedOutcome('renewed authority admitted the controller next transition')
    } }

    const first = await runLeppyLoop({
      tasks: repo.tasks, syncBranch: 'main', fetch: false, lifecycleAuthority: oldAuthority,
    }, { ...modelDeps, worker })
    expect(first.status).toBe('interrupted')
    expect(readFileSync(join(first.worktree!, 'src', 'value.txt'), 'utf8')).toBe('preserved renewal WIP\n')
    expect(JSON.parse(readFileSync(join(first.stateDir!, 'run.json'), 'utf8')).lifecycleAuthority).toEqual(oldAuthority)

    appendLifecycleAuthorityReceipt(first.stateDir!, first.runId, oldAuthority)
    appendLifecycleAuthorityReceipt(first.stateDir!, first.runId, renewedAuthority)
    appendLifecycleAuthorityReceipt(first.stateDir!, first.runId, admittedAuthority)

    const setupWorker = new FakeWorker()
    await expect(runLeppyLoop({
      tasks: repo.tasks, syncBranch: 'main', fetch: false, recoverExistingWip: true, recoverRunId: first.runId,
      lifecycleAuthority: { ...admittedAuthority, sessionId: 'another-session' },
    }, { ...modelDeps, worker: setupWorker })).rejects.toThrow('lifecycle authority does not match the authenticated run')
    expect(setupWorker.calls).toHaveLength(0)
    expect(readFileSync(join(first.worktree!, 'src', 'value.txt'), 'utf8')).toBe('preserved renewal WIP\n')

    const completed = await runLeppyLoop({
      tasks: repo.tasks, syncBranch: 'main', fetch: false, recoverExistingWip: true, recoverRunId: first.runId,
      lifecycleAuthority: admittedAuthority,
    }, { ...modelDeps, worker })
    expect(completed.status).toBe('completed')
    expect(completed.runId).toBe(first.runId)
    expect(workerCalls).toBe(2)
    expect(observedWip).toEqual(['preserved renewal WIP\n'])
    expect(readFileSync(join(completed.worktree!, 'src', 'value.txt'), 'utf8')).toBe(
      'preserved renewal WIP\ncompleted after next transition\n',
    )
    expect(JSON.parse(readFileSync(join(first.stateDir!, 'run.json'), 'utf8')).lifecycleAuthority).toEqual(admittedAuthority)
  }, 90_000)

  it('blocks worker release when authenticated revocation lands after task setup', async () => {
    const repo = repository('- [ ] Change `src/value.txt` | paths=src/value.txt | Done: value says done\n')
    const issuedAt = Date.now() - 1_000
    const authority: LifecycleAuthority = {
      sessionId: 'revoked-before-worker-owner', allowPublication: false, maxIterations: 64, maxRepairCycles: 3,
      maxTransitions: 16, transitions: 1, issuedAt, expiresAt: issuedAt + 86_400_000,
    }
    const revoked = { ...authority, revokedAt: issuedAt + 500 }
    const worker = new FakeWorker()
    let revocationAppended = false
    let observedRunId = ''

    await expect(runLeppyLoop({
      tasks: repo.tasks, syncBranch: 'main', fetch: false, lifecycleAuthority: authority,
    }, {
      ...modelDeps,
      worker,
      onProgress: async update => {
        if (update.type !== 'task-start' || revocationAppended) return
        revocationAppended = true
        observedRunId = update.runId
        const stateDir = await lifecycleStateDir(repo.root, update.runId)
        appendLifecycleAuthorityReceipt(stateDir, update.runId, authority)
        appendLifecycleAuthorityReceipt(stateDir, update.runId, revoked)
      },
    })).rejects.toThrow('direct human Leppy intent')

    expect(revocationAppended).toBe(true)
    expect(worker.calls).toHaveLength(0)
    const stateDir = await lifecycleStateDir(repo.root, observedRunId)
    const state = JSON.parse(readFileSync(join(stateDir, 'run.json'), 'utf8'))
    expect(state).toMatchObject({ status: 'interrupted', lifecycleAuthority: revoked })
    expect(state.lastError).toContain('direct human Leppy intent')
    expect(git(state.worktree, 'status', '--porcelain')).toBe('')
  }, 90_000)

  it('releases lifecycle admission mutex while a worker is blocked so stop persists before abort', async () => {
    const repo = repository('- [ ] Change `src/value.txt` | paths=src/value.txt | Done: value says done\n')
    const issuedAt = Date.now() - 1_000
    const authority: LifecycleAuthority = {
      sessionId: 'persist-before-kill-owner', allowPublication: false, maxIterations: 64, maxRepairCycles: 3,
      maxTransitions: 16, transitions: 1, issuedAt, expiresAt: issuedAt + 86_400_000,
    }
    const revoked: LifecycleAuthority = { ...authority, revokedAt: issuedAt + 500 }
    const control = new AbortController()
    let workerAdmissions = 0
    let workerSettled = false
    let workerSignal: AbortSignal | undefined
    let admitted!: (request: WorkerRequest) => void
    const workerAdmitted = new Promise<WorkerRequest>(resolveAdmitted => { admitted = resolveAdmitted })
    const worker: WorkerAdapter = {
      async run(request, signal) {
        workerAdmissions += 1
        workerSignal = signal
        admitted(request)
        return await new Promise<WorkerOutcome>(resolveOutcome => {
          const settle = () => {
            workerSettled = true
            resolveOutcome({ status: 'interrupted', output: '', error: 'Stopped through direct human Leppy intent' })
          }
          if (signal.aborted) settle()
          else signal.addEventListener('abort', settle, { once: true })
        })
      },
    }
    const running = runLeppyLoop({
      tasks: repo.tasks, syncBranch: 'main', fetch: false, lifecycleAuthority: authority,
    }, { ...modelDeps, worker, signal: control.signal })
    const request = await workerAdmitted
    const stateDir = await lifecycleStateDir(repo.root, request.runId)
    const mutexStartedAt = Date.now()
    const mutex = acquireLifecycleAuthorityMutex(stateDir)
    let timeout: ReturnType<typeof setTimeout> | undefined
    let releaseMutex: (() => void) | undefined
    try {
      releaseMutex = await Promise.race([
        mutex,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => { reject(new Error('lifecycle admission mutex remained held by blocked worker')) }, 750)
        }),
      ])
    } catch (error) {
      control.abort(new Error('Stopped through direct human Leppy intent'))
      const lateRelease = await mutex
      lateRelease()
      await running.catch(() => undefined)
      throw error
    } finally {
      if (timeout) clearTimeout(timeout)
    }

    const mutexElapsedMs = Date.now() - mutexStartedAt
    try {
      appendLifecycleAuthorityReceipt(stateDir, request.runId, authority)
      appendLifecycleAuthorityReceipt(stateDir, request.runId, revoked)
    } finally {
      releaseMutex!()
    }
    control.abort(new Error('Stopped through direct human Leppy intent'))
    await expect(running).rejects.toThrow('direct human Leppy intent')

    expect(mutexElapsedMs).toBeLessThan(1_000)
    expect(workerAdmissions).toBe(1)
    expect(workerSignal?.aborted).toBe(true)
    expect(workerSettled).toBe(true)
    const state = JSON.parse(readFileSync(join(stateDir, 'run.json'), 'utf8'))
    expect(state).toMatchObject({ status: 'interrupted', lifecycleAuthority: revoked })
    expect(state.lastError).toContain('direct human Leppy intent')
  }, 90_000)

  it('rereads locked-fresh progress when two exact recoveries observed the same pre-completion state', async () => {
    const repo = repository('- [ ] Change `src/value.txt` | paths=src/value.txt | Done: value says done\n')
    const first = await runLeppyLoop({ tasks: repo.tasks, syncBranch: 'main', fetch: false }, {
      ...modelDeps,
      worker: new FakeWorker([implementationImpossibleOutcome('seed recoverable run')]),
    })
    expect(first.status).toBe('stalled')

    let releaseWorker!: () => void
    let workerEntered!: () => void
    const workerGate = new Promise<void>(resolve => { releaseWorker = resolve })
    const entered = new Promise<void>(resolve => { workerEntered = resolve })
    let workerCalls = 0
    const worker: WorkerAdapter = { async run(request) {
      workerCalls += 1
      const valuePath = join(request.worktree, 'src', 'value.txt')
      writeFileSync(valuePath, 'first recovery preserved WIP\n')
      workerEntered()
      await workerGate
      git(request.worktree, 'add', '--', 'src/value.txt')
      git(request.worktree, 'commit', '-m', 'test: complete first queued recovery')
      return completedOutcome('first queued recovery completed the authenticated task')
    } }
    const firstProgress: RunProgress[] = []
    const secondProgress: RunProgress[] = []
    const firstRecovery = runLeppyLoop({
      tasks: repo.tasks, syncBranch: 'main', fetch: false, recoverExistingWip: true, recoverRunId: first.runId,
    }, { ...modelDeps, worker, onProgress: update => { firstProgress.push(update) } })
    await entered

    const realBranch = gitModule.branch
    let branchObserved!: () => void
    let releaseBranch!: () => void
    const observedPreLock = new Promise<void>(resolve => { branchObserved = resolve })
    const branchGate = new Promise<void>(resolve => { releaseBranch = resolve })
    let claimed = false
    const branchSpy = vi.spyOn(gitModule, 'branch').mockImplementation(async cwd => {
      if (!claimed) {
        claimed = true
        branchObserved()
        await branchGate
      }
      return realBranch(cwd)
    })
    let secondRecovery: Promise<Awaited<ReturnType<typeof runLeppyLoop>>> | undefined
    try {
      secondRecovery = runLeppyLoop({
        tasks: repo.tasks, syncBranch: 'main', fetch: false, recoverExistingWip: true, recoverRunId: first.runId,
      }, { ...modelDeps, worker, onProgress: update => { secondProgress.push(update) } })
      void secondRecovery.catch(() => undefined)
      await Promise.race([
        observedPreLock,
        new Promise<never>((_resolve, reject) => setTimeout(() => { reject(new Error('second recovery did not reach pre-lock branch validation')) }, 20_000)),
      ])

      releaseWorker()
      const completedFirst = await firstRecovery
      expect(completedFirst.status).toBe('completed')
      const stateAfterFirst = JSON.parse(readFileSync(join(first.stateDir!, 'run.json'), 'utf8'))
      const headAfterFirst = git(first.worktree!, 'rev-parse', 'HEAD')
      expect(stateAfterFirst).toMatchObject({ status: 'completed', completedTasks: 1 })
      expect(readFileSync(join(first.worktree!, 'src', 'value.txt'), 'utf8')).toBe('first recovery preserved WIP\n')

      releaseBranch()
      const completedSecond = await secondRecovery
      expect(completedSecond.status).toBe('completed')
      expect(completedSecond.runId).toBe(first.runId)
      expect(workerCalls).toBe(1)
      expect(secondProgress.filter(update => update.type === 'task-start')).toHaveLength(0)
      expect(firstProgress.filter(update => update.type === 'task-start')).toHaveLength(1)
      expect(git(first.worktree!, 'rev-parse', 'HEAD')).toBe(headAfterFirst)
      expect(readFileSync(join(first.worktree!, 'src', 'value.txt'), 'utf8')).toBe('first recovery preserved WIP\n')
      expect(JSON.parse(readFileSync(join(first.stateDir!, 'run.json'), 'utf8'))).toMatchObject({
        status: 'completed', completedTasks: 1, attempt: stateAfterFirst.attempt, taskAttempts: stateAfterFirst.taskAttempts,
      })
    } finally {
      releaseWorker()
      releaseBranch()
      branchSpy.mockRestore()
      if (secondRecovery) await secondRecovery.catch(() => undefined)
    }
  }, 90_000)

  it('removes an out-of-scope npm cache and adopts preserved scoped WIP in the same job', async () => {
    const repo = repository('- [ ] Change `src/value.txt` | paths=src/value.txt | Done: value says done\n')
    const issuedAt = Date.now() - 1_000
    const expiresAt = Date.now() + 60_000
    const authority = (transitions: number): LifecycleAuthority => ({
      sessionId: 'npm-cache-owner', allowPublication: false, maxIterations: 64, maxRepairCycles: 3,
      maxTransitions: 16, transitions, issuedAt, expiresAt,
    })
    let workerCalls = 0
    const worker: WorkerAdapter = {
      async run(request) {
        workerCalls += 1
        if (workerCalls === 1) {
          writeFileSync(join(request.worktree, 'src', 'value.txt'), 'done\n')
          mkdirSync(join(request.worktree, '.npm-cache', '_logs'), { recursive: true })
          writeFileSync(join(request.worktree, '.npm-cache', '_logs', 'attempt.log'), 'preserved cache bytes\n')
          return {
            status: 'failed', output: '',
            error: 'npx is unavailable and leppy_commit rejected .npm-cache/_logs/attempt.log outside this task write scope',
          }
        }
        expect(existsSync(join(request.worktree, '.npm-cache'))).toBe(false)
        expect(request.instructions.join('\n')).toContain('private authenticated quarantine')
        git(request.worktree, 'add', '--', 'src/value.txt')
        git(request.worktree, 'commit', '-m', 'test: preserve recovered task wip')
        return completedOutcome('validated preserved task WIP with the bare local executable')
      },
    }
    const result = await runLeppyLoop({
      tasks: repo.tasks, syncBranch: 'main', fetch: false, lifecycleAuthority: authority(1),
    }, { ...modelDeps, worker })
    expect(result).toMatchObject({ status: 'completed', completedTasks: 1 })
    expect(existsSync(join(result.worktree!, '.npm-cache'))).toBe(false)
    expect(readFileSync(join(result.worktree!, 'src', 'value.txt'), 'utf8')).toBe('done\n')
    expect(workerCalls).toBe(1)
    expect(readFileSync(join(result.stateDir!, 'events.jsonl'), 'utf8')).toContain('out-of-scope-validation-side-effects')
  }, 90_000)

  it.skip('obsolete: ordinary cache side effects are removed in the same job', async () => {
    const repo = repository('- [ ] Change `src/value.txt` | paths=src/value.txt | Done: value says done\n')
    const issuedAt = Date.now() - 1_000
    const expiresAt = Date.now() + 60_000
    const authority = (transitions: number): LifecycleAuthority => ({
      sessionId: 'npm-cache-reconcile-owner', allowPublication: false, maxIterations: 64, maxRepairCycles: 3,
      maxTransitions: 16, transitions, issuedAt, expiresAt,
    })
    let calls = 0
    const worker: WorkerAdapter = { async run(request) {
      calls += 1
      if (calls === 1) {
        mkdirSync(join(request.worktree, '.npm-cache', '_logs'), { recursive: true })
        writeFileSync(join(request.worktree, '.npm-cache', '_logs', 'attempt.log'), 'original\n')
        return { status: 'failed', output: '', error: 'npx failed and leppy_commit rejected .npm-cache/_logs/attempt.log outside this task write scope' }
      }
      return { status: 'interrupted', output: '', error: 'simulated interruption after completed quarantine receipt' }
    } }
    const first = await runLeppyLoop({ tasks: repo.tasks, syncBranch: 'main', fetch: false, lifecycleAuthority: authority(1) }, { ...modelDeps, worker })
    const firstState = JSON.parse(readFileSync(join(first.stateDir!, 'run.json'), 'utf8'))
    const interrupted = await runLeppyLoop({
      tasks: repo.tasks, syncBranch: 'main', fetch: false, recoverExistingWip: true, recoverRunId: first.runId,
      workerArtifactRecoveryDigest: createHash('sha256').update(firstState.lastError).digest('hex'), lifecycleAuthority: authority(2),
    }, { ...modelDeps, worker })
    expect(interrupted.status).toBe('interrupted')
    const completedState = JSON.parse(readFileSync(join(first.stateDir!, 'run.json'), 'utf8'))
    delete completedState.currentTask
    delete completedState.stateProof
    writeFileSync(join(first.stateDir!, 'run.json'), `${JSON.stringify(completedState, null, 2)}\n`)
    persistRunStateProof(
      first.stateDir!, completedState,
      Buffer.from(readFileSync(join(first.stateDir!, 'lease.key'), 'utf8').trim(), 'base64'),
    )
    mkdirSync(join(first.worktree!, '.npm-cache', '_logs'), { recursive: true })
    writeFileSync(join(first.worktree!, '.npm-cache', '_logs', 'downtime.log'), 'new during downtime\n')
    const forbiddenWorker = new FakeWorker()
    const refused = await runLeppyLoop({
      tasks: repo.tasks, syncBranch: 'main', fetch: false, recoverExistingWip: true, recoverRunId: first.runId,
      lifecycleAuthority: authority(3),
    }, { ...modelDeps, worker: forbiddenWorker })
    expect(refused.status).toBe('stalled')
    expect(refused.detail).toContain('appeared after the authenticated quarantine')
    expect(forbiddenWorker.calls).toHaveLength(0)
    expect(readFileSync(join(first.worktree!, '.npm-cache', '_logs', 'downtime.log'), 'utf8')).toBe('new during downtime\n')
  }, 90_000)

  it.skip('obsolete: same-job cache cleanup does not require recovery inference', async () => {
    const repo = repository('- [ ] Change `src/value.txt` | paths=src/value.txt | Done: value says done\n')
    const issuedAt = Date.now() - 1_000
    const expiresAt = Date.now() + 60_000
    const authority = (transitions: number): LifecycleAuthority => ({
      sessionId: 'npm-cache-exact-owner', allowPublication: false, maxIterations: 64, maxRepairCycles: 3,
      maxTransitions: 16, transitions, issuedAt, expiresAt,
    })
    const first = await runLeppyLoop({
      tasks: repo.tasks, syncBranch: 'main', fetch: false, lifecycleAuthority: authority(1),
    }, { ...modelDeps, worker: {
      async run(request) {
        mkdirSync(join(request.worktree, '.npm-cache', '_logs'), { recursive: true })
        writeFileSync(join(request.worktree, '.npm-cache', '_logs', 'attempt.log'), 'preserve me\n')
        return { status: 'failed', output: '', error: 'npx failed and leppy_commit rejected .npm-cache/_logs/attempt.log outside this task write scope' }
      },
    } })
    const firstState = JSON.parse(readFileSync(join(first.stateDir!, 'run.json'), 'utf8'))
    const automaticReceipt = JSON.parse(readFileSync(join(first.stateDir!, 'worker-npm-cache-recovery.json'), 'utf8'))
    expect(existsSync(join(first.worktree!, '.npm-cache'))).toBe(false)
    expect(readFileSync(join(automaticReceipt.quarantine, '_logs', 'attempt.log'), 'utf8')).toBe('preserve me\n')
    const forbiddenWorker = new FakeWorker()
    const refused = await runLeppyLoop({
      tasks: repo.tasks, syncBranch: 'main', fetch: false, recoverExistingWip: true,
      workerArtifactRecoveryDigest: createHash('sha256').update(firstState.lastError).digest('hex'),
      lifecycleAuthority: authority(2),
    }, { ...modelDeps, worker: forbiddenWorker })
    expect(refused.status).toBe('stalled')
    expect(refused.detail).toContain('exact authenticated existing run')
    expect(forbiddenWorker.calls).toHaveLength(0)
    expect(existsSync(join(first.worktree!, '.npm-cache'))).toBe(false)
    expect(readFileSync(join(automaticReceipt.quarantine, '_logs', 'attempt.log'), 'utf8')).toBe('preserve me\n')
  }, 90_000)

  it.skip('obsolete: unresolved dependency misses now use automatic locked repair', async () => {
    const repo = repository('- [ ] Change `src/value.txt` | Done: value says done\n')
    const first = await runLeppyLoop({ tasks: repo.tasks, syncBranch: 'main', fetch: false }, {
      ...modelDeps,
      worker: new FakeWorker([{ status: 'failed', output: '', error: "worker dependency unavailable after one tool failure; code: MODULE_NOT_FOUND; Cannot find module 'worktree/node_modules/typescript/bin/tsc'" }]),
    })
    expect(first.status).toBe('stalled')
    const firstState = JSON.parse(readFileSync(join(first.stateDir!, 'run.json'), 'utf8'))
    expect(firstState.dependencyBridgeActive).toBeUndefined()
    const forbiddenWorker = new FakeWorker()
    const refused = await runLeppyLoop({
      tasks: repo.tasks, syncBranch: 'main', fetch: false, recoverExistingWip: true, recoverRunId: first.runId,
    }, { ...modelDeps, worker: forbiddenWorker })
    expect(refused.status).toBe('stalled')
    expect(refused.detail).toContain('newly published tree')
    expect(refused.detail).toContain('MODULE_NOT_FOUND')
    expect(forbiddenWorker.calls).toHaveLength(0)
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
