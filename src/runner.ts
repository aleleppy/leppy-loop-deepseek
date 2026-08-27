import { createHash, createHmac, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  assertSourceReady, assertTaskCommit, branch as gitBranch, commitControllerChange,
  commitCount, commitSubject, createRunWorktree, discardUnstartedRunWorktree, head, isConventional, resolveRepoRoot,
  status as gitStatus, summarizeDiff, writeChecklistAndAmend,
} from './git.js'
import { lintChecklist, markTaskDone, markTaskOpen, parseChecklist, selectTask } from './checklist.js'
import { appendEvent, acquireLock, atomicWriteJson, createLeaseKey, processIdentity, statePath, verifyLease } from './state.js'
import type { SignedLease } from './state.js'
import { fingerprint, redact, scrubEnvironment } from './security.js'
import { runFile, runOpaqueShell } from './process.js'
import { physicalRelative } from './path.js'
import type {
  ChecklistTask, LeppyLoopOptions, ModelCapability, RunDependencies, RunEvent,
  RunEventType, RunProgress, RunResult, WorkerRequest,
} from './types.js'

const DEFAULTS = {
  maxIterations: 64,
  repairCycles: 3,
  syncMaxSeconds: 120,
  workerTimeoutMs: 30 * 60_000,
  workerOutputLimitBytes: 192 * 1024,
  workerTranscriptLimitBytes: 8 * 1024 * 1024,
  workerPolicy: 'adaptive',
  openPullRequest: false,
} as const

interface GateRepairContext {
  schemaVersion: 1
  gateIndex: number
  closureIndex: number
  instruction: string
  additionalPaths?: string[]
}

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
  pullRequestUrl?: string
  updatedAt: string
}

function digest(text: string): string { return createHash('sha256').update(text).digest('hex') }
function workerGateFingerprint(parsed: ReturnType<typeof parseChecklist>, task: ChecklistTask, fallback?: string): string | undefined {
  const gate = parsed.tasks.find(candidate => candidate.kind === 'gate' && candidate.mark !== 'x' && candidate.phase === task.phase)
  const command = gate?.metadata.gate ?? fallback
  if (!command) return undefined
  return fingerprint([process.platform === 'win32' ? 'cmd.exe' : '/bin/sh', command].join('\0'))
}
function safeSlug(value: string): string { return value.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'default' }
function commandArgument(value: string): string { return `"${value.replaceAll('"', '\\"')}"` }
function inside(root: string, path: string): boolean { const rel = relative(root, path); return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)) }
function existingAncestor(path: string): string {
  let current = resolve(path)
  while (!existsSync(current)) {
    const parent = dirname(current)
    if (parent === current) throw new Error(`no existing ancestor for ${path}`)
    current = parent
  }
  return current
}

function latestGateFailureInstruction(stateDir: string, gateIndex: number): string {
  const receiptsDir = join(stateDir, 'receipts')
  const match = readdirSync(receiptsDir)
    .map(name => ({ name, match: new RegExp(`^gate-${gateIndex}-(\\d+)\\.json$`, 'u').exec(name) }))
    .filter((entry): entry is { name: string; match: RegExpExecArray } => entry.match !== null)
    .sort((left, right) => Number(right.match[1]) - Number(left.match[1]))[0]
  if (!match) throw new Error('failed gate has no durable receipt')
  const receipt = JSON.parse(readFileSync(join(receiptsDir, match.name), 'utf8')) as { exitCode?: unknown; stdout?: unknown; stderr?: unknown }
  const stdout = typeof receipt.stdout === 'string' ? receipt.stdout : ''
  const stderr = typeof receipt.stderr === 'string' ? receipt.stderr : ''
  return [
    `A prior controller gate for this phase failed with exit code ${String(receipt.exitCode ?? 'unknown')}.`,
    'Repair the concrete failures below only inside the closure scope, then commit at most one correction.',
    `Gate stdout/stderr (bounded tail):\n${`${stdout}\n${stderr}`.slice(-24 * 1024)}`,
  ].join('\n')
}

function event(runId: string, type: RunEventType, phase: RunEvent['phase'], data: Record<string, unknown>, task?: ChecklistTask, attempt?: number): RunEvent {
  return { schemaVersion: 1, type, runId, timestamp: new Date().toISOString(), phase, ...(task ? { taskIndex: task.index } : {}), ...(attempt ? { attempt } : {}), data }
}

function alreadySatisfiedEvidence(output: string): boolean {
  const lines = output.trimEnd().split(/\r?\n/u)
  const evidence = lines.filter(line => /^LEPPY_ALREADY_SATISFIED:\s+\S/u.test(line))
  return evidence.length === 1 && lines.at(-1) === evidence[0]
}

