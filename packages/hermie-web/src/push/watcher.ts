/**
 * The watcher: the half of `--push` that decides whether anything happened.
 *
 * [ADR-0017](../../../../docs/adr/0017-push-through-hermie-web.md) names four
 * things worth a buzz and nothing else — a new bot message in a chat no client
 * is attached to, an approval or clarify request opening, a bot-to-bot DM, and a
 * cron delivery or cron error. Everything below follows from that list and from
 * three properties the gateway does not have:
 *
 *  - **It cannot be asked who is watching.** `session.active_list` answers about
 *    the CALLING connection and nobody else's, so "nobody is attached" is a
 *    heartbeat the app writes into `push.seen` and this reads. It is a
 *    heuristic, written down as one: it fails towards a redundant notification
 *    for a chat somebody is already reading, which is the right direction.
 *  - **It has no event for a cron delivery or a DM.** Both arrive as an ordinary
 *    inbound row with a header in front of it, so classifying a finished turn
 *    costs one `session.history` — see the note on `classifyTurn`.
 *  - **It never evicts a session whose transport is alive.** Resuming every Bot
 *    Chat therefore pins every Bot Chat, which ADR-0017 accepts knowingly and
 *    the deployment notes say out loud.
 *
 * Requests, DMs and cron deliveries are deliberately NOT suppressed by the
 * heartbeat: a question with a countdown on it is worth a buzz even if the chat
 * is open on a tablet in another room.
 */
import { announceAvailability, availabilityIsCurrent, type PushAvailability, withAvailability } from './announce'
import type { PushMessage } from './expo'
import { lastInboundRow } from './inbound'
import type { LinkEvent, LinkServerRequest } from './link'
import { type NotifiableEvent, pushMessageFor, typeForInbound } from './payload'
import { type PushRegistration, type PushType, registrationsFor, someoneAttached } from './registrations'
import { readRoster, type Roster, type WatchedBot } from './roster'
import type { PushState } from './state'

/** How fresh a `seen` stamp has to be to keep a message notification quiet. */
export const ATTACHED_WINDOW_SECONDS = 90

/**
 * The pause before a message notification goes out.
 *
 * ADR-0017: "A short delay before sending absorbs the case where the app is
 * opening." The registrations are re-read across it, so an app that got its
 * heartbeat in during the pause claims the chat and the buzz never happens.
 */
export const OPENING_GRACE_MS = 4000

/** Registrations are re-read no more often than this, outside a change signal. */
export const REGISTRATION_TTL_MS = 30_000

/** Per device. A bot in a loop must not become a hundred notifications. */
export const RATE_LIMIT_BURST = 12
export const RATE_LIMIT_WINDOW_SECONDS = 300

export interface WatcherLink {
  request<T>(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T>
}

export interface PushSender {
  /** Deliver to these registrations. Answers with the installations whose address is finished. */
  send(registrations: readonly PushRegistration[], message: PushMessage): Promise<{ dead: string[] }>
}

/** How long the availability stamp is allowed to stand before it is rewritten. */
export const AVAILABILITY_TTL_SECONDS = 300

export interface WatcherOptions {
  link: WatcherLink
  state: PushState
  save: () => Promise<void>
  sender: PushSender
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  log?: (line: string) => void
  attachedWindowSeconds?: number
  openingGraceMs?: number
  registrationTtlMs?: number
  rateLimit?: { burst: number; windowSeconds: number }
  /**
   * What to put in `hermie-app.push` so Settings can say push is available.
   * Absent means say nothing, which is what a test without a daemon wants.
   */
  availability?: () => Omit<PushAvailability, 'at'>
  availabilityTtlSeconds?: number
}

interface WatchedSession extends WatchedBot {
  /** Ids the gateway may name this session by; a resume answers with both. */
  aliases: string[]
}

export class PushWatcher {
  private roster: Roster = {
    bots: [],
    defaultProfile: '',
    appSection: null,
    appRevision: 0,
    push: { registrations: [], seen: {} }
  }
  private rosterReadAt = 0
  /** Every id the gateway might stamp on an event → the session it belongs to. */
  private readonly byId = new Map<string, WatchedSession>()
  private readonly rateLimit = new Map<string, number[]>()
  private relisting: Promise<void> | null = null
  private pendingRelist = false
  private inFlight = new Set<Promise<void>>()

