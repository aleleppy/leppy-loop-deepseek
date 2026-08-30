import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const harnessState = vi.hoisted(() => ({ prompts: [] as string[] }))
vi.mock('@deepseek-ai/dsh-sdk-client', () => ({
  DeepSeekHarness: class {
    async run(prompt: string): Promise<{ finalResponse: string }> {
      harnessState.prompts.push(prompt)
      return {
        finalResponse: 'LEPPY_OUTCOME: {"status":"completed","summary":"verified existing commit","validation":{"status":"passed","evidence":"focused validation passed"}}',
      }
    }
    async close(): Promise<void> { return undefined }
  },
}))

import { HarnessWorkerAdapter, WorkerToolFailureCircuitBreaker, workerFailureFromNotification, workerStatusForFailure } from '../src/worker.js'
import type { WorkerRequest } from '../src/types.js'

function request(stateDir: string, mode?: WorkerRequest['mode']): WorkerRequest {
  return {
    runId: 'cancel-test',
    task: {
      index: 0,
      line: 1,
      phase: 'P',
      mark: ' ',
      kind: 'task',
      text: 'test cancellation',
      raw: '- [ ] test cancellation',
      metadata: { done: 'canceled before launch', paths: ['src/value.ts'] },
    },
    attempt: 1,
    worktree: stateDir,
    checklistPath: 'tasks.task.md',
    allowedPaths: ['src/value.ts'],
    ...(mode ? { mode } : {}),
    model: 'unused',
    provider: 'unused',
    timeoutMs: 30_000,
    outputLimitBytes: 1024,
    transcriptLimitBytes: 1024,
    stateDir,
    instructions: [],
  }
}

