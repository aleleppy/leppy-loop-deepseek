import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import type { HarnessNotification } from '@deepseek-ai/dsh-sdk-client'
import type { WorkerAdapter, WorkerOutcome, WorkerRequest } from './types.js'
import { createLeaseKey } from './state.js'
import { redact, scrubEnvironment } from './security.js'

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
}

function byteLength(value: string): number { return Buffer.byteLength(value, 'utf8') }

function nestedRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined
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
        if (overflow) return
        const line = `${JSON.stringify(redact(notification, secrets))}\n`
        transcriptBytes += byteLength(line)
        if (transcriptBytes > request.transcriptLimitBytes) { overflow = 'transcript-limit'; void harness.close(); return }
        notifications.push(line)
      } })
      const output = redact(result.finalResponse, secrets)
      if (byteLength(output) > request.outputLimitBytes) overflow = 'output-limit'
      writeFileSync(outputPath, output, 'utf8')
      writeFileSync(transcriptPath, notifications.join(''), 'utf8')
      if (overflow) return { status: overflow, output, transcriptPath }
      if (runtimeFailure) return { status: workerStatusForFailure(runtimeFailure), output, transcriptPath, error: runtimeFailure }
      return { status: 'completed', output, transcriptPath }
    } catch (error) {
      const message = redact(error instanceof Error ? error.message : String(error), secrets)
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
  const kind = request.task.kind === 'closure' ? 'phase closure' : 'ordinary task'
  return [
    `You are one ephemeral Leppy Loop worker for a ${publicationConflict ? 'publication conflict resolution' : kind}.`,
    `Execute only this line: ${request.task.raw}`,
    request.task.metadata.done ? `Done contract: ${request.task.metadata.done}` : 'Closure contract: inspect the completed phase and correct only defects inside scope.',
    `Allowed repo-relative paths: ${request.allowedPaths.map(path => JSON.stringify(path)).join(', ')}`,
    publicationConflict
      ? 'Use only the provided leppy_read, leppy_write, and leppy_delete tools. Every allowed path is exact; no directory descendants are authorized.'
      : 'Use only the provided leppy_read, leppy_write, leppy_exec, and leppy_commit tools.',
    'Never read or edit the controlling checklist. Never push, publish, deploy, mutate PRs, fetch, merge, rebase, or manage worktrees.',
    publicationConflict
      ? 'Resolve the exact files and finish without staging or committing. The authenticated controller exclusively owns the Git index and rebase continuation.'
      : request.task.kind === 'task'
        ? 'Finish with exactly one conventional commit through leppy_commit and a clean working tree.'
        : 'If correction is needed, make at most one conventional commit and leave a clean tree. If no correction is needed, make no commit.',
    ...request.instructions,
  ].join('\n')
}
