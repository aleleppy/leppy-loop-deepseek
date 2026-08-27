/** Browser plugin for live Leppy Loop task and controller cards. */

import { createElement } from 'react'
import type { ClientContext, ISessions, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { LeppyLoopControllerCard } from './LeppyLoopControllerCard.js'
import { LeppyLoopTaskCard } from './LeppyLoopTaskCard.js'

/** Conversation owns both the keyed task row and additive session-header action. */
export const inject = ['sessions', 'slots']

/** Register task progress plus a background controller card with direct stop intent. */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('conversation.chat.commandview', () => ctx.slots.register({
    name: 'conversation.chat.commandview',
    key: 'leppy-loop-task',
  }, LeppyLoopTaskCard))
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: 'leppy-loop-controller',
    order: 19,
  }, props => createElement(LeppyLoopControllerCard, {
    ...props,
    onStop: async (sessionId: SessionId) => {
      const session = (ctx.sessions as unknown as ISessions).binding(sessionId)?.session
      if (!session) throw new Error('Leppy controller session is unavailable')
      const result = await session.command('/leppy-loop parar')
      if (!result.ok) throw new Error(result.error.message)
      if (!result.value.matched) throw new Error('Leppy stop command is unavailable in this session')
    },
  })))
}
