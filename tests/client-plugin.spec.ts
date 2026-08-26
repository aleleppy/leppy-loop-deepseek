import { describe, expect, it } from 'vitest'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { apply, inject } from '../src/client/index.js'
import { LeppyLoopTaskCard } from '../src/client/LeppyLoopTaskCard.js'

describe('Leppy browser plugin', () => {
  it('registers the keyed command row owned by ui-conversation', () => {
    let registration: { name: string; key: string; component: unknown } | undefined
    const ctx = {
      slots: {
        inject: (name: string, setup: () => unknown) => {
          expect(name).toBe('conversation.chat.commandview')
          setup()
        },
        register: (entry: { name: string; key: string }, component: unknown) => {
          registration = { ...entry, component }
          return () => {}
        },
      },
    } as unknown as ClientContext

    apply(ctx)

    expect(inject).toEqual(['slots'])
    expect(registration).toEqual({
      name: 'conversation.chat.commandview',
      key: 'leppy-loop-task',
      component: LeppyLoopTaskCard,
    })
  })
})
