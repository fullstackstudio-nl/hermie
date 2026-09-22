/**
 * A short, replayable account of what the auth layer did, so the next surprise
 * sign-out can be read rather than guessed at.
 *
 * A signed-in session on a Mac build ended in the signed-out panel with no
 * gateway restart and no second app instance, and the app had recorded nothing
 * at all — so the diagnosis had to start from "we do not know". Everything here
 * exists so that is never the answer twice.
 *
 * What may be recorded is deliberately narrow, because this ring is meant to be
 * pasted into an issue as it stands: an event name from a closed set, the HTTP
 * status or WebSocket close code, a `GatewayErrorKind`, and how long the gateway
 * itself said the access token had left. No token values, no message text, no
 * host, no session or user identifiers.
 */
import type { GatewayErrorKind } from './types'

/** How many events the ring keeps. Two or three dials' worth. */
export const AUTH_TIMELINE_SIZE = 20

/**
 * The closed set of things worth recording. Each one is a decision point on some
 * path to `needs_signin`, which is what makes the ring readable backwards.
 */
export type AuthEventName =
  /** A dial began: the credential is about to be resolved. */
  | 'dial.start'
  /** `gateway.ready` arrived; the connection is live. */
  | 'dial.ready'
  /** `POST /api/auth/ws-ticket` answered with a ticket. */
  | 'ticket.minted'
  /** The ticket mint failed. `status` says how. */
  | 'ticket.failed'
  /** A stored access token was handed out without rotating anything. */
  | 'token.served'
  /** The token store could not be read. */
  | 'token.read_failed'
  /**
   * A launch found the gateway's address but no credential beside it.
   *
   * Recorded because it is otherwise indistinguishable from a keychain that
   * REFUSED to answer: `SecItemCopyMatching` returns `errSecItemNotFound` both
   * when an item was never written and when it was written under an access
   * group this process can no longer see, and `expo-secure-store` resolves both
   * to `null`. Until this existed, a launch that dropped the owner back into
   * the wizard left nothing at all in the ring to read afterwards.
   */
  | 'token.absent'
  /** A rotated token set reached the store. */
  | 'token.write_ok'
  /** A rotated token set did NOT reach the store — the next launch will be signed out. */
  | 'token.write_failed'
  /** The token set was deleted, by a sign-out or by a definitive rejection. */
  | 'token.cleared'
  | 'refresh.start'
  | 'refresh.ok'
  /** The refresh did not produce a token set. `status` / `kind` say why. */
  | 'refresh.failed'
  /** The socket closed. `closeCode` is the gateway's verdict. */
  | 'ws.closed'
  /** A REST call came back 401. */
  | 'rest.unauthorized'
  /** The connection gave up and asked for a new sign-in. `reason` says why. */
  | 'signin.required'
  /**
   * A sign-in succeeded and produced NO refresh token.
   *
   * Recorded at the exchange rather than inferred later, because by the time it
   * matters the evidence is gone: the session simply ends when the access token
   * expires, and `token.cleared reason=no_refresh_token` an hour later reads as
   * a keychain problem. The cause is upstream of Hermie entirely — an OIDC
   * client registered without `offline_access` — and nothing the app does can
   * fix it, so saying so at the moment it is knowable is the whole remedy.
   */
  | 'signin.no_refresh'
  /**
   * The launch read of the stored gateway threw, and the app opened the wizard.
   *
   * Recorded because the alternative was what shipped: the provider's startup
   * `reload()` caught everything, switched to onboarding and kept the reason to
   * itself, so a device that could not write its keychain looked exactly like a
   * device nobody had set up yet. This is the event that tells those two apart
   * afterwards, on a screen the owner can reach.
   *
   * It is the one event here that is not about a token, and it is on this ring
   * anyway: the ring is where "why am I being asked to sign in again" is
   * answered, and a failed launch read is one of the answers.
   */
  | 'startup.failed'

/**
 * Why the session ended, in the terms the UI turns into one calm sentence.
 *
 * These are causes, not restatements of the status: `refresh_rejected` and
 * `rejected_after_refresh` look identical from the panel and are the two things
 * an owner most needs told apart — one means the refresh token is finished, the
 * other means the gateway would not accept a credential it had just minted.
 */
export type SignOutReason =
  /** The gateway rejected the refresh token itself. The session is genuinely over. */
  | 'refresh_rejected'
  /** The refresh never completed: network, timeout, or the gateway erroring. */
  | 'refresh_failed'
  /** There was no refresh token to rotate. */
  | 'no_refresh_token'
  /** A freshly refreshed credential was rejected again. */
  | 'rejected_after_refresh'
  /** The stored token set could not be read. */
  | 'token_unreadable'

export interface AuthEvent {
  /** `Date.now()` when it happened. */
  at: number
  event: AuthEventName
  /** HTTP status, when the event came from a response. */
  status?: number
  /** WebSocket close code, when the event came from a socket. */
  closeCode?: number
  /** How the failure was classified. */
  kind?: GatewayErrorKind
  /**
   * Seconds until the access token expires, as the gateway reported it and this
   * device's clock reads it. Negative means already expired; a reading far from
   * the lifetime the gateway issues is the fingerprint of clock drift.
   */
  expiresIn?: number
  reason?: SignOutReason
}

export type AuthEventInput = Omit<AuthEvent, 'at'> & { at?: number }

export interface AuthTimelineSnapshot {
  events: AuthEvent[]
  /** The reason attached to the most recent `signin.required`, if there was one. */
  lastSignOut: { at: number; reason: SignOutReason } | null
}

