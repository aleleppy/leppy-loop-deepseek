import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { atomicWriteJson, inspectProcessIdentity, requireFoundProcessIdentity, signLease } from './state.js'
import type { LeasePayload } from './state.js'

const require = createRequire(import.meta.url)

async function main(): Promise<void> {
  const stateDir = required('LEPPY_STATE_DIR')
  const leasePath = required('LEPPY_LEASE_PATH')
  const key = Buffer.from(readFileSync(join(stateDir, 'lease.key'), 'utf8').trim(), 'base64')
  const runId = required('LEPPY_RUN_ID')
  const taskIndex = Number(required('LEPPY_TASK_INDEX'))
  const attempt = Number(required('LEPPY_ATTEMPT'))
  const packageJson = require.resolve('@deepseek-ai/dsh-sdk-jsonrpc-demo/package.json')
  const packageDir = dirname(packageJson)
  const manifest = JSON.parse(readFileSync(packageJson, 'utf8')) as { bin: Record<string, string> }
  const runtimeBin = join(packageDir, manifest.bin['dsh-jsonrpc-agent']!)
  const config = required('LEPPY_WORKER_CONFIG')
  const processStart = requireFoundProcessIdentity(
    await inspectProcessIdentity(process.pid), 'cannot authenticate worker host process identity',
  )
  const context = new Context()
  const fiber = await context.plugin(LocalSubprocessRuntime)
  const runtime = context.subprocess
  const child = runtime.spawn({
    argv: [process.execPath, runtimeBin, config],
    cwd: required('LEPPY_WORKTREE'),
    env: process.env,
    stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
    graceMs: 3_000,
  })
  const base: LeasePayload = { schemaVersion: 1, runId, taskIndex, attempt, pid: process.pid, processStart, heartbeat: new Date().toISOString() }
  const heartbeat = (): void => atomicWriteJson(leasePath, signLease({ ...base, heartbeat: new Date().toISOString() }, key))
  heartbeat()
  const timer = setInterval(heartbeat, 2_000)
  timer.unref()
  process.stdin.pipe(child.stdin!)
  child.stdout!.pipe(process.stdout)
  child.stderr!.pipe(process.stderr)
  const terminate = (): void => child.terminate()
  process.once('SIGINT', terminate)
  process.once('SIGTERM', terminate)
  process.stdin.once('end', terminate)
  try {
    const outcome = await child.done
    await child.waitForExit()
    process.exitCode = outcome.exitCode ?? 1
  } finally {
    clearInterval(timer)
    await fiber.dispose()
  }
}

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

void main().catch(error => {
  process.stderr.write(`leppy-loop-worker-host: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
