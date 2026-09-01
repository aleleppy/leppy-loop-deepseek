import { mkdtempSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { get } from 'node:http'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { clearTimeout, setTimeout } from 'node:timers'

const project = resolve(import.meta.dirname, '..')
const scratch = mkdtempSync(join(tmpdir(), 'leppy-install-smoke-'))
const home = join(scratch, 'dsh-home')
const require = createRequire(import.meta.url)
const dshPackage = require.resolve('@deepseek-ai/dsh/package.json')
const dshManifest = JSON.parse(readFileSync(dshPackage, 'utf8'))
const dshBin = resolve(dshPackage, '..', dshManifest.bin.dsh)
const pnpmPackage = require.resolve('pnpm')
const pnpmManifest = JSON.parse(readFileSync(pnpmPackage, 'utf8'))
const pnpmBin = resolve(pnpmPackage, '..', pnpmManifest.bin.pnpm)

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: project, env, encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? 'spawn'}):\n${result.stdout ?? ''}\n${result.stderr ?? ''}`)
  return result.stdout ?? ''
}

const WEB_START_TIMEOUT_MS = 90_000

async function bootInstalledWeb(env) {
  const child = spawn(process.execPath, [dshBin, '--profile', 'web', '--host', '127.0.0.1', '--port', '0', '--no-open'], {
    cwd: project,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  try {
    const url = await new Promise((resolveUrl, reject) => {
      const timeout = setTimeout(() => reject(new Error(`installed Web profile did not start within ${WEB_START_TIMEOUT_MS} ms:\n${stdout}\n${stderr}`)), WEB_START_TIMEOUT_MS)
      const inspect = () => {
        const match = /dsh web: (http:\/\/127\.0\.0\.1:\d+)/u.exec(stdout)
        if (!match?.[1]) return
        clearTimeout(timeout)
        resolveUrl(match[1])
      }
      child.stdout.on('data', chunk => { stdout += String(chunk); inspect() })
      child.stderr.on('data', chunk => { stderr += String(chunk) })
      child.once('error', error => { clearTimeout(timeout); reject(error) })
      child.once('exit', code => {
        clearTimeout(timeout)
        reject(new Error(`installed Web profile exited before listening (${code ?? 'signal'}):\n${stdout}\n${stderr}`))
      })
    })
    const status = await new Promise((resolveStatus, reject) => {
      const request = get(url, response => {
        response.resume()
        resolveStatus(response.statusCode ?? 0)
      })
      request.once('error', reject)
    })
    if (status < 200 || status >= 400) throw new Error(`installed Web profile returned HTTP ${status}`)
    const client = await new Promise((resolveClient, reject) => {
      const request = get(`${url}/plugins/leppy-loop-deepseek/client.js`, response => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', chunk => { body += chunk })
        response.on('end', () => { resolveClient({ status: response.statusCode ?? 0, body }) })
      })
      request.once('error', reject)
    })
    if (client.status !== 200 || !client.body.includes('leppy-loop-deepseek')) {
      throw new Error(`installed Web profile did not serve the Leppy client bundle (HTTP ${client.status})`)
    }
  } finally {
    child.kill('SIGTERM')
  }
}

const requestedSpec = process.env.LEPPY_INSTALL_SPEC
if (requestedSpec && process.env.LEPPY_ALLOW_EXTERNAL_INSTALL_SMOKE !== '1') {
  throw new Error('LEPPY_INSTALL_SPEC requires explicit LEPPY_ALLOW_EXTERNAL_INSTALL_SMOKE=1 and cannot silently bypass the local release smoke')
}
let installSpec = requestedSpec
let installedLabel = requestedSpec
if (!installSpec) {
  run(process.execPath, [pnpmBin, 'pack', '--pack-destination', scratch])
  const tarballs = readdirSync(scratch).filter(name => name.endsWith('.tgz'))
  if (tarballs.length !== 1) throw new Error(`expected one tarball, found ${tarballs.length}`)
  installSpec = join(scratch, tarballs[0])
  installedLabel = tarballs[0]
}
const env = { ...process.env, DSH_HOME: home }
run(process.execPath, [dshBin, 'plugin', '--profile', 'web', 'add', installSpec], env)
const composition = run(process.execPath, [dshBin, '--profile', 'web', '--dump-config'], env)
if (!composition.includes('leppy-loop-deepseek') || !composition.includes('leppy-loop-command')) {
  throw new Error('installed Web profile did not compose the Leppy Loop command producer')
}
const installedRoot = realpathSync(join(home, 'profiles', 'web', 'node_modules', 'leppy-loop-deepseek'))
const wslRuntime = await import(pathToFileURL(join(installedRoot, 'dist', 'wsl-validation.js')).href)
if (typeof wslRuntime.executePlaywrightInWsl !== 'function') throw new Error('installed WSL validation runtime did not load')
const workerTools = await import(pathToFileURL(join(installedRoot, 'dist', 'worker-tool.js')).href)
if (typeof workerTools.apply !== 'function') throw new Error('installed worker tool runtime did not load')
run(process.execPath, ['--check', join(installedRoot, 'dist', 'worker-host.js')], env)
const workerComposition = readFileSync(join(installedRoot, 'worker.cordis.yml'), 'utf8')
if (!workerComposition.includes('./dist/worker-tool.js')) throw new Error('installed worker composition does not reference the shipped worker tool')
await bootInstalledWeb(env)
process.stdout.write(`clean Web-profile install and boot smoke passed: ${installedLabel}\n`)
