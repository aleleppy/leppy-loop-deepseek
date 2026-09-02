import { describe, expect, it } from 'vitest'
import { parseWorkerReport, renderWorkerOutcomeContract } from '../src/worker-report.js'

const completed = 'LEPPY_OUTCOME: {"status":"completed","summary":"implemented safely","validation":{"status":"passed","evidence":"pnpm test passed 12 tests"}}'

describe('worker outcome protocol', () => {
  it('accepts one structured completed disposition with passed evidence', () => {
    expect(parseWorkerReport(`Implemented.\n${completed}`)).toMatchObject({
      status: 'completed', validation: { status: 'passed' },
    })
  })

  it('lets ordinary workers complete with advisory validation while keeping verification strict', () => {
    const taskContract = renderWorkerOutcomeContract('task').join('\n')
    expect(taskContract).toContain('Validation and Git ceremony are advisory')
    expect(parseWorkerReport('Tests failed: spawn EPERM\nLEPPY_OUTCOME: {"status":"completed","summary":"implementation satisfied by inspection","validation":{"status":"failed","evidence":"Vitest startup failed with spawn EPERM"}}', true)).toMatchObject({
      status: 'completed', validation: { status: 'failed' },
    })
    expect(parseWorkerReport('LEPPY_OUTCOME: {"status":"completed","summary":"implementation satisfied by inspection","validation":{"status":"not-run","evidence":"validator unavailable in sandbox"}}', true)).toMatchObject({
      status: 'completed', validation: { status: 'not-run' },
    })
  })

  it('infers advisory ordinary completion from missing or malformed structured reports', () => {
    expect(parseWorkerReport('Implemented the scoped change.', true)).toMatchObject({
      status: 'completed', validation: { status: 'not-run' },
    })
    expect(parseWorkerReport('LEPPY_OUTCOME: not-json', true)).toMatchObject({
      status: 'completed', validation: { status: 'not-run' },
    })
    expect(parseWorkerReport('BLOQUEADO: missing implementation detail', true)).toMatchObject({ status: 'blocked' })
  })

  it('accepts only the explicit implementation-impossible disposition as ordinary stop authority', () => {
    expect(parseWorkerReport('LEPPY_OUTCOME: {"status":"blocked","disposition":"implementation-impossible","summary":"scope cannot include required file","validation":{"status":"not-run","evidence":"authenticated scope excludes dependency"}}', true)).toMatchObject({
      status: 'blocked', disposition: 'implementation-impossible',
    })
    expect(parseWorkerReport('LEPPY_OUTCOME: {"status":"blocked","disposition":"something-else","summary":"scope missing","validation":{"status":"not-run","evidence":"missing"}}', true)).not.toHaveProperty('disposition')
  })

  it('requires passed focused validation before verification can report completed', () => {
    const contract = renderWorkerOutcomeContract('verification').join('\n')
    expect(contract).toContain('existing committed task satisfies the Done contract')
    expect(contract).toContain('focused validation passed without changing HEAD or the worktree')
    expect(parseWorkerReport(completed)).toMatchObject({ status: 'completed', validation: { status: 'passed' } })
    for (const validation of ['failed', 'not-run']) {
      expect(() => parseWorkerReport(`LEPPY_OUTCOME: {"status":"completed","summary":"verification finished","validation":{"status":"${validation}","evidence":"focused verification did not pass"}}`))
        .toThrow('completed worker outcome requires passed validation evidence')
    }
  })

  it('rejects missing, malformed and internally inconsistent dispositions', () => {
    expect(() => parseWorkerReport('done')).toThrow('omitted required LEPPY_OUTCOME')
    expect(() => parseWorkerReport('LEPPY_OUTCOME: nope')).toThrow('invalid LEPPY_OUTCOME')
    expect(() => parseWorkerReport('LEPPY_OUTCOME: {"status":"completed","summary":"done","validation":{"status":"failed","evidence":"tests failed"}}')).toThrow('requires passed')
    expect(() => parseWorkerReport(`${completed}\ntrailing prose`)).toThrow('final non-empty output line')
    expect(() => parseWorkerReport(`${completed}\n${completed}`)).toThrow('exactly one')
  })

  it.each([
    'BLOQUEADO: escopo insuficiente',
    'BLOCKED: missing authority',
    'Tests failed: 2 failing',
    'Teste focal não compilou: legacy API',
  ])('never lets completed structured output override terminal failure prose: %s', failure => {
    expect(() => parseWorkerReport(`${failure}\n${completed}`)).toThrow('contradicts explicit failure')
  })

  it('preserves a structured blocked disposition for durable stalling', () => {
    expect(parseWorkerReport('LEPPY_OUTCOME: {"status":"blocked","summary":"scope missing","validation":{"status":"not-run","evidence":"write scope excludes test"}}')).toMatchObject({
      status: 'blocked', summary: 'scope missing', validation: { status: 'not-run' },
    })
  })
})
