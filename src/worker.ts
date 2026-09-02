import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import type { HarnessNotification } from '@deepseek-ai/dsh-sdk-client'
import type { WorkerAdapter, WorkerOutcome, WorkerRequest } from './types.js'
import { createLeaseKey } from './state.js'
import { redact, scrubEnvironment } from './security.js'
import { parseWorkerReport, renderWorkerOutcomeContract } from './worker-report.js'
import { windowsQuotedExecutableFailure } from './windows-command.js'

export interface WorkerCredential {
  envName?: string
  value?: string
  providerProfile?: Record<string, unknown>
}

export interface HarnessWorkerAdapterOptions {
  credential: (provider: string) => Promise<WorkerCredential>
  workerHostPath?: string
  workerConfigPath?: string
  /** Non-secret runtime facts for deterministic/keyless test compositions. */
  runtimeEnv?: NodeJS.ProcessEnv
  /** Stop a worker turn after this many identical failed tool calls. */
  identicalToolFailureLimit?: number
  /** Stop a worker turn after this many failed tool calls in total, even when arguments differ. */
  toolFailureBudget?: number
}

function byteLength(value: string): number { return Buffer.byteLength(value, 'utf8') }

function nestedRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined
}

function nestedTexts(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const child of value) nestedTexts(child, out)
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (key === 'text' && typeof child === 'string') out.push(child)
      else nestedTexts(child, out)
    }
  }
  return out
}

function nestedTrue(value: unknown, key: string): boolean {
  if (Array.isArray(value)) return value.some(child => nestedTrue(child, key))
  if (!value || typeof value !== 'object') return false
  return Object.entries(value).some(([childKey, child]) => (childKey === key && child === true) || nestedTrue(child, key))
}

/** Bounds deterministic tool thrashing inside one Harness turn before the runner regains control. */
export class WorkerToolFailureCircuitBreaker {
  private readonly calls = new Map<string, { name: string; arguments: string }>()
  private readonly signatures = new Map<string, number>()
  private failures = 0

  constructor(private readonly identicalLimit = 3, private readonly totalBudget = 8) {
    if (!Number.isSafeInteger(identicalLimit) || identicalLimit < 2 || identicalLimit > 10) throw new Error('identical tool failure limit must be an integer from 2 to 10')
    if (!Number.isSafeInteger(totalBudget) || totalBudget < identicalLimit || totalBudget > 32) throw new Error('tool failure budget must be an integer from identical limit to 32')
  }

  observe(notification: unknown): string | undefined {
    const envelope = nestedRecord(notification)
    if (envelope?.method !== 'session.event') return undefined
    const event = nestedRecord(nestedRecord(envelope.params)?.event)
    const data = nestedRecord(event?.data)
    if (event?.type === 'tool/call' && typeof data?.callId === 'string' && typeof data.name === 'string') {
      this.calls.set(data.callId, { name: data.name, arguments: typeof data.arguments === 'string' ? data.arguments : JSON.stringify(data.arguments ?? null) })
      return undefined
    }
    if (event?.type !== 'tool/result') return undefined
    const callId = nestedRecord(nestedRecord(data?.message)?.source)?.callId
    if (typeof callId !== 'string') return undefined
    const call = this.calls.get(callId)
    if (!call) return undefined
    const texts = nestedTexts(data?.message)
    const execFailure = texts.map(text => {
      try {
        const parsed = JSON.parse(text) as { exitCode?: unknown; stderr?: unknown }
        return typeof parsed.exitCode === 'number' && parsed.exitCode !== 0
          ? { code: `exit-${parsed.exitCode}`, detail: typeof parsed.stderr === 'string' && parsed.stderr.trim() ? parsed.stderr.trim() : text }
          : undefined
      } catch { return undefined }
    }).find(Boolean)
    if (!nestedTrue(data?.message, 'isError') && !execFailure) return undefined
    const detail = (execFailure?.detail ?? texts.join('\n') ?? 'tool error').replace(/\bline \d+\b/giu, 'line #').slice(0, 2_048)
    const code = execFailure?.code ?? 'tool-error'
    if ((/\bENOTCACHED\b/iu.test(detail) && /only-if-cached/iu.test(detail))
      || (/\bMODULE_NOT_FOUND\b/iu.test(detail) && /node_modules[\\/]/iu.test(detail))
      || /\bLEPPY_DEPENDENCY_UNAVAILABLE\b/iu.test(detail)) {
      return `worker dependency unavailable after one tool failure; do not retry install or executable variants: ${detail}`
    }
    if (windowsQuotedExecutableFailure(detail)) {
      return `worker Windows argv compatibility failure after one tool call; do not retry quoted executable variants: ${detail}`
    }
    let authenticatedPlaywrightCall = false
    if (call.name === 'leppy_exec') {
      try {
        const attempted = JSON.parse(call.arguments) as { command?: unknown }
        authenticatedPlaywrightCall = typeof attempted.command === 'string' && /^playwright(?:\.cmd|\.exe)?$/iu.test(attempted.command.split(/[\\/]/u).at(-1) ?? '')
      } catch {
        authenticatedPlaywrightCall = false
      }
    }
    if (authenticatedPlaywrightCall && /\bLEPPY_(?:WINDOWS_NAMED_PIPE|WSL_VALIDATION)_UNAVAILABLE\b/u.test(detail)) {
      return `worker validation infrastructure unavailable after one tool call; do not retry executable or stdio variants; attempted=${call.arguments.slice(0, 1_024)}: ${detail}`
    }
    const signature = createHash('sha256').update([call.name, call.arguments, code, detail].join('\0')).digest('hex')
    const count = (this.signatures.get(signature) ?? 0) + 1
    this.signatures.set(signature, count)
    this.failures += 1
    if (count >= this.identicalLimit) return `repeated deterministic tool failure: ${call.name} (${code}) repeated ${count} times: ${detail}`
    if (this.failures >= this.totalBudget) return `worker tool failure budget exhausted after ${this.failures} failures; last=${call.name} (${code}): ${detail}`
    return undefined
  }
}

