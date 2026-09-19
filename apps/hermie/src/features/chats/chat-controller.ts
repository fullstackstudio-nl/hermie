/**
 * The chat controller: the only thing in the app that talks to the gateway
 * about a transcript.
 *
 * Three rules shape the whole file.
 *
 * **Every opened chat stays live.** Leaving the screen does not detach. A bot
 * that receives a teammate's DM only streams it into a chat that is resumed, so
 * closing on navigation would turn bot-to-bot traffic into a silent list of
 * missed messages the user has to go looking for.
 *
 * **Runtime ids are never persisted.** The gateway hands out a new runtime
 * `session_id` every time it rebuilds a session, and every event and every
 * server request is addressed by that id. What is persisted is the canonical
 * chat's durable id; the runtime id lives in `runtimeToBot` and is dropped on
 * `session.reclaimed`.
 *
 * **A turn nobody here started is a foreign turn.** The reducer stands a
 * placeholder in, and this fills it with a short tail fetch. That covers a
 * teammate bot writing into the chat, the same chat open on a desktop, and a
 * cron job delivering into it.
 */
import { assertDesktopContract, type ConnectionStatus } from '@hermie/gateway-client'
import {
  applySubagentSnapshot,
  type ChatState,
  type ResumeSnapshot,
  type RowShape,
  rowsToItems,
  snapshotForCache,
  stateFromCache,
  type SubagentSnapshotRow,
  type TranscriptEvent,
  type TranscriptItem,
  type TranscriptRow
} from '@hermie/transcript'
import type {
  CommandsCatalogResult,
  CompletionItem,
  OpenRequestEntry,
  SessionLiveInfo,
  SessionResumeResult
} from '@hermes/shared/gateway-contract'
import type { ServerRequest as GatewayServerRequest } from '@hermes/shared/json-rpc-channel'

import type { ChatGateway } from '../../gateway/link'
import type { ChatCache } from '../../platform/chat-cache'
import type { Bot, BotCanonicalSession, BotsState } from '../../store/bots'
import type { ChatsState } from '../../store/chats'
import { liveChatNames } from '../../store/chats'
import type { BotsController } from '../bots/bots-controller'

/** Above this many rows, `session.history` is a download; the REST tail is not. */
export const REST_HISTORY_THRESHOLD = 400

/** Rows the REST transcript hands back for a full load. */
export const REST_HISTORY_LIMIT = 200

/** Rows a tail reconcile asks for. Enough to cover one foreign turn. */
export const TAIL_ROW_LIMIT = 30

/** `sessions.changed` fires roughly per tick; one sweep per burst is enough. */
export const SESSIONS_CHANGED_DEBOUNCE_MS = 500

/** Approval poll cadence while a turn is running and the app is in front. */
export const APPROVAL_POLL_MS = 30_000

/**
 * How often a chat with live children re-reads `subagent.list`.
 *
 * `subagent.*` has no replay, so a chat opened halfway through a delegation
 * never saw the children start. The roster is the only way to learn about them,
 * and once it has, the events carry the rest.
 */
export const SUBAGENT_RECONCILE_MS = 5_000

/** Rows the Activity screen's background load asks for per bot. */
export const ACTIVITY_TAIL_LIMIT = 50

/**
 * Terminal width the gateway lays its transcript out for.
 *
 * Every `session.resume` carries it. A resume that omits it silently re-lays
 * the session at the gateway's 80-column default, which rewraps everything the
 * chat has already shown.
 */
export const RESUME_COLS = 96

/**
 * Server requests held for a session that is not bound yet, per session.
 *
 * A bound session flushes in the same tick, so this only ever holds the handful
 * of requests one resume replays. The cap is there because a session id the
 * app never binds — another surface's chat on the same socket — would otherwise
 * accumulate for the life of the process.
 */
export const MAX_PARKED_REQUESTS = 16

/** The delivery runner a `message_agent` hand-off spawns (`tools/bot_mode_dm.py`). */
export const DM_DELIVERY_MARKER = 'bot_mode_dm.py --run-delivery'

type StoreApi<T> = {
  getState: () => T
  setState: (partial: Partial<T>) => void
}

export interface ChatControllerOptions {
  gateway: ChatGateway
  chats: StoreApi<ChatsState>
  bots: StoreApi<BotsState>
  botsController: BotsController
  cache?: ChatCache | null
  now?: () => number
}

export type ChatOptionKey = 'yolo' | 'fast' | 'reasoning' | 'model'

export interface SetOptionResult {
  /** The gateway wants an explicit confirmation before switching to this model. */
  confirmRequired?: boolean
  confirmMessage?: string
  warning?: string
}

interface PendingRequest {
  botName: string
  request: GatewayServerRequest
}

export class ChatController {
  private readonly gateway: ChatGateway
  private readonly chats: StoreApi<ChatsState>
  private readonly bots: StoreApi<BotsState>
  private readonly botsController: BotsController
  private readonly cache: ChatCache | null
  private readonly now: () => number

  private unsubscribes: (() => void)[] = []
  /** Approval request ids already acknowledged, so the ack is sent once. */
  private readonly acknowledged = new Set<string>()

  /** The gateway's model inventory, read once per connection. */
  private models: ModelChoice[] | null = null
  private modelsInFlight: Promise<ModelChoice[]> | null = null

  /** Live server→client requests, by JSON-RPC request id, so a card can answer. */
  private readonly pending = new Map<string, PendingRequest>()
  /**
   * Requests whose session is not bound yet, by runtime session id.
   *
   * The channel replays `open_requests` from a `session.resume` result BEFORE
   * resolving the call, so the approvals a reconnect inherits arrive a tick
   * before anything knows which bot owns them. Declining one is not a neutral
   * "not mine": the gateway reads the -32601 as "this client cannot answer"
   * and WITHDRAWS the approval, so the question the agent is parked on simply
   * disappears. They wait here instead and go in on `bindRuntime`.
   */
  private readonly parked = new Map<string, GatewayServerRequest[]>()
  private readonly opening = new Map<string, Promise<void>>()
  private readonly slashCatalogs = new Map<string, CommandsCatalogResult>()
  private sessionsChangedTimer: ReturnType<typeof setTimeout> | undefined
  private approvalPollTimer: ReturnType<typeof setInterval> | undefined
  private subagentPollTimer: ReturnType<typeof setInterval> | undefined
  private foregrounded = true
  private sawReady = false
  private started = false