function taskProgress(state: RunState, task: ChecklistTask, totalTasks: number, type: RunProgress['type'], elapsedMs: number, error?: string, attempt = state.attempt): RunProgress {
  return {
    type,
    runId: state.runId,
    taskIndex: task.index,
    attempt,
    kind: task.kind,
    phase: task.phase,
    text: task.text,
    completedTasks: state.completedTasks,
    totalTasks,
    elapsedMs: Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0,
    ...(error ? { error } : {}),
  }
}

function policySelection(
  provider: string,
  policy: NonNullable<LeppyLoopOptions['workerPolicy']>,
  task: ChecklistTask,
  retry: boolean,
  catalog: readonly ModelCapability[],
): { model: string; effort: string } | undefined {
  if (provider !== 'openai-codex' || policy === 'selected') return undefined
  const desired = policy === 'terra-high'
    ? { model: 'gpt-5.6-terra', effort: 'high' }
    : policy === 'sol-low'
      ? { model: 'gpt-5.6-sol', effort: 'low' }
      : retry || task.kind === 'closure'
        ? { model: 'gpt-5.6-sol', effort: 'low' }
        : { model: 'gpt-5.6-terra', effort: 'high' }
  return catalog.some(entry => entry.id === desired.model) ? desired : undefined
}

function selectedModel(
  task: ChecklistTask,
  options: LeppyLoopOptions,
  fallback: { provider: string; model: string; effort?: string },
  catalog: readonly ModelCapability[],
  retry = false,
): { provider: string; model: string; effort?: string } {
  const provider = options.provider ?? fallback.provider
  const policy = policySelection(provider, options.workerPolicy ?? 'adaptive', task, retry, catalog)
  const effort = task.metadata.effort ?? options.effort ?? policy?.effort ?? fallback.effort
  return {
    provider,
    model: task.metadata.model ?? options.model ?? policy?.model ?? fallback.model,
    ...(effort ? { effort } : {}),
  }
}

