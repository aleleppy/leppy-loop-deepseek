import type { WorkerReport } from './types.js'

export const WORKER_OUTCOME_PREFIX = 'LEPPY_OUTCOME:'

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function boundedText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length < 3) throw new Error(`${field} must be a non-empty string`)
  return value.trim().slice(0, 8 * 1024)
}

/** Parse the final machine-readable worker disposition. Prose alone never authorizes adoption. */
export function parseWorkerReport(output: string, advisoryValidation = false): WorkerReport {
  const lines = output.split(/\r?\n/u).map(candidate => candidate.trim()).filter(Boolean)
  const records = lines.filter(candidate => candidate.startsWith(WORKER_OUTCOME_PREFIX))
  const line = records[0]
  if (!line) throw new Error(`worker omitted required ${WORKER_OUTCOME_PREFIX} final record`)
  if (records.length !== 1) throw new Error(`worker must emit exactly one ${WORKER_OUTCOME_PREFIX} final record`)
  if (lines.at(-1) !== line) throw new Error(`${WORKER_OUTCOME_PREFIX} record must be the final non-empty output line`)
  let parsed: unknown
  try {
    parsed = JSON.parse(line.slice(WORKER_OUTCOME_PREFIX.length).trim())
  } catch (error) {
    throw new Error(`worker emitted invalid ${WORKER_OUTCOME_PREFIX} JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  const value = record(parsed)
  const validation = record(value?.validation)
  if (!value || !['completed', 'blocked', 'failed'].includes(String(value.status))) throw new Error('worker outcome status must be completed, blocked, or failed')
  if (!validation || !['passed', 'failed', 'not-run'].includes(String(validation.status))) throw new Error('worker validation status must be passed, failed, or not-run')
  const report: WorkerReport = {
    status: value.status as WorkerReport['status'],
    summary: boundedText(value.summary, 'worker outcome summary'),
    validation: {
      status: validation.status as WorkerReport['validation']['status'],
      evidence: boundedText(validation.evidence, 'worker validation evidence'),
    },
  }
  if (!advisoryValidation && report.status === 'completed' && report.validation.status !== 'passed') throw new Error('completed worker outcome requires passed validation evidence')
  if (report.status !== 'completed' && report.validation.status === 'passed') throw new Error(`${report.status} worker outcome cannot claim passed validation`)
  const contradictoryFailure = output.split(/\r?\n/u).map(candidate => candidate.trim()).find(candidate =>
    /^(?:BLOQUEADO|BLOCKED|TESTS? FAILED|TESTES? FALHARAM|TESTE FOCAL (?:NÃO|NAO) COMPILOU)\s*[:.-]/iu.test(candidate))
  if (!advisoryValidation && report.status === 'completed' && contradictoryFailure) throw new Error(`completed worker outcome contradicts explicit failure: ${contradictoryFailure.slice(0, 512)}`)
  return report
}

export function renderWorkerOutcomeContract(kind: 'task' | 'closure' | 'verification' | 'publication-conflict'): string[] {
  const completion = kind === 'task'
    ? 'completed requires exactly one conventional commit. Validation is advisory: attempt focused checks and report their exact result, but infrastructure/tooling failures do not prevent completion when your engineering judgment says the Done contract is satisfied.'
    : kind === 'closure'
      ? 'completed is allowed when the phase is verified clean or one corrective commit was created. Validation is advisory: report failures exactly and use engineering judgment instead of blocking on unavailable tooling.'
      : kind === 'verification'
        ? 'completed is allowed only when the existing committed task satisfies the Done contract and concrete focused validation passed without changing HEAD or the worktree.'
        : 'completed is allowed only after every exact conflict path is resolved and concrete validation passed.'
  return [
    `Finish with exactly one final line: ${WORKER_OUTCOME_PREFIX} {"status":"completed|blocked|failed","summary":"concrete disposition","validation":{"status":"passed|failed|not-run","evidence":"command/result or concrete inspection"}}`,
    completion,
    kind === 'task' || kind === 'closure'
      ? 'Use blocked only when scope, missing authority, or an unresolved implementation defect prevents the Done contract. Unavailable validation tooling alone is advisory and must not block completion.'
      : 'Use blocked when scope, missing authority, unavailable tooling, or an unresolved defect prevents the Done contract. Never describe a blocked or failed result as completed.',
  ]
}