describe('Harness worker cancellation', () => {
  it('does not launch a Harness process when cancellation arrives during credential resolution', async () => {
    let releaseCredential!: (value: { envName: string; value: string }) => void
    const credential = new Promise<{ envName: string; value: string }>(resolve => { releaseCredential = resolve })
    const adapter = new HarnessWorkerAdapter({ credential: async () => await credential })
    const control = new AbortController()
    const running = adapter.run(request(mkdtempSync(join(tmpdir(), 'leppy-worker-cancel-'))), control.signal)
    control.abort(new Error('request canceled'))
    releaseCredential({ envName: 'UNUSED_API_KEY', value: 'unused-key' })
    await expect(running).rejects.toThrow('request canceled')
  })

  it('prompts verification as isolated validation with no durable mutation', async () => {
    harnessState.prompts.length = 0
    const stateDir = mkdtempSync(join(tmpdir(), 'leppy-worker-verification-'))
    const adapter = new HarnessWorkerAdapter({ credential: async () => ({}) })
    await expect(adapter.run(request(stateDir, 'verification'), new AbortController().signal)).resolves.toMatchObject({
      status: 'completed', report: { validation: { status: 'passed' } },
    })
    const prompt = harnessState.prompts.at(-1)
    expect(prompt).toContain('ephemeral Leppy Loop worker for an isolated committed-task verification')
    expect(prompt).toContain('This is verification-only: no write, edit, commit, or delete capability exists.')
    expect(prompt).toContain('package managers, repository scripts, shells, and language interpreter frontends are denied')
    expect(prompt).toContain('Do not change HEAD or any worktree file.')
    expect(prompt).toContain('existing committed HEAD')
  })

  it('classifies terminal SDK overload notifications as unavailable', () => {
    const terminal = {
      method: 'session.event',
      params: { event: { type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'Codex error: Our servers are currently overloaded. Please try again later.', code: 'PI_AI_ERROR' } } } } },
    }
    const chunk = {
      method: 'session.event',
      params: { event: { type: 'assistant/chunk', data: { chunk: { type: 'finish', reason: { kind: 'error', failure: { message: '503 temporarily unavailable' } } } } } },
    }
    expect(workerFailureFromNotification(terminal)).toContain('overloaded')
    expect(workerStatusForFailure(workerFailureFromNotification(terminal)!)).toBe('unavailable')
    expect(workerFailureFromNotification(chunk)).toBe('503 temporarily unavailable')
    expect(workerStatusForFailure('request timeout after 30s')).toBe('timeout')
    expect(workerStatusForFailure('invalid response')).toBe('failed')
  })

  it('ignores successful and unrelated SDK notifications', () => {
    expect(workerFailureFromNotification({ method: 'session.event', params: { event: { type: 'turn/end', data: { reason: { kind: 'completed' } } } } })).toBeUndefined()
    expect(workerFailureFromNotification({ method: 'session.status', params: { status: 'idle' } })).toBeUndefined()
  })

  it('opens the circuit on the third identical failed tool call', () => {
    const circuit = new WorkerToolFailureCircuitBreaker(3, 8)
    const observe = (callId: string): string | undefined => {
      expect(circuit.observe({ method: 'session.event', params: { event: { type: 'tool/call', data: { callId, name: 'leppy_search', arguments: '{"pattern":"x"}' } } } })).toBeUndefined()
      return circuit.observe({
        method: 'session.event',
        params: { event: { type: 'tool/result', data: { message: { source: { callId }, content: [{ content: [{ isError: true, content: [{ type: 'text', text: 'Error: search unavailable' }] }] }] } } } },
      })
    }
    expect(observe('one')).toBeUndefined()
    expect(observe('two')).toBeUndefined()
    expect(observe('three')).toContain('repeated deterministic tool failure: leppy_search')
  })

  it('stops after the first deterministic offline dependency miss', () => {
    const circuit = new WorkerToolFailureCircuitBreaker(3, 8)
    const callId = 'dependency-miss'
    expect(circuit.observe({ method: 'session.event', params: { event: { type: 'tool/call', data: { callId, name: 'leppy_exec', arguments: '{"command":"npx","args":["tsc"]}' } } } })).toBeUndefined()
    expect(circuit.observe({
      method: 'session.event',
      params: { event: { type: 'tool/result', data: { message: { source: { callId }, content: [{ content: [{ isError: true, content: [{ type: 'text', text: 'npm error code ENOTCACHED; cache mode is only-if-cached' }] }] }] } } } },
    })).toContain('dependency unavailable after one tool failure')
  })

  it('stops after the first missing module under node_modules', () => {
    const circuit = new WorkerToolFailureCircuitBreaker(3, 8)
    const callId = 'module-miss'
    expect(circuit.observe({ method: 'session.event', params: { event: { type: 'tool/call', data: { callId, name: 'leppy_exec', arguments: '{"command":"node","args":["node_modules/typescript/bin/tsc"]}' } } } })).toBeUndefined()
    expect(circuit.observe({
      method: 'session.event',
      params: { event: { type: 'tool/result', data: { message: { source: { callId }, content: [{ content: [{ isError: true, content: [{ type: 'text', text: "code: MODULE_NOT_FOUND; Cannot find module 'worktree/node_modules/typescript/bin/tsc'" }] }] }] } } } },
    })).toContain('dependency unavailable after one tool failure')
  })

  it('stops after the first localized Windows quoted-executable failure', () => {
    const circuit = new WorkerToolFailureCircuitBreaker(3, 8)
    const callId = 'windows-quoted-executable'
    expect(circuit.observe({ method: 'session.event', params: { event: { type: 'tool/call', data: { callId, name: 'leppy_exec', arguments: '{"command":"node_modules/.bin/tsc","args":[]}' } } } })).toBeUndefined()
    expect(circuit.observe({
      method: 'session.event',
      params: { event: { type: 'tool/result', data: { message: { source: { callId }, content: [{ content: [{ isError: true, content: [{ type: 'text', text: "Error: 'node_modules' não é reconhecido como um comando interno ou externo" }] }] }] } } } },
    })).toContain('Windows argv compatibility failure after one tool call')
  })

  it('does not count non-error search discovery results toward the failure budget', () => {
    const circuit = new WorkerToolFailureCircuitBreaker(3, 8)
    for (let index = 0; index < 10; index += 1) {
      const callId = `missing-path-${index}`
      expect(circuit.observe({ method: 'session.event', params: { event: { type: 'tool/call', data: { callId, name: 'leppy_search', arguments: '{"paths":["messages"]}' } } } })).toBeUndefined()
      expect(circuit.observe({
        method: 'session.event',
        params: { event: { type: 'tool/result', data: { message: { source: { callId }, content: [{ content: [{ content: [{ type: 'text', text: 'No requested search path exists: messages' }] }] }] } } } },
      })).toBeUndefined()
    }
  })

  it('keeps distinct failures separate and enforces a total failure budget', () => {
    const circuit = new WorkerToolFailureCircuitBreaker(3, 4)
    const fail = (index: number): string | undefined => {
      const callId = `call-${index}`
      circuit.observe({ method: 'session.event', params: { event: { type: 'tool/call', data: { callId, name: 'leppy_exec', arguments: JSON.stringify({ command: `missing-${index}` }) } } } })
      return circuit.observe({
        method: 'session.event',
        params: {
          event: {
            type: 'tool/result',
            data: {
              message: {
                source: { callId },
                content: [{ content: [{ content: [{ type: 'text', text: JSON.stringify({ exitCode: 127, stderr: `missing-${index}` }) }] }] }],
              },
            },
          },
        },
      })
    }
    expect(fail(1)).toBeUndefined()
    expect(fail(2)).toBeUndefined()
    expect(fail(3)).toBeUndefined()
    expect(fail(4)).toContain('failure budget exhausted')
  })

  it('rejects a pre-aborted signal before requesting credentials', async () => {
    let credentialCalls = 0
    const adapter = new HarnessWorkerAdapter({ credential: async () => { credentialCalls += 1; return { envName: 'UNUSED_API_KEY', value: 'unused-key' } } })
    const control = new AbortController()
    control.abort(new Error('already canceled'))
    await expect(adapter.run(request(mkdtempSync(join(tmpdir(), 'leppy-worker-pre-cancel-'))), control.signal))
      .rejects.toThrow('already canceled')
    expect(credentialCalls).toBe(0)
  })
})
