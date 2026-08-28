export const RUN_EVENT_TYPES = [
  'run-start', 'start', 'done', 'recovery-start', 'recovery-done',
  'gate-start', 'gate-end', 'publish-start', 'publish-done',
  'stall', 'timeout', 'gate-failed', 'run-end',
] as const

export type RunEventType = typeof RUN_EVENT_TYPES[number]
export type Phase = 'setup' | 'worker' | 'closure' | 'gate' | 'human' | 'recovery' | 'publish' | 'complete'
export type TaskKind = 'task' | 'closure' | 'gate' | 'human'
export type ChecklistMark = ' ' | 'x' | '?' | '~'
export type WorkerPolicy = 'adaptive' | 'selected' | 'terra-high' | 'sol-low'
export type WorkerMode = 'task' | 'publication-conflict'

export interface TaskMetadata {
  done?: string
  paths: string[]
  model?: string
  effort?: string
  gate?: string
}

export interface ChecklistTask {
  index: number
  line: number
  phase: string
  mark: ChecklistMark
  kind: TaskKind
  text: string
  raw: string
  metadata: TaskMetadata
}

export interface ParsedChecklist {
  path: string
  source: string
  lines: string[]
  tasks: ChecklistTask[]
}

export interface LintDiagnostic {
  severity: 'error' | 'warning'
  code: string
  message: string
  line?: number
}

export interface ModelCapability {
  id: string
  reasoningEfforts?: readonly string[]
}

export interface ChecklistLintOptions {
  repoRoot?: string
  controllerPath?: string
  models?: readonly ModelCapability[]
  provider?: string
  defaultModel?: string
  defaultEffort?: string
  phaseGateCommand?: string
}

export interface LeppyLoopOptions {
  tasks: string
  syncBranch: string
  phaseGateCommand?: string
  dryRun?: boolean
  maxIterations?: number
  taskMatch?: string
  recoverExistingWip?: boolean
  recoverRunId?: string
  retryGate?: boolean
  repairGate?: boolean
  repairPaths?: string[]
  repairCycles?: number
  publicationRepairCycles?: number
  syncMaxSeconds?: number
  workerTimeoutMs?: number
  workerOutputLimitBytes?: number
  workerTranscriptLimitBytes?: number
  artifactsDir?: string
  provider?: string
  model?: string
  effort?: string
  workerPolicy?: WorkerPolicy
  fallbackModel?: string
  fetch?: boolean
  openPullRequest?: boolean
  publicationTarget?: string
  repoRoot?: string
}

export interface RunEvent<T = Record<string, unknown>> {
  schemaVersion: 1
  type: RunEventType
  runId: string
  timestamp: string
  phase: Phase
  taskIndex?: number
  attempt?: number
  data: T
}

export interface RunPreview {
  selectedLine: string | null
  model: { provider: string; model: string; effort?: string }
  paths: string[]
  branch: string
  worktree: string
  gate: string | null
  diagnostics: LintDiagnostic[]
}

export interface RunResult {
  runId: string
  status: 'completed' | 'dry-run' | 'stalled' | 'failed' | 'interrupted'
  branch?: string
  worktree?: string
  stateDir?: string
  completedTasks: number
  currentTask?: number
  diagnostics: LintDiagnostic[]
  pullRequestUrl?: string
  detail?: string
  preview?: RunPreview
}

export interface WorkerRequest {
  runId: string
  task: ChecklistTask
  attempt: number
  worktree: string
  checklistPath: string
  allowedPaths: string[]
  mode?: WorkerMode
  model: string
  effort?: string
  provider: string
  timeoutMs: number
  outputLimitBytes: number
  transcriptLimitBytes: number
  stateDir: string
  gateFingerprint?: string
  instructions: string[]
}

export interface WorkerOutcome {
  status: 'completed' | 'timeout' | 'output-limit' | 'transcript-limit' | 'unavailable' | 'failed' | 'interrupted'
  output: string
  transcriptPath?: string
  error?: string
}

export interface WorkerAdapter {
  run(request: WorkerRequest, signal: AbortSignal): Promise<WorkerOutcome>
}

export interface RunProgress {
  type: 'task-start' | 'task-done' | 'task-failed'
  runId: string
  taskIndex: number
  /** Global durable attempt identity used by controller records and recovery. */
  attempt: number
  /** Human-facing ordinal for this exact checklist row identity. */
  taskAttempt: number
  kind: TaskKind
  phase: string
  text: string
  completedTasks: number
  totalTasks: number
  elapsedMs: number
  error?: string
}

export interface PublicationConflict {
  paths: string[]
  detail: string
}

export interface PublicationValidation {
  receipt: string
  validatedHead: string
}

export interface PublicationHooks {
  repairConflict: (conflict: PublicationConflict) => Promise<void>
  validateBeforePush: (targetCommit: string) => Promise<PublicationValidation>
  recordRemoteHead?: (head: string | undefined) => Promise<void>
}

export interface PublishedPullRequest {
  url: string
  validationReceipt: string
  reconciledExisting?: boolean
}

export interface PullRequestRequest {
  runId: string
  repoRoot: string
  worktree: string
  branch: string
  syncBranch: string
  originalSyncBranch?: string
  priorTargetCommit?: string
  priorRemoteHead?: string
}

export interface RunDependencies {
  worker?: WorkerAdapter
  now?: () => Date
  runId?: () => string
  modelCatalog?: (provider: string) => Promise<ModelCapability[]>
  defaultModel?: () => Promise<{ provider: string; model: string; effort?: string }>
  publishPullRequest?: (request: PullRequestRequest, signal: AbortSignal, hooks: PublicationHooks) => Promise<PublishedPullRequest>
  onProgress?: (progress: RunProgress) => void | Promise<void>
  signal?: AbortSignal
}