  constructor(private readonly options: WatcherOptions) {}

  private get now(): number {
    return this.options.now?.() ?? Math.floor(Date.now() / 1000)
  }

  private log(line: string): void {
    this.options.log?.(line)
  }

  /** The chats being watched right now, for a log line and for the tests. */
  get watched(): WatchedBot[] {
    return this.roster.bots
  }

  /**
   * The sessions actually resumed, which is what subscribes this connection to
   * their events. Distinct from `watched` on purpose: the roster is read before
   * the resumes are made, so a caller that has to know the daemon is LISTENING
   * — a test, a log line — has to ask about this and not about that.
   */
  get resumed(): string[] {
    return [...new Set([...this.byId.values()].map(session => session.sessionId))]
  }

  /** What the last roster read said about registrations. */
  get registrations(): PushRegistration[] {
    return this.roster.push.registrations
  }

  /** Let every in-flight notification finish. Used by the tests and by a clean stop. */
  async settle(): Promise<void> {
    while (this.inFlight.size) {
      await Promise.allSettled([...this.inFlight])
    }
  }

  /**
   * Read the roster and resume every bot's canonical Bot Chat.
   *
   * Called on every connect, and again whenever the gateway says the session
   * store or a profile moved. Resuming is what subscribes this connection to a
   * session's events; without it the socket is open and silent.
   */
  async resumeAll(): Promise<void> {
    if (this.relisting) {
      this.pendingRelist = true

      return this.relisting
    }

    const run = this.relist().finally(() => {
      this.relisting = null
    })
    this.relisting = run
    await run

    if (this.pendingRelist) {
      this.pendingRelist = false
      await this.resumeAll()
    }
  }

