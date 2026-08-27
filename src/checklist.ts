import { existsSync, lstatSync, realpathSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type {
  ChecklistLintOptions, ChecklistMark, ChecklistTask, LintDiagnostic,
  ModelCapability, ParsedChecklist, TaskKind, TaskMetadata,
} from './types.js'
import { physicalRelative } from './path.js'

const CHECKBOX = /^(\s*[-*+]\s+\[)([ x?~])(\]\s+)(.*)$/i
const PHASE = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/
const META_KEYS = ['Done', 'paths', 'model', 'effort', 'gate'] as const

function splitSegments(text: string): string[] {
  const out: string[] = []
  let start = 0
  let backtick = false
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '`') backtick = !backtick
    if (!backtick && text[i] === '|') {
      out.push(text.slice(start, i).trim())
      start = i + 1
    }
  }
  out.push(text.slice(start).trim())
  return out
}

function kindOf(mark: ChecklistMark, text: string): TaskKind {
  if (/^\s*\[human(?:\/[^\]]+)?\]/i.test(text)) return 'human'
  if (mark === '?' || /^\s*(?:\[closure\]\s*)?closure\s*:/i.test(text) || /^\s*\[closure\]/i.test(text)) return 'closure'
  if (mark === '~' || /^\s*(?:\[gate\]\s*)?gate\s*:/i.test(text) || /^\s*\[gate\]/i.test(text)) return 'gate'
  return 'task'
}

function stripKindPrefix(text: string, kind: TaskKind): string {
  if (kind === 'closure') return text.replace(/^\s*\[closure\]\s*/i, '').replace(/^closure\s*:\s*/i, '')
  if (kind === 'gate') return text.replace(/^\s*\[gate\]\s*/i, '').replace(/^gate\s*:\s*/i, '')
  if (kind === 'human') return text.replace(/^\s*\[human(?:\/[^\]]+)?\]\s*/i, '')
  return text
}

function unquote(value: string): string {
  const trimmed = value.trim()
  return trimmed.startsWith('`') && trimmed.endsWith('`') ? trimmed.slice(1, -1) : trimmed
}

function extractLegacyFields(segment: string): { text: string; done?: string; paths: string[] } {
  const markers = [...segment.matchAll(/(?:^|\s)(Done|Paths?(?:\s+(?:EXATOS?|permitidos?))?)\s*:\s*/gi)]
  if (markers.length === 0) return { text: segment, paths: [] }
  const first = markers[0]!
  const text = segment.slice(0, first.index).trim()
  let done: string | undefined
  const paths: string[] = []
  for (const [index, marker] of markers.entries()) {
    const start = (marker.index ?? 0) + marker[0].length
    const end = markers[index + 1]?.index ?? segment.length
    const value = segment.slice(start, end).trim()
    if (/^done$/i.test(marker[1]!)) done = value
    else paths.push(...[...value.matchAll(/`([^`]+)`/g)].map(match => match[1]!).filter(looksLikePath))
  }
  return { text, ...(done ? { done } : {}), paths }
}

function parseMetadata(segments: string[], kind: TaskKind): { text: string; metadata: TaskMetadata } {
  const metadata: TaskMetadata = { paths: [] }
  const textParts: string[] = []
  for (const [index, segment] of segments.entries()) {
    if (index === 0 && kind === 'gate' && /^gate\s*:/i.test(segment)) {
      textParts.push(segment)
      continue
    }
    const match = /^(Done|paths|model|effort|gate)\s*[:=]\s*(.*)$/i.exec(segment)
    if (!match) {
      const legacy = extractLegacyFields(segment)
      if (legacy.text) textParts.push(legacy.text)
      if (legacy.done) metadata.done = legacy.done
      if (legacy.paths.length > 0) metadata.paths.push(...legacy.paths)
      continue
    }
    const key = META_KEYS.find(candidate => candidate.toLowerCase() === match[1]?.toLowerCase())
    const value = match[2]?.trim() ?? ''
    switch (key) {
      case 'Done': metadata.done = value; break
      case 'paths': metadata.paths = value.split(',').map(unquote).filter(Boolean); break
      case 'model': metadata.model = unquote(value); break
      case 'effort': metadata.effort = unquote(value); break
      case 'gate': metadata.gate = unquote(value); break
    }
  }
  const text = stripKindPrefix(textParts.join(' | ').trim(), kind)
  metadata.paths = [...new Set(metadata.paths)]
  if (metadata.paths.length === 0 && kind !== 'gate' && kind !== 'human') {
    const candidates = [...text.matchAll(/`([^`]+)`/g)].map(match => match[1]!).filter(looksLikePath)
    metadata.paths = [...new Set(candidates)]
  }
  return { text, metadata }
}

function looksLikePath(value: string): boolean {
  return /[\\/]/.test(value) || /\.[A-Za-z0-9_-]{1,12}$/.test(value)
}

export function parseChecklist(sourceOrPath: string, path = '<memory>'): ParsedChecklist {
  const fromFile = path === '<memory>' && existsSync(sourceOrPath) && lstatSync(sourceOrPath).isFile()
  const actualPath = fromFile ? resolve(sourceOrPath) : path
  const source = fromFile ? readFileSync(actualPath, 'utf8') : sourceOrPath
  const lines = source.split(/\r?\n/)
  const tasks: ChecklistTask[] = []
  let phase = 'Default'
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const raw = lines[lineIndex]!
    const heading = PHASE.exec(raw)
    if (heading) phase = heading[1]!.trim()
    const match = CHECKBOX.exec(raw)
    if (!match) continue
    const mark = match[2]!.toLowerCase() as ChecklistMark
    const continuation: string[] = []
    for (let continuationIndex = lineIndex + 1; continuationIndex < lines.length; continuationIndex += 1) {
      const candidate = lines[continuationIndex]!
      if (CHECKBOX.test(candidate) || PHASE.test(candidate)) break
      if (candidate.trim() === '') {
        if (continuation.length > 0) continuation.push('')
        continue
      }
      if (!/^\s{2,}\S/u.test(candidate)) break
      continuation.push(candidate.trim())
    }
    const body = [match[4]!.trim(), ...continuation].filter(Boolean).join(' ')
    const provisionalKind = kindOf(mark, body)
    const parsed = parseMetadata(splitSegments(body), provisionalKind)
    tasks.push({
      index: tasks.length,
      line: lineIndex + 1,
      phase,
      mark,
      kind: provisionalKind,
      text: parsed.text,
      raw: `${match[1]}${mark}${match[3]}${body}`,
      metadata: parsed.metadata,
    })
  }
  return { path: actualPath, source, lines, tasks }
}

