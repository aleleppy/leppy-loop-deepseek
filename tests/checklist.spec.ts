import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { lintChecklist, markTaskDone, parseChecklist, selectTask } from '../src/checklist.js'

const valid = `# Plan

intro remains untouched

## Phase one

- [ ] Implement \`src/a.ts\` | Done: exports a | model=deepseek-v4-pro | effort=high
- [?] Closure: review \`src\` | paths=src
- [~] Gate: focused suite
`

describe('checklist parser and lint', () => {
  it('parses all four marks and three line kinds while preserving Markdown', () => {
    const parsed = parseChecklist(valid)
    expect(parsed.tasks.map(task => [task.mark, task.kind])).toEqual([[' ', 'task'], ['?', 'closure'], ['~', 'gate']])
    expect(parsed.lines[2]).toBe('intro remains untouched')
    expect(markTaskDone(parsed, parsed.tasks[0]!)).toContain('- [x] Implement')
  })

  it('parses legacy multiline rows, role tags and metadata without discarding context', () => {
    const parsed = parseChecklist(`## Legacy
- [ ] R1 — implement the bounded queue.
  Paths EXATOS: \`src/queue.ts\`, \`src/queue.test.ts\`
  Done: queue rejects overflow and focused tests pass.
- [ ] [closure] Audit the queue invariants. | paths=src/queue.ts,src/queue.test.ts
- [ ] [gate] Gate the phase. | gate=\`pnpm test\`
- [?] [human/live] Confirm behavior in the release client.
`)
    expect(parsed.tasks.map(task => task.kind)).toEqual(['task', 'closure', 'gate', 'human'])
    expect(parsed.tasks[0]?.metadata).toMatchObject({
      paths: ['src/queue.ts', 'src/queue.test.ts'],
      done: 'queue rejects overflow and focused tests pass.',
    })
    expect(parsed.tasks[0]?.raw).toContain('bounded queue. Paths EXATOS:')
    expect(lintChecklist(parsed)).toEqual([])
  })

  it('selects exactly one open line with literal substring matching', () => {
    const parsed = parseChecklist(valid)
    expect(selectTask(parsed, 'src/a.ts')?.index).toBe(0)
    expect(selectTask(parsed, 'src.*a')).toBeUndefined()
  })

  it('accepts phases without closure or gate', () => {
    const parsed = parseChecklist('- [ ] Do `a.ts` | Done: a exists')
    expect(lintChecklist(parsed, { phaseGateCommand: 'pnpm test' })).toEqual([])
  })

  it('rejects missing Done, vague references, unsafe paths, unknown models, efforts, empty gate and bad ordering', () => {
    const source = `## P
- [ ] See checklist above | paths=../escape | model=missing | effort=ultra
- [~] Gate: nope
- [?] Closure: review | paths=src
`
    const diagnostics = lintChecklist(parseChecklist(source), {
      models: [{ id: 'known', reasoningEfforts: ['low'] }], provider: 'p', defaultModel: 'known',
    })
    expect(diagnostics.map(item => item.code)).toEqual(expect.arrayContaining([
      'vague-reference', 'missing-done', 'unsafe-path', 'unknown-model', 'empty-gate', 'gate-order', 'closure-gate-adjacency',
    ]))
  })

  it('rejects extension fragments, brace scopes, abbreviated inferred basenames and missing test write scope', () => {
    const root = mkdtempSync(join(tmpdir(), 'leppy-strict-paths-'))
    mkdirSync(join(root, 'mod', 'src', 'main'), { recursive: true })
    writeFileSync(join(root, 'mod', 'src', 'main', 'Page.java'), 'class Page {}\n')
    const parsed = parseChecklist('- [ ] Update `mod/src/main/Page.java`/`Event.java` using grammar `.ui` and update tests | Done: tests pass\n- [?] Closure: audit `core/{main,test}/`\n')
    const codes = lintChecklist(parsed, { repoRoot: root }).map(item => item.code)
    expect(codes).toEqual(expect.arrayContaining([
      'ambiguous-inferred-path', 'unsupported-path-syntax', 'missing-test-scope',
    ]))
    expect(codes.filter(code => code === 'unsupported-path-syntax').length).toBeGreaterThanOrEqual(2)
  })

  it('accepts explicit new source and test paths when their repository parent exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'leppy-explicit-paths-'))
    mkdirSync(join(root, 'src'))
    const parsed = parseChecklist('- [ ] Add implementation and tests | Done: tests pass | paths=src/new.ts,src/new.test.ts\n')
    expect(lintChecklist(parsed, { repoRoot: root })).toEqual([])
  })

  it('rejects a junction escaping the repository', () => {
    const root = mkdtempSync(join(tmpdir(), 'leppy-path-root-'))
    const outside = mkdtempSync(join(tmpdir(), 'leppy-path-out-'))
    mkdirSync(join(root, 'src'))
    symlinkSync(outside, join(root, 'src', 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    const parsed = parseChecklist('- [ ] Change `src/linked/owned.ts` | Done: changed')
    expect(lintChecklist(parsed, { repoRoot: root }).map(item => item.code)).toContain('path-escape')
  })

  it('rejects the controlling checklist in worker scope', () => {
    const root = mkdtempSync(join(tmpdir(), 'leppy-controller-'))
    const tasks = join(root, 'tasks.task.md')
    writeFileSync(tasks, '- [ ] edit | Done: no | paths=tasks.task.md')
    const parsed = parseChecklist(tasks)
    expect(lintChecklist(parsed, { repoRoot: root, controllerPath: tasks }).map(item => item.code)).toContain('controller-in-scope')
  })
})
