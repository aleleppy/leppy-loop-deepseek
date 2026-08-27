import { useEffect, useState } from 'react'
import type { CommandRowProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import './LeppyLoopTaskCard.module.css'

const ELAPSED_MARKER = /(?:^|\n)leppy-elapsed-ms=(\d+)$/u
const ATTEMPT_MARKER = /(?:^|\n)leppy-attempt=(\d+)$/u

/** Split the human task label from Host-owned attempt and elapsed metadata. */
export function parseProgressArgs(args: string | null): { label: string; elapsedMs: number; attempt?: number } {
  if (args === null) return { label: 'Running', elapsedMs: 0 }
  const elapsedMatch = ELAPSED_MARKER.exec(args)
  const elapsedMs = elapsedMatch === null ? 0 : Number.parseInt(elapsedMatch[1]!, 10)
  const withoutElapsed = args.replace(ELAPSED_MARKER, '')
  const attemptMatch = ATTEMPT_MARKER.exec(withoutElapsed)
  const label = withoutElapsed.replace(ATTEMPT_MARKER, '').trim()
  return {
    label: label === '' ? 'Running' : label,
    elapsedMs,
    ...(attemptMatch === null ? {} : { attempt: Number.parseInt(attemptMatch[1]!, 10) }),
  }
}

/** Format a compact English wall-clock duration. */
export function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return [hours > 0 ? `${hours}h` : '', minutes > 0 || hours > 0 ? `${minutes}m` : '', `${seconds}s`]
    .filter(Boolean)
    .join(' ')
}

export interface LeppyLoopTaskCardProps {
  node: CommandRowProps['node']
}

/** Specialized command row whose visible running duration never competes with the elided task label. */
export function LeppyLoopTaskCard({ node }: LeppyLoopTaskCardProps) {
  const outcome = node.outcome
  const running = outcome === null
  const [now, setNow] = useState(() => Date.now())
  const progress = parseProgressArgs(node.args)

  useEffect(() => {
    if (!running) return undefined
    setNow(Date.now())
    const timer = window.setInterval(() => { setNow(Date.now()) }, 1000)
    return () => { window.clearInterval(timer) }
  }, [running, node.time])

  const elapsedMs = progress.elapsedMs + Math.max(0, now - node.time)
  const state = outcome === null ? 'running' : outcome.kind === 'error' ? 'error' : 'ok'
  const status = state === 'running' ? 'Running' : state === 'error' ? 'Stopped' : 'Completed'
  const summary = outcome === null ? progress.label : outcome.text ?? (state === 'error' ? 'Task failed' : 'Task completed')

  return (
    <div className="leppy-loop-task-card" data-state={state} data-testid="leppy-loop-task-card">
      <div className="leppy-loop-task-card__row">
        <span className="leppy-loop-task-card__leading" data-state={state} aria-hidden>
          {state === 'ok' ? '◇' : '●'}
        </span>
        <span className="leppy-loop-task-card__title">Leppy task</span>
        <span className="leppy-loop-task-card__separator" aria-hidden />
        <span className="leppy-loop-task-card__status" data-state={state}>{status}</span>
        <span className="leppy-loop-task-card__summary" title={summary} data-error={state === 'error' || undefined}>{summary}</span>
        {progress.attempt === undefined ? null : <span className="leppy-loop-task-card__attempt">Attempt {progress.attempt}</span>}
        {running ? <span className="leppy-loop-task-card__elapsed" aria-label={`${formatElapsed(elapsedMs)} elapsed`}>{formatElapsed(elapsedMs)}</span> : null}
      </div>
    </div>
  )
}