/** Extract an Agent failure because SDK run() may resolve after a terminal error notification. */
export function workerFailureFromNotification(notification: unknown): string | undefined {
  const envelope = nestedRecord(notification)
  if (envelope?.method !== 'session.event') return undefined
  const params = nestedRecord(envelope.params)
  const event = nestedRecord(params?.event)
  const data = nestedRecord(event?.data)
  if (event?.type === 'turn/end') {
    const reason = nestedRecord(data?.reason)
    const error = nestedRecord(reason?.error)
    if (reason?.kind === 'error' && typeof error?.message === 'string') return error.message
  }
  if (event?.type === 'assistant/chunk') {
    const chunk = nestedRecord(data?.chunk)
    const reason = nestedRecord(chunk?.reason)
    const failure = nestedRecord(reason?.failure)
    if (chunk?.type === 'finish' && reason?.kind === 'error' && typeof failure?.message === 'string') return failure.message
  }
  return undefined
}

export function workerStatusForFailure(message: string): Exclude<WorkerOutcome['status'], 'completed'> {
  if (/timeout/i.test(message)) return 'timeout'
  if (/(rate.?limit|temporar|unavailable|overload|429|502|503)/i.test(message)) return 'unavailable'
  return 'failed'
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return
  if (signal.reason instanceof Error) throw signal.reason
  throw new Error(typeof signal.reason === 'string' ? signal.reason : 'worker aborted')
}

export class HarnessWorkerAdapter implements WorkerAdapter {
  constructor(private readonly options: HarnessWorkerAdapterOptions) {}

