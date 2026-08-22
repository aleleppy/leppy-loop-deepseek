import { createHash, createHmac, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  assertSourceReady, assertTaskCommit, branch as gitBranch, commitControllerChange,
  commitCount, commitSubject, createRunWorktree, head, isConventional, resolveRepoRoot,
  status as gitStatus, summarizeDiff, writeChecklistAndAmend,
} from './git.js'
import { lintChecklist, markTaskDone, parseChecklist, selectTask } from './checklist.js'
import { appendEvent, acquireLock, atomicWriteJson, createLeaseKey, processIdentity, statePath, verifyLease } from './state.js'
import type { SignedLease } from './state.js'
import { fingerprint, redact, scrubEnvironment } from './security.js'
import { runFile, runOpaqueShell } from './process.js'
import { physicalRelative } from './path.js'
import type {
  ChecklistTask, LeppyLoopOptions, ModelCapability, RunDependencies, RunEvent,
  RunEventType, RunResult, WorkerRequest,
} from './types.js'

const DEFAULTS = {
  maxIterations: 64,
  syncMaxSeconds: 120,
  workerTimeoutMs: 30 * 60_000,
  workerOutputLimitBytes: 192 * 1024,
  workerTranscriptLimitBytes: 2 * 1024 * 1024,
  provider: 'deepseek-official',
} as const

interface RunState {
  schemaVersion: 1
  runId: string
  status: RunResult['status'] | 'running'
  repoRoot: string
  checklistRelative: string
  sourceHead: string
  branch: string
  worktree: string
  syncBranch: string
  currentTask?: number
  attempt: number
  completedTasks: number
  gateAttempts: Record<string, number>
  updatedAt: string
}

function digest(text: string): string { return createHash('sha256').update(text).digest('hex') }
function safeSlug(value: string): string { return value.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'default' }
function inside(root: string, path: string): boolean { const rel = relative(root, path); return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)) }

function event(runId: string, type: RunEventType, phase: RunEvent['phase'], data: Record<string, unknown>, task?: ChecklistTask, attempt?: number): RunEvent {
  return { schemaVersion: 1, type, runId, timestamp: new Date().toISOString(), phase, ...(task ? { taskIndex: task.index } : {}), ...(attempt ? { attempt } : {}), data }
}

function selectedModel(task: ChecklistTask, options: LeppyLoopOptions, fallback: { provider: string; model: string; effort?: string }): { provider: string; model: string; effort?: string } {
  return {
    provider: options.provider ?? fallback.provider,
    model: task.metadata.model ?? options.model ?? fallback.model,
    ...(task.metadata.effort ?? options.effort ?? fallback.effort ? { effort: task.metadata.effort ?? options.effort ?? fallback.effort } : {}),
  }
}

async function discoverInstructions(root: string, paths: readonly string[]): Promise<string[]> {
  const candidates = new Set<string>([join(root, 'AGENTS.md'), join(root, 'CLAUDE.md')])
  for (const scoped of paths) {
    let current = resolve(root, scoped)
    if (!existsSync(current) || !statSync(current).isDirectory()) current = dirname(current)
    while (inside(root, current)) {
      candidates.add(join(current, 'AGENTS.md'))
      candidates.add(join(current, 'CLAUDE.md'))
      if (current === root) break
      current = dirname(current)
    }
  }
  return [...candidates].filter(existsSync).map(path => {
    const body = readFileSync(path, 'utf8')
    if (Buffer.byteLength(body) > 64 * 1024) throw new Error(`instruction file exceeds 64 KiB: ${path}`)
    return `Applicable instructions from ${relative(root, path)}:\n${body}`
  })
}

function validateModelSelection(catalog: readonly ModelCapability[], model: string, effort?: string): void {
  const selected = catalog.find(entry => entry.id === model)
  if (!selected) throw new Error(`model ${JSON.stringify(model)} is absent from the selected provider catalog`)
  if (effort && selected.reasoningEfforts && !selected.reasoningEfforts.includes(effort)) throw new Error(`effort ${JSON.stringify(effort)} is unsupported by model ${JSON.stringify(model)}`)
}

function writeState(path: string, state: RunState): void {
  state.updatedAt = new Date().toISOString()
  atomicWriteJson(path, state)
}