  constructor(options: ChatControllerOptions) {
    this.gateway = options.gateway
    this.chats = options.chats
    this.bots = options.bots
    this.botsController = options.botsController
    this.cache = options.cache ?? null
    this.now = options.now ?? (() => Date.now())
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  start(): void {
    if (this.started) {
      return
    }

    this.started = true
    this.unsubscribes.push(
      this.gateway.onAny(event => this.onEvent(event as TranscriptEvent)),
      this.gateway.onRequest(request => this.onServerRequest(request)),
      this.gateway.onStatus(status => this.onStatus(status))
    )
  }

  stop(): void {
    for (const unsubscribe of this.unsubscribes) {
      unsubscribe()
    }

    this.unsubscribes = []
    this.started = false
    this.clearSessionsChangedTimer()
    this.stopApprovalPoll()
    this.stopSubagentPoll()
    this.pending.clear()
    this.parked.clear()
    this.acknowledged.clear()
    this.opening.clear()
    this.slashCatalogs.clear()
  }

  // ── opening a chat ─────────────────────────────────────────────────────────

  /**
   * Open a bot's canonical chat and leave it live.
   *
   * Calling this for a chat that is already live is cheap on purpose — the
   * roster calls it on every tap — but it is never two hydrations at once.
   */
  openChat(bot: Bot): Promise<void> {
    const existing = this.opening.get(bot.name)

    if (existing) {
      return existing
    }

    const run = this.hydrate(bot).finally(() => {
      this.opening.delete(bot.name)
    })

    this.opening.set(bot.name, run)

    return run
  }

  private async hydrate(bot: Bot): Promise<void> {
    const chats = this.chats.getState()
    const canonical = await this.botsController.resolveCanonical(bot)

    chats.ensure(bot.name, { storedSessionId: canonical.id, resolvedSessionId: canonical.resolvedId })

    // 1. The cache paints first, so the thread is on screen before the socket
    //    has answered. Reconciliation below keeps the item ids it painted.
    await this.paintFromCache(bot.name, canonical.id, canonical.resolvedId)

    this.chats.getState().setHydration(bot.name, 'hydrating')

    let resume: SessionResumeResult

    try {
      resume = await this.gateway.request('session.resume', {
        session_id: canonical.id,
        profile: bot.name,
        omit_messages: true,
        source: 'hermie',
        cols: RESUME_COLS
      })
    } catch (error) {
      this.chats.getState().setHydration(bot.name, 'error')

      throw error
    }

    // 2. Refuse a gateway too old to send the events this transcript is made of,
    //    before anything half-renders.
    assertDesktopContract(resume.info as SessionLiveInfo | undefined)

    const runtimeId = typeof resume.session_id === 'string' ? resume.session_id : ''

    if (!runtimeId) {
      // Every event and every server request is addressed by this id. Binding
      // an empty one routes the whole session to nobody, which reads as a chat
      // that opened fine and then never said anything again.
      this.chats.getState().setHydration(bot.name, 'error')

      throw new Error(`The gateway resumed ${bot.name}'s chat without a session id.`)
    }

    const resolvedId = resume.stored_session_id || canonical.resolvedId

    this.chats.getState().ensure(bot.name, { storedSessionId: canonical.id, resolvedSessionId: resolvedId })
    this.bindRuntime(bot.name, runtimeId)
    this.chats.getState().markLive(bot.name)

    // 3. History. Either transport projects onto the same items, which is what
    //    lets the reconcile below keep every id it already handed out.
    const messageCount = resume.message_count ?? canonical.messageCount
    const history = await this.loadHistory(runtimeId, resolvedId, bot.name, messageCount)

    if (history.rows.length) {
      this.chats.getState().applyHistory(bot.name, rowsToItems(history.rows, history.shape))
    }

    // 4. The in-flight tail the persisted rows do not contain yet.
    this.chats.getState().applySnapshot(bot.name, resumeSnapshotOf(resume))
    this.registerOpenRequests(bot.name, resume.open_requests ?? null)

    // 5. Anything that happened between the history read and now.
    await this.replaySince(bot.name, runtimeId)

    this.chats.getState().setHydration(bot.name, 'live')
    // Seen as of NOW, not as of the roster's `last_active`: the roster row can
    // be a minute old, and a chat the user is looking at is read.
    this.bots.getState().markSeen(bot.name, Math.floor(this.now() / 1000))
    this.syncApprovalPoll()

    // A chat opened mid-delegation never saw its children start.
    await this.reconcileSubagents(bot.name)
    this.syncSubagentPoll()
  }

  private async paintFromCache(botName: string, storedId: string, resolvedId: string): Promise<void> {
    if (!this.cache) {
      return
    }

    const chat = this.chats.getState().chats[botName]

    if (chat && chat.order.length) {
      return
    }

    try {
      const row = await this.cache.read(botName)

      if (!row) {
        return
      }

      const snapshot = JSON.parse(row.itemsJson) as Parameters<typeof stateFromCache>[2]

      this.chats
        .getState()
        .hydrate(
          botName,
          stateFromCache(botName, { storedSessionId: storedId, resolvedSessionId: resolvedId }, snapshot)
        )
    } catch {
      // A cache that cannot be read is a cache that is not used. The gateway is
      // the source of truth either way.
    }
  }

  /**
   * History rows for a chat.
   *
   * `session.history` is unpaginated, so a chat with thousands of rows is a
   * multi-megabyte download on every open. Past the threshold the REST
   * transcript's newest 200 rows are enough to render, and a gateway without
   * that endpoint falls back to the RPC.
   */
  private async loadHistory(
    runtimeId: string,
    resolvedId: string,
    profile: string,
    messageCount: number
  ): Promise<{ rows: TranscriptRow[]; shape: RowShape }> {
    if (messageCount > REST_HISTORY_THRESHOLD) {
      const rows = await this.gateway.fetchMessages(resolvedId, { limit: REST_HISTORY_LIMIT, order: 'latest' })

      if (rows) {
        return { rows, shape: 'rest' }
      }
    }

    const result = await this.gateway.request('session.history', { session_id: runtimeId, profile })

    return { rows: (result?.messages ?? []) as TranscriptRow[], shape: 'rpc' }
  }

  /**
   * Fold in the events that landed since our watermark.
   *
   * A cold chat has no watermark, and asking for everything since zero would
   * replay a turn the history read already contains. So a cold hydration adopts
   * `latest_seq` without applying the events; a warm one (a cached chat, a
   * reconnect) applies them. A `truncated` reply or a changed epoch means the
   * ring no longer reaches back far enough and only a full re-hydration is
   * honest — the caller is already doing one.
   */
  private async replaySince(botName: string, runtimeId: string): Promise<void> {
    const chat = this.chats.getState().chats[botName]

    if (!chat) {
      return
    }

    const knownEpoch = chat.epoch
    let result

    try {
      result = await this.gateway.request('session.events.since', {
        session_id: runtimeId,
        last_seen: chat.lastSeq
      })
    } catch {
      // The replay is an optimisation over the history read that just ran; a
      // failure costs the events of the last few seconds, which the socket
      // delivers anyway.
      return
    }

    if (!result) {
      return
    }

    // The epoch identifies the gateway process that did the numbering. A
    // different one restarted under us and began counting at 1 again, so every
    // seq we hold describes a different sequence and the ring's contents cannot
    // be lined up against them.
    const epochChanged = knownEpoch !== undefined && knownEpoch !== result.epoch
    const cold = chat.lastSeq === 0 || epochChanged

    if (cold || result.truncated) {
      // Adopt the watermark without replaying: history already describes this.
      this.chats.getState().update(botName, state => ({
        ...state,
        lastSeq: epochChanged ? result.latest_seq : Math.max(state.lastSeq, result.latest_seq),
        lastSeqSessionId: runtimeId,
        epoch: result.epoch
      }))
    } else {
      for (const raw of Array.isArray(result.events) ? result.events : []) {
        const event = transcriptEventOf(raw)

        if (event) {
          this.chats.getState().dispatchEvent(botName, event)
        }
      }

      this.chats
        .getState()
        .update(botName, state => (state.epoch === result.epoch ? state : { ...state, epoch: result.epoch }))
    }

    this.registerOpenRequests(botName, result.open_requests ?? null)
  }

  /**
   * Rebuild the cards for requests the agent is still waiting on.
   *
   * These arrive without a live JSON-RPC handle, so answering one goes out as
   * `approval.respond` / `clarify.lock` rather than as a reply to the request.
   */
  private registerOpenRequests(botName: string, entries: OpenRequestEntry[] | null): void {
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (typeof entry?.id !== 'string' || typeof entry.method !== 'string') {
        continue
      }

      this.chats.getState().dispatchServerRequest(botName, {
        id: entry.id,
        method: entry.method,
        params: entry.params && typeof entry.params === 'object' ? entry.params : {},
        replayed: true
      })
    }
  }

