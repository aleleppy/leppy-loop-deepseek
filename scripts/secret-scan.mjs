import { spawnSync } from 'node:child_process'

const scan = spawnSync('git', ['grep', '-nEI', '(sk-[A-Za-z0-9_-]{16,}|BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|gh[pousr]_[A-Za-z0-9]{20,})', '--', ':!pnpm-lock.yaml'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
if (scan.status === 0 && scan.stdout.trim() !== '') {
  process.stderr.write(scan.stdout)
  process.exitCode = 1
} else if (scan.status !== 1) {
  process.stderr.write(scan.stderr || 'secret scan failed\n')
  process.exitCode = scan.status ?? 1
}
