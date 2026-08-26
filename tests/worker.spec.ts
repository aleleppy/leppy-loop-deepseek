import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HarnessWorkerAdapter } from '../src/worker.js'
import type { WorkerRequest } from '../src/types.js'

function request(stateDir: string): WorkerRequest {
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