function diagnostic(code: string, message: string, task?: ChecklistTask): LintDiagnostic {
  return { severity: 'error', code, message, ...(task ? { line: task.line } : {}) }
}

function modelById(models: readonly ModelCapability[] | undefined, id: string): ModelCapability | undefined {
  return models?.find(model => model.id === id)
}

function pathEscapesLexically(path: string): boolean {
  if (path.trim() === '' || isAbsolute(path)) return true
  const normalized = path.replaceAll('\\', '/')
  return normalized === '..' || normalized.startsWith('../') || normalized.includes('/../') || normalized.includes('\0')
}

function canonicalInside(repoRoot: string, candidate: string): boolean {
  const rootReal = realpathSync(repoRoot)
  const absolute = resolve(rootReal, candidate)
  let current = absolute
  while (!existsSync(current)) {
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  const existingReal = realpathSync(current)
  const suffix = relative(current, absolute)
  return physicalRelative(rootReal, existingReal) !== undefined && !isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`)
}

export function lintChecklist(parsed: ParsedChecklist, options: ChecklistLintOptions = {}): LintDiagnostic[] {
  const diagnostics: LintDiagnostic[] = []
  if (parsed.tasks.length === 0) diagnostics.push(diagnostic('empty-corpus', 'Checklist contains no executable checkbox lines.'))
  const byPhase = new Map<string, ChecklistTask[]>()
  for (const task of parsed.tasks) {
    const group = byPhase.get(task.phase) ?? []
    group.push(task)
    byPhase.set(task.phase, group)
    if (task.text.trim() === '') diagnostics.push(diagnostic('empty-task', 'Task text is empty.', task))
    if (/\b(see|same as|refer to|conforme|igual)\b.*\b(checklist|above|acima|outra)\b/i.test(task.text)) {
      diagnostics.push(diagnostic('vague-reference', 'Task refers vaguely to another checklist or line.', task))
    }
    if (task.kind === 'task' && task.mark !== 'x' && (task.metadata.done === undefined || task.metadata.done.trim() === '')) {
      diagnostics.push(diagnostic('missing-done', 'Open task requires a non-empty Done: contract.', task))
    }
    if (task.kind !== 'gate' && task.kind !== 'human' && task.mark !== 'x' && task.metadata.paths.length === 0) {
      diagnostics.push(diagnostic('missing-paths', 'Open worker line requires paths=... or repo-relative paths in backticks.', task))
    }
    for (const path of task.metadata.paths) {
      if (pathEscapesLexically(path)) diagnostics.push(diagnostic('unsafe-path', `Unsafe path: ${JSON.stringify(path)}.`, task))
      else if (options.repoRoot && !canonicalInside(options.repoRoot, path)) diagnostics.push(diagnostic('path-escape', `Path resolves outside the repository: ${JSON.stringify(path)}.`, task))
      if (options.controllerPath && resolve(options.repoRoot ?? '.', path) === resolve(options.controllerPath)) {
        diagnostics.push(diagnostic('controller-in-scope', 'The controlling checklist cannot be a worker path.', task))
      }
    }
    const modelId = task.metadata.model ?? options.defaultModel
    if (task.metadata.model && options.models && !modelById(options.models, task.metadata.model)) {
      diagnostics.push(diagnostic('unknown-model', `Model ${JSON.stringify(task.metadata.model)} is absent from provider ${options.provider ?? '<unknown>'}.`, task))
    }
    const effort = task.metadata.effort ?? options.defaultEffort
    if (effort && modelId && options.models) {
      const model = modelById(options.models, modelId)
      if (model?.reasoningEfforts && !model.reasoningEfforts.includes(effort)) {
        diagnostics.push(diagnostic('unsupported-effort', `Effort ${JSON.stringify(effort)} is unsupported by model ${JSON.stringify(modelId)}.`, task))
      }
    }
    if (task.kind === 'gate' && task.mark !== 'x') {
      const command = task.metadata.gate ?? options.phaseGateCommand
      if (command === undefined || command.trim() === '') diagnostics.push(diagnostic('empty-gate', 'Open gate requires --phase-gate-command or gate=....', task))
    }
    if (task.kind === 'task' && (task.mark === '?' || task.mark === '~')) diagnostics.push(diagnostic('contradictory-kind', 'Task marker contradicts its line type.', task))
  }
  for (const tasks of byPhase.values()) {
    const automated = tasks.filter(task => task.kind !== 'human')
    const closures = automated.filter(task => task.kind === 'closure')
    const gates = automated.filter(task => task.kind === 'gate')
    const humans = tasks.filter(task => task.kind === 'human')
    if (closures.length > 1) diagnostics.push(diagnostic('multiple-closures', `Phase ${JSON.stringify(tasks[0]?.phase)} has multiple closure lines.`, closures[1]))
    if (gates.length > 1) diagnostics.push(diagnostic('multiple-gates', `Phase ${JSON.stringify(tasks[0]?.phase)} has multiple gate lines.`, gates[1]))
    if (humans.length > 1) diagnostics.push(diagnostic('multiple-human-checkpoints', `Phase ${JSON.stringify(tasks[0]?.phase)} has multiple human checkpoints.`, humans[1]))
    const closure = closures[0]
    const gate = gates[0]
    if (closure && automated.at(-1) !== closure && automated.at(-1) !== gate) diagnostics.push(diagnostic('closure-order', 'Closure must be the last automated worker line in its phase.', closure))
    if (gate && automated.at(-1) !== gate) diagnostics.push(diagnostic('gate-order', 'Gate must be the final automated line in its phase.', gate))
    if (closure && gate && automated.indexOf(gate) !== automated.indexOf(closure) + 1) diagnostics.push(diagnostic('closure-gate-adjacency', 'Closure and gate must be adjacent.', gate))
    if (humans[0] && tasks.at(-1) !== humans[0]) diagnostics.push(diagnostic('human-order', 'Human checkpoint must be the final line in its phase.', humans[0]))
  }
  return diagnostics
}

export function selectTask(parsed: ParsedChecklist, literalMatch?: string): ChecklistTask | undefined {
  return parsed.tasks.find(task => task.mark !== 'x' && (literalMatch === undefined || task.raw.includes(literalMatch)))
}

export function markTaskDone(parsed: ParsedChecklist, task: ChecklistTask): string {
  const line = parsed.lines[task.line - 1]
  if (line === undefined) throw new Error(`Checklist line ${task.line} disappeared`)
  parsed.lines[task.line - 1] = line.replace(CHECKBOX, '$1x$3$4')
  return parsed.lines.join('\n')
}

export function markTaskOpen(parsed: ParsedChecklist, task: ChecklistTask): string {
  const line = parsed.lines[task.line - 1]
  if (line === undefined) throw new Error(`Checklist line ${task.line} disappeared`)
  const mark: ChecklistMark = task.kind === 'closure' ? '?' : task.kind === 'gate' ? '~' : ' '
  parsed.lines[task.line - 1] = line.replace(CHECKBOX, `$1${mark}$3$4`)
  return parsed.lines.join('\n')
}