export interface AuthTimelineOptions {
  size?: number
  now?: () => number
  /**
   * Called after every record with the whole snapshot. The app persists it to the
   * key-value store: a sign-out is usually followed by a restart, and a ring that
   * does not survive that restart cannot explain the thing it exists to explain.
   */
  sink?: (snapshot: AuthTimelineSnapshot) => void
}

/** Keep only fields that carry a value, so a recorded event has no `undefined` noise. */
function compact(input: AuthEventInput, at: number): AuthEvent {
  const event: AuthEvent = { at, event: input.event }

  if (input.status !== undefined) {
    event.status = input.status
  }

  if (input.closeCode !== undefined) {
    event.closeCode = input.closeCode
  }

  if (input.kind !== undefined) {
    event.kind = input.kind
  }

  if (input.expiresIn !== undefined) {
    event.expiresIn = Math.round(input.expiresIn)
  }

  if (input.reason !== undefined) {
    event.reason = input.reason
  }

  return event
}

function isAuthEvent(value: unknown): value is AuthEvent {
  if (!value || typeof value !== 'object') {
    return false
  }

  const candidate = value as Partial<AuthEvent>

  return typeof candidate.at === 'number' && typeof candidate.event === 'string'
}

/**
 * The ring itself.
 *
 * Recording must never be able to break a dial, so `record` swallows whatever
 * the sink throws: a full disk is not a reason to lose a connection that works.
 */
export class AuthTimeline {
  private events: AuthEvent[] = []
  private lastSignOut: { at: number; reason: SignOutReason } | null = null
  private readonly size: number
  private readonly now: () => number
  private readonly sink: ((snapshot: AuthTimelineSnapshot) => void) | undefined

  constructor(options: AuthTimelineOptions = {}) {
    this.size = options.size ?? AUTH_TIMELINE_SIZE
    this.now = options.now ?? (() => Date.now())
    this.sink = options.sink
  }

  record(input: AuthEventInput): void {
    const event = compact(input, input.at ?? this.now())
    this.events.push(event)

    if (this.events.length > this.size) {
      this.events.splice(0, this.events.length - this.size)
    }

    if (event.event === 'signin.required' && event.reason) {
      this.lastSignOut = { at: event.at, reason: event.reason }
    }

    try {
      this.sink?.(this.snapshot())
    } catch {
      // Persisting the account of a failure must not become another failure.
    }
  }

  /**
   * Record the sign-out, attributed to the most recent cause the ring can
   * actually account for.
   *
   * The connection knows it is giving up but not always why: a `reauth` verdict
   * only says the credential provider has nothing left to offer, while the reason
   * it has nothing left — a rejected grant, an unreadable keychain — was recorded
   * by the coordinator moments earlier. Reading backwards to the last decisive
   * event is what turns "signed out" into a sentence. The walk stops at
   * `dial.ready`, because anything older than the last healthy connection belongs
   * to a different story.
   */
  signOut(fallback: SignOutReason): void {
    this.record({ event: 'signin.required', reason: this.attribute() ?? fallback })
  }

  private attribute(): SignOutReason | null {
    for (let index = this.events.length - 1; index >= 0; index -= 1) {
      const entry = this.events[index] as AuthEvent

      if (entry.event === 'dial.ready') {
        return null
      }

      if (entry.event === 'token.cleared') {
        return entry.reason ?? null
      }

      if (entry.event === 'token.read_failed') {
        return 'token_unreadable'
      }

      if (entry.event === 'refresh.failed') {
        return entry.kind === 'auth' ? 'refresh_rejected' : 'refresh_failed'
      }
    }

    return null
  }

  snapshot(): AuthTimelineSnapshot {
    return { events: [...this.events], lastSignOut: this.lastSignOut }
  }

  /** The reason for the most recent sign-out, across restarts once restored. */
  get signOutReason(): SignOutReason | null {
    return this.lastSignOut?.reason ?? null
  }

  /**
   * Adopt a snapshot read back from storage. Anything that does not look like an
   * event is dropped rather than trusted: this blob may have been written by an
   * older build.
   */
  restore(snapshot: unknown): void {
    if (!snapshot || typeof snapshot !== 'object') {
      return
    }

    const candidate = snapshot as Partial<AuthTimelineSnapshot>

    if (Array.isArray(candidate.events)) {
      this.events = candidate.events.filter(isAuthEvent).slice(-this.size)
    }

    const signOut = candidate.lastSignOut

    if (signOut && typeof signOut.at === 'number' && typeof signOut.reason === 'string') {
      this.lastSignOut = { at: signOut.at, reason: signOut.reason as SignOutReason }
    }
  }
}

/**
 * The timeline every code path can talk to unconditionally.
 *
 * The connection, the coordinator and the credential provider all record, and
 * all three are constructed in tests that care about none of it. A shared no-op
 * keeps `timeline.record(...)` free of a `?.` at every call site.
 */
export const NULL_AUTH_TIMELINE: AuthTimelineSink = { record: () => undefined, signOut: () => undefined }

/** What the connection and the coordinator need: recording, and nothing else. */
export type AuthTimelineSink = Pick<AuthTimeline, 'record' | 'signOut'>

/**
 * The smaller half, for a caller that only ever writes one event.
 *
 * A sign-in does not end a session, so `exchangeCode` has no business being
 * handed something that can declare one — and a React screen that wants to
 * record one line should not have to build a whole sink to do it.
 */
export type AuthEventRecorder = Pick<AuthTimeline, 'record'>
