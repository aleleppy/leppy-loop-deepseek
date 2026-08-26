// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import { describe, expect, it } from 'vitest'

interface ClientBundleRow {
  id: string
  factory: (require: (id: string) => unknown) => { apply?: unknown; inject?: unknown }
}

describe('built client bundle', () => {
  it('registers with the DSH module loader and requests only baseline modules', () => {
    let row: ClientBundleRow | undefined
    const browser = { __ModuleLoader__: { load: (candidate: ClientBundleRow) => { row = candidate } } }
    const source = readFileSync(join(process.cwd(), 'dist', 'client.js'), 'utf8')
    Function('window', source)(browser)

    expect(row?.id).toBe('leppy-loop-deepseek')
    const requested: string[] = []
    const plugin = row!.factory(id => {
      requested.push(id)
      if (id === 'react') return React
      if (id === 'react/jsx-runtime') return jsxRuntime
      throw new Error(`unexpected client external ${id}`)
    })
    expect(requested).toEqual(['react', 'react/jsx-runtime'])
    expect(plugin.inject).toEqual(['slots'])
    expect(plugin.apply).toEqual(expect.any(Function))
  })
})
