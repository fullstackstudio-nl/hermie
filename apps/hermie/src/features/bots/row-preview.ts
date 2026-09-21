/**
 * The preview line one chat-list row shows, wired to the transcript store.
 *
 * `chatRowPreview` holds the decision (see `packages/transcript/src/preview.ts`);
 * this is the subscription around it. It lives beside the row rather than in the
 * list because the row is what needs it, and the list hands every row the same
 * handler identities on purpose — threading a per-bot preview down from there
 * would cost that.
 *
 * Two selectors, each returning a PRIMITIVE. A selector that returned the derived
 * object would hand back a fresh identity on every store notification, and a chat
 * store notifies on every streamed delta: forty rows would re-render for one
 * token arriving in one of them. A string and a boolean compare by value, so a
 * row re-renders when its line actually changes and not before. The derivation
 * runs twice for that, which is a backwards walk that stops at the first message
 * — cheaper than the render it avoids.
 */
import { chatRowPreview } from '@hermie/transcript'
import { useMemo } from 'react'

import { formatChatPreview } from '../../chat-ui'
import { useChatsStore } from '../../store/chats'

export interface RowPreview {
  text: string
  /** The words are scaffolding, not speech: the row draws them more quietly. */
  system: boolean
}

export function useRowPreview(botName: string, gatewayPreview: string): RowPreview {
  const text = useChatsStore(state => formatChatPreview(chatRowPreview(state.chats[botName], gatewayPreview)))
  const system = useChatsStore(state => chatRowPreview(state.chats[botName], gatewayPreview)?.system === true)

  return useMemo(() => ({ text, system }), [text, system])
}
