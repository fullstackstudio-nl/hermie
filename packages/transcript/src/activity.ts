/**
 * The cross-bot activity timeline.
 *
 * Activity is a VIEW, never a second copy of the truth. Every row here is
 * derived from the `ChatState`s the chat store already holds, which is why the
 * screen can show traffic between two bots the user has never opened: the
 * controller loads their tails into the same store, and this reads them back.
 *
 * Three item kinds carry bot-to-bot traffic, and one of them is written twice
 * on the wire:
 *
 *  - `bot_dm_out` lives in the SENDER's chat (`researcher → writer: …`), and
 *    carries the teammate's answer once the delivery process reports back.
 *  - `bot_dm_in` lives in the RECIPIENT's chat and is the SAME message seen
 *    from the other side. Emitting both would double every conversation, so an
 *    inbound row that matches a dispatch we already have is dropped and the
 *    dispatch keeps the floor — it is the row that knows the delivery status.
 *  - `subagent_group` is a `delegate_task` fan-out: `researcher spawned 3
 *    agents · running`.
 */
import type { BotDmInItem, BotDmOutItem, ChatState, SubagentGroupItem, TranscriptItem } from './types'
import { normalizeAgentTarget } from './bot-dm'

export type ActivityKind = 'dm_out' | 'dm_reply' | 'dm_in' | 'delegation'

export interface ActivityEntry {
  /** Unique across bots: one chat's item id is only unique within that chat. */
  id: string
  /** The chat this row was derived from — tapping opens it. */
  botName: string
  /** The item to scroll to once that chat is open. */
  itemId: string
  kind: ActivityKind
  /** Unix seconds. Rows without a stamp inherit the newest one before them. */
  at: number
  /** Routing handle of whoever spoke. */
  fromHandle: string
  /** Routing handle of whoever was addressed; absent for a delegation. */
  toHandle?: string
  /** The message, the reply, or the delegation's goals joined. */
  text: string
  /** `Queued`, `Delivered`, `done`, `running` — whatever the row can prove. */
  status?: string
  /** True while the traffic this row describes has not landed yet. */
  pending?: boolean
  /** True when the row describes something that failed. */
  failed?: boolean
  /** `subagent_group` only: how many children the fan-out spawned. */
  agentCount?: number
}

/**
 * How far apart two views of the same delivery may be stamped and still be
 * recognised as one. The sender stamps the dispatch when the tool ran; the
 * recipient stamps the inbound row when its turn started, which is later by
 * however long the delivery process queued.
 */
export const DM_MATCH_WINDOW_SECONDS = 900

