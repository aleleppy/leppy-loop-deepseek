import { describe, expect, it } from 'vitest'
import { parseWorkerReport } from '../src/worker-report.js'

const completed = 'LEPPY_OUTCOME: {"status":"completed","summary":"implemented safely","validation":{"status":"passed","evidence":"pnpm test passed 12 tests"}}'

describe('worker outcome protocol', () => {
  it('accepts one structured completed disposition with passed evidence', () => {
    expect(parseWorkerReport(`Implemented.\n${completed}`)).toMatchObject({
      status: 'completed', validation: { status: 'passed' },
    })
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