  private async relist(): Promise<void> {
    const roster = readRoster(await this.options.link.request('profiles.list', {}))
    this.roster = roster
    this.rosterReadAt = Date.now()

    for (const bot of roster.bots) {
      const existing = this.byId.get(bot.sessionId)

      if (existing && existing.name === bot.name) {
        continue
      }

      try {
        // `omit_messages` because the daemon is not painting a transcript: what
        // a resume is for here is the subscription and the open requests that
        // come back with it.
        const result = await this.options.link.request<{
          session_id?: unknown
          stored_session_id?: unknown
        }>('session.resume', { session_id: bot.sessionId, omit_messages: true })

        const aliases = [
          bot.sessionId,
          bot.storedId,
          String(result?.session_id ?? ''),
          String(result?.stored_session_id ?? '')
        ]
        const session: WatchedSession = { ...bot, aliases: [...new Set(aliases.filter(Boolean))] }

        for (const alias of session.aliases) {
          this.byId.set(alias, session)
        }
      } catch (error) {
        // One bot that cannot be resumed costs that bot. A gateway mid-restart
        // would otherwise take the whole watch down with it.
        this.log(`push: could not watch ${bot.name} — ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    // A bot that left the roster stops being watched, so a deleted profile does
    // not keep a stale alias alive for ever.
    const live = new Set(roster.bots.map(bot => bot.sessionId))

    for (const [alias, session] of this.byId) {
      if (!live.has(session.sessionId)) {
        this.byId.delete(alias)
      }
    }

    this.log(
      `push: watching ${String(roster.bots.length)} chat(s), ${String(roster.push.registrations.length)} registration(s)`
    )
    await this.announce()
  }

  /**
   * Leave the liveness stamp, when there is something to say and it is stale.
   *
   * Skipped when the bag already says exactly this: the write is a
   * compare-and-swap against a key devices are heartbeating into, and rewriting
   * an unchanged value would be a round trip that can only lose a race.
   */
  async announce(): Promise<void> {
    const describe = this.options.availability

    if (!describe) {
      return
    }

    const availability: PushAvailability = { ...describe(), at: this.now }
    const ttl = this.options.availabilityTtlSeconds ?? AVAILABILITY_TTL_SECONDS

    if (availabilityIsCurrent(this.roster.appSection, availability, ttl)) {
      return
    }

    try {
      const result = await announceAvailability(this.options.link, this.roster, availability)

      if (result.written) {
        // Keep the local copy in step, through the same function that built the
        // write: the next sweep must compare against what was STORED and not
        // against what was last read.
        this.roster = {
          ...this.roster,
          appRevision: result.revision,
          appSection: withAvailability(this.roster.appSection, availability)
        }
      }
    } catch (error) {
      // Saying "push is available" is not what push is for. A gateway too old
      // for `profiles.configure`, or one that refuses the write, costs a line
      // in Settings and nothing else.
      this.log(
        `push: could not leave the availability stamp — ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  /** Re-read the roster when it is older than the TTL, or when told to. */
  private async refreshRegistrations(force = false): Promise<void> {
    if (!force && Date.now() - this.rosterReadAt < (this.options.registrationTtlMs ?? REGISTRATION_TTL_MS)) {
      return
    }

    try {
      this.roster = readRoster(await this.options.link.request('profiles.list', {}))
      this.rosterReadAt = Date.now()
    } catch {
      // Keep the last good roster: a refresh that failed is not a statement
      // that nobody is registered.
    }
  }

  /** One gateway event. Returns immediately; the work runs behind it. */
  onEvent(event: LinkEvent): void {
    if (event.type === 'sessions.changed' || event.type === 'profiles.changed') {
      this.track(this.resumeAll().catch(() => undefined))

      return
    }

    if (event.type !== 'message.complete') {
      return
    }

    const session = event.session_id ? this.byId.get(event.session_id) : undefined

    if (!session || typeof event.seq !== 'number') {
      return
    }

    this.track(
      this.onTurnComplete(session, event).catch(error => {
        this.log(`push: a turn could not be reported — ${error instanceof Error ? error.message : String(error)}`)
      })
    )
  }

  /** One server→client request. Never answered; see `link.ts`. */
  onServerRequest(request: LinkServerRequest): void {
    if (request.method !== 'approval' && request.method !== 'clarify') {
      return
    }

    const sessionId = typeof request.params.session_id === 'string' ? request.params.session_id : ''
    const session = this.byId.get(sessionId)

    if (!session) {
      return
    }

    this.track(
      this.notify(
        {
          type: 'request',
          bot: session.name,
          botLabel: session.label,
          sessionId: session.sessionId,
          requestId: request.id,
          requestMethod: request.method,
          preview: previewOfRequest(request.params)
        },
        // The request id is the identity: a resume re-delivers the same id, so
        // an unanswered question does not buzz again on every reconnect.
        `${session.sessionId}:req:${request.id}`,
        { suppressWhenAttached: false }
      ).catch(() => undefined)
    )
  }

  private track(promise: Promise<void>): void {
    this.inFlight.add(promise)
    void promise.finally(() => this.inFlight.delete(promise))
  }

  private async onTurnComplete(session: WatchedSession, event: LinkEvent): Promise<void> {
    const seq = event.seq ?? 0
    const payload = (event.payload ?? {}) as { text?: unknown; status?: unknown; error?: unknown }

    // Nothing to classify for, so nothing to fetch. The history read below is
    // the daemon's one expensive call and it is worth skipping when it would
    // only decide which of several empty audiences to address.
    if (!this.roster.push.registrations.length) {
      return
    }

    const inbound = await this.classifyTurn(session)
    const type: PushType = typeForInbound(inbound.kind)
    const failed = payload.status === 'error' || typeof payload.error === 'string'

    const notifiable: NotifiableEvent = {
      type,
      bot: session.name,
      botLabel: session.label,
      sessionId: session.sessionId,
      ...(inbound.name ? { name: inbound.name } : {}),
      ...(type === 'cron' && failed ? { failed: true } : {}),
      preview: typeof payload.text === 'string' ? payload.text : ''
    }

    await this.notify(notifiable, `${session.sessionId}:${type}:${String(seq)}`, {
      // Only an ordinary message defers to the heartbeat. A DM, a cron report
      // and a failed run are worth a buzz whether or not a chat is on screen.
      suppressWhenAttached: type === 'message'
    })
  }

  /**
   * What started this turn.
   *
   * Hermes has no wire marker for a cron delivery or a DM, so the only place the
   * answer exists is the inbound row, and the only way to read that row is
   * `session.history` — which has no tail parameter and therefore returns the
   * whole transcript. That is the daemon's one costly call. It is made once per
   * finished turn in a watched chat, and only when somebody is registered at
   * all; a failure degrades to "the owner typed", which produces an ordinary
   * message notification rather than none.
   */
  private async classifyTurn(session: WatchedSession): Promise<ReturnType<typeof lastInboundRow>> {
    try {
      const history = await this.options.link.request<{ messages?: unknown }>('session.history', {
        session_id: session.sessionId
      })

      return lastInboundRow(Array.isArray(history?.messages) ? (history.messages as Record<string, unknown>[]) : [])
    } catch {
      return { kind: 'message', name: '', body: '' }
    }
  }

  /** Decide, dedupe, rate-limit and send. The single exit for every notification. */
  private async notify(
    event: NotifiableEvent,
    dedupeKey: string,
    options: { suppressWhenAttached: boolean }
  ): Promise<void> {
    const state = this.options.state

    if (state.sent[dedupeKey]) {
      return
    }

    // Claimed BEFORE the grace pause, not after: two events racing through the
    // same key — a live frame and its replayed twin — must not both get past
    // this line and both buzz.
    state.sent[dedupeKey] = this.now

    if (options.suppressWhenAttached) {
      const sleep =
        this.options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms).unref()))
      await sleep(this.options.openingGraceMs ?? OPENING_GRACE_MS)
      await this.refreshRegistrations(true)

      if (someoneAttached(this.roster.push, this.now, this.options.attachedWindowSeconds ?? ATTACHED_WINDOW_SECONDS)) {
        this.log(`push: ${event.bot} — somebody is reading; not notifying`)
        await this.options.save()

        return
      }
    } else {
      await this.refreshRegistrations()
    }

    const audience = registrationsFor(this.roster.push, event.type).filter(
      registration => !state.invalid[registration.installationId] && this.allow(registration.installationId)
    )

    if (!audience.length) {
      await this.options.save()

      return
    }

    // One send per preview setting: the same event, said two ways, because the
    // decision is the registration's and not the event's.
    for (const preview of [false, true]) {
      const targets = audience.filter(registration => registration.preview === preview)

      if (!targets.length) {
        continue
      }

      const { dead } = await this.options.sender.send(targets, pushMessageFor(event, preview))

      for (const installationId of dead) {
        state.invalid[installationId] = this.now
      }
    }

    this.log(`push: ${event.bot} — ${event.type} to ${String(audience.length)} device(s)`)
    await this.options.save()
  }

  /**
   * A token bucket per device.
   *
   * Held in memory rather than in the state file on purpose: a restart clearing
   * it is the safe direction, because the dedupe keys ARE persisted and they are
   * what stops the same event being sent twice. This limit exists for a bot in a
   * loop producing a hundred DIFFERENT events, which is not something a restart
   * should be able to un-decide either — but a rate limit that survives a crash
   * is a silence nobody can explain.
   */
  private allow(installationId: string): boolean {
    const { burst, windowSeconds } = this.options.rateLimit ?? {
      burst: RATE_LIMIT_BURST,
      windowSeconds: RATE_LIMIT_WINDOW_SECONDS
    }
    const now = this.now
    const recent = (this.rateLimit.get(installationId) ?? []).filter(at => now - at < windowSeconds)

    if (recent.length >= burst) {
      this.rateLimit.set(installationId, recent)

      return false
    }

    recent.push(now)
    this.rateLimit.set(installationId, recent)

    return true
  }
}

/** The one line a request carries that a device with `preview` on may see. */
function previewOfRequest(params: Record<string, unknown>): string {
  for (const key of ['command', 'description', 'question', 'prompt', 'title']) {
    const value = params[key]

    if (typeof value === 'string' && value) {
      return value
    }
  }

  return ''
}