  // ── events ─────────────────────────────────────────────────────────────────

  private onEvent(event: TranscriptEvent): void {
    if (event.type === 'sessions.changed') {
      this.scheduleSessionsChanged()

      return
    }

    if (event.type === 'cron.changed') {
      // The routines feature owns this one; nothing in a transcript changes.
      return
    }

    const sessionId = event.session_id

    if (!sessionId) {
      return
    }

    const botName = this.chats.getState().runtimeToBot[sessionId]

    if (!botName) {
      return
    }

    if (event.type === 'session.reclaimed') {
      // Another client took the session over. The transcript is still true; the
      // attachment is not. Keep the items, drop the id, re-resume on next focus.
      this.chats.getState().dispatchEvent(botName, event)
      this.chats.getState().dropRuntime(botName)
      this.chats.getState().setHydration(botName, 'stale')

      return
    }

    this.chats.getState().dispatchEvent(botName, event)

    if (event.type === 'request.cancel' || event.type === 'message.complete' || event.type === 'error') {
      // A withdrawn question and a finished turn both close cards. The handles
      // behind them answer nothing from here on, and a chat left open for days
      // would otherwise keep every one it ever saw.
      this.pruneRequests(botName)
    }

    if (event.type === 'message.start' || event.type === 'message.complete') {
      this.syncApprovalPoll()
      this.syncSubagentPoll()
    }

    if (event.type.startsWith('subagent.')) {
      this.syncSubagentPoll()
    }

    if (event.type === 'message.complete') {
      const chat = this.chats.getState().chats[botName]

      if (chat?.turn.foreignReconcilePending) {
        void this.reconcileTailFor(botName)
      }

      void this.persist(botName)
    }
  }

  private scheduleSessionsChanged(): void {
    this.clearSessionsChangedTimer()
    this.sessionsChangedTimer = setTimeout(() => {
      this.sessionsChangedTimer = undefined
      void this.sweep()
    }, SESSIONS_CHANGED_DEBOUNCE_MS)
  }

  private clearSessionsChangedTimer(): void {
    if (this.sessionsChangedTimer !== undefined) {
      clearTimeout(this.sessionsChangedTimer)
      this.sessionsChangedTimer = undefined
    }
  }

  /**
   * One `sessions.changed` sweep: refresh the roster, and tail-reconcile every
   * live chat that is not mid-turn. A chat that IS mid-turn is receiving the
   * truth on the socket already, and a tail fetch racing it would fight the
   * bubble being streamed.
   */
  private async sweep(): Promise<void> {
    const names = liveChatNames(this.chats.getState())

    await Promise.all([
      this.botsController.refresh().catch(() => undefined),
      ...names.map(name => {
        const chat = this.chats.getState().chats[name]

        return chat && !chat.turn.active ? this.reconcileTailFor(name) : Promise.resolve()
      })
    ])
  }

  /** Fetch the newest rows and fold them in: fills foreign placeholders, joins DM replies. */
  async reconcileTailFor(botName: string): Promise<void> {
    const chat = this.chats.getState().chats[botName]

    if (!chat) {
      return
    }

    let rows = await this.gateway.fetchMessages(chat.resolvedSessionId, {
      limit: TAIL_ROW_LIMIT,
      order: 'latest'
    })

    if (rows === null) {
      if (!chat.runtimeSessionId) {
        return
      }

      try {
        const result = await this.gateway.request('session.history', {
          session_id: chat.runtimeSessionId,
          profile: botName
        })

        rows = ((result?.messages ?? []) as TranscriptRow[]).slice(-TAIL_ROW_LIMIT)
      } catch {
        return
      }
    }

    if (!rows.length) {
      return
    }

    this.chats.getState().applyTail(botName, rowsToItems(rows, 'rest'))
  }

  // ── connection status ──────────────────────────────────────────────────────

  private onStatus(status: ConnectionStatus): void {
    if (status !== 'ready') {
      if (status === 'disconnected' || status === 'reconnecting' || status === 'paused' || status === 'offline') {
        this.stopApprovalPoll()
        this.stopSubagentPoll()
      }

      return
    }

    if (!this.sawReady) {
      // The first ready of the process is not a reconnect; nothing is live yet.
      this.sawReady = true

      return
    }

    void this.recoverAfterReconnect()
  }

