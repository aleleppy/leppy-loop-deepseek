import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { normalizeExecCommand, windowsQuotedExecutableFailure } from '../src/windows-command.js'

describe('Windows structured argv compatibility', () => {
  it('removes redundant shell quotes and selects an existing npm .cmd shim', () => {
    const root = mkdtempSync(join(tmpdir(), 'leppy-windows-argv-'))
    mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true })
    writeFileSync(join(root, 'node_modules', '.bin', 'tsc.cmd'), '@echo off\r\n')
    expect(normalizeExecCommand("'node_modules/.bin/tsc'", root, 'win32')).toBe('node_modules/.bin/tsc.cmd')
    expect(normalizeExecCommand('".\\node_modules\\.bin\\tsc"', root, 'win32')).toBe('.\\node_modules\\.bin\\tsc.cmd')
    expect(normalizeExecCommand("'node_modules/.bin/tsc'", root, 'linux')).toBe('node_modules/.bin/tsc')
  })

  it('rejects command strings that still contain shell syntax', () => {
    const root = mkdtempSync(join(tmpdir(), 'leppy-windows-argv-'))
    expect(() => normalizeExecCommand("'node_modules/.bin/tsc' --noEmit", root, 'win32')).toThrow('shell quote characters')
    expect(() => normalizeExecCommand('"node_modules/.bin/tsc --noEmit"', root, 'win32')).toThrow('must not contain whitespace')
    expect(() => normalizeExecCommand("'node modules/.bin/tsc'", root, 'win32')).toThrow('must not contain whitespace')
    expect(() => normalizeExecCommand('node_modules/.bin/tsc\t--noEmit', root, 'win32')).toThrow('must not contain whitespace')
    expect(() => normalizeExecCommand('node_modules/.bin/tsc\n--noEmit', root, 'win32')).toThrow('must not contain whitespace')
    expect(() => normalizeExecCommand(' node_modules/.bin/tsc ', root, 'win32')).toThrow('surrounding whitespace')
  })

  it('recognizes localized cmd.exe node_modules failures without matching unrelated errors', () => {
    expect(windowsQuotedExecutableFailure("'node_modules' não é reconhecido como um comando interno ou externo, um programa operável ou um arquivo em lotes.")).toBe(true)
    expect(windowsQuotedExecutableFailure("'node_modules' is not recognized as an internal or external command, operable program or batch file.")).toBe(true)
    expect(windowsQuotedExecutableFailure("'git' is not recognized as an internal or external command")).toBe(false)
  })
})
