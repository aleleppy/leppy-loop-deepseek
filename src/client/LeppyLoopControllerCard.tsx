import { useEffect, useMemo, useState } from 'react'
import type { JobView, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import './LeppyLoopControllerCard.module.css'

export interface LeppyLoopControllerCardProps extends PropsRuntime<'conversation.session.header.actions'> {
  onStop: (sessionId: SessionId) => Promise<void>
}

function live(job: JobView): boolean {
  return job.status === 'running' || job.status === 'stopping'
}

function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(seconds / 60)
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`
}

/** Dedicated background-controller card with status, timer and direct human cancellation. */
export function LeppyLoopControllerCard({ sessionId, useSessions, onStop }: LeppyLoopControllerCardProps) {
  const jobs = useSessions(state => state.jobsBySession[sessionId]) ?? []
  const controllers = useMemo(() => jobs.filter(job => job.kind === 'leppy-loop'), [jobs])
  const controller = [...controllers].sort((left, right) => right.startedAt - left.startedAt)[0]
  const [now, setNow] = useState(() => Date.now())
  const [stopping, setStopping] = useState(false)

  useEffect(() => {
    if (!controller || !live(controller)) return undefined
    setNow(Date.now())
    const timer = window.setInterval(() => { setNow(Date.now()) }, 1000)
    return () => { window.clearInterval(timer) }
  }, [controller?.id, controller?.status])

  useEffect(() => {
    if (controller?.status !== 'stopping') setStopping(false)
  }, [controller?.status])

  if (!controller) return null
  const isLive = live(controller)
  const elapsed = (isLive ? now : controller.finishedAt ?? controller.startedAt) - controller.startedAt
  const status = stopping || controller.status === 'stopping'
    ? 'Stopping'
    : controller.status === 'running' ? 'Running'
      : controller.status === 'completed' ? 'Completed'
        : controller.status === 'killed' ? 'Stopped' : 'Failed'

  return (
    <div className="leppy-controller-card" data-state={controller.status} data-testid="leppy-controller-card">
      <span className="leppy-controller-card__dot" aria-hidden />
      <span className="leppy-controller-card__kind">Leppy controller</span>
      <span className="leppy-controller-card__label" title={controller.label}>{controller.label}</span>
      <span className="leppy-controller-card__status">{status}</span>
      <span className="leppy-controller-card__elapsed">{duration(elapsed)}</span>
      {isLive ? (
        <button
          type="button"
          className="leppy-controller-card__stop"
          disabled={stopping || controller.status === 'stopping'}
          onClick={() => {
            setStopping(true)
            void onStop(sessionId).catch(() => { setStopping(false) })
          }}
        >
          Stop
        </button>
      ) : null}
    </div>
  )
}