  /**
   * Come back from a dropped socket.
   *
   * Two things can have happened while we were away: the session was rebuilt
   * (so the runtime id changed and every subscription is addressed at a dead
   * id), and rows were written we never saw. The first is fixed by re-resuming
   * every live chat; the second by comparing the roster's message counts with
   * what each chat holds and re-reading history only where they disagree.
   */
  private async recoverAfterReconnect(): Promise<void> {
    const names = liveChatNames(this.chats.getState())

    if (!names.length) {
      return
    }

    const bots = await this.botsController.refresh().catch(() => [] as Bot[])
    const byName = new Map(bots.map(bot => [bot.name, bot]))

    await Promise.all(
      names.map(async name => {
        const chat = this.chats.getState().chats[name]

        if (!chat) {
          return
        }

        try {
          const resume = await this.gateway.request('session.resume', {
            session_id: chat.storedSessionId,
            profile: name,
            omit_messages: true,
            source: 'hermie',
            cols: RESUME_COLS
          })

          if (typeof resume.session_id !== 'string' || !resume.session_id) {
            throw new Error(`The gateway resumed ${name}'s chat without a session id.`)
          }

          this.bindRuntime(name, resume.session_id)
          this.chats.getState().applySnapshot(name, resumeSnapshotOf(resume))
          this.registerOpenRequests(name, resume.open_requests ?? null)
          await this.replaySince(name, resume.session_id)

          const expected = byName.get(name)?.canonical?.messageCount ?? 0

          if (expected > countPersistedRows(chat)) {
            await this.reconcileTailFor(name)
          }

          this.chats.getState().setHydration(name, 'live')
        } catch {
          this.chats.getState().setHydration(name, 'stale')
        }
      })
    )

    this.syncApprovalPoll()
  }

  // ── server→client requests ─────────────────────────────────────────────────

  private onServerRequest(request: GatewayServerRequest): boolean {
    if (request.method !== 'approval' && request.method !== 'clarify') {
      // Everything else (sudo, secret, vault, preview, terminal, window, tour)
      // belongs to a surface this app does not have. Declining lets the channel
      // answer -32601, which withdraws the request instead of parking the agent.
      return false
    }

    const sessionId = typeof request.params.session_id === 'string' ? request.params.session_id : ''
    const botName = sessionId ? this.chats.getState().runtimeToBot[sessionId] : undefined

    if (botName) {
      this.deliverServerRequest(botName, request)

      return true
    }

    return sessionId ? this.park(sessionId, request) : false
  }

  /** Hold a request until its session is bound. False means "we cannot take it". */
  private park(sessionId: string, request: GatewayServerRequest): boolean {
    const queue = this.parked.get(sessionId) ?? []

    if (queue.length >= MAX_PARKED_REQUESTS) {
      return false
    }

    queue.push(request)
    this.parked.set(sessionId, queue)

    return true
  }

  /** Bind a runtime id to a bot and hand over whatever was waiting on it. */
  private bindRuntime(botName: string, runtimeSessionId: string): void {
    const previous = this.chats.getState().chats[botName]?.runtimeSessionId

    if (previous && previous !== runtimeSessionId) {
      // The catalogue is a per-session fact and the old session is gone.
      this.slashCatalogs.delete(previous)
      this.parked.delete(previous)
    }

    this.chats.getState().bindRuntime(botName, runtimeSessionId)

    const waiting = this.parked.get(runtimeSessionId)

    if (!waiting?.length) {
      return
    }

    this.parked.delete(runtimeSessionId)

    for (const request of waiting) {
      this.deliverServerRequest(botName, request)
    }
  }

  /**
   * Put one request on screen and remember how to answer it.
   *
   * The reducer may fold this onto a card it already holds for the same
   * approval-queue entry — a replayed snapshot and the live request are one
   * question under two transport ids. When it does, the live reply handle is
   * filed under the card's id, so answering what the user can actually see
   * still resolves the request the agent is waiting on.
   */
  private deliverServerRequest(botName: string, request: GatewayServerRequest): void {
    this.chats.getState().dispatchServerRequest(botName, {
      id: request.id,
      method: request.method,
      params: request.params,
      ...(request.replayed ? { replayed: true } : {})
    })

    const chat = this.chats.getState().chats[botName]
    const cardId = chat?.byRequestId[request.id]
      ? request.id
      : approvalCardIdFor(chat, typeof request.params.request_id === 'string' ? request.params.request_id : '')

    if (cardId) {
      this.pending.set(cardId, { botName, request })

      if (request.method === 'approval') {
        void this.acknowledgeApproval(botName, cardId)
      }
    }

    this.syncApprovalPoll()
  }

  /**
   * Forget the bookkeeping behind cards that are no longer open.
   *
   * `pending` holds a JSON-RPC reply handle and `acknowledged` a request id;
   * neither means anything once the card has been answered, cancelled or
   * withdrawn, and a chat that stays live for a working day accumulates both.
   */
  private pruneRequests(botName: string): void {
    const chat = this.chats.getState().chats[botName]

    if (!chat) {
      return
    }

    const stillOpen = (requestId: string): boolean => {
      const itemId = chat.byRequestId[requestId]
      const item = itemId ? chat.items[itemId] : undefined

      return (item?.kind === 'approval' || item?.kind === 'clarify') && item.state === 'open'
    }

    for (const [requestId, entry] of this.pending) {
      if (entry.botName === botName && !stillOpen(requestId)) {
        this.pending.delete(requestId)
      }
    }

    for (const requestId of this.acknowledged) {
      if (chat.byRequestId[requestId] && !stillOpen(requestId)) {
        this.acknowledged.delete(requestId)
      }
    }
  }

  /**
   * Tell the queue a human is looking at this approval.
   *
   * It is an acknowledgement, not an answer: the agent keeps waiting until a
   * choice comes back, but the queue stops counting the request down as
   * unseen. Sent once per request — a card that arrives on the socket is
   * acknowledged on arrival, and one rebuilt from a resume snapshot or from
   * the pending poll is acknowledged when the sheet first shows it, so the
   * screen may call this freely.
   */
  async acknowledgeApproval(botName: string, requestId: string): Promise<void> {
    if (this.acknowledged.has(requestId)) {
      return
    }

    const chat = this.chats.getState().chats[botName]
    const sessionId = chat?.runtimeSessionId

    if (!sessionId) {
      return
    }

    const itemId = chat?.byRequestId[requestId]
    const item = itemId ? chat?.items[itemId] : undefined
    const approvalId = item?.kind === 'approval' && item.approvalId ? item.approvalId : requestId

    this.acknowledged.add(requestId)

    try {
      await this.gateway.request('approval.received', { session_id: sessionId, request_id: approvalId })
    } catch {
      // The ack is a courtesy to the queue's timeout, never a precondition for
      // answering; a failed one must not keep the sheet off the screen.
    }
  }