  async run(request: WorkerRequest, signal: AbortSignal): Promise<WorkerOutcome> {
    throwIfAborted(signal)
    mkdirSync(join(request.stateDir, 'outputs'), { recursive: true })
    mkdirSync(join(request.stateDir, 'transcripts'), { recursive: true })
    mkdirSync(join(request.stateDir, 'sessions'), { recursive: true })
    mkdirSync(join(request.stateDir, 'leases'), { recursive: true })
    createLeaseKey(request.stateDir)
    const credential = await this.options.credential(request.provider)
    throwIfAborted(signal)
    if ((credential.envName === undefined) !== (credential.value === undefined)) throw new Error('worker credential name/value mismatch')
    if (credential.value !== undefined && credential.value.trim() === '') return { status: 'failed', output: '', error: `${credential.envName} resolved to an empty credential` }
    const secrets = credential.value === undefined ? [] : [credential.value]
    const suffix = `${request.task.index}-${request.attempt}`
    const outputPath = join(request.stateDir, 'outputs', `${suffix}.txt`)
    const transcriptPath = join(request.stateDir, 'transcripts', `${suffix}.jsonl`)
    const leasePath = join(request.stateDir, 'leases', `${suffix}.json`)
    const host = this.options.workerHostPath ?? fileURLToPath(new URL('./worker-host.js', import.meta.url))
    const config = this.options.workerConfigPath ?? fileURLToPath(new URL('../worker.cordis.yml', import.meta.url))
    const prompt = workerPrompt(request)
    const piAiProviders = request.provider === 'deepseek-official'
      ? {}
      : { [request.provider]: { ...credential.providerProfile, ...(credential.envName ? { apiKeyEnv: credential.envName } : {}) } }
    const env = {
      ...scrubEnvironment(process.env, ['DSH_HOME']),
      ...this.options.runtimeEnv,
      ...(credential.envName && credential.value ? { [credential.envName]: credential.value } : {}),
      LEPPY_PI_AI_PROVIDERS: JSON.stringify(piAiProviders),
      LEPPY_RUN_ID: request.runId,
      LEPPY_TASK_INDEX: String(request.task.index),
      LEPPY_ATTEMPT: String(request.attempt),
      LEPPY_STATE_DIR: request.stateDir,
      LEPPY_LEASE_PATH: leasePath,
      LEPPY_WORKTREE: request.worktree,
      LEPPY_REPO_ROOT: request.repoRoot,
      ...(request.verificationCommitHead ? { LEPPY_VERIFICATION_COMMIT_HEAD: request.verificationCommitHead } : {}),
      LEPPY_CHECKLIST: request.checklistPath,
      LEPPY_ALLOWED_PATHS: JSON.stringify(request.allowedPaths),
      LEPPY_WORKER_MODE: request.mode ?? 'task',
      LEPPY_MODEL_EFFORT: request.effort ?? '',
      LEPPY_SYSTEM_PROMPT: prompt,
      LEPPY_SESSION_ROOT: join(request.stateDir, 'sessions', suffix),
      LEPPY_WORKER_CONFIG: config,
      ...(request.gateFingerprint ? { LEPPY_GATE_FINGERPRINT: request.gateFingerprint } : {}),
    }
    const harness = new DeepSeekHarness({
      launch: {
        command: process.execPath,
        args: [host],
        cwd: request.worktree,
        env,
        requestTimeoutMs: request.timeoutMs,
        shutdownTimeoutMs: 1_000,
        disposeEofGraceMs: 4_000,
        disposeGraceMs: 3_000,
      },
      cwd: request.worktree,
      provider: request.provider,
      model: request.model,
    })
    const notifications: string[] = []
    const failureCircuit = new WorkerToolFailureCircuitBreaker(this.options.identicalToolFailureLimit ?? 3, this.options.toolFailureBudget ?? 8)
    let transcriptBytes = 0
    let overflow: WorkerOutcome['status'] | undefined
    let runtimeFailure: string | undefined
    const abort = (): void => { void harness.close() }
    signal.addEventListener('abort', abort, { once: true })
    try {
      throwIfAborted(signal)
      const result = await harness.run(prompt, { onNotification(notification: HarnessNotification) {
        const failure = workerFailureFromNotification(notification)
        if (failure && !runtimeFailure) runtimeFailure = redact(failure, secrets)
        const toolFailure = failureCircuit.observe(notification)
        if (toolFailure && !runtimeFailure) {
          runtimeFailure = redact(toolFailure, secrets)
          void harness.close()
        }
        if (overflow) return
        const line = `${JSON.stringify(redact(notification, secrets))}\n`
        transcriptBytes += byteLength(line)
        if (transcriptBytes > request.transcriptLimitBytes) { overflow = 'transcript-limit'; void harness.close(); return }
        notifications.push(line)
      } })
      const fullOutput = redact(result.finalResponse, secrets)
      if (byteLength(fullOutput) > request.outputLimitBytes) overflow = 'output-limit'
      const encodedOutput = Buffer.from(fullOutput)
      let output = overflow === 'output-limit'
        ? encodedOutput.subarray(Math.max(0, encodedOutput.length - request.outputLimitBytes)).toString('utf8')
        : fullOutput
      while (byteLength(output) > request.outputLimitBytes) output = output.slice(1)
      writeFileSync(outputPath, output, 'utf8')
      writeFileSync(transcriptPath, notifications.join(''), 'utf8')
      if (overflow) return { status: overflow, output, transcriptPath }
      if (runtimeFailure) return { status: workerStatusForFailure(runtimeFailure), output, transcriptPath, error: runtimeFailure }
      try {
        const advisoryValidation = request.mode !== 'verification' && request.mode !== 'publication-conflict'
        const report = parseWorkerReport(output, advisoryValidation)
        if (report.status !== 'completed') return { status: report.status, output, transcriptPath, report, error: report.summary }
        return { status: 'completed', output, transcriptPath, report }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { status: 'failed', output, transcriptPath, error: message }
      }
    } catch (error) {
      const message = runtimeFailure ?? redact(error instanceof Error ? error.message : String(error), secrets)
      writeFileSync(transcriptPath, notifications.join(''), 'utf8')
      if (overflow) return { status: overflow, output: '', transcriptPath, error: message }
      if (signal.aborted) return { status: 'interrupted', output: '', transcriptPath, error: message }
      return { status: workerStatusForFailure(message), output: '', transcriptPath, error: message }
    } finally {
      signal.removeEventListener('abort', abort)
      await harness.close().catch(() => {})
    }
  }
}

