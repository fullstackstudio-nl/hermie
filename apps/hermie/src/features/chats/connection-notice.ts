/**
 * What a chat says about its connection, and WHERE it says it.
 *
 * This is the whole of the decision, kept away from the screen because the
 * screen is where it went wrong: the connection notice used to be a bar at the
 * top of the transcript pane, and the transcript pane's top is UNDER the
 * floating header. A reader saw "Waiting for the g…" with the rest of the
 * sentence behind the contact pill, because a `Banner` above a list that the
 * chrome floats over has nowhere to be.
 *
 * Two placements replace it, and which one applies is decided by one thing: is
 * there anything on screen already?
 *
 *  - **Nothing on screen** — a chat that has never been opened on this device,
 *    or whose cache was dropped. There is no transcript to interrupt, so the
 *    notice IS the screen: a centred plate with the bot on it, the way every
 *    messenger draws a conversation it cannot show yet.
 *  - **A cached transcript** — the reader can read. The pane stays exactly as
 *    it was and the notice shrinks to a pill above the composer, with the
 *    header's own subtitle carrying the state word. Nothing covers a message.
 *
 * `blocked` is the one case that produces neither. A refusal the reader has to
 * act on — signed out, an incompatible gateway, a host guard — is not a wait,
 * and it has its own banner with its own button. Two notices about one
 * connection is how a screen stops being read at all.
 */
import type { ConnectionStatus } from '@hermie/gateway-client'

/** Which of the three words the connection has earned. */
export type ConnectionPhase = 'connecting' | 'reconnecting' | 'offline'

export interface ConnectionNotice {
  /** `none` is the common case: a live connection says nothing at all. */
  kind: 'none' | 'empty' | 'pill'
  phase: ConnectionPhase
  /**
   * Offer the reader a dial of their own.
   *
   * Deliberately NOT offered immediately. The ladder's first rungs are hundreds
   * of milliseconds apart, so a button in the first second competes with a
   * reconnect that is already happening and teaches the reader that pressing it
   * is what fixes this. After five seconds the ladder is far enough up that a
   * reset to the bottom is worth something.
   */
  retry: boolean
}

/** How long a reconnect runs before the reader is offered a dial of their own. */
export const RETRY_OFFER_MS = 5_000

const NONE: ConnectionNotice = { kind: 'none', phase: 'connecting', retry: false }

/**
 * A status that is not `ready` but is also not a wait.
 *
 * `paused` is the app in the background — the connection stopped on purpose and
 * nothing is wrong. Drawing "Reconnecting…" over a chat the reader is about to
 * come back to means the first frame after a resume is a lie about the last
 * one.
 */
function phaseFor(status: ConnectionStatus): ConnectionPhase {
  if (status === 'offline') {
    return 'offline'
  }

  if (status === 'reconnecting') {
    return 'reconnecting'
  }

  return 'connecting'
}

export function connectionNotice(input: {
  status: ConnectionStatus
  /** Is there anything in the pane? Rows the reader can read, cached or live. */
  hasTranscript: boolean
  /** A refusal with its own banner; see the note above. */
  blocked: boolean
  /** How long this connection has been away from `ready`. */
  waitingMs: number
}): ConnectionNotice {
  if (input.status === 'ready' || input.status === 'paused' || input.blocked) {
    return NONE
  }

  const phase = phaseFor(input.status)

  return {
    kind: input.hasTranscript ? 'pill' : 'empty',
    phase,
    retry: phase === 'reconnecting' && input.waitingMs > RETRY_OFFER_MS
  }
}
