import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

/** Recognize the localized cmd.exe diagnostic produced when a node_modules path is parsed as a shell token. */
export function windowsQuotedExecutableFailure(detail?: string): boolean {
  if (!detail || !/["']node_modules["']/iu.test(detail)) return false
  const normalized = detail.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
  return normalized.includes('nao e reconhecido como um comando interno ou externo')
    || (normalized.includes('is not recognized') && normalized.includes('internal or external command'))
}

/**
 * Structured argv must not carry shell quotes. On Windows, npm's extensionless .bin shim is a POSIX script;
 * select the sibling .cmd shim when it exists so subprocess execution never falls through cmd.exe parsing.
 */
export function normalizeExecCommand(command: string, cwd: string, platform: NodeJS.Platform = process.platform): string {
  if (command !== command.trim()) throw new Error('structured argv command must not have surrounding whitespace')
  let executable = command
  const quote = executable[0]
  if (executable.length >= 2 && (quote === '"' || quote === "'") && executable.at(-1) === quote) executable = executable.slice(1, -1)
  if (executable.includes('"') || executable.includes("'")) throw new Error('structured argv command must not contain shell quote characters')
  if (/\s/u.test(executable)) throw new Error('structured argv command must not contain whitespace; pass every flag in args')
  if (!executable) throw new Error('structured argv command must not be empty')
  if (platform === 'win32' && /^(?:\.?[\\/])?node_modules[\\/]\.bin[\\/]/iu.test(executable) && !/\.cmd$/iu.test(executable)) {
    if (existsSync(`${resolve(cwd, executable)}.cmd`)) return `${executable}.cmd`
  }
  return executable
}