  /**
   * Answer an approval.
   *
   * A request is answered on its own JSON-RPC reply, which is what the queue is
   * waiting on. That includes one replayed out of `open_requests`: the channel
   * re-delivers it over the socket that owns it, so its reply frame is as live
   * as any other.
   *
   * What has no frame is a card synthesized from the `pending_approval` resume
   * field or from the `approval.pending` poll — those are queue entries, never
   * transported requests. They go out as `approval.respond` against the queue
   * entry's own id instead.
   */
  async respondApproval(botName: string, requestId: string, choice: string, all = false): Promise<void> {
    const chat = this.chats.getState().chats[botName]
    const itemId = chat?.byRequestId[requestId]
    const item = itemId ? chat?.items[itemId] : undefined
    const approvalId = item?.kind === 'approval' ? item.approvalId : requestId
    const live = this.pending.get(requestId)
    const result = { choice, ...(all ? { all: true } : {}) }

    this.chats.getState().answer(botName, requestId, choice)
    this.acknowledged.delete(requestId)

    if (live) {
      this.pending.delete(requestId)
      live.request.respond(result)
    } else if (approvalId && chat?.runtimeSessionId) {
      await this.gateway.request('approval.respond', {
        session_id: chat.runtimeSessionId,
        profile: botName,
        choice,
        ...(all ? { all: true } : {}),
        request_id: approvalId
      })
    } else {
      // No queue id to address and no reply frame to make. `request.answer` is
      // the gateway's proxy for exactly that: it settles the open request by
      // its own id, with the result the reply frame would have carried.
      await this.gateway.request('request.answer', { id: requestId, result, profile: botName })
    }

    this.syncApprovalPoll()
  }

  /**
   * Answer one clarify question.
   *
   * A live request is answered on its own reply frame. A replayed one has no
   * frame to answer, and `clarify.lock` cannot stand in for every shape: the
   * gateway only accepts a lock for a BATCH clarify and reports `expired` for a
   * single-question one, which would leave the agent waiting on a question the
   * user has already answered. `request.answer` settles an open request by its
   * id and is the path for that case.
   */
  async respondClarify(botName: string, requestId: string, answers: Record<string, string>): Promise<void> {
    const chat = this.chats.getState().chats[botName]
    const itemId = chat?.byRequestId[requestId]
    const item = itemId ? chat?.items[itemId] : undefined
    const clarify = item?.kind === 'clarify' ? item : undefined
    const live = this.pending.get(requestId)

    this.chats.getState().answer(botName, requestId, answers)

    const complete = clarify ? clarify.questions.every(question => answers[question.qid] !== undefined) : true
    // The wire shape follows the question shape: a batch answers `answers` by
    // qid, a single question answers the bare `answer` the gateway reads.
    const result = clarify?.batch ? { answers } : { answer: Object.values(answers)[0] ?? '' }

    if (live && complete) {
      this.pending.delete(requestId)
      this.acknowledged.delete(requestId)
      live.request.respond(result)

      return
    }

    if (!live && (complete || !clarify?.batch)) {
      await this.gateway.request('request.answer', { id: requestId, result, profile: botName })

      return
    }

    for (const [qid, answer] of Object.entries(answers)) {
      await this.lockClarify(botName, requestId, qid, answer)
    }
  }

  /** Lock one answer of a batch clarify without resolving the whole request. */
  async lockClarify(botName: string, requestId: string, questionId: string, answer: string): Promise<void> {
    this.chats.getState().answer(botName, requestId, { [questionId]: answer })

    await this.gateway.request('clarify.lock', {
      request_id: requestId,
      question_id: questionId,
      answer,
      profile: botName
    })
  }

  // ── sending ────────────────────────────────────────────────────────────────

  /**
   * Submit a prompt.
   *
   * The user's message is painted before the round trip and settled against
   * `prompt.submit`'s status afterwards — `queued` keeps it pending behind the
   * running turn, `steered` folds it into that turn, `streaming` starts a new
   * one. Images are attached first: they are queued onto the next turn, so the
   * order matters.
   */
  async send(botName: string, text: string, attachments: AttachmentInput[] = []): Promise<void> {
    const chat = this.chats.getState().chats[botName]

    if (!chat?.runtimeSessionId) {
      throw new Error(`${botName}'s chat is not attached to the gateway yet.`)
    }

    const sessionId = chat.runtimeSessionId

    this.chats
      .getState()
      .beginTurn(botName, text, attachments.length ? attachments.map(file => file.filename) : undefined)

    try {
      for (const file of attachments) {
        await this.gateway.request('image.attach_bytes', {
          session_id: sessionId,
          profile: botName,
          content_base64: file.base64,
          filename: file.filename
        })
      }

      const result = await this.gateway.request('prompt.submit', {
        session_id: sessionId,
        profile: botName,
        text
      })

      this.chats.getState().settleTurn(botName, { status: result?.status ?? null })
      this.syncApprovalPoll()
    } catch (error) {
      // The optimistic bubble stays — the text is the user's, not ours to throw
      // away — but the turn is not running, so the composer comes back.
      this.chats.getState().interrupt(botName)

      throw error
    }
  }

  /** Stop the running turn. The partial reply is kept; it was really said. */
  async stopTurn(botName: string): Promise<void> {
    const chat = this.chats.getState().chats[botName]

    if (!chat?.runtimeSessionId) {
      return
    }

    try {
      await this.gateway.request('session.interrupt', { session_id: chat.runtimeSessionId, profile: botName })
    } finally {
      this.chats.getState().interrupt(botName)
      this.syncApprovalPoll()
    }
  }

  // ── subagents ──────────────────────────────────────────────────────────────

  async steerSubagent(botName: string, subagentId: string, text: string): Promise<string> {
    const sessionId = this.requireRuntime(botName)
    const result = await this.gateway.request('subagent.steer', {
      session_id: sessionId,
      profile: botName,
      subagent_id: subagentId,
      text
    })

    return result?.status ?? 'queued'
  }

  async interruptSubagent(botName: string, subagentId: string): Promise<boolean> {
    const sessionId = this.requireRuntime(botName)
    const result = await this.gateway.request('subagent.interrupt', {
      session_id: sessionId,
      profile: botName,
      subagent_id: subagentId
    })

    return result?.found === true
  }

  async tailSubagent(botName: string, subagentId: string): Promise<string> {
    const sessionId = this.requireRuntime(botName)
    const result = await this.gateway.request('subagent.tail', {
      session_id: sessionId,
      profile: botName,
      subagent_id: subagentId
    })

    return result?.available === false ? '' : (result?.text ?? '')
  }

