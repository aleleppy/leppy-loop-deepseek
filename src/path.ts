import { realpathSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

export function physicalRelative(root: string, candidate: string): string | undefined {
  const canonicalRoot = realpathSync(root)
  let current = realpathSync(candidate)
  const rootIdentity = statSync(canonicalRoot, { bigint: true })
  const parts: string[] = []
  while (true) {
    const identity = statSync(current, { bigint: true })
    if (identity.dev === rootIdentity.dev && identity.ino === rootIdentity.ino) return parts.length === 0 ? '' : join(...parts.reverse())
    const parent = dirname(current)
    if (parent === current) return undefined
    parts.push(basename(current))
    current = parent
  }
}
