// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CommandRowProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { formatElapsed, LeppyLoopTaskCard, parseProgressArgs } from '../src/client/LeppyLoopTaskCard.js'

const LONG_LABEL = `[4/24] ${'Implement storage without truncating the visible timer '.repeat(8)}`

function command(outcome: CommandRowProps['node']['outcome'] = null): CommandRowProps['node'] {
  return {
    kind: 'command', seq: 1, time: 9_000,
    commandId: 'leppy-progress-run-2-3' as CommandRowProps['node']['commandId'],
    name: 'leppy-loop-task',
    args: ` ${LONG_LABEL}\nleppy-attempt=15\nleppy-elapsed-ms=0`,
    outcome,
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

describe('LeppyLoopTaskCard', () => {
  it('keeps Running, attempt and timer in separate always-visible elements beside an elided long label', () => {
    const view = render(<LeppyLoopTaskCard node={command()} />)
    expect(screen.getByText('Running')).toBeTruthy()
    expect(screen.getByText('Attempt 15')).toBeTruthy()
    expect(screen.getByLabelText('1s elapsed').textContent).toBe('1s')
    expect(screen.getByTitle(LONG_LABEL.trim()).className).toContain('leppy-loop-task-card__summary')
    expect(vi.getTimerCount()).toBe(1)

    act(() => { vi.advanceTimersByTime(2_000) })
    expect(screen.getByLabelText('3s elapsed').textContent).toBe('3s')

    view.rerender(<LeppyLoopTaskCard node={command({ kind: 'success', text: 'Task completed — 4/24 — 3s elapsed.' })} />)
    expect(screen.getByText('Completed')).toBeTruthy()
    expect(screen.getByText('Task completed — 4/24 — 3s elapsed.')).toBeTruthy()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('parses durable metadata and clamps compact durations', () => {
    expect(parseProgressArgs(' Task\nleppy-attempt=4\nleppy-elapsed-ms=346000')).toEqual({ label: 'Task', elapsedMs: 346_000, attempt: 4 })
    expect(parseProgressArgs(null)).toEqual({ label: 'Running', elapsedMs: 0 })
    expect(formatElapsed(-1)).toBe('0s')
    expect(formatElapsed(3_661_000)).toBe('1h 1m 1s')
  })
})
