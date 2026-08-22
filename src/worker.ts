import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import type { HarnessNotification } from '@deepseek-ai/dsh-sdk-client'
import type { WorkerAdapter, WorkerOutcome, WorkerRequest } from './types.js'
import { createLeaseKey } from './state.js'
import { redact, scrubEnvironment } from './security.js'

export interface HarnessWorkerAdapterOptions {
  credential: () => Promise<string>
  workerHostPath?: string
  workerConfigPath?: string
  /** Non-secret runtime facts for deterministic/keyless test compositions. */
  runtimeEnv?: NodeJS.ProcessEnv
}

function byteLength(value: string): number { return Buffer.byteLength(value, 'utf8') }

export class HarnessWorkerAdapter implements WorkerAdapter {
  constructor(private readonly options: HarnessWorkerAdapterOptions) {}

  async run(request: WorkerRequest, signal: AbortSignal): Promise<WorkerOutcome> {
    mkdirSync(join(request.stateDir, 'outputs'), { recursive: true })
    mkdirSync(join(request.stateDir, 'transcripts'), { recursive: true })
    mkdirSync(join(request.stateDir, 'sessions'), { recursive: true })
    mkdirSync(join(request.stateDir, 'leases'), { recursive: true })
    createLeaseKey(request.stateDir)
    const apiKey = await this.options.credential()
    if (apiKey.trim() === '') return { status: 'failed', output: '', error: 'DeepSeek credential service returned an empty key' }
    const suffix = `${request.task.index}-${request.attempt}`
    const outputPath = join(request.stateDir, 'outputs', `${suffix}.txt`)
    const transcriptPath = join(request.stateDir, 'transcripts', `${suffix}.jsonl`)
    const leasePath = join(request.stateDir, 'leases', `${suffix}.json`)
    const host = this.options.workerHostPath ?? fileURLToPath(new URL('./worker-host.js', import.meta.url))
    const config = this.options.workerConfigPath ?? fileURLToPath(new URL('../worker.cordis.yml', import.meta.url))
    const prompt = workerPrompt(request)
    const env = {
      ...scrubEnvironment(process.env),
      ...this.options.runtimeEnv,
      DEEPSEEK_API_KEY: apiKey,
      LEPPY_RUN_ID: request.runId,
      LEPPY_TASK_INDEX: String(request.task.index),
      LEPPY_ATTEMPT: String(request.attempt),
      LEPPY_STATE_DIR: request.stateDir,
      LEPPY_LEASE_PATH: leasePath,
      LEPPY_WORKTREE: request.worktree,
      LEPPY_CHECKLIST: request.checklistPath,
      LEPPY_ALLOWED_PATHS: JSON.stringify(request.allowedPaths),
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
    const abort = (): void => { void harness.close() }
    signal.addEventListener('abort', abort, { once: true })
    try {
      const result = await harness.run(prompt, { onNotification(notification: HarnessNotification) {
        if (overflow) return
        const line = `${JSON.stringify(redact(notification, [apiKey]))}\n`
        transcriptBytes += byteLength(line)
        if (transcriptBytes > request.transcriptLimitBytes) { overflow = 'transcript-limit'; void harness.close(); return }
        notifications.push(line)
      } })
      const output = redact(result.finalResponse, [apiKey])
      if (byteLength(output) > request.outputLimitBytes) overflow = 'output-limit'
      writeFileSync(outputPath, output, 'utf8')
      writeFileSync(transcriptPath, notifications.join(''), 'utf8')
      if (overflow) return { status: overflow, output, transcriptPath }
      return { status: 'completed', output, transcriptPath }
    } catch (error) {
      const message = redact(error instanceof Error ? error.message : String(error), [apiKey])
      writeFileSync(transcriptPath, notifications.join(''), 'utf8')
      if (overflow) return { status: overflow, output: '', transcriptPath, error: message }
      if (signal.aborted) return { status: 'interrupted', output: '', transcriptPath, error: message }
      if (/timeout/i.test(message)) return { status: 'timeout', output: '', transcriptPath, error: message }
      if (/(rate.?limit|temporar|unavailable|overload|429|502|503)/i.test(message)) return { status: 'unavailable', output: '', transcriptPath, error: message }
      return { status: 'failed', output: '', transcriptPath, error: message }
    } finally {
      signal.removeEventListener('abort', abort)
      await harness.close().catch(() => {})
    }
  }
}

function workerPrompt(request: WorkerRequest): string {
  const kind = request.task.kind === 'closure' ? 'phase closure' : 'ordinary task'
  return [
    `You are one ephemeral Leppy Loop worker for a ${kind}.`,
    `Execute only this line: ${request.task.raw}`,
    request.task.metadata.done ? `Done contract: ${request.task.metadata.done}` : 'Closure contract: inspect the completed phase and correct only defects inside scope.',
    `Allowed repo-relative paths: ${request.allowedPaths.map(path => JSON.stringify(path)).join(', ')}`,
    'Use only the provided leppy_read, leppy_write, leppy_exec, and leppy_commit tools.',
    'Never read or edit the controlling checklist. Never push, publish, deploy, mutate PRs, fetch, merge, rebase, or manage worktrees.',
    request.task.kind === 'task'
      ? 'Finish with exactly one conventional commit through leppy_commit and a clean working tree.'
      : 'If correction is needed, make at most one conventional commit and leave a clean tree. If no correction is needed, make no commit.',
    ...request.instructions,
  ].join('\n')
}
