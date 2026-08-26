/** Browser plugin for live Leppy Loop command progress cards. */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { LeppyLoopTaskCard } from './LeppyLoopTaskCard.js'

/** The conversation package owns the keyed command-row slot. */
export const inject = ['slots']

/** Register the Leppy-specific command row for this client fiber's lifetime. */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('conversation.chat.commandview', () => ctx.slots.register({
    name: 'conversation.chat.commandview',
    key: 'leppy-loop-task',
  }, LeppyLoopTaskCard))
}