function ownership(state: RunState, key: Buffer): string {
  return createHmac('sha256', key).update(JSON.stringify({ runId: state.runId, repoRoot: state.repoRoot, checklistRelative: state.checklistRelative, branch: state.branch, worktree: state.worktree })).digest('base64url')
}

async function terminateAuthenticatedLease(stateDir: string, runId: string): Promise<void> {
  const leaseDir = join(stateDir, 'leases')
  if (!existsSync(leaseDir)) return
  const key = createLeaseKey(stateDir)
  for (const name of readdirSync(leaseDir).filter(file => file.endsWith('.json'))) {
    const lease = JSON.parse(readFileSync(join(leaseDir, name), 'utf8')) as SignedLease
    if (!verifyLease(lease, key) || lease.payload.runId !== runId) continue
    const current = await processIdentity(lease.payload.pid)
    if (current === undefined || current !== lease.payload.processStart) continue
    if (process.platform === 'win32') await runFile('taskkill.exe', ['/PID', String(lease.payload.pid), '/T', '/F'], { allowFailure: true })
    else { try { process.kill(lease.payload.pid, 'SIGTERM') } catch { /* already exited */ } }
  }
}

async function recoverState(base: string, repoRoot: string, checklistRelative: string): Promise<{ state: RunState; dir: string } | undefined> {
  if (!existsSync(base)) return undefined
  const matches: { state: RunState; dir: string }[] = []
  for (const name of readdirSync(base)) {
    const dir = join(base, name)
    const path = join(dir, 'run.json')
    const proof = join(dir, 'ownership.hmac')
    if (!existsSync(path) || !existsSync(proof)) continue
    const state = JSON.parse(readFileSync(path, 'utf8')) as RunState
    if (state.status === 'completed' || state.repoRoot !== repoRoot || state.checklistRelative !== checklistRelative) continue
    const key = createLeaseKey(dir)
    if (readFileSync(proof, 'utf8').trim() !== ownership(state, key)) continue
    matches.push({ state, dir })
  }
  if (matches.length > 1) throw new Error('multiple authenticated matching runs exist; recovery is ambiguous')
  const match = matches[0]
  if (!match) return undefined
  if (!existsSync(match.state.worktree) || await gitBranch(match.state.worktree) !== match.state.branch) throw new Error('authenticated run worktree or branch no longer matches')
  await terminateAuthenticatedLease(match.dir, match.state.runId)
  return match
}

function dryRunResult(runId: string, task: ChecklistTask | undefined, diagnostics: RunResult['diagnostics'], repoRoot: string, tasks: string, model: { provider: string; model: string; effort?: string }, options: LeppyLoopOptions): RunResult {
  const slug = safeSlug(basename(tasks).replace(/\.task\.md$/i, ''))
  const branch = `leppy-loop/${slug}-${runId}`
  const worktree = resolve(dirname(repoRoot), `${basename(repoRoot)}-${slug}-${runId}`)
  const preview = {
    selectedLine: task?.raw ?? null,
    model,
    paths: task?.metadata.paths ?? [],
    branch,
    worktree,
    gate: options.phaseGateCommand ?? task?.metadata.gate ?? null,
    diagnostics,
  }
  process.stdout.write(`${JSON.stringify(preview, null, 2)}\n`)
  return { runId, status: 'dry-run', branch, worktree, completedTasks: 0, ...(task ? { currentTask: task.index } : {}), diagnostics }
}

