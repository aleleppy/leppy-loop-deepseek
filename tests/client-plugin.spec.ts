import { describe, expect, it } from 'vitest'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { apply, inject } from '../src/client/index.js'
import { LeppyLoopTaskCard } from '../src/client/LeppyLoopTaskCard.js'

describe('Leppy browser plugin', () => {
  it('registers the keyed task row and dedicated background controller action', () => {
    const registrations: Array<{ name: string; key?: string; id?: string; order?: number; component: unknown }> = []
    const ctx = {
      sessions: {},
      slots: {
        inject: (_name: string, setup: () => unknown) => { setup() },
        register: (entry: { name: string; key?: string; id?: string; order?: number }, component: unknown) => {
          registrations.push({ ...entry, component })
          return () => {}
        },
      },
    } as unknown as ClientContext

    apply(ctx)

    expect(inject).toEqual(['sessions', 'slots'])
    expect(registrations[0]).toEqual({
      name: 'conversation.chat.commandview', key: 'leppy-loop-task', component: LeppyLoopTaskCard,
    })
    expect(registrations[1]).toMatchObject({
      name: 'conversation.session.header.actions', id: 'leppy-loop-controller', order: 19,
    })
    expect(registrations[1]?.component).toEqual(expect.any(Function))
  })
})
