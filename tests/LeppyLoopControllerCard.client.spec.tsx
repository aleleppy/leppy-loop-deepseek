// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JobView, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { LeppyLoopControllerCard } from '../src/client/LeppyLoopControllerCard.js'

const sessionId = 'session-a' as SessionId

function job(overrides: Partial<JobView> = {}): JobView {
  return {
    id: 'leppy-loop-1' as JobView['id'], kind: 'leppy-loop',
    label: `Controller 44c85fb806c6 — ${'very-long-controller-label/'.repeat(12)}`,
    status: 'running', startedAt: 9_000, ...overrides,
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(10_000)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('LeppyLoopControllerCard', () => {
  it('shows background status and timer and exposes direct stop without touching the composer', async () => {
    const stop = vi.fn(async () => {})
    const jobs = [job()]
    const useSessions = (<T,>(selector: (state: { jobsBySession: Record<string, JobView[]> }) => T): T => selector({ jobsBySession: { [sessionId]: jobs } }))
    render(<LeppyLoopControllerCard
      sessionId={sessionId}
      useSessions={useSessions as never}
      useSession={vi.fn() as never}
      useProjection={vi.fn() as never}
      useWorkspaces={vi.fn() as never}
      useInput={vi.fn() as never}
      inputActions={{} as never}
      onStop={stop}
    />)
    expect(screen.getByText('Running')).toBeTruthy()
    expect(screen.getByText('1s')).toBeTruthy()
    expect(screen.getByTitle(jobs[0]!.label).className).toContain('leppy-controller-card__label')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Stop' })) })
    expect(stop).toHaveBeenCalledWith(sessionId)
    expect(screen.getByText('Stopping')).toBeTruthy()
  })
})
