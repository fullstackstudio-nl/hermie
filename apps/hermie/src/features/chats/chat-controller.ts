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
  type ChatState,
  type ResumeSnapshot,
  type RowShape,
  rowsToItems,
  snapshotForCache,
  stateFromCache,
  type TranscriptEvent,
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
import type { Bot, BotsState } from '../../store/bots'
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
  private readonly opening = new Map<string, Promise<void>>()
  private readonly slashCatalogs = new Map<string, CommandsCatalogResult>()
  private sessionsChangedTimer: ReturnType<typeof setTimeout> | undefined
  private approvalPollTimer: ReturnType<typeof setInterval> | undefined
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
    this.pending.clear()
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
        cols: 96
      })
    } catch (error) {
      this.chats.getState().setHydration(bot.name, 'error')

      throw error
    }

    // 2. Refuse a gateway too old to send the events this transcript is made of,
    //    before anything half-renders.
    assertDesktopContract(resume.info as SessionLiveInfo | undefined)

    const runtimeId = resume.session_id
    const resolvedId = resume.stored_session_id || canonical.resolvedId

    this.chats.getState().ensure(bot.name, { storedSessionId: canonical.id, resolvedSessionId: resolvedId })
    this.chats.getState().bindRuntime(bot.name, runtimeId)
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
    this.bots.getState().markSeen(bot.name)
    this.syncApprovalPoll()
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

    const cold = chat.lastSeq === 0
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

    if (cold || result.truncated) {
      // Adopt the watermark without replaying: history already describes this.
      this.chats
        .getState()
        .update(botName, state =>
          result.latest_seq > state.lastSeq ? { ...state, lastSeq: result.latest_seq, epoch: result.epoch } : state
        )
    } else {
      for (const raw of result.events ?? []) {
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
    for (const entry of entries ?? []) {
      this.chats
        .getState()
        .dispatchServerRequest(botName, { id: entry.id, method: entry.method, params: entry.params, replayed: true })
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

    if (event.type === 'message.start' || event.type === 'message.complete') {
      this.syncApprovalPoll()
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
            source: 'hermie'
          })

          this.chats.getState().bindRuntime(name, resume.session_id)
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

    if (!botName) {
      return false
    }

    this.pending.set(request.id, { botName, request })
    this.chats.getState().dispatchServerRequest(botName, {
      id: request.id,
      method: request.method,
      params: request.params,
      ...(request.replayed ? { replayed: true } : {})
    })

    if (request.method === 'approval') {
      void this.acknowledgeApproval(botName, request.id)
    }

    this.syncApprovalPoll()

    return true
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
   * A live request is answered on its own JSON-RPC reply, which is what the
   * queue is waiting on. A card rebuilt from `open_requests` or from a resume
   * snapshot has no reply to make, so it goes out as `approval.respond` against
   * the queue entry's own id instead.
   */
  async respondApproval(botName: string, requestId: string, choice: string, all = false): Promise<void> {
    const chat = this.chats.getState().chats[botName]
    const itemId = chat?.byRequestId[requestId]
    const item = itemId ? chat?.items[itemId] : undefined
    const approvalId = item?.kind === 'approval' ? item.approvalId : requestId
    const live = this.pending.get(requestId)

    this.chats.getState().answer(botName, requestId, choice)
    this.acknowledged.delete(requestId)

    if (live) {
      this.pending.delete(requestId)
      live.request.respond({ choice, ...(all ? { all: true } : {}) })
    } else if (chat?.runtimeSessionId) {
      await this.gateway.request('approval.respond', {
        session_id: chat.runtimeSessionId,
        profile: botName,
        choice,
        ...(all ? { all: true } : {}),
        ...(approvalId ? { request_id: approvalId } : {})
      })
    }

    this.syncApprovalPoll()
  }

  /**
   * Answer one clarify question.
   *
   * Batch clarify is answered question by question: each answer is locked
   * server-side, and the lock that empties `remaining` resolves the request. A
   * single-question clarify still goes back on the request itself.
   */
  async respondClarify(botName: string, requestId: string, answers: Record<string, string>): Promise<void> {
    const chat = this.chats.getState().chats[botName]
    const itemId = chat?.byRequestId[requestId]
    const item = itemId ? chat?.items[itemId] : undefined
    const live = this.pending.get(requestId)

    this.chats.getState().answer(botName, requestId, answers)

    const complete =
      item?.kind === 'clarify' ? item.questions.every(question => answers[question.qid] !== undefined) : true

    if (live && complete) {
      this.pending.delete(requestId)
      live.request.respond({ answers })

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

  /** Re-read `session.info` so the options sheet reflects what the gateway holds. */
  async refreshOptions(botName: string): Promise<SessionLiveInfo | null> {
    const chat = this.chats.getState().chats[botName]

    if (!chat?.runtimeSessionId) {
      return null
    }

    try {
      const resume = await this.gateway.request('session.resume', {
        session_id: chat.storedSessionId,
        profile: botName,
        omit_messages: true,
        source: 'hermie'
      })

      this.chats.getState().bindRuntime(botName, resume.session_id)
      this.chats.getState().dispatchEvent(botName, {
        type: 'session.info',
        session_id: resume.session_id,
        payload: resume.info
      })

      return resume.info ?? null
    } catch {
      return null
    }
  }

  // ── approvals while a turn runs ────────────────────────────────────────────

  /** The app came to the front: re-read anything the agent is still waiting on. */
  async onForeground(): Promise<void> {
    this.foregrounded = true
    this.syncApprovalPoll()

    await Promise.all(liveChatNames(this.chats.getState()).map(name => this.refreshPendingApprovals(name)))
  }

  onBackground(): void {
    this.foregrounded = false
    this.stopApprovalPoll()
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

      for (const approval of result?.approvals ?? []) {
        const approvalId = typeof approval.request_id === 'string' ? approval.request_id : ''

        // `pending:` marks a card with no live JSON-RPC reply behind it, the
        // same shape `applyResumeSnapshot` synthesizes.
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
    this.bots.getState().markSeen(botName)
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
