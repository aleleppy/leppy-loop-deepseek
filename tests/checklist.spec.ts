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