  /**
   * The child's OWN transcript, read the same way a chat is.
   *
   * `subagent.tail` is a live stream tail and stops existing the moment the
   * child does. A child that reported a `child_session_id` has a real stored
   * session behind it, and that one can still be read afterwards — which is
   * what makes "Open transcript" worth offering on a finished child at all.
   */
  async childTranscript(botName: string, childSessionId: string): Promise<TranscriptItem[]> {
    const rows = await this.gateway.fetchMessages(childSessionId, { limit: REST_HISTORY_LIMIT, order: 'latest' })

    if (rows?.length) {
      return [...rowsToItems(rows, 'rest')]
    }

    const result = await this.gateway.request('session.history', { session_id: childSessionId, profile: botName })

    return [...rowsToItems((result?.messages ?? []) as TranscriptRow[], 'rpc')]
  }

  /**
   * Fold the gateway's live-children roster into a chat.
   *
   * Cheap and idempotent: an empty roster is a no-op in the reducer, and a
   * child the events already described is refreshed rather than duplicated.
   */
  async reconcileSubagents(botName: string): Promise<void> {
    const chat = this.chats.getState().chats[botName]

    if (!chat?.runtimeSessionId) {
      return
    }

    try {
      const result = await this.gateway.request('subagent.list', {
        session_id: chat.runtimeSessionId,
        profile: botName
      })

      const rows = (result?.subagents ?? []) as SubagentSnapshotRow[]

      if (rows.length) {
        this.chats.getState().update(botName, state => applySubagentSnapshot(state, rows, this.now()))
      }
    } catch {
      // A gateway without `subagent.list` still streams `subagent.*`; the
      // roster is a recovery path, never the only one.
    }
  }

  /**
   * Poll `subagent.list` while anything is delegating.
   *
   * Reference-free and idempotent: it turns itself off the moment no live chat
   * has a running child or an active turn, so an idle app polls nothing.
   */
  private syncSubagentPoll(): void {
    const busy = liveChatNames(this.chats.getState()).some(name => {
      const chat = this.chats.getState().chats[name]

      if (!chat) {
        return false
      }

      return (
        chat.turn.active ||
        Object.values(chat.subagents).some(child => child.status === 'running' || child.status === 'queued')
      )
    })

    if (busy && this.foregrounded) {
      if (this.subagentPollTimer === undefined) {
        this.subagentPollTimer = setInterval(() => {
          for (const name of liveChatNames(this.chats.getState())) {
            void this.reconcileSubagents(name)
          }
        }, SUBAGENT_RECONCILE_MS)
      }

      return
    }

    this.stopSubagentPoll()
  }

  private stopSubagentPoll(): void {
    if (this.subagentPollTimer !== undefined) {
      clearInterval(this.subagentPollTimer)
      this.subagentPollTimer = undefined
    }
  }

  // ── the activity timeline ──────────────────────────────────────────────────

  /**
   * Load one bot's recent transcript WITHOUT attaching to its session.
   *
   * The Activity screen is a view over the chat store, so a bot nobody has
   * opened has nothing to show. This fills that gap with the cheapest read that
   * exists — the REST tail under the canonical chat's resolved id — and puts
   * the rows through the same `rowsToItems` every other path uses, so opening
   * the chat afterwards reconciles onto the items rather than duplicating them.
   *
   * A chat that IS live is left alone: it has the truth on the socket already.
   */
  async prefetchTail(bot: Bot, limit = ACTIVITY_TAIL_LIMIT): Promise<void> {
    const existing = this.chats.getState().chats[bot.name]

    if (existing && (this.chats.getState().live[bot.name] || existing.turn.active)) {
      return
    }

    let canonical: BotCanonicalSession

    try {
      canonical = await this.botsController.resolveCanonical(bot)
    } catch {
      // A bot whose chat cannot be resolved contributes nothing to the
      // timeline; it must not take the whole screen down.
      return
    }

    this.chats.getState().ensure(bot.name, {
      storedSessionId: canonical.id,
      resolvedSessionId: canonical.resolvedId
    })

    let rows = await this.gateway.fetchMessages(canonical.resolvedId, { limit, order: 'latest' })

    if (rows === null) {
      try {
        const result = await this.gateway.request('session.history', {
          session_id: canonical.id,
          profile: bot.name
        })

        rows = ((result?.messages ?? []) as TranscriptRow[]).slice(-limit)
      } catch {
        return
      }
    }

    if (!rows.length) {
      return
    }

    this.chats.getState().applyTail(bot.name, rowsToItems(rows, 'rest'))

    const chat = this.chats.getState().chats[bot.name]

    if (chat?.hydration === 'cold') {
      // Not `live`: nothing is attached. `stale` is the honest word for a
      // transcript that was read once and is not being streamed.
      this.chats.getState().setHydration(bot.name, 'stale')
    }
  }

  /**
   * The background load behind the Activity screen: every bot, in parallel.
   *
   * The roster is re-read FIRST. A bot's canonical id is the only key the tail
   * can be fetched under, and a stale one (a gateway restarted under a running
   * app, a chat recreated elsewhere) fails the fetch silently — which reads as
   * "these bots never talked to each other" rather than as the stale key it is.
   */
  async loadActivity(limit = ACTIVITY_TAIL_LIMIT): Promise<void> {
    const bots = await this.botsController.refresh().catch(() => this.bots.getState().bots)

    await Promise.all(bots.map(bot => this.prefetchTail(bot, limit).catch(() => undefined)))
  }

  /** How many sub-agents each bot has running right now (`delegation.status`). */
  async activeSubagentCount(): Promise<number> {
    const bots = this.bots.getState().bots
    const counts = await Promise.all(
      bots.map(async bot => {
        try {
          const result = await this.gateway.request('delegation.status', { profile: bot.name })

          return (result?.active ?? []).length
        } catch {
          // A gateway without delegation support reports none rather than
          // failing the whole header.
          return 0
        }
      })
    )

    return counts.reduce((sum, count) => sum + count, 0)
  }

  /**
   * Bot-to-bot deliveries still in flight.
   *
   * `agents.list` reports every background process the gateway is running, of
   * which a DM delivery is one shape: the `bot_mode_dm.py --run-delivery`
   * runner. Anything else in that list is somebody else's work.
   */
  async inFlightDeliveries(): Promise<number> {
    const bots = this.bots.getState().bots
    const counts = await Promise.all(
      bots.map(async bot => {
        try {
          const result = await this.gateway.request('agents.list', { profile: bot.name })

          return (result?.processes ?? []).filter(row => String(row.command ?? '').includes(DM_DELIVERY_MARKER)).length
        } catch {
          return 0
        }
      })
    )

    return counts.reduce((sum, count) => sum + count, 0)
  }

  // ── slash commands ─────────────────────────────────────────────────────────

