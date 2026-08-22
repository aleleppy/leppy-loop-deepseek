import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const project = resolve(import.meta.dirname, '..')
const scratch = mkdtempSync(join(tmpdir(), 'leppy-install-smoke-'))
const home = join(scratch, 'dsh-home')

function windowsQuote(value) {
  if (/^[A-Za-z0-9_@:.\\/=-]+$/.test(value)) return value
  return `"${value.replaceAll('"', '""').replaceAll('%', '%%')}"`
}

function run(command, args, env = process.env) {
  const result = process.platform === 'win32'
    ? spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', [command, ...args.map(windowsQuote)].join(' ')], { cwd: project, env, encoding: 'utf8', windowsHide: true })
    : spawnSync(command, args, { cwd: project, env, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? 'spawn'}):\n${result.stdout ?? ''}\n${result.stderr ?? ''}`)
  return result.stdout ?? ''
}

run('npm', ['pack', '--silent', '--pack-destination', scratch])
const tarballs = readdirSync(scratch).filter(name => name.endsWith('.tgz'))
if (tarballs.length !== 1) throw new Error(`expected one tarball, found ${tarballs.length}`)
const tarball = join(scratch, tarballs[0])
const env = { ...process.env, DSH_HOME: home }
run('npx', ['--yes', '@deepseek-ai/dsh@0.1.1-rc.2', 'plugin', '--profile', 'leppy-loop', 'add', tarball], env)
const help = run('npx', ['--yes', '@deepseek-ai/dsh@0.1.1-rc.2', '--profile', 'leppy-loop', '--help'], env)
if (!help.includes('--tasks') || !help.includes('--sync-branch')) throw new Error('installed profile did not expose Leppy Loop help')
process.stdout.write(`clean install smoke passed: ${tarballs[0]}\n`)
