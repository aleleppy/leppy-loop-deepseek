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

function inferredAdvisoryReport(output: string, reason: string): WorkerReport {
  const prose = output.trim().slice(-8 * 1024)
  const explicitlyBlocked = /(?:^|\n)\s*(?:BLOQUEADO|BLOCKED)\s*[:.-]/iu.test(output)
  return {
    status: explicitlyBlocked ? 'blocked' : 'completed',
    summary: prose || 'Worker finished without a structured summary.',
    validation: {
      status: 'not-run',
      evidence: `${reason}; ordinary validation is advisory.`,
    },
  }
}

/** Parse strict verification/publication reports; ordinary prose degrades to advisory evidence. */
export function parseWorkerReport(output: string, advisoryValidation = false): WorkerReport {
  const lines = output.split(/\r?\n/u).map(candidate => candidate.trim()).filter(Boolean)
  const records = lines.filter(candidate => candidate.startsWith(WORKER_OUTCOME_PREFIX))
  const line = records.at(-1)
  if (!line) {
    if (advisoryValidation) return inferredAdvisoryReport(output, `worker omitted ${WORKER_OUTCOME_PREFIX}`)
    throw new Error(`worker omitted required ${WORKER_OUTCOME_PREFIX} final record`)
  }
  if (!advisoryValidation && records.length !== 1) throw new Error(`worker must emit exactly one ${WORKER_OUTCOME_PREFIX} final record`)
  if (!advisoryValidation && lines.at(-1) !== line) throw new Error(`${WORKER_OUTCOME_PREFIX} record must be the final non-empty output line`)
  try {
    const parsed = JSON.parse(line.slice(WORKER_OUTCOME_PREFIX.length).trim()) as unknown
    const value = record(parsed)
    const validation = record(value?.validation)
    if (!value || !['completed', 'blocked', 'failed'].includes(String(value.status))) throw new Error('worker outcome status must be completed, blocked, or failed')
    if (!validation || !['passed', 'failed', 'not-run'].includes(String(validation.status))) throw new Error('worker validation status must be passed, failed, or not-run')
    if (value.disposition !== undefined && value.disposition !== 'implementation-impossible') {
      throw new Error('worker outcome disposition must be implementation-impossible when provided')
    }
    const report: WorkerReport = {
      status: value.status as WorkerReport['status'],
      ...(value.disposition === 'implementation-impossible' ? { disposition: value.disposition } : {}),
      summary: boundedText(value.summary, 'worker outcome summary'),
      validation: {
        status: validation.status as WorkerReport['validation']['status'],
        evidence: boundedText(validation.evidence, 'worker validation evidence'),
      },
    }
    if (report.disposition === 'implementation-impossible' && report.status === 'completed') throw new Error('completed worker outcome cannot be implementation-impossible')
    if (!advisoryValidation && report.status === 'completed' && report.validation.status !== 'passed') throw new Error('completed worker outcome requires passed validation evidence')
    if (report.status !== 'completed' && report.validation.status === 'passed') throw new Error(`${report.status} worker outcome cannot claim passed validation`)
    const contradictoryFailure = output.split(/\r?\n/u).map(candidate => candidate.trim()).find(candidate =>
      /^(?:BLOQUEADO|BLOCKED|TESTS? FAILED|TESTES? FALHARAM|TESTE FOCAL (?:NÃO|NAO) COMPILOU)\s*[:.-]/iu.test(candidate))
    if (!advisoryValidation && report.status === 'completed' && contradictoryFailure) throw new Error(`completed worker outcome contradicts explicit failure: ${contradictoryFailure.slice(0, 512)}`)
    return report
  } catch (error) {
    if (advisoryValidation) {
      return inferredAdvisoryReport(output, `worker emitted a noncanonical ${WORKER_OUTCOME_PREFIX} record: ${error instanceof Error ? error.message : String(error)}`)
    }
    throw new Error(`worker emitted invalid ${WORKER_OUTCOME_PREFIX} report: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function renderWorkerOutcomeContract(kind: 'task' | 'closure' | 'verification' | 'publication-conflict'): string[] {
  const completion = kind === 'task'
    ? 'Validation and Git ceremony are advisory. Implement the Done contract and use engineering judgment; the controller adopts safe in-scope changes and normalizes commit structure.'
    : kind === 'closure'
      ? 'Inspect and repair the phase with engineering judgment. Validation and Git ceremony are advisory; the controller cleans generated side effects and adopts in-scope changes.'
      : kind === 'verification'
        ? 'completed is allowed only when the existing committed task satisfies the Done contract and concrete focused validation passed without changing HEAD or the worktree.'
        : 'completed is allowed only after every exact conflict path is resolved and concrete validation passed.'
  return [
    kind === 'task' || kind === 'closure'
      ? `Prefer one final line: ${WORKER_OUTCOME_PREFIX} {"status":"completed|blocked|failed","summary":"concrete disposition","validation":{"status":"passed|failed|not-run","evidence":"command/result or concrete inspection"}}. If and only if implementation is genuinely impossible within scope or authority, add "disposition":"implementation-impossible". If formatting fails, concise final prose is accepted.`
      : `Finish with exactly one final line: ${WORKER_OUTCOME_PREFIX} {"status":"completed|blocked|failed","summary":"concrete disposition","validation":{"status":"passed|failed|not-run","evidence":"command/result or concrete inspection"}}`,
    completion,
    kind === 'task' || kind === 'closure'
      ? 'Ordinary blocked/failed status is advisory unless you add disposition implementation-impossible for a concrete unresolved implementation, scope, or authority impossibility. Unavailable validation or Git ceremony never qualifies.'
      : 'Use blocked when scope, missing authority, unavailable tooling, or an unresolved defect prevents the Done contract. Never describe a blocked or failed result as completed.',
  ]
}