  /**
   * Completions for what the user is typing.
   *
   * The catalogue is fetched once per session and kept: it is the list of every
   * command and skill this profile has, and it does not change mid-chat. The
   * per-keystroke work is `complete.slash`, which is what the gateway is built
   * to answer quickly.
   */
  async querySlash(botName: string, prefix: string): Promise<CompletionItem[]> {
    const sessionId = this.requireRuntime(botName)

    if (!this.slashCatalogs.has(sessionId)) {
      try {
        const catalog = await this.gateway.request('commands.catalog', { session_id: sessionId, profile: botName })

        this.slashCatalogs.set(sessionId, catalog ?? {})
      } catch {
        this.slashCatalogs.set(sessionId, {})
      }
    }

    try {
      const result = await this.gateway.request('complete.slash', { text: prefix, session_id: sessionId })

      return result?.items ?? []
    } catch {
      return []
    }
  }

  /** The catalogue behind `querySlash`, for a picker that wants the whole list. */
  slashCatalog(botName: string): CommandsCatalogResult | undefined {
    const chat = this.chats.getState().chats[botName]

    return chat?.runtimeSessionId ? this.slashCatalogs.get(chat.runtimeSessionId) : undefined
  }

  /**
   * Run a slash command. The gateway answers with text rather than a turn, so
   * the result lands in the transcript as a notice rather than as a reply.
   */
  async runSlash(botName: string, command: string): Promise<void> {
    const sessionId = this.requireRuntime(botName)
    const result = await this.gateway.request('slash.exec', { session_id: sessionId, command, profile: botName })
    const body = (result?.output ?? result?.message ?? result?.notice ?? '').trim()

    // `notice` carries a single line, so the command and its answer share one.
    this.chats.getState().dispatchEvent(botName, {
      type: 'notice',
      session_id: sessionId,
      payload: { message: body ? `${command} — ${body}` : `${command} ran.` }
    })

    if (result?.warning) {
      this.chats.getState().dispatchEvent(botName, {
        type: 'notice',
        session_id: sessionId,
        payload: { message: `${command} — ${result.warning}` }
      })
    }
  }

  // ── chat options ───────────────────────────────────────────────────────────

  /**
   * Set one of the chat's runtime options.
   *
   * All four are `config.set` under the hood, scoped to this session so the
   * toggle never rewrites the gateway's global configuration behind the user's
   * back. The model switch can come back asking for confirmation, which is the
   * gateway's way of saying the model is expensive; that answer is handed to
   * the caller rather than auto-confirmed.
   */
  async setOption(
    botName: string,
    key: ChatOptionKey,
    value: string,
    options: { confirmExpensiveModel?: boolean } = {}
  ): Promise<SetOptionResult> {
    const sessionId = this.requireRuntime(botName)
    const result = await this.gateway.request('config.set', {
      key,
      value,
      session_id: sessionId,
      profile: botName,
      ...(key === 'yolo' || key === 'reasoning' ? { scope: 'session' } : {}),
      ...(key === 'model' && options.confirmExpensiveModel ? { confirm_expensive_model: true } : {})
    })

    if (result?.info) {
      this.chats.getState().dispatchEvent(botName, {
        type: 'session.info',
        session_id: sessionId,
        payload: result.info
      })
    } else {
      await this.refreshOptions(botName)
    }

    return {
      ...(result?.confirm_required ? { confirmRequired: true } : {}),
      ...(result?.confirm_message ? { confirmMessage: result.confirm_message } : {}),
      ...(result?.warning ? { warning: result.warning } : {})
    }
  }

  /**
   * The gateway's model catalogue, flattened to `provider/model` ids.
   *
   * Fetched once per connection and kept: the inventory is a per-gateway fact,
   * not a per-chat one, and it is big enough that re-reading it every time the
   * options sheet opens would be felt. A gateway that cannot answer gets an
   * empty list rather than an error — the picker then shows only the model the
   * chat is already on, which is honest.
   */
  async modelOptions(): Promise<ModelChoice[]> {
    if (this.models) {
      return this.models
    }

    if (!this.modelsInFlight) {
      this.modelsInFlight = this.gateway
        .request('model.options', {})
        .then(result => {
          const choices: ModelChoice[] = []

          for (const provider of result?.providers ?? []) {
            const slug = provider.slug || provider.name || ''

            for (const model of provider.models ?? []) {
              // The inventory writes plain ids; a model already carrying its
              // provider must not be prefixed twice.
              const id = model.includes('/') ? model : slug ? `${slug}/${model}` : model

              choices.push({ id, label: model, provider: provider.name || slug })
            }
          }

          this.models = choices

          return choices
        })
        .catch(() => {
          this.models = []

          return []
        })
        .finally(() => {
          this.modelsInFlight = null
        })
    }

    return this.modelsInFlight
  }

  /**
   * Re-read the four chat options so the sheet reflects what the gateway holds.
   *
   * Deliberately NOT `session.resume`. Resuming is a write: it mints a new
   * runtime session id, rebinds the socket's transport to it and schedules an
   * agent build. Using it to answer "what model is this chat on" rebuilt the
   * session every time the options sheet opened, which invalidated the very
   * event watermark the sheet was opened alongside. `config.get` is the read.
   */
  async refreshOptions(botName: string): Promise<SessionLiveInfo | null> {
    const chat = this.chats.getState().chats[botName]
    const sessionId = chat?.runtimeSessionId

    if (!sessionId) {
      return null
    }

    const keys: ChatOptionKey[] = ['model', 'yolo', 'fast', 'reasoning']
    const values = await Promise.all(
      keys.map(async key => {
        try {
          const result = await this.gateway.request('config.get', { key, session_id: sessionId, profile: botName })

          return typeof result?.value === 'string' ? result.value : key === 'model' ? (result?.model ?? '') : ''
        } catch {
          // A gateway that cannot answer one key leaves that row as it was
          // rather than failing the whole sheet.
          return ''
        }
      })
    )

    const [model, yolo, fast, reasoning] = values
    const patch: SessionLiveInfo = {
      ...(model ? { model } : {}),
      ...(yolo ? { yolo: yolo === 'on' || yolo === '1' || yolo === 'true' } : {}),
      ...(fast ? { fast: fast === 'fast' || fast === 'on' || fast === 'true' } : {}),
      ...(reasoning ? { reasoning_effort: reasoning } : {})
    }

    if (!Object.keys(patch).length) {
      return null
    }

    // `session.info` replaces the whole record, so the four keys read here go
    // on top of what the resume reported rather than in place of it.
    const info: SessionLiveInfo = { ...this.chats.getState().chats[botName]?.info, ...patch }

    this.chats.getState().dispatchEvent(botName, {
      type: 'session.info',
      session_id: sessionId,
      payload: info
    })

    return info
  }

