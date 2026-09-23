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
import { chatRowPreview, type ChatPreviewOptions } from '@hermie/transcript'
import { useMemo } from 'react'

import { fallbackSenderName, formatChatPreview } from '../../chat-ui'
import { useChatsStore } from '../../store/chats'
import { useDeviceContextStore } from '../../store/device-context'

export interface RowPreview {
  text: string
  /** The words are scaffolding, not speech: the row draws them more quietly. */
  system: boolean
}

/**
 * This hook is only ever asked for the row a BOT owns — `state.chats[botName]`,
 * keyed by the bare bot name, which is the canonical GROUP chat's state; a
 * personal sub-chat lives under `bot#<storedId>` and its list row reads the
 * gateway's own `preview` string directly (`ConversationListView.tsx`), never
 * this hook. So `groupChat: true` is simply what is true of every call here —
 * not a guess — and it is still spelled out as an explicit option rather than
 * assumed, exactly like `TranscriptContext.groupChat` (HERM-83, D6, gate 1).
 */
const GROUP_CHAT_OPTIONS = { groupChat: true } as const

export function useRowPreview(botName: string, gatewayPreview: string): RowPreview {
  // The reader's own identity — D3's own/foreign gate — the same source
  // `ChatScreen` reads for the transcript itself.
  const ownAuthorId = useDeviceContextStore(state => state.userId) || undefined
  const options: ChatPreviewOptions = {
    ...GROUP_CHAT_OPTIONS,
    ownAuthorId,
    // D4's rungs 2 and 3 — the same resolver a bubble falls back to when the
    // host has nothing beyond the row itself (HERM-83 Task 4 is not built).
    resolveSenderName: fallbackSenderName
  }

  const text = useChatsStore(state => formatChatPreview(chatRowPreview(state.chats[botName], gatewayPreview, options)))
  const system = useChatsStore(state => chatRowPreview(state.chats[botName], gatewayPreview, options)?.system === true)

  return useMemo(() => ({ text, system }), [text, system])
}
