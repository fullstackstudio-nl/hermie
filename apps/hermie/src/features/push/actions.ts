/**
 * What a tap on a notification is allowed to do.
 *
 * ADR-0017 is explicit, and this file is where that sentence becomes code:
 *
 * > Tapping one does **not** answer anything by itself: the app opens, connects
 * > to the gateway, re-reads the open requests, and responds only if that
 * > request is still open and still says what the notification said it did. A
 * > notification is a hint that something happened, never an instruction.
 *
 * So a payload is never trusted for anything except *which chat to look in*.
 * Everything about the decision — that there is a request, that it is the one
 * named, that it is still open, which answers it will take — comes back from the
 * gateway's own `approval.pending`, and the payload is only allowed to select a
 * row out of that answer. A forged "Allow `rm -rf /`" therefore opens a chat and
 * finds nothing, which is the failure mode the ADR designed for.
 *
 * Everything here is pure. The round trip lives in `push-sync.ts`; what a given
 * pair of (payload, gateway answer) means is a table in a test.
 */
import { PUSH_ACTION_ALLOW, PUSH_ACTION_DENY, PUSH_TYPES_WITH_ACTIONS, type PushResponse } from './platform-contract'

/** One row of `approval.pending`, as far as this needs to read it. */
export interface OpenApproval {
  request_id?: string | null
  choices?: string[] | null
  [key: string]: unknown
}

/** What the app should do once it has asked the gateway. */
export type PushIntent =
  { kind: 'open-chat'; bot: string } | { kind: 'respond'; bot: string; requestId: string; choice: string }

/** What a tap asked for, before the gateway has been consulted. */
export interface PushTap {
  bot: string
  /** Empty unless the payload named one; an action without one cannot answer. */
  requestId: string
  action: 'allow' | 'deny' | 'open'
}

const stringOf = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

/**
 * Read a tap, or nothing.
 *
 * A payload with no bot in it is unusable: every entry point in this app resolves
 * against the roster, and "open some chat" is not a destination. That is the one
 * field a notification is trusted for, and even it is only a lookup key.
 */
export function pushTapOf(response: PushResponse): PushTap | null {
  const bot = stringOf(response.data.bot)

  if (!bot) {
    return null
  }

  const action =
    response.actionIdentifier === PUSH_ACTION_ALLOW
      ? 'allow'
      : response.actionIdentifier === PUSH_ACTION_DENY
        ? 'deny'
        : 'open'

  // An Allow or Deny that names no request is a button with nothing to press.
  // It degrades to opening the chat rather than answering the oldest question,
  // which is the kind of guess that answers the wrong one.
  const requestId = stringOf(response.data.requestId)

  return { bot, requestId, action: action !== 'open' && !requestId ? 'open' : action }
}

/**
 * The choice to send for Allow, out of the ones the gateway is offering.
 *
 * `once` if it is on the list, because a button on a lock screen is the least
 * considered decision the reader will make all day and it should be the
 * narrowest one — never `session`, and never `always`, whatever the queue
 * entry allows. If the gateway offers neither `once` nor anything else this
 * recognises, nothing is sent.
 */
export function allowChoiceOf(approval: OpenApproval): string | null {
  const choices = Array.isArray(approval.choices) ? approval.choices.filter(choice => typeof choice === 'string') : []

  return choices.includes('once') ? 'once' : null
}

/** The choice to send for Deny, on the same rule. */
export function denyChoiceOf(approval: OpenApproval): string | null {
  const choices = Array.isArray(approval.choices) ? approval.choices.filter(choice => typeof choice === 'string') : []

  return choices.includes('deny') ? 'deny' : null
}

export interface ResolveOptions {
  tap: PushTap
  /** What `approval.pending` answered for this bot, just now. */
  pending: readonly OpenApproval[]
}

/**
 * The tap, decided against what the gateway currently says is open.
 *
 * Every path that is not an exact match on a still-open request falls through to
 * opening the chat, which is both the safe answer and the useful one: a question
 * that was answered on another device, a cron that was deleted, a bot that no
 * longer exists all leave the reader looking at the conversation, where the app
 * can say what is actually true.
 */
export function resolvePushTap(options: ResolveOptions): PushIntent {
  const { tap, pending } = options
  const openChat: PushIntent = { kind: 'open-chat', bot: tap.bot }

  if (tap.action === 'open' || !tap.requestId) {
    return openChat
  }

  const match = pending.find(approval => stringOf(approval.request_id) === tap.requestId)

  if (!match) {
    // Answered, expired, or never real. Either way there is nothing to respond
    // to and the chat is where the reader finds out which.
    return openChat
  }

  const choice = tap.action === 'allow' ? allowChoiceOf(match) : denyChoiceOf(match)

  return choice ? { kind: 'respond', bot: tap.bot, requestId: tap.requestId, choice } : openChat
}

/** True when this payload is the kind that would have carried buttons. */
export const wantsActions = (response: PushResponse): boolean =>
  PUSH_TYPES_WITH_ACTIONS.includes(stringOf(response.data.type))
