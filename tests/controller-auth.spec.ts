import { createHmac } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { inspectAuthenticatedControllers } from '../src/controller-auth.js'
import { appendLifecycleAuthorityReceipt } from '../src/lifecycle-authority.js'
import { createLeaseKey } from '../src/state.js'
import type { LifecycleAuthority } from '../src/types.js'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function authority(): LifecycleAuthority {
  return {
    sessionId: 'session-a', allowPublication: false, maxIterations: 64, maxRepairCycles: 3,
    maxTransitions: 16, transitions: 1, issuedAt: 1_000, expiresAt: 86_401_000,
  }
}

function repository(withAuthority: boolean): { root: string; stateDir: string; runId: string } {
  const root = mkdtempSync(join(tmpdir(), 'leppy-controller-auth-'))
  git(root, 'init', '-b', 'main')
  git(root, 'config', 'user.email', 'test@example.com')
  git(root, 'config', 'user.name', 'Test')
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src', 'value.txt'), 'initial\n')
  writeFileSync(join(root, 'tasks.task.md'), '- [ ] Alpha `src/value.txt` | Done: alpha\n')
  git(root, 'add', '.')
  git(root, 'commit', '-m', 'test: fixture')

  const runId = 'authrun00001'
  const stateDir = join(root, '.git', 'leppy-loop', 'runs', runId)
  mkdirSync(stateDir, { recursive: true })
  const state = {
    schemaVersion: 1, runId, status: 'stalled', repoRoot: root, checklistRelative: 'tasks.task.md',
    sourceHead: git(root, 'rev-parse', 'HEAD'), branch: 'main', worktree: root, syncBranch: 'main',
    currentTask: 0, attempt: 1, taskAttempts: {}, completedTasks: 0, gateAttempts: {},
    ...(withAuthority ? { lifecycleAuthority: authority() } : {}), updatedAt: new Date().toISOString(),
  }
  writeFileSync(join(stateDir, 'run.json'), `${JSON.stringify(state)}\n`)
  const key = createLeaseKey(stateDir)
  const ownership = JSON.stringify({ runId, repoRoot: root, checklistRelative: 'tasks.task.md', branch: 'main', worktree: root })
  writeFileSync(join(stateDir, 'ownership.hmac'), `${createHmac('sha256', key).update(ownership).digest('base64url')}\n`)
  if (withAuthority) appendLifecycleAuthorityReceipt(stateDir, runId, authority())
  return { root, stateDir, runId }
}

describe('authenticated controller lifecycle authority integrity', () => {
  it('accepts a valid modern receipt chain and genuine legacy state', async () => {
    const modern = repository(true)
    await expect(inspectAuthenticatedControllers(modern.root)).resolves.toHaveLength(1)
    const legacy = repository(false)
    await expect(inspectAuthenticatedControllers(legacy.root)).resolves.toHaveLength(1)
  })

  it('quarantines a modern controller after receipt corruption or head deletion', async () => {
    const corrupted = repository(true)
    const receiptPath = join(corrupted.stateDir, 'lifecycle-authority', 'authority-000001.json')
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as { authority: { allowPublication: boolean } }
    receipt.authority.allowPublication = true
    writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`)
    await expect(inspectAuthenticatedControllers(corrupted.root)).resolves.toHaveLength(0)

    const missingHead = repository(true)
    unlinkSync(join(missingHead.stateDir, 'lifecycle-authority-head.json'))
    await expect(inspectAuthenticatedControllers(missingHead.root)).resolves.toHaveLength(0)
  })

  it('does not reinterpret a deleted modern chain as legacy while its authenticated marker remains', async () => {
    const modern = repository(true)
    rmSync(join(modern.stateDir, 'lifecycle-authority'), { recursive: true, force: true })
    unlinkSync(join(modern.stateDir, 'lifecycle-authority-head.json'))
    await expect(inspectAuthenticatedControllers(modern.root)).resolves.toHaveLength(0)
  })
})