/** First line, whitespace collapsed — the timeline shows one line per row. */
function firstLine(text: string, max = 140): string {
  const line = text.replace(/\s+/gu, ' ').trim()

  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** The shape a dedupe compares on: who, to whom, and the opening of the text. */
function deliveryKey(from: string, to: string, text: string): string {
  return `${from}>${to}>${firstLine(text, 64).toLowerCase()}`
}

function dispatchStatusLabel(item: BotDmOutItem): { status: string; pending: boolean; failed: boolean } {
  if (item.reply?.error) {
    return { status: 'Failed', pending: false, failed: true }
  }

  if (item.reply) {
    return { status: 'Replied', pending: false, failed: false }
  }

  switch (item.dispatch.status) {
    case 'failed':
      return { status: 'Failed', pending: false, failed: true }
    case 'ambiguous':
      return { status: 'Ambiguous target', pending: false, failed: true }
    case 'sending':
      return { status: 'Sending', pending: true, failed: false }
    case 'queued':
      return { status: 'Queued', pending: true, failed: false }
    default:
      return { status: 'Sent', pending: false, failed: false }
  }
}

/**
 * Walk one chat in order, handing every item the newest stamp at or before it.
 *
 * A tool row carries no timestamp on the wire, so a `bot_dm_out` derived from
 * one has none either. Sorting those to 1970 would bury the newest traffic in
 * the app at the bottom of the timeline, so they inherit the stamp of the row
 * they follow — which is where they happened.
 */
function stampedItems(chat: ChatState): { item: TranscriptItem; at: number }[] {
  const out: { item: TranscriptItem; at: number }[] = []
  let carried = 0

  for (const id of chat.order) {
    const item = chat.items[id]

    if (!item) {
      continue
    }

    if (item.ts && item.ts > carried) {
      carried = item.ts
    }

    out.push({ item, at: item.ts ?? carried })
  }

  return out
}

function ownHandle(chat: ChatState): string {
  return normalizeAgentTarget(chat.botName) || chat.botName.toLowerCase()
}

export interface ActivityOptions {
  /** Rows older than this many seconds are dropped. Omitted keeps everything. */
  sinceSeconds?: number
}

/**
 * Every bot-to-bot row across every loaded chat, newest last.
 *
 * Deterministic: equal stamps fall back to the bot name and the item id, so a
 * re-render never reshuffles rows that happened in the same second.
 */
export function activityEntries(
  chats: Readonly<Record<string, ChatState>>,
  options: ActivityOptions = {}
): ActivityEntry[] {
  const dispatched = new Set<string>()
  const entries: ActivityEntry[] = []

  // Pass one: the sender side. It is authoritative for a delivery's status, so
  // it claims the key an inbound row would otherwise repeat.
  for (const chat of Object.values(chats)) {
    const from = ownHandle(chat)

    for (const { item, at } of stampedItems(chat)) {
      if (item.kind !== 'bot_dm_out') {
        continue
      }

      const dm = item as BotDmOutItem
      const to = dm.targetHandle || normalizeAgentTarget(dm.target)
      const { status, pending, failed } = dispatchStatusLabel(dm)

      dispatched.add(deliveryKey(from, to, dm.message))
      entries.push({
        id: `${chat.botName}:${dm.id}`,
        botName: chat.botName,
        itemId: dm.id,
        kind: 'dm_out',
        at,
        fromHandle: from,
        toHandle: to,
        text: firstLine(dm.message),
        status,
        ...(pending ? { pending: true } : {}),
        ...(failed ? { failed: true } : {})
      })

      if (dm.reply && (dm.reply.text || dm.reply.error)) {
        entries.push({
          id: `${chat.botName}:${dm.id}:reply`,
          botName: chat.botName,
          itemId: dm.id,
          kind: 'dm_reply',
          at: dm.reply.ts ?? at,
          fromHandle: to,
          toHandle: from,
          text: firstLine(dm.reply.text || dm.reply.error || ''),
          ...(dm.reply.error ? { failed: true, status: 'Failed' } : {})
        })
      }
    }
  }

  // Pass two: the recipient side, for traffic whose sender chat is not loaded
  // (or whose dispatch row the gateway never persisted).
  for (const chat of Object.values(chats)) {
    const to = ownHandle(chat)

    for (const { item, at } of stampedItems(chat)) {
      if (item.kind === 'bot_dm_in') {
        const dm = item as BotDmInItem
        const from = dm.senderHandle || normalizeAgentTarget(dm.senderName)

        if (dispatched.has(deliveryKey(from, to, dm.text))) {
          continue
        }

        entries.push({
          id: `${chat.botName}:${dm.id}`,
          botName: chat.botName,
          itemId: dm.id,
          kind: dm.answersOurDispatch ? 'dm_reply' : 'dm_in',
          at,
          fromHandle: from,
          toHandle: to,
          text: firstLine(dm.text)
        })

        continue
      }

      if (item.kind === 'subagent_group') {
        const group = item as SubagentGroupItem
        const count = group.rootIds.length || group.goals.length

        if (!count) {
          continue
        }

        entries.push({
          id: `${chat.botName}:${group.id}`,
          botName: chat.botName,
          itemId: group.id,
          kind: 'delegation',
          at,
          fromHandle: to,
          text: firstLine(group.completion || group.goals.join(' · ')),
          status: group.status,
          agentCount: count,
          ...(group.status === 'running' || group.status === 'dispatched' ? { pending: true } : {}),
          ...(group.status === 'failed' ? { failed: true } : {})
        })
      }
    }
  }

  const cutoff = options.sinceSeconds ? Date.now() / 1000 - options.sinceSeconds : 0

  return entries
    .filter(entry => entry.at >= cutoff)
    .sort((a, b) => a.at - b.at || a.botName.localeCompare(b.botName) || a.id.localeCompare(b.id))
}

/**
 * The counterpart of one DM in another bot's chat.
 *
 * Tapping `researcher → writer: …` should land on the message as WRITER saw it,
 * not at the bottom of Writer's chat. The two rows share a sender, a recipient
 * and a body but nothing the gateway keys them by, so the match is handle plus
 * nearest stamp, and it refuses rather than guesses when nothing is close.
 */
export function findDmCounterpart(
  chat: ChatState | undefined,
  query: { kind: 'bot_dm_in' | 'bot_dm_out'; handle: string; at?: number; text?: string }
): string | undefined {
  if (!chat) {
    return undefined
  }

  const wanted = normalizeAgentTarget(query.handle)

  if (!wanted) {
    return undefined
  }

  const body = query.text ? firstLine(query.text, 64).toLowerCase() : ''
  let best: { id: string; distance: number; exact: boolean } | undefined
  let carried = 0

  for (const id of chat.order) {
    const item = chat.items[id]

    if (!item || item.kind !== query.kind) {
      if (item?.ts && item.ts > carried) {
        carried = item.ts
      }

      continue
    }

    if (item.ts && item.ts > carried) {
      carried = item.ts
    }

    const handle =
      item.kind === 'bot_dm_in'
        ? item.senderHandle || normalizeAgentTarget(item.senderName)
        : item.targetHandle || normalizeAgentTarget(item.target)

    if (handle !== wanted) {
      continue
    }

    const text = item.kind === 'bot_dm_in' ? item.text : item.message
    const exact = Boolean(body) && firstLine(text, 64).toLowerCase() === body
    const distance = query.at ? Math.abs((item.ts ?? carried) - query.at) : 0

    // An exact body match wins outright; otherwise the nearest stamp does.
    if (!best || (exact && !best.exact) || (exact === best.exact && distance < best.distance)) {
      best = { id, distance, exact }
    }
  }

  if (!best) {
    return undefined
  }

  return best.exact || !query.at || best.distance <= DM_MATCH_WINDOW_SECONDS ? best.id : undefined
}
