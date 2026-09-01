import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HarnessWorkerAdapter } from '../src/worker.js'
import type { ChecklistTask } from '../src/types.js'

const project = resolve(import.meta.dirname, '..')

function git(cwd: string, ...args: string[]): string { return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim() }

describe('real Harness keyless composition', () => {
  it('routes published and keyless worker personas through the same opaque prompt variable', () => {
    for (const manifest of ['worker.cordis.yml', join('tests', 'fixtures', 'keyless-worker.cordis.yml')]) {
      expect(readFileSync(join(project, manifest), 'utf8')).toContain("persona: '{{leppy_prompt}}'")
    }
  })

  it('opens an isolated SDK session, emits events, edits and commits through the scoped tools', async () => {
    const root = mkdtempSync(join(tmpdir(), 'leppy-keyless-'))
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src', 'value.txt'), 'before\n')
    git(root, 'init', '-b', 'main')
    git(root, 'config', 'user.email', 'tests@example.invalid')
    git(root, 'config', 'user.name', 'Leppy Tests')
    git(root, 'add', '--', 'src/value.txt')
    git(root, 'commit', '-m', 'chore: seed')
    const stateDir = mkdtempSync(join(tmpdir(), 'leppy-keyless-state-'))
    const task: ChecklistTask = { index: 0, line: 1, phase: 'P', mark: ' ', kind: 'task', text: 'change value', raw: '- [ ] change', metadata: { done: 'value changed with {{ duration: 200 }}', paths: ['src/value.txt'] } }
    const adapter = new HarnessWorkerAdapter({
      credential: async () => ({ envName: 'REPLAY_API_KEY', value: 'keyless-unused', providerProfile: {} }),
      workerHostPath: join(project, 'dist', 'worker-host.js'),
      workerConfigPath: join(project, 'tests', 'fixtures', 'keyless-worker.cordis.yml'),
      runtimeEnv: {
        LEPPY_REPLAY_FILE: join(project, 'tests', 'fixtures', 'replay-session.jsonl'),
        LEPPY_REPLAY_OVERRIDE: join(project, 'tests', 'fixtures', 'replay.override.json'),
      },
    })
    const outcome = await adapter.run({
      runId: 'keyless', task, attempt: 1, worktree: root, repoRoot: root, checklistPath: 'tasks.task.md',
      allowedPaths: ['src/value.txt'], model: 'replay-model', effort: 'high', provider: 'replay',
      timeoutMs: 90_000, outputLimitBytes: 64 * 1024, transcriptLimitBytes: 512 * 1024,
      stateDir, instructions: [],
    }, new AbortController().signal)
    expect(outcome, outcome.error).toMatchObject({ status: 'completed' })
    expect(outcome.output).toContain('KEYLESS_DONE')
    expect(readFileSync(join(root, 'src', 'value.txt'), 'utf8')).toBe('keyless worker\n')
    expect(git(root, 'log', '-1', '--pretty=%s')).toBe('feat: prove keyless worker')
    expect(readFileSync(outcome.transcriptPath!, 'utf8')).toContain('session.event')
  }, 120_000)
})