function workerPrompt(request: WorkerRequest): string {
  const publicationConflict = request.mode === 'publication-conflict'
  const verification = request.mode === 'verification'
  const kind = request.task.kind === 'closure' ? 'phase closure' : 'ordinary task'
  return [
    `You are one ephemeral Leppy Loop worker for ${publicationConflict ? 'a publication conflict resolution' : verification ? 'an isolated committed-task verification' : `a ${kind}`}.`,
    `Execute only this line: ${request.task.raw}`,
    request.task.metadata.done ? `Done contract: ${request.task.metadata.done}` : 'Closure contract: inspect the completed phase and correct only defects inside scope.',
    `${verification ? 'Relevant' : 'Writable'} repo-relative paths: ${request.allowedPaths.map(path => JSON.stringify(path)).join(', ')}`,
    `Runtime platform: ${process.platform}.`,
    publicationConflict
      ? 'Use only the provided leppy_read, leppy_write, and leppy_delete tools. Every allowed path is exact; no directory descendants are authorized.'
      : verification
        ? 'Use only the provided leppy_read, leppy_search, and leppy_exec tools. This is verification-only: no write, edit, commit, or delete capability exists. Run the narrow focused validation required by the Done contract against the existing committed HEAD. Invoke already-materialized direct validation binaries such as playwright, vitest, or tsc; package managers, repository scripts, shells, and language interpreter frontends are denied.'
        : 'Use only the provided leppy_read, leppy_write, leppy_edit, leppy_search, leppy_exec, and leppy_commit tools. Use leppy_search instead of rg/grep/find, leppy_edit instead of patches, and never invoke a shell command string. leppy_exec resolves bare local binaries from the authenticated root node_modules/.bin; invoke playwright, vitest, tsc, or similar directly. Package-manager commands are limited to explicit run/test scripts. Never use npx, dlx, corepack/alternate package frontends, dependency installation, cache overrides, or an in-worktree package-manager cache.',
    'Never read or edit the controlling checklist. Never push, publish, deploy, mutate PRs, fetch, merge, rebase, or manage worktrees. Never use git apply, restore, reset, clean, add, commit, or checkout through leppy_exec.',
    publicationConflict
      ? 'Resolve the exact files and finish without staging or committing. The authenticated controller exclusively owns the Git index and rebase continuation.'
      : verification
        ? 'Do not change HEAD or any worktree file. Report completed only if focused validation passes and the existing commit satisfies the Done contract; report failed for a real validation failure and blocked with validation not-run when the environment still cannot execute it.'
        : request.task.kind === 'task'
          ? 'Finish with exactly one conventional commit through leppy_commit and a clean working tree.'
          : 'If correction is needed, make at most one conventional commit and leave a clean tree. If no correction is needed, make no commit.',
    ...(!publicationConflict && !verification ? [
      'Validation informs your engineering decision but does not control the lifecycle. Attempt the focused checks, record every failure exactly, and distinguish implementation defects from unavailable tooling, sandbox limitations, or unrelated baseline failures. If the Done contract is satisfied in your judgment, commit and report completed even when validation is failed or not-run. Block only for a real unresolved implementation/scope/authority problem.',
    ] : []),
    ...request.instructions,
    'Applicable project instructions have already been injected above. Do not try to re-read CLAUDE.md, AGENTS.md, or instruction files unless an explicit writable path also authorizes them.',
    ...renderWorkerOutcomeContract(publicationConflict ? 'publication-conflict' : verification ? 'verification' : request.task.kind === 'closure' ? 'closure' : 'task'),
  ].join('\n')
}
