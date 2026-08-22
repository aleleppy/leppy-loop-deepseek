import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const project = resolve(import.meta.dirname, '..')
const scratch = mkdtempSync(join(tmpdir(), 'leppy-install-smoke-'))
const home = join(scratch, 'dsh-home')
const require = createRequire(import.meta.url)
const dshPackage = require.resolve('@deepseek-ai/dsh/package.json')
const dshManifest = JSON.parse(readFileSync(dshPackage, 'utf8'))
const dshBin = resolve(dshPackage, '..', dshManifest.bin.dsh)

function windowsQuote(value) {
  if (/^[A-Za-z0-9_@:.\\/=-]+$/.test(value)) return value
  return `"${value.replaceAll('"', '""').replaceAll('%', '%%')}"`
}

function run(command, args, env = process.env) {
  const result = process.platform === 'win32' && command !== process.execPath
    ? spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', [command, ...args.map(windowsQuote)].join(' ')], { cwd: project, env, encoding: 'utf8', windowsHide: true })
    : spawnSync(command, args, { cwd: project, env, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? 'spawn'}):\n${result.stdout ?? ''}\n${result.stderr ?? ''}`)
  return result.stdout ?? ''
}

const requestedSpec = process.env.LEPPY_INSTALL_SPEC
let installSpec = requestedSpec
let installedLabel = requestedSpec
if (!installSpec) {
  run('npm', ['pack', '--silent', '--pack-destination', scratch])
  const tarballs = readdirSync(scratch).filter(name => name.endsWith('.tgz'))
  if (tarballs.length !== 1) throw new Error(`expected one tarball, found ${tarballs.length}`)
  installSpec = join(scratch, tarballs[0])
  installedLabel = tarballs[0]
}
const env = { ...process.env, DSH_HOME: home }
run(process.execPath, [dshBin, 'plugin', '--profile', 'leppy-loop', 'add', installSpec], env)
const help = run(process.execPath, [dshBin, '--profile', 'leppy-loop', '--help'], env)
if (!help.includes('--tasks') || !help.includes('--sync-branch')) throw new Error('installed profile did not expose Leppy Loop help')
process.stdout.write(`clean install smoke passed: ${installedLabel}\n`)
