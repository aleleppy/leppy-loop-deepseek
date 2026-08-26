import { describe, expect, it } from 'vitest'
import { runOpaqueShell } from '../src/process.js'

describe('opaque gate process cancellation', () => {
  it('rejects a pre-aborted signal before spawning the shell', async () => {
    const control = new AbortController()
    control.abort(new Error('gate canceled'))
    await expect(runOpaqueShell('echo should-not-run', process.cwd(), control.signal))
      .rejects.toThrow('gate canceled')
  })

  it('terminates the shell process tree when the command is canceled', async () => {
    const control = new AbortController()
    const command = 'node -e "setInterval(() => {}, 1000)"'
    const running = runOpaqueShell(command, process.cwd(), control.signal)
    setTimeout(() => control.abort(new Error('gate canceled')), 100)
    await expect(running).rejects.toThrow('gate canceled')
  }, 10_000)
})
