import { createHash, createHmac } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseChecklist, selectTask } from '../src/checklist.js'
import { inspectAuthenticatedControllers, migrateRunStateSecurityProof } from '../src/controller-auth.js'
import { appendLifecycleAuthorityReceipt } from '../src/lifecycle-authority.js'
import { ensureRunStateProofRequired, persistRunStateProof } from '../src/run-state-proof.js'
import { createLeaseKey } from '../src/state.js'
import type { ActiveTaskAttempt, LifecycleAuthority, PendingTaskValidation } from '../src/types.js'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function authority(overrides: Partial<LifecycleAuthority> = {}): LifecycleAuthority {
  return {
    sessionId: 'session-a', allowPublication: false, maxIterations: 64, maxRepairCycles: 3,
    maxTransitions: 16, transitions: 1, issuedAt: 1_000, expiresAt: 86_401_000,
    ...overrides,
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

type Fixture = ReturnType<typeof repository>
type MutableRunState = Record<string, unknown> & {
  runId: string
  currentTask?: number
  activeTaskAttempt?: ActiveTaskAttempt
  pendingTaskValidation?: PendingTaskValidation
}

function taskFacts(root: string): { taskKey: string; checklistDigest: string } {
  const path = join(root, 'tasks.task.md')
  const source = readFileSync(path, 'utf8')
  const task = selectTask(parseChecklist(source, path))!
  return {
    taskKey: createHash('sha256').update(JSON.stringify({ index: task.index, phase: task.phase, kind: task.kind, raw: task.raw })).digest('hex'),
    checklistDigest: createHash('sha256').update(source).digest('hex'),
  }
}

function authenticateState(fixture: Fixture, mutate: (state: MutableRunState) => void): MutableRunState {
  const statePath = join(fixture.stateDir, 'run.json')
  const state = JSON.parse(readFileSync(statePath, 'utf8')) as MutableRunState
  mutate(state)
  writeFileSync(statePath, `${JSON.stringify(state)}\n`)
  persistRunStateProof(fixture.stateDir, state as never, createLeaseKey(fixture.stateDir))
  return state
}

function pendingValidation(fixture: Fixture, overrides: Partial<PendingTaskValidation> = {}): PendingTaskValidation {
  const facts = taskFacts(fixture.root)
  return {
    schemaVersion: 1,
    taskKey: facts.taskKey,
    taskIndex: 0,
    baseHead: git(fixture.root, 'rev-parse', 'HEAD'),
    commitHead: git(fixture.root, 'rev-parse', 'HEAD'),
    checklistDigest: facts.checklistDigest,
    ignoredPathsDigest: createHash('sha256').update('[]').digest('hex'),
    failureSignature: 'f'.repeat(64),
    createdAttempt: 1,
    verifierAttempts: 0,
    phase: 'pending',
    ...overrides,
  }
}

describe('authenticated controller lifecycle authority integrity', () => {
  it('accepts a valid modern receipt chain and genuine legacy state', async () => {
    const modern = repository(true)
    await expect(inspectAuthenticatedControllers(modern.root)).resolves.toHaveLength(1)
    const legacy = repository(false)
    await expect(inspectAuthenticatedControllers(legacy.root)).resolves.toHaveLength(1)
  })

  it('exposes an authenticated zero-consumption epoch tail after Host restart while run state remains on its prior epoch', async () => {
    const fixture = repository(true)
    for (let transitions = 2; transitions <= 16; transitions += 1) {
      appendLifecycleAuthorityReceipt(fixture.stateDir, fixture.runId, authority({ transitions }))
    }
    appendLifecycleAuthorityReceipt(fixture.stateDir, fixture.runId, authority({
      epoch: 2, transitions: 0, issuedAt: 90_000_000, expiresAt: 176_400_000,
    }))
    await expect(inspectAuthenticatedControllers(fixture.root)).resolves.toMatchObject([{
      runId: fixture.runId, lifecycleAuthority: { epoch: 2, transitions: 0 },
    }])
  })

  it('round-trips the authenticated legacy ignored bridge condition and active attempt after Host restart', async () => {
    const fixture = repository(true)
    const facts = taskFacts(fixture.root)
    const detail = '\r\n worker ignored artifact recovery cannot prove its legacy non-empty baseline from current fingerprints after exact newly tracked promotion inference within 4 additions and 3 candidates\t'
    authenticateState(fixture, state => {
      state.lastError = detail
      state.autoRecoveryBlocked = true
      state.activeTaskAttempt = {
        schemaVersion: 1, taskKey: facts.taskKey, taskIndex: 0,
        baseHead: git(fixture.root, 'rev-parse', 'HEAD'), checklistDigest: facts.checklistDigest,
        ignoredPathsDigest: 'd'.repeat(64), attempt: 1,
      }
    })

    await expect(inspectAuthenticatedControllers(fixture.root)).resolves.toMatchObject([{
      runId: fixture.runId, detail, autoRecoveryBlocked: true,
      activeTaskAttempt: { taskKey: facts.taskKey, ignoredPathsDigest: 'd'.repeat(64), attempt: 1 },
      lifecycleAuthority: { sessionId: 'session-a', transitions: 1 },
    }])
  })

  it('migrates legacy ownership once and rejects later recovery-state tampering', async () => {
    const legacy = repository(false)
    const statePath = join(legacy.stateDir, 'run.json')
    const legacyState = JSON.parse(readFileSync(statePath, 'utf8')) as { stateProof?: { value?: string }; lastError?: string; autoRecoveryBlocked?: boolean; dependencyBridgeActive?: boolean; windowsArgvBridgeActive?: boolean }
    legacyState.lastError = 'forged legacy failure'
    legacyState.autoRecoveryBlocked = true
    legacyState.dependencyBridgeActive = true
    legacyState.windowsArgvBridgeActive = true
    writeFileSync(statePath, `${JSON.stringify(legacyState)}\n`)

    await migrateRunStateSecurityProof(legacy.root, legacy.runId)
    expect(readFileSync(join(legacy.stateDir, 'run-state-auth-required.hmac'), 'utf8')).not.toBe('')
    const migrated = JSON.parse(readFileSync(statePath, 'utf8')) as typeof legacyState
    expect(migrated.lastError).toBeUndefined()
    expect(migrated.autoRecoveryBlocked).toBeUndefined()
    expect(migrated.dependencyBridgeActive).toBeUndefined()
    expect(migrated.windowsArgvBridgeActive).toBeUndefined()
    expect(migrated.stateProof?.value).toMatch(/^[A-Za-z0-9_-]{43}$/u)
    unlinkSync(join(legacy.stateDir, 'ownership.hmac'))
    await expect(inspectAuthenticatedControllers(legacy.root)).resolves.toHaveLength(1)

    migrated.lastError = 'npm error code ENOTCACHED; cache mode is only-if-cached'
    migrated.autoRecoveryBlocked = true
    migrated.windowsArgvBridgeActive = true
    writeFileSync(statePath, `${JSON.stringify(migrated)}\n`)
    await expect(inspectAuthenticatedControllers(legacy.root)).resolves.toHaveLength(0)
  })

  it('resumes both proof-migration crash phases and cannot downgrade to legacy ownership', async () => {
    const beforeTargetProof = repository(false)
    const firstPath = join(beforeTargetProof.stateDir, 'run.json')
    const firstKey = createLeaseKey(beforeTargetProof.stateDir)
    ensureRunStateProofRequired(beforeTargetProof.stateDir, beforeTargetProof.runId, firstKey)
    const attackerState = JSON.parse(readFileSync(firstPath, 'utf8')) as MutableRunState
    attackerState.autoRecoveryBlocked = true
    attackerState.pendingTaskValidation = pendingValidation(beforeTargetProof)
    writeFileSync(firstPath, `${JSON.stringify(attackerState)}\n`)
    await migrateRunStateSecurityProof(beforeTargetProof.root, beforeTargetProof.runId)
    const firstMigrated = JSON.parse(readFileSync(firstPath, 'utf8')) as MutableRunState & { stateProof?: { value?: string } }
    expect(firstMigrated.autoRecoveryBlocked).toBeUndefined()
    expect(firstMigrated.pendingTaskValidation).toBeUndefined()
    expect(firstMigrated.stateProof?.value).toMatch(/^[A-Za-z0-9_-]{43}$/u)

    const afterTargetProof = repository(false)
    const secondPath = join(afterTargetProof.stateDir, 'run.json')
    const secondKey = createLeaseKey(afterTargetProof.stateDir)
    const interruptedState = JSON.parse(readFileSync(secondPath, 'utf8')) as MutableRunState
    interruptedState.lastError = 'legacy failure cleared by migration'
    writeFileSync(secondPath, `${JSON.stringify(interruptedState)}\n`)
    const preparedTarget = { ...interruptedState }
    delete preparedTarget.lastError
    persistRunStateProof(afterTargetProof.stateDir, preparedTarget as never, secondKey)
    await migrateRunStateSecurityProof(afterTargetProof.root, afterTargetProof.runId)
    const secondMigrated = JSON.parse(readFileSync(secondPath, 'utf8')) as MutableRunState & { stateProof?: { value?: string } }
    expect(secondMigrated.stateProof?.value).toMatch(/^[A-Za-z0-9_-]{43}$/u)

    delete secondMigrated.stateProof
    secondMigrated.autoRecoveryBlocked = true
    writeFileSync(secondPath, `${JSON.stringify(secondMigrated)}\n`)
    unlinkSync(join(afterTargetProof.stateDir, 'run-state-auth-required.hmac'))
    await expect(inspectAuthenticatedControllers(afterTargetProof.root)).resolves.toHaveLength(0)
  })

  it('quarantines receipt corruption but repairs a missing local head from the external anchor', async () => {
    const corrupted = repository(true)
    const receiptPath = join(corrupted.stateDir, 'lifecycle-authority', 'authority-000001.json')
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as { authority: { allowPublication: boolean } }
    receipt.authority.allowPublication = true
    writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`)
    await expect(inspectAuthenticatedControllers(corrupted.root)).resolves.toHaveLength(0)

    const missingHead = repository(true)
    unlinkSync(join(missingHead.stateDir, 'lifecycle-authority-head.json'))
    await expect(inspectAuthenticatedControllers(missingHead.root)).resolves.toHaveLength(1)
  })

  it('does not reinterpret a deleted modern chain as legacy while its authenticated marker remains', async () => {
    const modern = repository(true)
    rmSync(join(modern.stateDir, 'lifecycle-authority'), { recursive: true, force: true })
    unlinkSync(join(modern.stateDir, 'lifecycle-authority-head.json'))
    await expect(inspectAuthenticatedControllers(modern.root)).resolves.toHaveLength(0)
  })

  it('rejects malformed or mutually exclusive active-attempt and pending-validation state even with a fresh HMAC', async () => {
    const malformed = repository(false)
    const facts = taskFacts(malformed.root)
    authenticateState(malformed, state => {
      state.activeTaskAttempt = {
        schemaVersion: 1, taskKey: facts.taskKey, taskIndex: 0, baseHead: git(malformed.root, 'rev-parse', 'HEAD'),
        checklistDigest: facts.checklistDigest, ignoredPathsDigest: createHash('sha256').update('[]').digest('hex'), attempt: 0,
      }
    })
    await expect(inspectAuthenticatedControllers(malformed.root)).resolves.toHaveLength(0)

    const malformedTransaction = repository(false)
    const transactionFacts = taskFacts(malformedTransaction.root)
    authenticateState(malformedTransaction, state => {
      state.activeTaskAttempt = {
        schemaVersion: 1, taskKey: transactionFacts.taskKey, taskIndex: 0,
        baseHead: git(malformedTransaction.root, 'rev-parse', 'HEAD'), checklistDigest: transactionFacts.checklistDigest,
        ignoredPathsDigest: createHash('sha256').update('[]').digest('hex'), attempt: 1,
        ignoredArtifactTransaction: {
          schemaVersion: 1, transactionId: '12345678-1234-4234-8234-123456789abc', baselineDigest: 'f'.repeat(64),
        },
      }
    })
    await expect(inspectAuthenticatedControllers(malformedTransaction.root)).resolves.toHaveLength(0)

    const malformedPending = repository(false)
    authenticateState(malformedPending, state => {
      state.pendingTaskValidation = { ...pendingValidation(malformedPending), phase: 'validated' }
    })
    await expect(inspectAuthenticatedControllers(malformedPending.root)).resolves.toHaveLength(0)

    const exclusive = repository(false)
    const pending = pendingValidation(exclusive)
    authenticateState(exclusive, state => {
      state.activeTaskAttempt = {
        schemaVersion: 1, taskKey: pending.taskKey, taskIndex: pending.taskIndex, baseHead: pending.baseHead,
        checklistDigest: pending.checklistDigest, ignoredPathsDigest: pending.ignoredPathsDigest, attempt: 1,
      }
      state.pendingTaskValidation = pending
    })
    await expect(inspectAuthenticatedControllers(exclusive.root)).resolves.toHaveLength(0)
  })

  it('binds pending committed validation to exact commit, task identity, and checklist bytes', async () => {
    const valid = repository(false)
    const baseHead = git(valid.root, 'rev-parse', 'HEAD')
    writeFileSync(join(valid.root, 'src', 'value.txt'), 'committed pending result\n')
    git(valid.root, 'add', 'src/value.txt')
    git(valid.root, 'commit', '-m', 'feat: pending committed result')
    const pending = pendingValidation(valid, { baseHead })
    authenticateState(valid, state => { state.pendingTaskValidation = pending })
    await expect(inspectAuthenticatedControllers(valid.root)).resolves.toMatchObject([{
      runId: valid.runId,
      pendingTaskValidation: pending,
      openTask: { index: 0 },
    }])

    for (const mutation of [
      { commitHead: '9'.repeat(40) },
      { taskKey: '8'.repeat(64) },
      { taskIndex: 1 },
      { checklistDigest: '7'.repeat(64) },
    ] satisfies Array<Partial<PendingTaskValidation>>) {
      const mismatched = repository(false)
      authenticateState(mismatched, state => { state.pendingTaskValidation = pendingValidation(mismatched, mutation) })
      await expect(inspectAuthenticatedControllers(mismatched.root)).resolves.toHaveLength(0)
    }
  })

  it('exposes a validated pending commit after controller adoption changed HEAD and checklist bytes', async () => {
    const fixture = repository(false)
    const original = pendingValidation(fixture)
    writeFileSync(join(fixture.root, 'src', 'value.txt'), 'committed worker result\n')
    git(fixture.root, 'add', 'src/value.txt')
    git(fixture.root, 'commit', '-m', 'feat: committed task result')
    const commitHead = git(fixture.root, 'rev-parse', 'HEAD')
    writeFileSync(join(fixture.root, 'tasks.task.md'), '- [x] Alpha `src/value.txt` | Done: alpha\n')
    git(fixture.root, 'add', 'tasks.task.md')
    git(fixture.root, 'commit', '-m', 'chore: adopt validated task')
    const adoptedChecklistDigest = createHash('sha256').update(readFileSync(join(fixture.root, 'tasks.task.md'), 'utf8')).digest('hex')
    const validated: PendingTaskValidation = {
      ...original,
      commitHead,
      phase: 'validated',
      verifierAttempts: 1,
      validatedChecklistDigest: adoptedChecklistDigest,
      validationEvidenceDigest: '6'.repeat(64),
    }
    authenticateState(fixture, state => { state.pendingTaskValidation = validated })

    const controllers = await inspectAuthenticatedControllers(fixture.root)
    expect(controllers).toMatchObject([{
      runId: fixture.runId,
      pendingTaskValidation: validated,
    }])
    expect(controllers[0]?.openTask).toBeUndefined()
    expect(git(fixture.root, 'rev-parse', 'HEAD')).not.toBe(commitHead)
  })
})
