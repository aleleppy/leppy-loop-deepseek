// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CommandRowProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import {
  formatElapsed, LeppyLoopTaskCard, parseProgressArgs,
} from '../src/client/LeppyLoopTaskCard.js'

function command(outcome: CommandRowProps['node']['outcome'] = null): CommandRowProps['node'] {
  return {
    kind: 'command',
    seq: 1,
    time: 9_000,
    commandId: 'leppy-progress-run-2-3' as CommandRowProps['node']['commandId'],
    name: 'leppy-loop-task',
    args: ' [4/24] Implement storage\nleppy-elapsed-ms=0',
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
  it('ticks task elapsed time locally and stops after settlement', () => {
    const view = render(<LeppyLoopTaskCard node={command()} />)
    expect(screen.getByText('[4/24] Implement storage — 1s elapsed…')).toBeTruthy()
    expect(vi.getTimerCount()).toBe(1)

    act(() => { vi.advanceTimersByTime(2_000) })
    expect(screen.getByText('[4/24] Implement storage — 3s elapsed…')).toBeTruthy()

    view.rerender(<LeppyLoopTaskCard node={command({ kind: 'success', text: 'Task completed — 4/24 — 3s elapsed.' })} />)
    expect(screen.getByText('Task completed — 4/24 — 3s elapsed.')).toBeTruthy()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('parses the durable baseline and clamps compact durations', () => {
    expect(parseProgressArgs(' Task\nleppy-elapsed-ms=346000')).toEqual({ label: 'Task', elapsedMs: 346_000 })
    expect(parseProgressArgs(null)).toEqual({ label: 'Running', elapsedMs: 0 })
    expect(formatElapsed(-1)).toBe('0s')
    expect(formatElapsed(3_661_000)).toBe('1h 1m 1s')
  })
})
