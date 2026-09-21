/**
 * Asking for the last reply again.
 *
 * Its own module because the DECISION is the whole of it and the decision has
 * three outcomes, only one of which is "send something": a running turn refuses,
 * a conversation with nothing to repeat refuses, and everything else takes one
 * of two roads. Inside a `useCallback` in the screen that is three branches
 * nothing can reach; out here it is a function with a suite.
 *
 * ## Two roads, and the catalogue chooses
 *
 * **`/retry` where the gateway has it.** It is the gateway's own command, it
 * knows what the turn was, and it re-runs it on that side — so the conversation
 * gains a reply rather than gaining a second copy of the prompt that produced
 * it. It goes down the ordinary slash path (`chat-controller.runSlash`), which
 * means it gets the same directive handling, the same notices and the same
 * failure reporting every other command gets.
 *
 * **The previous prompt again, where it does not.** An older gateway, or a
 * profile whose catalogue does not carry the command. Sending the prompt again
 * is what a reader would do by hand, and it is honest: there really are two
 * turns now, and the transcript says so. The alternative — doing nothing on a
 * gateway that cannot retry — is a menu line that silently fails.
 *
 * The catalogue is the same one the composer's autocomplete reads, and a
 * catalogue that has not arrived yet answers "no". That is the safe direction:
 * the fallback works everywhere, and `/retry` is an optimisation on it.
 */
import type { TranscriptItem } from '@hermie/transcript'

/** The slice of `useChat` this needs, so a test does not have to build the rest. */
export interface RegenerateSource {
  /** Whether a turn is running right now. */
  turnActive: boolean
  /** The VISIBLE rows, newest last. */
  items: readonly { item: TranscriptItem }[]
  knowsSlashCommand: (name: string) => boolean
  runSlash: (command: string) => Promise<unknown>
  send: (text: string) => Promise<void>
}

export type RegenerateOutcome =
  /** `/retry` went to the gateway. */
  | { kind: 'retried' }
  /** The previous prompt was sent again, because the gateway has no `/retry`. */
  | { kind: 'resent'; text: string }
  /** A turn is running; nothing was sent. */
  | { kind: 'busy' }
  /** There is no prompt in this conversation to repeat. */
  | { kind: 'nothing' }

/** The command, spelled once, so the catalogue lookup and the call cannot drift. */
const RETRY = 'retry'

/**
 * The newest of the reader's own turns.
 *
 * Which is the prompt the last reply answered — and deliberately not the newest
 * row of any kind: a conversation whose tail is a cron delivery or an inbound
 * bot message has nothing the reader asked for, and repeating one of those would
 * be repeating somebody else's words.
 */
function lastPrompt(items: readonly { item: TranscriptItem }[]): string {
  for (let at = items.length - 1; at >= 0; at -= 1) {
    const item = items[at]?.item

    if (item?.kind === 'user' && item.text.trim()) {
      return item.text
    }
  }

  return ''
}

/**
 * Run the last reply again, and say which road was taken.
 *
 * Never throws for a refusal — a refusal is an outcome the caller reports — but
 * it does let a gateway failure through, because that is the caller's banner and
 * not this function's business.
 */
export async function regenerateLastTurn(chat: RegenerateSource): Promise<RegenerateOutcome> {
  if (chat.turnActive) {
    return { kind: 'busy' }
  }

  if (chat.knowsSlashCommand(RETRY)) {
    await chat.runSlash(`/${RETRY}`)

    return { kind: 'retried' }
  }

  const text = lastPrompt(chat.items)

  if (!text) {
    return { kind: 'nothing' }
  }

  await chat.send(text)

  return { kind: 'resent', text }
}
