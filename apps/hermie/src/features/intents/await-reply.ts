/**
 * Waiting for the reply a Shortcut asked for.
 *
 * `ChatController.send` returns once the gateway has ACCEPTED the prompt, which
 * is a different moment from the bot having answered — and the answer is the
 * whole point of "Ask <bot>", because it is what flows into the next action of
 * a Shortcut. So this is the one place in the app that watches a turn to its
 * end and takes the text out.
 *
 * ## It watches the store rather than the socket
 *
 * A reply arrives as a stream of deltas into the chat store, which is already
 * the app's one model of a turn: `turn.active` goes true when a prompt is
 * submitted and false when the turn ends, however it ends — completed,
 * interrupted, or failed. Watching the store rather than the gateway means a
 * reply that came in over a reconnect, or one the reducer reconstructed from a
 * REST tail, is the same reply.
 *
 * ## The watch starts BEFORE the prompt is sent, and that is load bearing
 *
 * `watchReply` reads the id of the last thing the bot said and then waits for a
 * DIFFERENT one. Started after the send instead, it would be wrong in both
 * directions at once:
 *
 *  - a fast gateway can finish the whole turn before the caller gets back, and
 *    a watch that only reacted to later changes would sit through the entire
 *    budget for a reply that had already landed;
 *  - a prompt sent while a turn is already running is PARKED behind it
 *    (`ChatController.queue`), so the first turn to end is not the one that was
 *    asked about, and a watch with no marker would return the previous answer.
 *
 * ## Three ways out, and all three answer
 *
 * A new reply: its text. The budget runs out: `null`, which the runner turns
 * into "still working, open Hermie to read it". A turn that ends with nothing
 * new in it — an interruption, a tool-only turn, an error — also `null`, for
 * the same reason: a Shortcut that returns an empty string looks like it
 * worked.
 *
 * Nothing here is cancelled from outside. The subscription and the timer are
 * torn down by whichever fires first, so a caller that walks away leaks
 * neither.
 */
import type { ChatState } from '@hermie/transcript'

import { INTENT_BUDGET_MS } from './queue'

export interface WatchReplyOptions {
  chats: {
    getState: () => { chats: Record<string, ChatState> }
    subscribe: (listener: () => void) => () => void
  }
  botName: string
  /** Defaults to the queue's own budget, which is what the intent polls for. */
  timeoutMs?: number
  /** Injected in tests. */
  setTimeoutImpl?: typeof setTimeout
  clearTimeoutImpl?: typeof clearTimeout
}

/**
 * The last thing the bot actually SAID in this chat, as an id and its text.
 *
 * Deliberately the last `assistant` item and not the last item: a turn
 * routinely ends with a tool call, a notice or an injected row, and none of
 * those is an answer. `interim` bubbles — mid-turn commentary the gateway seals
 * before the real reply — are skipped for the same reason.
 *
 * Exported because it is the part worth testing on its own: a scan over a
 * transcript, with no store, no clock and no gateway in it.
 */
export function lastReplyOf(chat: ChatState | undefined): { id: string; text: string } | null {
  if (!chat) {
    return null
  }

  // `items` is an id-keyed map and `order` is the sequence; walking `order`
  // backwards is the only way to ask "the last thing said" — a map has no last.
  for (let index = chat.order.length - 1; index >= 0; index -= 1) {
    const id = chat.order[index]
    const item = id === undefined ? undefined : chat.items[id]

    if (item?.kind !== 'assistant' || item.interim) {
      continue
    }

    return { id: item.id, text: item.text.trim() }
  }

  return null
}

/**
 * Start watching now; answer with the next reply, or `null`.
 *
 * Call this BEFORE sending — see the note above about why the marker cannot be
 * read afterwards. It never rejects, so a caller whose send failed can simply
 * abandon the promise.
 */
export function watchReply(options: WatchReplyOptions): Promise<string | null> {
  const { botName, chats } = options
  const timeoutMs = options.timeoutMs ?? INTENT_BUDGET_MS
  const schedule = options.setTimeoutImpl ?? setTimeout
  const cancel = options.clearTimeoutImpl ?? clearTimeout

  const before = lastReplyOf(chats.getState().chats[botName])?.id ?? null

  return new Promise(resolve => {
    let settled = false
    let unsubscribe = (): void => undefined

    const finish = (value: string | null): void => {
      if (settled) {
        return
      }

      settled = true
      cancel(timer)
      unsubscribe()
      resolve(value)
    }

    const timer = schedule(() => finish(null), timeoutMs)

    const check = (): void => {
      const chat = chats.getState().chats[botName]

      // Still running is the ordinary case and the only reason to keep waiting.
      if (chat?.turn.active) {
        return
      }

      const latest = lastReplyOf(chat)

      // Nothing new since the marker. Either the prompt has not started its turn
      // yet — it is parked behind another one — or the turn that just ended was
      // somebody else's. Either way there is nothing to answer with yet.
      if (!latest || latest.id === before) {
        return
      }

      finish(latest.text || null)
    }

    unsubscribe = chats.subscribe(check)

    // Once immediately, for the fast-gateway half of the note above: the reply
    // may already be there, and a watch that only reacted to CHANGES would wait
    // out the whole budget for it.
    check()
  })
}