  // ── approvals while a turn runs ────────────────────────────────────────────

  /** The app came to the front: re-read anything the agent is still waiting on. */
  async onForeground(): Promise<void> {
    this.foregrounded = true
    this.syncApprovalPoll()
    this.syncSubagentPoll()

    await Promise.all(liveChatNames(this.chats.getState()).map(name => this.refreshPendingApprovals(name)))
  }

  onBackground(): void {
    this.foregrounded = false
    this.stopApprovalPoll()
    this.stopSubagentPoll()
  }

  /**
   * Poll for approvals only while a turn is running and the app is in front.
   *
   * The socket delivers approvals as server requests, so this is a safety net
   * for the one case that has no frame: a request written while the app was
   * detached. Polling an idle chat would be pure battery.
   */
  private syncApprovalPoll(): void {
    const busy = Object.values(this.chats.getState().chats).some(chat => chat.turn.active)

    if (busy && this.foregrounded) {
      if (this.approvalPollTimer === undefined) {
        this.approvalPollTimer = setInterval(() => {
          for (const name of liveChatNames(this.chats.getState())) {
            void this.refreshPendingApprovals(name)
          }
        }, APPROVAL_POLL_MS)
      }

      return
    }

    this.stopApprovalPoll()
  }

  private stopApprovalPoll(): void {
    if (this.approvalPollTimer !== undefined) {
      clearInterval(this.approvalPollTimer)
      this.approvalPollTimer = undefined
    }
  }

  private async refreshPendingApprovals(botName: string): Promise<void> {
    const chat = this.chats.getState().chats[botName]

    if (!chat?.runtimeSessionId) {
      return
    }

    try {
      const result = await this.gateway.request('approval.pending', {
        session_id: chat.runtimeSessionId,
        profile: botName
      })

      for (const approval of Array.isArray(result?.approvals) ? result.approvals : []) {
        const approvalId = typeof approval.request_id === 'string' ? approval.request_id : ''

        // `pending:` marks a card with no live JSON-RPC reply behind it, the
        // same shape `applyResumeSnapshot` synthesizes. The reducer folds it
        // onto the card already showing this queue entry, if there is one —
        // the poll is a safety net for questions with no card, not a second
        // copy of the ones that have.
        this.chats.getState().dispatchServerRequest(botName, {
          id: `pending:${approvalId || 'approval'}`,
          method: 'approval',
          params: approval,
          replayed: true
        })
      }
    } catch {
      // The poll is best-effort by construction.
    }
  }

  // ── cache ──────────────────────────────────────────────────────────────────

  /** Write one chat's snapshot. Called on `message.complete`, on close and on background. */
  async persist(botName: string): Promise<void> {
    const chat = this.chats.getState().chats[botName]

    if (!this.cache || !chat || chat.hydration === 'cold') {
      return
    }

    const snapshot = snapshotForCache(chat, this.now())

    try {
      await this.cache.write({
        bot: botName,
        itemsJson: JSON.stringify(snapshot),
        lastRowId: snapshot.lastRowId ?? null,
        lastSeq: snapshot.lastSeq,
        epoch: snapshot.epoch ?? null,
        updatedAt: snapshot.updatedAt
      })
    } catch {
      // A cache write that fails costs the next cold start a spinner.
    }
  }

  /** Write every live chat: the app is going to the background. */
  async persistAll(): Promise<void> {
    await Promise.all(liveChatNames(this.chats.getState()).map(name => this.persist(name)))
  }

  /**
   * The user left the chat screen. This writes the cache and marks the chat
   * read; it deliberately does NOT detach, so bot-to-bot traffic keeps arriving.
   */
  async closeChat(botName: string): Promise<void> {
    this.bots.getState().markSeen(botName, Math.floor(this.now() / 1000))
    await this.persist(botName)
  }

  private requireRuntime(botName: string): string {
    const chat = this.chats.getState().chats[botName]

    if (!chat?.runtimeSessionId) {
      throw new Error(`${botName}'s chat is not attached to the gateway yet.`)
    }

    return chat.runtimeSessionId
  }
}

export interface AttachmentInput {
  filename: string
  base64: string
}

/** One entry of the gateway's model inventory, as the options picker shows it. */
export interface ModelChoice {
  /** The value `config.set {key:'model'}` takes. */
  id: string
  label: string
  provider: string
}

/**
 * `session.resume`'s reply is a superset of what `applyResumeSnapshot` reads.
 * Naming the fields here rather than casting the whole result keeps the two
 * contracts visibly connected: a field the gateway renames fails to compile.
 */
function resumeSnapshotOf(result: SessionResumeResult): ResumeSnapshot {
  return {
    inflight: asRecord(result.inflight),
    running: result.running ?? null,
    queued: asRecord(result.queued),
    pending_approval: asRecord(result.pending_approval),
    todo_state: asRecord(result.todo_state),
    open_requests: result.open_requests ?? null
  }
}

/**
 * The generated contract models these as closed interfaces; the reducer reads
 * them as open bags because the gateway keeps adding fields to them. One narrow
 * widening here beats a cast at every call site.
 */
function asRecord(value: object | null | undefined): Record<string, unknown> | null {
  return value ? ({ ...value } as Record<string, unknown>) : null
}

/**
 * The open approval card already showing this queue entry, if any.
 *
 * The same question reaches a client under several transport ids; the reducer
 * keeps one card for it, and this is how the caller finds which one so the live
 * reply handle can be filed against it.
 */
function approvalCardIdFor(chat: ChatState | undefined, approvalId: string): string | undefined {
  if (!chat || !approvalId) {
    return undefined
  }

  const itemId = chat.byApprovalId[approvalId]
  const item = itemId ? chat.items[itemId] : undefined

  return item?.kind === 'approval' && item.state === 'open' ? item.requestId : undefined
}

/** One replayed event frame, narrowed to what the reducer needs. */
function transcriptEventOf(raw: Record<string, unknown>): TranscriptEvent | null {
  if (typeof raw.type !== 'string') {
    return null
  }

  return {
    type: raw.type,
    ...(typeof raw.session_id === 'string' ? { session_id: raw.session_id } : {}),
    ...(typeof raw.seq === 'number' ? { seq: raw.seq } : {}),
    payload: raw.payload
  }
}

/** How many persisted rows a chat holds, for the reconnect count comparison. */
function countPersistedRows(chat: ChatState): number {
  let count = 0

  for (const id of chat.order) {
    if (chat.items[id]?.rowId !== undefined) {
      count += 1
    }
  }

  return count
}