export async function runLeppyLoop(input: LeppyLoopOptions, dependencies: RunDependencies = {}): Promise<RunResult> {
  const options = { ...DEFAULTS, ...input }
  const runId = dependencies.runId?.() ?? randomUUID().replaceAll('-', '').slice(0, 12)
  const tasksAbsolute = realpathSync(resolve(options.tasks))
  const repoRoot = realpathSync(options.repoRoot ?? await resolveRepoRoot(dirname(tasksAbsolute)))
  const checklistRelative = physicalRelative(repoRoot, tasksAbsolute)
  if (checklistRelative === undefined) throw new Error('--tasks must be inside the source repository')
  await assertSourceReady(repoRoot, checklistRelative)
  const fallbackSelection = dependencies.defaultModel ? await dependencies.defaultModel() : { provider: options.provider, model: options.model ?? 'deepseek-v4-flash', ...(options.effort ? { effort: options.effort } : {}) }
  const provider = options.provider ?? fallbackSelection.provider
  const catalog = dependencies.modelCatalog ? await dependencies.modelCatalog(provider) : [{ id: options.model ?? fallbackSelection.model }]
  const parsedSource = parseChecklist(tasksAbsolute)
  const initialTask = selectTask(parsedSource, options.taskMatch)
  const previewModel = initialTask ? selectedModel(initialTask, options, fallbackSelection) : fallbackSelection
  const defaultEffort = options.effort ?? fallbackSelection.effort
  const diagnostics = lintChecklist(parsedSource, {
    repoRoot, controllerPath: tasksAbsolute, models: catalog, provider,
    defaultModel: options.model ?? fallbackSelection.model,
    ...(defaultEffort ? { defaultEffort } : {}),
    ...(options.phaseGateCommand ? { phaseGateCommand: options.phaseGateCommand } : {}),
  })
  if (options.dryRun) return dryRunResult(runId, initialTask, diagnostics, repoRoot, checklistRelative, previewModel, options)
  if (diagnostics.some(item => item.severity === 'error')) throw new Error(`checklist lint failed:\n${diagnostics.map(item => `${item.line ?? '-'} ${item.code}: ${item.message}`).join('\n')}`)
  if (!dependencies.worker) throw new Error('runLeppyLoop requires a WorkerAdapter outside the Harness bundle')

  const commonRaw = (await runFile('git', ['rev-parse', '--git-common-dir'], { cwd: repoRoot })).stdout.trim()
  const commonDir = realpathSync(resolve(repoRoot, commonRaw))
  const stateBase = resolve(options.artifactsDir ?? join(commonDir, 'leppy-loop', 'runs'))
  mkdirSync(stateBase, { recursive: true })
  let state: RunState
  let stateDir: string
  let releaseLock: (() => void) | undefined
  const recovered = options.recoverExistingWip ? await recoverState(stateBase, repoRoot, checklistRelative) : undefined
  if (options.recoverExistingWip && !recovered) throw new Error('no authenticated matching WIP run exists')
  if (recovered) {
    state = recovered.state
    stateDir = recovered.dir
    releaseLock = acquireLock(commonDir, state.runId)
    appendEvent(join(stateDir, 'events.jsonl'), event(state.runId, 'recovery-start', 'recovery', { worktree: state.worktree }))
    appendEvent(join(stateDir, 'events.jsonl'), event(state.runId, 'recovery-done', 'recovery', { taskIndex: state.currentTask ?? null }))
  } else {
    releaseLock = acquireLock(commonDir, runId)
    try {
      const setup = await createRunWorktree(repoRoot, checklistRelative, options.syncBranch, runId, options.fetch ?? true, options.syncMaxSeconds)
      stateDir = statePath(stateBase, runId)
      mkdirSync(stateDir, { recursive: true })
      state = { schemaVersion: 1, runId, status: 'running', repoRoot, checklistRelative, sourceHead: setup.sourceHead, branch: setup.branch, worktree: setup.worktree, syncBranch: options.syncBranch, attempt: 0, completedTasks: 0, gateAttempts: {}, updatedAt: new Date().toISOString() }
      const key = createLeaseKey(stateDir)
      writeState(join(stateDir, 'run.json'), state)
      writeFileSync(join(stateDir, 'ownership.hmac'), `${ownership(state, key)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      writeFileSync(join(stateDir, 'runner.pid'), `${process.pid}\n`, 'utf8')
      appendEvent(join(stateDir, 'events.jsonl'), event(runId, 'run-start', 'setup', { branch: state.branch, worktree: state.worktree, sourceHead: state.sourceHead }))
    } catch (error) {
      releaseLock()
      throw error
    }
  }

  const eventsPath = join(stateDir, 'events.jsonl')
  const abort = new AbortController()
  const interrupt = (): void => abort.abort(new Error('interrupted'))
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', interrupt)
  try {
    for (let iteration = 0; iteration < options.maxIterations; iteration += 1) {
      const checklistPath = join(state.worktree, checklistRelative)
      const parsed = parseChecklist(checklistPath)
      const task = selectTask(parsed, options.taskMatch)
      if (!task) {
        state.status = 'completed'
        delete state.currentTask
        writeState(join(stateDir, 'run.json'), state)
        appendEvent(eventsPath, event(state.runId, 'run-end', 'complete', { status: 'completed', completedTasks: state.completedTasks }))
        return { runId: state.runId, status: 'completed', branch: state.branch, worktree: state.worktree, stateDir, completedTasks: state.completedTasks, diagnostics }
      }
      state.currentTask = task.index
      state.attempt += 1
      writeState(join(stateDir, 'run.json'), state)
      if (task.kind === 'gate') {
        const command = task.metadata.gate ?? options.phaseGateCommand!
        const key = `${task.index}:${fingerprint(command)}`
        if ((state.gateAttempts[key] ?? 0) > 0) {
          appendEvent(eventsPath, event(state.runId, 'stall', 'gate', { reason: 'gate requires an explicit new invocation after any prior attempt' }, task, state.attempt))
          state.status = 'stalled'; writeState(join(stateDir, 'run.json'), state)
          return { runId: state.runId, status: 'stalled', branch: state.branch, worktree: state.worktree, stateDir, completedTasks: state.completedTasks, currentTask: task.index, diagnostics }
        }
        state.gateAttempts[key] = 1
        writeState(join(stateDir, 'run.json'), state)
        appendEvent(eventsPath, event(state.runId, 'gate-start', 'gate', { commandFingerprint: fingerprint(command) }, task, state.attempt))
        const gate = await runOpaqueShell(command, state.worktree, abort.signal, scrubEnvironment(process.env))
        const receipt = { schemaVersion: 1, runId: state.runId, taskIndex: task.index, attempt: state.attempt, commandFingerprint: fingerprint(command), exitCode: gate.exitCode, stdout: redact(gate.stdout), stderr: redact(gate.stderr), timestamp: new Date().toISOString() }
        mkdirSync(join(stateDir, 'receipts'), { recursive: true })
        atomicWriteJson(join(stateDir, 'receipts', `gate-${task.index}-${state.attempt}.json`), receipt)
        if (gate.exitCode !== 0) {
          appendEvent(eventsPath, event(state.runId, 'gate-failed', 'gate', { exitCode: gate.exitCode }, task, state.attempt))
          state.status = 'stalled'; writeState(join(stateDir, 'run.json'), state)
          return { runId: state.runId, status: 'stalled', branch: state.branch, worktree: state.worktree, stateDir, completedTasks: state.completedTasks, currentTask: task.index, diagnostics }
        }
        const completed = markTaskDone(parsed, task)
        const receiptRelative = join('.leppy-loop-receipts', `gate-${task.index}.json`)
        mkdirSync(dirname(join(state.worktree, receiptRelative)), { recursive: true })
        writeFileSync(join(state.worktree, receiptRelative), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
        writeFileSync(checklistPath, completed, 'utf8')
        await commitControllerChange(state.worktree, [checklistRelative, receiptRelative], `chore(leppy-loop): record ${safeSlug(task.phase)} gate`)
        state.completedTasks += 1
        writeState(join(stateDir, 'run.json'), state)
        appendEvent(eventsPath, event(state.runId, 'gate-end', 'gate', { exitCode: 0 }, task, state.attempt))
        continue
      }

      const model = selectedModel(task, options, fallbackSelection)
      validateModelSelection(catalog, model.model, model.effort)
      const controllerHash = digest(readFileSync(checklistPath, 'utf8'))
      const previousHead = await head(state.worktree)
      const instructions = await discoverInstructions(state.worktree, task.metadata.paths)
      const request: WorkerRequest = {
        runId: state.runId, task, attempt: state.attempt, worktree: state.worktree,
        checklistPath: checklistRelative, allowedPaths: task.metadata.paths,
        model: model.model, provider: model.provider, ...(model.effort ? { effort: model.effort } : {}),
        timeoutMs: options.workerTimeoutMs, outputLimitBytes: options.workerOutputLimitBytes,
        transcriptLimitBytes: options.workerTranscriptLimitBytes, stateDir,
        ...(options.phaseGateCommand ? { gateFingerprint: fingerprint([process.platform === 'win32' ? 'cmd.exe' : '/bin/sh', options.phaseGateCommand].join('\0')) } : {}),
        instructions,
      }
      appendEvent(eventsPath, event(state.runId, 'start', task.kind === 'closure' ? 'closure' : 'worker', { model: model.model, effort: model.effort ?? null, paths: task.metadata.paths }, task, state.attempt))
      let outcome = await dependencies.worker.run(request, abort.signal)
      if (outcome.status === 'unavailable' && options.fallbackModel && options.fallbackModel !== model.model) {
        validateModelSelection(catalog, options.fallbackModel, model.effort)
        outcome = await dependencies.worker.run({ ...request, model: options.fallbackModel, attempt: state.attempt + 1 }, abort.signal)
      }
      if (digest(readFileSync(checklistPath, 'utf8')) !== controllerHash) throw new Error('worker altered the controlling checklist')
      if (outcome.status !== 'completed') {
        const type = outcome.status === 'timeout' ? 'timeout' : 'stall'
        appendEvent(eventsPath, event(state.runId, type, task.kind === 'closure' ? 'closure' : 'worker', { status: outcome.status, error: outcome.error ?? null }, task, state.attempt))
        state.status = outcome.status === 'interrupted' ? 'interrupted' : 'stalled'
        writeState(join(stateDir, 'run.json'), state)
        atomicWriteJson(join(stateDir, 'resume.json'), { runId: state.runId, taskIndex: task.index, attempt: state.attempt, status: outcome.status, worktree: state.worktree, command: `dsh --profile leppy-loop --tasks ${JSON.stringify(checklistRelative)} --sync-branch ${JSON.stringify(state.syncBranch)} --recover-existing-wip` })
        return { runId: state.runId, status: state.status, branch: state.branch, worktree: state.worktree, stateDir, completedTasks: state.completedTasks, currentTask: task.index, diagnostics }
      }
      if (task.kind === 'task') {
        await assertTaskCommit(state.worktree, previousHead, state.branch)
      } else {
        if (await gitBranch(state.worktree) !== state.branch) throw new Error('closure changed the run branch')
        const count = await commitCount(state.worktree, previousHead)
        if (count > 1) throw new Error(`closure may create at most one commit; observed ${count}`)
        if (count === 1 && !isConventional(await commitSubject(state.worktree))) throw new Error('closure commit is not conventional')
        if ((await gitStatus(state.worktree)).trim() !== '') throw new Error('closure must leave a clean tree')
      }
      const marked = markTaskDone(parsed, task)
      const newCommits = await commitCount(state.worktree, previousHead)
      if (newCommits === 1) await writeChecklistAndAmend(state.worktree, checklistRelative, marked, 'chore(leppy-loop): complete task')
      else {
        writeFileSync(checklistPath, marked, 'utf8')
        await commitControllerChange(state.worktree, [checklistRelative], `chore(leppy-loop): close ${safeSlug(task.phase)}`)
      }
      state.completedTasks += 1
      writeState(join(stateDir, 'run.json'), state)
      writeFileSync(join(stateDir, `diff-${task.index}.txt`), await summarizeDiff(state.worktree, previousHead), 'utf8')
      appendEvent(eventsPath, event(state.runId, 'done', task.kind === 'closure' ? 'closure' : 'worker', { commit: await head(state.worktree) }, task, state.attempt))
    }
    appendEvent(eventsPath, event(state.runId, 'stall', 'complete', { reason: 'max iterations reached' }))
    state.status = 'stalled'; writeState(join(stateDir, 'run.json'), state)
    return { runId: state.runId, status: 'stalled', branch: state.branch, worktree: state.worktree, stateDir, completedTasks: state.completedTasks, ...(state.currentTask !== undefined ? { currentTask: state.currentTask } : {}), diagnostics }
  } catch (error) {
    if (state.status === 'running') state.status = abort.signal.aborted ? 'interrupted' : 'failed'
    writeState(join(stateDir, 'run.json'), state)
    appendEvent(eventsPath, event(state.runId, 'run-end', 'complete', { status: state.status, error: redact(error instanceof Error ? error.message : String(error)) }))
    throw error
  } finally {
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', interrupt)
    releaseLock?.()
  }
}
