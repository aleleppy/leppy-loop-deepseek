import { describe, expect, it, vi } from 'vitest'
import { assertOpaqueGateContainmentPlatform, runFileTree, runOpaqueShell, terminateProcessTreeAndWait } from '../src/process.js'

describe('opaque gate process cancellation', () => {
  it('fails closed before gate execution on platforms without proven descendant containment', () => {
    expect(() => assertOpaqueGateContainmentPlatform('darwin')).toThrow('containment is unavailable on darwin')
    expect(() => assertOpaqueGateContainmentPlatform('freebsd')).toThrow('containment is unavailable on freebsd')
    expect(() => assertOpaqueGateContainmentPlatform('win32')).not.toThrow()
    expect(() => assertOpaqueGateContainmentPlatform('linux')).not.toThrow()
  })

  it('rejects a pre-aborted signal before spawning the shell', async () => {
    const control = new AbortController()
    control.abort(new Error('gate canceled'))
    await expect(runOpaqueShell('echo should-not-run', process.cwd(), control.signal))
      .rejects.toThrow('gate canceled')
  })

  it('terminates an exact argv process tree when canceled', async () => {
    const control = new AbortController()
    const script = "require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)']);setInterval(()=>{},1000)"
    const running = runFileTree(process.execPath, ['-e', script], { cwd: process.cwd(), signal: control.signal })
    setTimeout(() => control.abort(new Error('argv canceled')), 100)
    await expect(running).rejects.toThrow('argv canceled')
  }, 10_000)

  it('terminates the shell process tree when the command is canceled', async () => {
    const control = new AbortController()
    const command = 'node -e "setInterval(() => {}, 1000)"'
    const running = runOpaqueShell(command, process.cwd(), control.signal)
    setTimeout(() => control.abort(new Error('gate canceled')), 100)
    await expect(running).rejects.toThrow('gate canceled')
  }, 10_000)

  it.runIf(process.platform === 'win32')('falls back when taskkill starts but returns nonzero', async () => {
    const fallback = vi.fn()
    await terminateProcessTreeAndWait(2_147_483_647, fallback)
    expect(fallback).toHaveBeenCalledOnce()
  })
})