function legacyCustomInstructions(root: string): string[] {
  const path = join(root, '.leppy-loop.json')
  if (!existsSync(path)) return []
  const body = readFileSync(path, 'utf8')
  if (Buffer.byteLength(body) > 64 * 1024) throw new Error('.leppy-loop.json exceeds 64 KiB')
  const parsed = JSON.parse(body) as unknown
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('.leppy-loop.json must contain an object')
  const custom = (parsed as { customInstructions?: unknown }).customInstructions
  if (custom === undefined || custom === '') return []
  if (typeof custom !== 'string') throw new Error('.leppy-loop.json customInstructions must be a string')
  if (Buffer.byteLength(custom) > 32 * 1024) throw new Error('.leppy-loop.json customInstructions exceeds 32 KiB')
  return [`Applicable tracked legacy instructions from .leppy-loop.json:\n${custom}`]
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

async function recoverState(base: string, repoRoot: string, checklistRelative: string, requestedRunId?: string, adopt = true): Promise<{ state: RunState; dir: string } | undefined> {
  if (!existsSync(base)) return undefined
  const matches: { state: RunState; dir: string }[] = []
  for (const name of readdirSync(base)) {
    const dir = join(base, name)
    const path = join(dir, 'run.json')
    const proof = join(dir, 'ownership.hmac')
    if (!existsSync(path) || !existsSync(proof)) continue
    const state = JSON.parse(readFileSync(path, 'utf8')) as RunState
    if (state.repoRoot !== repoRoot || state.checklistRelative !== checklistRelative) continue
    if (requestedRunId && state.runId !== requestedRunId) continue
    if (state.status === 'completed' && !requestedRunId) continue
    const key = createLeaseKey(dir)
    if (readFileSync(proof, 'utf8').trim() !== ownership(state, key)) continue
    matches.push({ state, dir })
  }
  let candidates = matches
  if (!requestedRunId && matches.length > 1) {
    const intentionallyRecoverable = matches.filter(entry => entry.state.status === 'stalled' || entry.state.status === 'interrupted')
    if (intentionallyRecoverable.length === 1) candidates = intentionallyRecoverable
    else throw new Error(`multiple authenticated matching runs exist; select one with --recover-run <id>: ${matches.map(entry => entry.state.runId).join(', ')}`)
  }
  const match = candidates[0]
  if (!match) return undefined
  if (!existsSync(match.state.worktree) || await gitBranch(match.state.worktree) !== match.state.branch) throw new Error('authenticated run worktree or branch no longer matches')
  if (adopt) await terminateAuthenticatedLease(match.dir, match.state.runId)
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
  return { runId, status: 'dry-run', branch, worktree, completedTasks: 0, ...(task ? { currentTask: task.index } : {}), diagnostics, preview }
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason
  return new Error(typeof signal.reason === 'string' ? signal.reason : 'interrupted')
}

export async function runLeppyLoop(input: LeppyLoopOptions, dependencies: RunDependencies = {}): Promise<RunResult> {
  const processAbort = new AbortController()
  const interrupt = (): void => processAbort.abort(new Error('interrupted'))
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', interrupt)
  const signal = dependencies.signal
    ? AbortSignal.any([dependencies.signal, processAbort.signal])
    : processAbort.signal
  try {
    if (signal.aborted) throw abortReason(signal)
    return await runLeppyLoopControlled(input, dependencies, signal)
  } finally {
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', interrupt)
  }
}

async function runLeppyLoopControlled(input: LeppyLoopOptions, dependencies: RunDependencies, signal: AbortSignal): Promise<RunResult> {
  const options = { ...DEFAULTS, ...input }
  if ((options.retryGate || options.repairGate) && (!options.recoverExistingWip || !options.recoverRunId)) throw new Error('--retry-gate/--repair-gate require --recover-existing-wip and an exact --recover-run')
  if ((options.repairPaths?.length ?? 0) > 0 && !options.repairGate) throw new Error('--repair-path requires --repair-gate')
  if (input.repairCycles !== undefined && !options.repairGate) throw new Error('--repair-cycles requires --repair-gate')
  if (!Number.isSafeInteger(options.repairCycles) || options.repairCycles < 1 || options.repairCycles > 8) throw new Error('--repair-cycles must be an integer from 1 to 8')
  const clock = dependencies.now ?? (() => new Date())
  const runId = dependencies.runId?.() ?? randomUUID().replaceAll('-', '').slice(0, 12)
  const requestedTasks = resolve(options.tasks)
  const repoRoot = realpathSync(options.repoRoot ?? await resolveRepoRoot(existingAncestor(dirname(requestedTasks)), signal))
  const tasksAbsolute = existsSync(requestedTasks) ? realpathSync(requestedTasks) : requestedTasks
  const checklistRelative = existsSync(tasksAbsolute)
    ? physicalRelative(repoRoot, tasksAbsolute)
    : inside(repoRoot, tasksAbsolute) ? relative(repoRoot, tasksAbsolute) : undefined
  if (checklistRelative === undefined) throw new Error('--tasks must be inside the source repository')
  if (!existsSync(tasksAbsolute) && !options.recoverExistingWip) throw new Error(`controlling checklist does not exist: ${tasksAbsolute}`)

  const commonRaw = (await runFile('git', ['rev-parse', '--git-common-dir'], { cwd: repoRoot, signal })).stdout.trim()
  const commonDir = realpathSync(resolve(repoRoot, commonRaw))
  const stateBase = resolve(options.artifactsDir ?? join(commonDir, 'leppy-loop', 'runs'))
  const recoveryPreview = options.recoverExistingWip ? await recoverState(stateBase, repoRoot, checklistRelative, options.recoverRunId, false) : undefined
  if (options.recoverExistingWip && !recoveryPreview) throw new Error('no authenticated matching run exists')
  if (!recoveryPreview) await assertSourceReady(repoRoot, checklistRelative, signal)
  const controllerPath = recoveryPreview ? join(recoveryPreview.state.worktree, checklistRelative) : tasksAbsolute
  const controllerRoot = recoveryPreview?.state.worktree ?? repoRoot

  const fallbackSelection = dependencies.defaultModel ? await dependencies.defaultModel() : { provider: options.provider ?? 'deepseek-official', model: options.model ?? 'deepseek-v4-flash', ...(options.effort ? { effort: options.effort } : {}) }
  const provider = options.provider ?? fallbackSelection.provider
  const catalog = dependencies.modelCatalog ? await dependencies.modelCatalog(provider) : [{ id: options.model ?? fallbackSelection.model }]
  const parsedSource = parseChecklist(controllerPath)
  const initialTask = selectTask(parsedSource, options.taskMatch)
  const previewModel = initialTask ? selectedModel(initialTask, options, fallbackSelection, catalog) : fallbackSelection
  const defaultEffort = previewModel.effort
  const diagnostics = lintChecklist(parsedSource, {
    repoRoot: controllerRoot, controllerPath, models: catalog, provider,
    defaultModel: previewModel.model,
    ...(defaultEffort ? { defaultEffort } : {}),
    ...(options.phaseGateCommand ? { phaseGateCommand: options.phaseGateCommand } : {}),
  })
  if (options.dryRun) return dryRunResult(runId, initialTask, diagnostics, repoRoot, checklistRelative, previewModel, options)
  if (diagnostics.some(item => item.severity === 'error')) throw new Error(`checklist lint failed:\n${diagnostics.map(item => `${item.line ?? '-'} ${item.code}: ${item.message}`).join('\n')}`)
  if (!dependencies.worker) throw new Error('runLeppyLoop requires a WorkerAdapter outside the Harness bundle')

  mkdirSync(stateBase, { recursive: true })
  let state: RunState
  let stateDir: string
  let releaseLock: (() => void) | undefined
  const recovered = options.recoverExistingWip ? await recoverState(stateBase, repoRoot, checklistRelative, options.recoverRunId) : undefined
  if (options.recoverExistingWip && !recovered) throw new Error('authenticated run disappeared during recovery')
  if (!recovered && !initialTask) throw new Error('checklist contains no open executable rows')
  if (recovered) {
    state = recovered.state
    stateDir = recovered.dir
    releaseLock = acquireLock(commonDir, state.runId)
    const previousStatus = state.status
    state.status = 'running'
    writeState(join(stateDir, 'run.json'), state)
    appendEvent(join(stateDir, 'events.jsonl'), event(state.runId, 'recovery-start', 'recovery', { worktree: state.worktree, previousStatus }))
    appendEvent(join(stateDir, 'events.jsonl'), event(state.runId, 'recovery-done', 'recovery', { taskIndex: state.currentTask ?? null }))
  } else {
    releaseLock = acquireLock(commonDir, runId)
    try {
      const setup = await createRunWorktree(repoRoot, checklistRelative, options.syncBranch, runId, options.fetch ?? true, options.syncMaxSeconds, signal)
      const baseTask = selectTask(parseChecklist(join(setup.worktree, checklistRelative)), options.taskMatch)
      if (!baseTask) {
        await discardUnstartedRunWorktree(repoRoot, setup.worktree, setup.branch)
        throw new Error('authoritative base checklist contains no open executable rows')
      }
      stateDir = statePath(stateBase, runId)
      mkdirSync(stateDir, { recursive: true })
      state = { schemaVersion: 1, runId, status: 'running', repoRoot, checklistRelative, sourceHead: setup.sourceHead, branch: setup.branch, worktree: setup.worktree, syncBranch: options.syncBranch, attempt: 0, completedTasks: 0, gateAttempts: {}, updatedAt: clock().toISOString() }
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
  const gateRepairPath = join(stateDir, 'gate-repair.json')
  let gateRepairContext: GateRepairContext | undefined = existsSync(gateRepairPath)
    ? JSON.parse(readFileSync(gateRepairPath, 'utf8')) as GateRepairContext
    : undefined
  let activeProgress: { task: ChecklistTask; totalTasks: number; attempt: number; startedAtMs: number } | undefined
  let retryGateAuthorized = Boolean(options.retryGate || options.repairGate)
  let repairCyclesRemaining = options.repairGate ? options.repairCycles : 0
  let repairCyclesUsed = 0
  const settleProgress = async (type: 'task-done' | 'task-failed', error?: string): Promise<void> => {
    const active = activeProgress
    if (!active) return
    activeProgress = undefined
    const elapsedMs = clock().getTime() - active.startedAtMs
    await dependencies.onProgress?.(taskProgress(state, active.task, active.totalTasks, type, elapsedMs, error, active.attempt))
  }
  const reopenRepairClosure = async (): Promise<void> => {
    if (repairCyclesRemaining < 1) throw new Error('gate repair cycle limit exhausted')
    const parsed = parseChecklist(join(state.worktree, checklistRelative))
    const gate = state.currentTask === undefined ? undefined : parsed.tasks.find(task => task.index === state.currentTask)
    if (!gate || gate.kind !== 'gate' || gate.mark === 'x') throw new Error('--repair-gate requires the current row to be an open failed gate')
    if (!Object.keys(state.gateAttempts).some(key => key.startsWith(`${gate.index}:`) && (state.gateAttempts[key] ?? 0) > 0)) throw new Error('--repair-gate requires a recorded failed gate attempt')
    const closure = parsed.tasks.filter(task => task.phase === gate.phase && task.index < gate.index && task.kind === 'closure').at(-1)
    if (!closure || closure.mark !== 'x') throw new Error('--repair-gate requires the preceding phase closure to be completed')
    if ((await gitStatus(state.worktree)).trim() !== '') throw new Error('--repair-gate refuses a dirty worktree; discard unauthorized edits or recover the existing worker WIP first')
    const requestedPaths = [...new Set([...(gateRepairContext?.additionalPaths ?? []), ...(options.repairPaths ?? [])])]
    const additionalPaths = requestedPaths.map(candidate => {
      if (candidate.includes('\0') || isAbsolute(candidate)) throw new Error('--repair-path must be repo-relative')
      const absolute = resolve(state.worktree, candidate)
      const scoped = existsSync(absolute) ? physicalRelative(state.worktree, absolute) : undefined
      if (!scoped || scoped === checklistRelative) throw new Error(`--repair-path must name an existing path inside the preserved worktree: ${candidate}`)
      return scoped
    })
    repairCyclesRemaining -= 1
    repairCyclesUsed += 1
    gateRepairContext = { schemaVersion: 1, gateIndex: gate.index, closureIndex: closure.index, instruction: latestGateFailureInstruction(stateDir, gate.index), additionalPaths }
    writeFileSync(join(state.worktree, checklistRelative), markTaskOpen(parsed, closure), 'utf8')
    await commitControllerChange(state.worktree, [checklistRelative], `chore(leppy-loop): reopen ${safeSlug(gate.phase)} repair closure`)
    state.completedTasks = Math.max(0, state.completedTasks - 1)
    state.currentTask = closure.index
    writeState(join(stateDir, 'run.json'), state)
    atomicWriteJson(gateRepairPath, gateRepairContext)
    appendEvent(eventsPath, event(state.runId, 'recovery-done', 'recovery', {
      taskIndex: closure.index, gateRepair: true, gateIndex: gate.index, additionalPaths,
      repairCycle: repairCyclesUsed, repairCycleLimit: options.repairCycles,
    }))
  }
  try {
    if (options.repairGate) await reopenRepairClosure()
    for (let iteration = 0; iteration < options.maxIterations; iteration += 1) {
      if (signal.aborted) throw abortReason(signal)
      const checklistPath = join(state.worktree, checklistRelative)
      const parsed = parseChecklist(checklistPath)
      const task = selectTask(parsed, options.taskMatch)
      if (!task) {
        delete state.currentTask
        if (options.openPullRequest && !state.pullRequestUrl) {
          if (!dependencies.publishPullRequest) throw new Error('pull request publication is unavailable in this composition')
          appendEvent(eventsPath, event(state.runId, 'publish-start', 'publish', { branch: state.branch, syncBranch: state.syncBranch }))
          try {
            state.pullRequestUrl = await dependencies.publishPullRequest({
              runId: state.runId,
              repoRoot: state.repoRoot,
              worktree: state.worktree,
              branch: state.branch,
              syncBranch: state.syncBranch,
            }, signal)
            writeState(join(stateDir, 'run.json'), state)
            appendEvent(eventsPath, event(state.runId, 'publish-done', 'publish', { url: state.pullRequestUrl }))
          } catch (error) {
            const message = redact(error instanceof Error ? error.message : String(error))
            state.status = 'stalled'
            writeState(join(stateDir, 'run.json'), state)
            appendEvent(eventsPath, event(state.runId, 'stall', 'publish', { reason: message }))
            atomicWriteJson(join(stateDir, 'resume.json'), {
              schemaVersion: 1,
              runId: state.runId,
              reason: 'pull request publication stalled',
              command: `/leppy-loop --tasks ${commandArgument(checklistRelative)} --sync-branch ${commandArgument(state.syncBranch)} --recover-existing-wip --recover-run ${commandArgument(state.runId)}`,
            })
            return { runId: state.runId, status: 'stalled', branch: state.branch, worktree: state.worktree, stateDir, completedTasks: state.completedTasks, diagnostics }
          }
        }
        state.status = 'completed'
        writeState(join(stateDir, 'run.json'), state)
        appendEvent(eventsPath, event(state.runId, 'run-end', 'complete', { status: 'completed', completedTasks: state.completedTasks, pullRequestUrl: state.pullRequestUrl ?? null }))
        return { runId: state.runId, status: 'completed', branch: state.branch, worktree: state.worktree, stateDir, completedTasks: state.completedTasks, diagnostics, ...(state.pullRequestUrl ? { pullRequestUrl: state.pullRequestUrl } : {}) }
      }
      if (retryGateAuthorized && task.kind !== 'gate' && task.index !== gateRepairContext?.closureIndex) throw new Error('--retry-gate can only authorize the recovered failed gate or its controller-reopened repair closure')
      const retryingRecoveredTask = Boolean(recovered && state.currentTask === task.index)
      const literalMatch = options.taskMatch
      const remainingTasks = parsed.tasks.filter(candidate =>
        candidate.mark !== 'x' && (literalMatch === undefined || candidate.raw.includes(literalMatch)))
      const totalTasks = state.completedTasks + remainingTasks.length
      state.currentTask = task.index
      state.attempt += 1
      writeState(join(stateDir, 'run.json'), state)
      const progressStartedAtMs = clock().getTime()
      await dependencies.onProgress?.(taskProgress(state, task, totalTasks, 'task-start', 0))
      activeProgress = { task, totalTasks, attempt: state.attempt, startedAtMs: progressStartedAtMs }
      if (task.kind === 'human') {
        const reason = 'human checkpoint requires direct approval; mark this row complete in the preserved worktree, then recover the same run'
        appendEvent(eventsPath, event(state.runId, 'stall', 'human', { reason, worktree: state.worktree }, task, state.attempt))
        state.status = 'stalled'
        writeState(join(stateDir, 'run.json'), state)
        atomicWriteJson(join(stateDir, 'resume.json'), { runId: state.runId, taskIndex: task.index, attempt: state.attempt, status: 'human', worktree: state.worktree, command: `/leppy-loop --tasks ${commandArgument(checklistRelative)} --sync-branch ${commandArgument(state.syncBranch)} --recover-existing-wip --recover-run ${commandArgument(state.runId)}` })
        await settleProgress('task-failed', reason)
        return { runId: state.runId, status: 'stalled', branch: state.branch, worktree: state.worktree, stateDir, completedTasks: state.completedTasks, currentTask: task.index, diagnostics }
      }
      if (task.kind === 'gate') {
        const command = task.metadata.gate ?? options.phaseGateCommand!
        const key = `${task.index}:${fingerprint(command)}`
        const priorTaskGateKey = Object.keys(state.gateAttempts).find(candidate => candidate.startsWith(`${task.index}:`) && (state.gateAttempts[candidate] ?? 0) > 0)
        if (priorTaskGateKey && priorTaskGateKey !== key) throw new Error('recovered gate command fingerprint differs from its recorded attempt')
        const priorGateAttempts = state.gateAttempts[key] ?? 0
        const retryCommand = `/leppy-loop --tasks ${commandArgument(checklistRelative)} --sync-branch ${commandArgument(state.syncBranch)} --recover-existing-wip --recover-run ${commandArgument(state.runId)} --retry-gate`
        const repairPathArguments = (gateRepairContext?.additionalPaths ?? []).map(path => ` ${commandArgument(path)}`).join('')
        const repairCommand = `/leppy-loop --tasks ${commandArgument(checklistRelative)} --sync-branch ${commandArgument(state.syncBranch)} --recover-existing-wip --recover-run ${commandArgument(state.runId)} --repair-gate --repair-cycles ${options.repairCycles}${repairPathArguments ? ` --repair-path${repairPathArguments}` : ''}`
        if (retryGateAuthorized && priorGateAttempts === 0) throw new Error('--retry-gate requires a recorded failed attempt for the current gate fingerprint')
        if (priorGateAttempts > 0 && !retryGateAuthorized) {
          const reason = 'gate retry requires a direct human invocation with --retry-gate and the exact authenticated run ID'
          appendEvent(eventsPath, event(state.runId, 'stall', 'gate', { reason }, task, state.attempt))
          state.status = 'stalled'; writeState(join(stateDir, 'run.json'), state)
          atomicWriteJson(join(stateDir, 'resume.json'), { runId: state.runId, taskIndex: task.index, attempt: state.attempt, status: 'gate-retry-authorization-required', worktree: state.worktree, command: retryCommand })
          await settleProgress('task-failed', reason)
          return { runId: state.runId, status: 'stalled', branch: state.branch, worktree: state.worktree, stateDir, completedTasks: state.completedTasks, currentTask: task.index, diagnostics }
        }
        state.gateAttempts[key] = priorGateAttempts + 1
        retryGateAuthorized = false
        writeState(join(stateDir, 'run.json'), state)
        appendEvent(eventsPath, event(state.runId, 'gate-start', 'gate', { commandFingerprint: fingerprint(command), ...(priorGateAttempts > 0 ? { retry: true } : {}) }, task, state.attempt))
        const gate = await runOpaqueShell(command, state.worktree, signal, scrubEnvironment(process.env))
        if (signal.aborted) throw abortReason(signal)
        const receipt = { schemaVersion: 1, runId: state.runId, taskIndex: task.index, attempt: state.attempt, commandFingerprint: fingerprint(command), exitCode: gate.exitCode, stdout: redact(gate.stdout), stderr: redact(gate.stderr), timestamp: new Date().toISOString() }
        mkdirSync(join(stateDir, 'receipts'), { recursive: true })
        atomicWriteJson(join(stateDir, 'receipts', `gate-${task.index}-${state.attempt}.json`), receipt)
        if (gate.exitCode !== 0) {
          appendEvent(eventsPath, event(state.runId, 'gate-failed', 'gate', {
            exitCode: gate.exitCode, repairCyclesUsed, repairCyclesRemaining,
          }, task, state.attempt))
          await settleProgress('task-failed', `gate exited with code ${gate.exitCode}`)
          if (options.repairGate && repairCyclesRemaining > 0) {
            retryGateAuthorized = true
            await reopenRepairClosure()
            continue
          }
          state.status = 'stalled'; writeState(join(stateDir, 'run.json'), state)
          atomicWriteJson(join(stateDir, 'resume.json'), {
            runId: state.runId, taskIndex: task.index, attempt: state.attempt, status: 'gate-failed', worktree: state.worktree,
            command: repairCommand, retryWithoutRepairCommand: retryCommand,
            repairCyclesUsed, repairCycleLimit: options.repairCycles,
          })
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
        await settleProgress('task-done')
        continue
      }

      const allowedPaths = task.index === gateRepairContext?.closureIndex
        ? [...new Set([...task.metadata.paths, ...(gateRepairContext.additionalPaths ?? [])])]
        : task.metadata.paths
      const model = selectedModel(task, options, fallbackSelection, catalog, retryingRecoveredTask)
      validateModelSelection(catalog, model.model, model.effort)
      const controllerHash = digest(readFileSync(checklistPath, 'utf8'))
      const previousHead = await head(state.worktree)
      const instructions = [
        ...legacyCustomInstructions(state.worktree),
        ...await discoverInstructions(state.worktree, allowedPaths),
        ...(task.index === gateRepairContext?.closureIndex ? [
          gateRepairContext.instruction,
          ...(gateRepairContext.additionalPaths?.length ? [`Direct human authorized these additional repair scopes: ${gateRepairContext.additionalPaths.join(', ')}`] : []),
          'For repository-root commands, omit cwd in leppy_exec (cwd "." is also normalized to the root). Use the repository generation command when a gate reports stale generated artifacts.',
        ] : []),
      ]
      const effectiveGateFingerprint = workerGateFingerprint(parsed, task, options.phaseGateCommand)
      const request: WorkerRequest = {
        runId: state.runId, task, attempt: state.attempt, worktree: state.worktree,
        checklistPath: checklistRelative, allowedPaths,
        model: model.model, provider: model.provider, ...(model.effort ? { effort: model.effort } : {}),
        timeoutMs: options.workerTimeoutMs, outputLimitBytes: options.workerOutputLimitBytes,
        transcriptLimitBytes: options.workerTranscriptLimitBytes, stateDir,
        ...(effectiveGateFingerprint ? { gateFingerprint: effectiveGateFingerprint } : {}),
        instructions,
      }
      appendEvent(eventsPath, event(state.runId, 'start', task.kind === 'closure' ? 'closure' : 'worker', { model: model.model, effort: model.effort ?? null, paths: allowedPaths }, task, state.attempt))
      if (signal.aborted) throw abortReason(signal)
      let outcome = await dependencies.worker.run(request, signal)
      let outcomeAttempt = state.attempt
      let retryUsed = false
      let verifyingNoCommit = false
      if (outcome.status === 'unavailable') {
        const retryModel = options.fallbackModel
          ? { ...model, model: options.fallbackModel }
          : selectedModel(task, options, fallbackSelection, catalog, true)
        if (retryModel.model !== model.model || retryModel.effort !== model.effort) {
          validateModelSelection(catalog, retryModel.model, retryModel.effort)
          if (signal.aborted) throw abortReason(signal)
          outcomeAttempt += 1
          const retryRequest: WorkerRequest = {
            ...request,
            model: retryModel.model,
            attempt: outcomeAttempt,
            ...(retryModel.effort ? { effort: retryModel.effort } : {}),
          }
          if (!retryModel.effort) delete retryRequest.effort
          appendEvent(eventsPath, event(state.runId, 'start', task.kind === 'closure' ? 'closure' : 'worker', { model: retryModel.model, effort: retryModel.effort ?? null, paths: task.metadata.paths, retry: 'availability' }, task, outcomeAttempt))
          outcome = await dependencies.worker.run(retryRequest, signal)
          retryUsed = true
        }
      }
      if (signal.aborted) throw abortReason(signal)
      if (digest(readFileSync(checklistPath, 'utf8')) !== controllerHash) throw new Error('worker altered the controlling checklist')
      if (task.kind === 'task'
        && outcome.status === 'completed'
        && !retryUsed
        && await commitCount(state.worktree, previousHead) === 0
        && (await gitStatus(state.worktree)).trim() === '') {
        const retryModel = selectedModel(task, options, fallbackSelection, catalog, true)
        validateModelSelection(catalog, retryModel.model, retryModel.effort)
        if (signal.aborted) throw abortReason(signal)
        outcomeAttempt += 1
        const retryRequest: WorkerRequest = {
          ...request,
          model: retryModel.model,
          attempt: outcomeAttempt,
          instructions: [
            ...request.instructions,
            'A prior attempt reported completion but produced no commit. Independently re-evaluate the Done contract. If work is missing, implement it and finish with exactly one conventional commit. If the Done contract is already fully satisfied and no repository change is needed, leave the tree clean and end with exactly one evidence line: LEPPY_ALREADY_SATISFIED: <concrete evidence>. Do not use that marker when any required work remains.',
          ],
          ...(retryModel.effort ? { effort: retryModel.effort } : {}),
        }
        if (!retryModel.effort) delete retryRequest.effort
        appendEvent(eventsPath, event(state.runId, 'start', 'worker', { model: retryModel.model, effort: retryModel.effort ?? null, paths: task.metadata.paths, retry: 'no-commit' }, task, outcomeAttempt))
        verifyingNoCommit = true
        outcome = await dependencies.worker.run(retryRequest, signal)
        retryUsed = true
        if (signal.aborted) throw abortReason(signal)
        if (digest(readFileSync(checklistPath, 'utf8')) !== controllerHash) throw new Error('worker altered the controlling checklist')
      }
      if (outcomeAttempt !== state.attempt) {
        state.attempt = outcomeAttempt
        writeState(join(stateDir, 'run.json'), state)
      }
      if (outcome.status !== 'completed') {
        const type = outcome.status === 'timeout' ? 'timeout' : 'stall'
        appendEvent(eventsPath, event(state.runId, type, task.kind === 'closure' ? 'closure' : 'worker', { status: outcome.status, error: outcome.error ?? null }, task, outcomeAttempt))
        state.status = outcome.status === 'interrupted' ? 'interrupted' : 'stalled'
        writeState(join(stateDir, 'run.json'), state)
        atomicWriteJson(join(stateDir, 'resume.json'), { runId: state.runId, taskIndex: task.index, attempt: state.attempt, status: outcome.status, worktree: state.worktree, command: `/leppy-loop --tasks ${commandArgument(checklistRelative)} --sync-branch ${commandArgument(state.syncBranch)} --recover-existing-wip --recover-run ${commandArgument(state.runId)}` })
        await settleProgress('task-failed', outcome.error ?? outcome.status)
        return { runId: state.runId, status: state.status, branch: state.branch, worktree: state.worktree, stateDir, completedTasks: state.completedTasks, currentTask: task.index, diagnostics }
      }
      const verifiedAlreadySatisfied = task.kind === 'task'
        && verifyingNoCommit
        && await commitCount(state.worktree, previousHead) === 0
        && (await gitStatus(state.worktree)).trim() === ''
        && alreadySatisfiedEvidence(outcome.output)
      if (task.kind === 'task' && !verifiedAlreadySatisfied) {
        await assertTaskCommit(state.worktree, previousHead, state.branch)
      } else if (task.kind === 'task') {
        if (await gitBranch(state.worktree) !== state.branch) throw new Error('verification worker changed the run branch')
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
      appendEvent(eventsPath, event(state.runId, 'done', task.kind === 'closure' ? 'closure' : 'worker', { commit: await head(state.worktree), ...(verifiedAlreadySatisfied ? { verifiedAlreadySatisfied: true } : {}) }, task, outcomeAttempt))
      await settleProgress('task-done')
    }
    appendEvent(eventsPath, event(state.runId, 'stall', 'complete', { reason: 'max iterations reached' }))
    state.status = 'stalled'; writeState(join(stateDir, 'run.json'), state)
    return { runId: state.runId, status: 'stalled', branch: state.branch, worktree: state.worktree, stateDir, completedTasks: state.completedTasks, ...(state.currentTask !== undefined ? { currentTask: state.currentTask } : {}), diagnostics }
  } catch (error) {
    const message = redact(error instanceof Error ? error.message : String(error))
    if (state.status === 'running') state.status = signal.aborted ? 'interrupted' : 'failed'
    writeState(join(stateDir, 'run.json'), state)
    appendEvent(eventsPath, event(state.runId, 'run-end', 'complete', { status: state.status, error: message }))
    try {
      await settleProgress('task-failed', message)
    } catch {
      // Preserve the controller failure even if the best-effort progress card cannot settle.
    }
    throw error
  } finally {
    releaseLock?.()
  }
}
