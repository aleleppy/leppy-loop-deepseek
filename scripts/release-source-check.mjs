import { spawnSync } from 'node:child_process'

const result = spawnSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
  cwd: new URL('..', import.meta.url),
  encoding: 'utf8',
  windowsHide: true,
})
if (result.status !== 0) {
  throw new Error(`cannot authenticate release source (${result.status ?? 'spawn'}):\n${result.stderr ?? ''}`)
}
if (result.stdout.trim()) {
  throw new Error(`release source must be committed and clean before gate:\n${result.stdout}`)
}
process.stdout.write('release source is committed and clean\n')
