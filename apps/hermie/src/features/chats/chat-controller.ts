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
import { assertDesktopContract, type ConnectionStatus, type GatewayHttp } from '@hermie/gateway-client'
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
  CorrectionStatus,
  OpenRequestEntry,
  PendingApproval,
  SessionListRow,
  SessionLiveInfo,
  SessionResumeResult,
  SlashExecResult,
  Usage
} from '@hermes/shared/gateway-contract'
import type { ServerRequest as GatewayServerRequest } from '@hermes/shared/json-rpc-channel'
import { parseCommandDispatch, parseSlashCommand } from '@hermes/shared/slash'

import type { ChatGateway } from '../../gateway/link'
import { describeRpcFailure, type RpcFailure } from '../../gateway/rpc-failures'
import type { ChatCache } from '../../platform/chat-cache'
import type { Bot, BotCanonicalSession, BotsState } from '../../store/bots'
import type { ChatsState, QueuedMessage } from '../../store/chats'
import { liveChatNames } from '../../store/chats'
import {
  type BotsController,
  CANONICAL_CHAT_TITLE,
  createCanonicalSession,
  PROFILE_SESSION_LIST_LIMIT
} from '../bots/bots-controller'
import {
  classifyConversations,
  conversationKey,
  type Conversation,
  type ConversationGroups
} from '../sessions/session-model'
import {
  fileReferenceFor,
  FileUploadError,
  imageReferenceFor,
  uploadFile,
  type UploadableFile,
  type UploadedFile,
  withFileReferences
} from './file-upload'

/** Above this many rows, `session.history` is a download; the REST tail is not. */
export const REST_HISTORY_THRESHOLD = 400

/** Rows the REST transcript hands back for a full load. */
export const REST_HISTORY_LIMIT = 200

/**
 * The biggest window the REST transcript will serve in one request.
 *
 * `_get_session_messages` clamps every limit to 500, so this is a ceiling and
 * not a preference: asking for more answers with 500 and no indication that it
 * did. It stopped being a floor on how far back the reader can get when paging
 * arrived — `loadOlder` walks back a page at a time — and it is kept as the
 * statement of what one request can carry.
 */
export const REST_HISTORY_MAX = 500

/**
 * How far back one chat has loaded, and whether there is anything before it.
 *
 * Rows, not items: one row projects to several items, a live item has no row,
 * and the route pages in rows. Held here rather than in the transcript state
 * because it is a fact about this client's reading of the conversation, not
 * about the conversation.
 */
interface HistoryWindow {
  rows: number
  reachedStart: boolean
}

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
export /** The contract number a `session.info` payload carries, if any. */
function contractIn(info: SessionLiveInfo | undefined): number | null {
  const raw = info?.desktop_contract
  const contract = typeof raw === 'string' ? Number.parseInt(raw, 10) : raw

  return typeof contract === 'number' && !Number.isNaN(contract) ? contract : null
}

const RESUME_COLS = 96

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
  /** The REST half, for the one thing that cannot go over the socket: file uploads. */
  http?: GatewayHttp | null
  cache?: ChatCache | null
  now?: () => number
  /**
   * Somewhere to put a gateway refusal this controller decided to absorb.
   *
   * Injected rather than imported so the controller keeps knowing nothing about
   * the app's stores, and so a test can read the failures it recorded.
   */
  onRpcFailure?: (failure: RpcFailure) => void
}

/**
 * The gateway's way of saying "right command, wrong method".
 *
 * Upstream's `slash.exec` answers a skill or a bundle with
 * `4018 skill command: use command.dispatch for /<name>` rather than running
 * it. Matched on the method name because that is the part of the sentence that
 * is a protocol fact; the rest of it is prose upstream is free to reword.
 */
const WANTS_DISPATCH_RE = /command\.dispatch/u

/**
 * The commands that start a fresh conversation, which this client runs ITSELF.
 *
 * `slash.exec` cannot do it. Upstream runs a worker command in a separate CLI
 * process (`tui_gateway/methods_tools.py::slash.exec` → `_SlashWorker`), and
 * `/new` there rotates THAT worker's session and prints "New session started!"
 * — the live session this app is bound to is never touched. Only the commands
 * in `_SLASH_MIRRORS` (`methods_slash.py`: model, approvals, personality,
 * prompt, …) are mirrored back onto it, and `new` is not one of them. So the
 * line arrived, the reader was told a new session had started, and the next
 * message went to the same session with the same system prompt. Upstream's own
 * desktop app intercepts these client-side for the same reason
 * (`apps/desktop/src/lib/desktop-slash-commands.ts`).
 *
 * `new` with its upstream alias `reset`, plus `clear` — registered upstream as
 * "Clear screen and start a new session", and a screen is not a thing this app
 * has, so the second half is all of it that means anything here.
 */
const NEW_CONVERSATION_COMMANDS: ReadonlySet<string> = new Set(['new', 'reset', 'clear'])

/**
 * Which road a command takes.
 *
 * `local` is this client's own, and it exists so that the same catalogue lookup
 * that tells the composer "this is a command, do not send it as prose" can also
 * answer for a command the gateway would mishandle. See
 * `NEW_CONVERSATION_COMMANDS`.
 */
export type SlashRoute = 'dispatch' | 'exec' | 'local'

/** What a slash command left behind for the surface that ran it. */
export interface SlashOutcome {
  /** A `prefill` directive's text: the composer, not the transcript. */
  prefill?: string
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
  private readonly http: GatewayHttp | null
  private readonly cache: ChatCache | null
  private readonly now: () => number
  private readonly onRpcFailure: ((failure: RpcFailure) => void) | undefined

  private unsubscribes: (() => void)[] = []
  /** Approval request ids already acknowledged, so the ack is sent once. */
  private readonly acknowledged = new Set<string>()

  /**
   * The bytes behind a queued message, by queue id, and the counter that names
   * them. The store holds what the transcript draws; this holds what the send
   * will need if and when it runs.
   */
  private readonly queuedAttachments = new Map<string, AttachmentInput[]>()
  private queueSeq = 0

  /** The gateway's model inventory, read once per connection. */
  private models: ModelChoice[] | null = null
  private modelsInFlight: Promise<ModelChoice[]> | null = null

  /**
   * Whether `session.usage` is worth calling on this connection.
   *
   * Set false by the gateway's own refusal and never set back: a method a
   * gateway does not have is not going to appear while the socket is up, and
   * asking again per chat would turn one absent capability into one failed RPC
   * per conversation the reader opens. A fresh connection builds a fresh
   * controller, which is where it becomes true again.
   */
  private usageSupported = true

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
  /** How far back each chat has read, and whether the start is in sight. */
  private readonly windows = new Map<string, HistoryWindow>()
  /** Chats with a page of older history in the air, so the list cannot ask twice. */
  private readonly loadingOlder = new Set<string>()
  private readonly parked = new Map<string, GatewayServerRequest[]>()
  private readonly opening = new Map<string, Promise<void>>()
  private readonly slashCatalogs = new Map<string, CommandsCatalogResult>()
  /**
   * One catalogue fetch per session, shared by every keystroke that wants it.
   *
   * It resolves to the REFUSAL when there was one, so the six keystrokes that
   * arrive while a catalogue is in the air all learn the same answer — and the
   * popover a reader is looking at says the same thing whichever of them it was
   * painted by.
   */
  private readonly slashCatalogLoads = new Map<string, Promise<SlashFailure | null>>()
  private sessionsChangedTimer: ReturnType<typeof setTimeout> | undefined
  private approvalPollTimer: ReturnType<typeof setInterval> | undefined
  private subagentPollTimer: ReturnType<typeof setInterval> | undefined
  private foregrounded = true
  private sawReady = false
  private started = false
  /**
   * The desktop contract this gateway last reported, from any resume or
   * `session.info`. A bot that has never spoken resumes without one (see
   * `assertDesktopContract`), and this is what stands in for it.
   */
  private knownContract: number | null = null

  constructor(options: ChatControllerOptions) {
    this.gateway = options.gateway
    this.chats = options.chats
    this.bots = options.bots
    this.botsController = options.botsController
    this.http = options.http ?? null
    this.cache = options.cache ?? null
    this.now = options.now ?? (() => Date.now())
    this.onRpcFailure = options.onRpcFailure
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
    this.slashCatalogLoads.clear()
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

  private rememberContract(contract: number | null): void {
    if (typeof contract === 'number' && !Number.isNaN(contract)) {
      this.knownContract = contract
    }
  }

  /**
   * Open one of a bot's OTHER conversations — a branch, or one `/new` put away.
   *
   * The same machinery, under a different key. `store/chats.ts` is keyed by bot
   * name because until now a bot had exactly one chat; a branch is a second
   * transcript belonging to the same bot, so it is held under
   * `conversationKey(bot, storedId)` — see `features/sessions/session-model.ts`
   * for why a `#` cannot collide with a profile name. Everything downstream of
   * the key (the reducer, the event routing through `runtimeToBot`, the
   * composer, the approvals) goes on working because all of it was already
   * written against a string.
   *
   * Three things the canonical path does that this one deliberately does not:
   *
   *  - **the transcript cache**, which is keyed by BOT and therefore already
   *    holds the canonical conversation. Writing a branch into it would make the
   *    canonical chat paint the branch on its next cold open;
   *  - **`markSeen`**, which is about the bot's unread badge. Reading a branch
   *    is not reading what arrived in the Bot Chat;
   *  - **`resolveCanonical`**, obviously: the stored id is handed in, and
   *    resolving would find the one conversation this is not.
   */
  openConversation(bot: Bot, storedId: string): Promise<void> {
    const key = conversationKey(bot.name, storedId)
    const existing = this.opening.get(key)

    if (existing) {
      return existing
    }

    const run = this.hydrate(bot, {
      key,
      canonical: { id: storedId, resolvedId: storedId, preview: '', lastActive: 0, messageCount: 0 }
    }).finally(() => {
      this.opening.delete(key)
    })

    this.opening.set(key, run)

    return run
  }

  /**
   * Bring one conversation on screen, canonical or not.
   *
   * `options` is absent for the canonical chat, which is the case every existing
   * caller is in: the key is the bot's name and the session is whatever
   * `resolveCanonical` answers. A branch hands both in, and the two paths differ
   * in nothing else — which is the point, because a second hydration written
   * specially for branches is a second place for the transcript machinery to
   * drift.
   */
  private async hydrate(bot: Bot, options?: { key: string; canonical: BotCanonicalSession }): Promise<void> {
    const chats = this.chats.getState()
    const canonical = options?.canonical ?? (await this.botsController.resolveCanonical(bot))
    const key = options?.key ?? bot.name
    const isCanonical = key === bot.name

    chats.ensure(key, { storedSessionId: canonical.id, resolvedSessionId: canonical.resolvedId })

    // 1. The cache paints first, so the thread is on screen before the socket
    //    has answered. Reconciliation below keeps the item ids it painted. Only
    //    for the canonical chat: the cache is keyed by bot and already holds it.
    if (isCanonical) {
      await this.paintFromCache(key, canonical.id, canonical.resolvedId)
    }

    this.chats.getState().setHydration(key, 'hydrating')

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
      this.chats.getState().setHydration(key, 'error')

      throw error
    }

    // 2. Refuse a gateway too old to send the events this transcript is made of,
    //    before anything half-renders. A never-spoken bot resumes without the
    //    number; the one this gateway reported before stands in for it.
    this.rememberContract(contractIn(resume.info as SessionLiveInfo | undefined))
    assertDesktopContract(resume.info as SessionLiveInfo | undefined, this.knownContract)

    const runtimeId = typeof resume.session_id === 'string' ? resume.session_id : ''

    if (!runtimeId) {
      // Every event and every server request is addressed by this id. Binding
      // an empty one routes the whole session to nobody, which reads as a chat
      // that opened fine and then never said anything again.
      this.chats.getState().setHydration(key, 'error')

      throw new Error(`The gateway resumed ${bot.name}'s chat without a session id.`)
    }

    const resolvedId = resume.stored_session_id || canonical.resolvedId

    this.chats.getState().ensure(key, { storedSessionId: canonical.id, resolvedSessionId: resolvedId })
    this.bindRuntime(key, runtimeId)
    this.chats.getState().markLive(key)

    // The resume's own `info` — the gateway's view of this session: its model,
    // its flags, and its working directory. It was being read once for the
    // contract check and then dropped, which left `chat.info` undefined until
    // the gateway happened to emit a `session.info` event of its own. Two things
    // already assumed otherwise: `refreshOptions` merges its patch onto "what
    // the resume reported", and a file upload needs `cwd` to know where a file
    // may legally go.
    if (resume.info) {
      this.chats.getState().dispatchEvent(key, {
        type: 'session.info',
        session_id: runtimeId,
        payload: resume.info as unknown as Record<string, unknown>
      })
    }

    // 3. History. Either transport projects onto the same items, which is what
    //    lets the reconcile below keep every id it already handed out.
    const messageCount = resume.message_count ?? canonical.messageCount
    const history = await this.loadHistory(runtimeId, resolvedId, bot.name, messageCount)

    if (history.rows.length) {
      this.chats.getState().applyHistory(key, rowsToItems(history.rows, history.shape))
    }

    /*
      Where the far end of the loaded window is, so `loadOlder` knows what to ask
      for next. It is a count of ROWS, not of items: one row can project to
      several items, a live item has no row at all, and the route pages in rows.

      The RPC transport reaches the start by definition — `session.history` is
      unpaginated, so what came back IS the conversation.
    */
    this.windows.set(key, {
      rows: history.rows.length,
      reachedStart: history.shape === 'rpc' || history.rows.length < REST_HISTORY_LIMIT
    })

    // 4. The in-flight tail the persisted rows do not contain yet.
    this.chats.getState().applySnapshot(key, resumeSnapshotOf(resume))
    this.registerOpenRequests(key, resume.open_requests ?? null)

    // 5. Anything that happened between the history read and now.
    await this.replaySince(key, runtimeId)

    this.chats.getState().setHydration(key, 'live')

    if (isCanonical) {
      // Seen as of NOW, not as of the roster's `last_active`: the roster row can
      // be a minute old, and a chat the user is looking at is read. A branch is
      // not the Bot Chat, so reading one clears nothing.
      this.bots.getState().markSeen(bot.name, Math.floor(this.now() / 1000))
    }

    this.syncApprovalPoll()

    // A chat opened mid-delegation never saw its children start.
    await this.reconcileSubagents(key)
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

    if (event.type === 'session.info') {
      this.rememberContract(contractIn(event.payload as SessionLiveInfo | undefined))
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
      void this.drainQueue(botName)
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
   *
   * With one exception, and it is the whole of "a message I sent on my phone is
   * missing on my Mac". `message.start` carries no author, so a turn somebody
   * else began stands an empty `unknownAuthor` bubble in and waits to be told who
   * spoke. Nothing on the socket ever tells us: the deltas are the REPLY. The
   * only frame that filled it was `message.complete`, so until the turn ended —
   * seconds for a greeting, minutes for real work — the other device's message
   * simply was not in the transcript, and `selectors.ts` hides an empty
   * placeholder rather than drawing a blank bubble, so there was not even a gap
   * to explain it.
   *
   * A pending placeholder therefore outranks the mid-turn rule. The risk that
   * rule guards against does not apply to it: `reconcileTail` splices rows in
   * FRONT of the live tail and never drops a live item, so the worst case is the
   * prompt landing above the bubble that is still streaming — which is where it
   * belongs. And the gateway has already written that row; it is what
   * `sessions.changed` is announcing.
   */
  private async sweep(): Promise<void> {
    const names = liveChatNames(this.chats.getState())

    await Promise.all([
      this.botsController.refresh().catch(() => undefined),
      ...names.map(name => {
        const chat = this.chats.getState().chats[name]

        if (!chat) {
          return Promise.resolve()
        }

        return !chat.turn.active || chat.turn.foreignReconcilePending ? this.reconcileTailFor(name) : Promise.resolve()
      })
    ])
  }

  /**
   * One page further back.
   *
   * The transcript used to be a tail that reconciles and nothing else: there was
   * no scrollback, `onEndReached` was a no-op, and the one thing that could load
   * more re-read the SAME conversation at the route's maximum window and folded
   * it in with `applyHistory`. That is a bigger tail, not a page — it can be
   * done once, it stops at 500 rows for good, and a conversation longer than
   * that had a floor nobody could get under.
   *
   * This is paging. `offset` counts rows back from the newest end, so the next
   * page is the one before everything held, and it goes in at the FRONT through
   * `prependHistory` rather than through a re-hydration. Nothing already on
   * screen is rebuilt from the server's version of it, which is what keeps the
   * reader's place: `maintainVisibleContentPosition` holds an anchor through a
   * prepend on an inverted list, and it can only do that if the rows below the
   * anchor are the same rows.
   *
   * The answer is three-valued on purpose. A caller that cannot tell "there is
   * nothing older" from "loaded, still not what you wanted" from "this gateway
   * cannot do this" has nothing honest to say to the reader, and all three of
   * those happen.
   *
   * A gateway with no REST transcript answers `unavailable`, and that is not a
   * failure: the RPC fallback is unpaginated, so it already handed over
   * everything there is, and `reachedStart` was set at hydration.
   */
  async loadOlder(botName: string): Promise<'grew' | 'start' | 'unavailable'> {
    const chat = this.chats.getState().chats[botName]

    if (!chat?.resolvedSessionId) {
      return 'unavailable'
    }

    const window = this.windows.get(botName)

    if (window?.reachedStart) {
      return 'start'
    }

    if (this.loadingOlder.has(botName)) {
      // The list fires `onEndReached` more than once while one page is in the
      // air, and two pages fetched at the same offset are the same page twice.
      return 'grew'
    }

    this.loadingOlder.add(botName)

    try {
      const rows = await this.gateway.fetchMessages(chat.resolvedSessionId, {
        limit: REST_HISTORY_LIMIT,
        offset: window?.rows ?? chat.order.length,
        order: 'latest'
      })

      if (rows === null) {
        this.windows.set(botName, { rows: window?.rows ?? 0, reachedStart: true })

        return 'unavailable'
      }

      const loaded = (window?.rows ?? 0) + rows.length

      /*
        A short page is the start. The route has no `has_more` and no total — the
        envelope carries `limit`, `offset`, `order` and `returned` and nothing
        else — so "it gave me fewer than I asked for" is the only signal there
        is, and an empty page past the end is what it answers rather than an
        error. Measured, 2026-09-21.
      */
      this.windows.set(botName, { rows: loaded, reachedStart: rows.length < REST_HISTORY_LIMIT })

      if (!rows.length) {
        return 'start'
      }

      const before = this.chats.getState().chats[botName]?.order.length ?? 0

      this.chats.getState().prependHistory(botName, rowsToItems(rows, 'rest'))

      const after = this.chats.getState().chats[botName]?.order.length ?? 0

      // A page that was entirely rows we already hold is not growth. It happens
      // when a turn lands between two pages and shifts every older row by one.
      return after > before ? 'grew' : rows.length < REST_HISTORY_LIMIT ? 'start' : 'grew'
    } finally {
      this.loadingOlder.delete(botName)
    }
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
   * What the GATEWAY says is still open for this bot, right now.
   *
   * Read straight off `approval.pending` rather than out of the store, and that
   * is the whole point of it: its one caller is ADR-0017's notification action,
   * where nothing the device already believes counts as evidence. A tap on
   * "Allow" is a hint that something happened, so the request it names is looked
   * up again here before anything is sent.
   *
   * Answers `[]` for a chat with no live session and for a call that failed,
   * which both resolve to "open the chat and let the reader see".
   */
  async openApprovals(botName: string): Promise<PendingApproval[]> {
    const chat = this.chats.getState().chats[botName]

    if (!chat?.runtimeSessionId) {
      return []
    }

    try {
      const result = await this.gateway.request('approval.pending', {
        session_id: chat.runtimeSessionId,
        profile: botName
      })

      return Array.isArray(result?.approvals) ? result.approvals : []
    } catch {
      return []
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
   *
   * A file attachment is not attached at all — there is no RPC for it. Its bytes
   * are already on the gateway (`uploadFile`), so all that is left is to name the
   * path in the prompt, which `withFileReferences` appends as the `@file:` token
   * the gateway expands. That composed text is what is painted AND what is
   * submitted: the two have to be byte-identical, or the gateway echoes the turn
   * back as a message the reconciler does not recognise and the bubble appears
   * twice.
   *
   * Byte-identical text is not enough when there is no text. An attachment sent
   * with nothing typed leaves the two sides with only the attachment in common,
   * so what is painted has to be the REFERENCE the row will carry rather than a
   * display name — see `attachmentReferences`.
   */
  async send(
    botName: string,
    text: string,
    attachments: AttachmentInput[] = [],
    options: { display?: string } = {}
  ): Promise<void> {
    const chat = this.chats.getState().chats[botName]

    if (!chat?.runtimeSessionId) {
      throw new Error(`${botName}'s chat is not attached to the gateway yet.`)
    }

    // A turn is running: the message is parked HERE rather than on the gateway.
    // See `QueuedMessage` — `prompt.submit` would take it, and would then be the
    // only one holding it, with nothing to read it back or take it out again.
    if (chat.turn.active) {
      this.queue(botName, text, attachments)

      return
    }

    const sessionId = chat.runtimeSessionId
    const files = attachments.filter(isFileAttachment)
    const images = attachments.filter((attachment): attachment is ImageAttachmentInput => !isFileAttachment(attachment))
    const body = withFileReferences(
      text,
      files.map(file => file.path)
    )

    // `display` exists for one caller: a `send`/`skill` directive, whose `text`
    // is the expanded skill body the model is meant to read and NOT what the
    // reader typed. The bubble shows `/docx`; the gateway is sent the expansion.
    this.chats.getState().beginTurn(botName, options.display ?? body, attachmentReferences(attachments))

    try {
      for (const file of images) {
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
        text: body
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

  // ── the queue behind a running turn ────────────────────────────────────────

  /**
   * Park a message, and give the transcript a row for it.
   *
   * The attachments stay in this map and never reach the store: they are bytes
   * and paths, the store draws names. They leave together with the entry,
   * whichever way it leaves.
   */
  private queue(botName: string, text: string, attachments: AttachmentInput[]): void {
    const id = `q:${(this.queueSeq += 1)}`

    this.queuedAttachments.set(id, attachments)
    this.chats.getState().enqueue(botName, {
      id,
      text,
      ...(attachments.length ? { attachments: attachmentReferences(attachments) } : {})
    })
  }

  /** Every queued message for one bot, oldest first. */
  private queueOf(botName: string): QueuedMessage[] {
    return this.chats.getState().queues[botName] ?? []
  }

  private takeQueued(
    botName: string,
    id: string
  ): { entry: QueuedMessage; attachments: AttachmentInput[] } | undefined {
    const entry = this.queueOf(botName).find(candidate => candidate.id === id)

    if (!entry) {
      return undefined
    }

    const attachments = this.queuedAttachments.get(id) ?? []

    this.queuedAttachments.delete(id)
    this.chats.getState().dropQueued(botName, id)

    return { attachments, entry }
  }

  /**
   * The turn ended: submit the oldest parked message, if there is one.
   *
   * ONE per completion. The message it sends starts a turn of its own, and that
   * turn's completion comes back through here — so a queue of three goes out in
   * order, each one after the reply to the one before it, which is the order the
   * reader wrote them in and the only one that makes the replies readable.
   */
  private async drainQueue(botName: string): Promise<void> {
    const next = this.queueOf(botName)[0]

    if (!next) {
      return
    }

    const taken = this.takeQueued(botName, next.id)

    if (!taken) {
      return
    }

    try {
      await this.send(botName, taken.entry.text, taken.attachments)
    } catch {
      // The send painted its own failure — and putting the message back would
      // start a loop against a gateway that is refusing it.
    }
  }

  /** Take a parked message back for editing. Returns the text to put in the field. */
  editQueued(botName: string, id: string): string | undefined {
    return this.takeQueued(botName, id)?.entry.text
  }

  deleteQueued(botName: string, id: string): void {
    this.takeQueued(botName, id)
  }

  /**
   * Inject a parked message into the turn that is running, now.
   *
   * `session.steer` is the gateway's own word for it: the text is handed to the
   * agent with its next tool result, without interrupting anything. The answer
   * can be `rejected` — a turn past its final tool batch has nothing left to
   * hand it to — and then the message goes back into the queue rather than
   * disappearing into a turn that never heard it.
   *
   * The bubble is painted HERE, before the round trip, for the same reason
   * `send` paints one: taking the entry out of the queue is the only thing the
   * reader can see, and on its own it reads as the message being deleted. That
   * was the whole of the build-176 report — the strip dropped the chip and
   * nothing arrived.
   *
   * Whether the gateway persists a row for a steer is not something this client
   * can know: the contract says only "inject text into the next tool result",
   * and `display_kind: "steer"` exists in the row projection without any
   * promise that a steer produces one. So the bubble is local and optimistic,
   * and the tail reconcile pairs it with a persisted row on its text if one
   * ever turns up (`matchKeyOf`) rather than drawing the words twice.
   *
   * Refusal unwinds all of it: the bubble comes off and the entry goes back in
   * the strip, which is where the reader will go looking for it.
   */
  async steerQueued(botName: string, id: string): Promise<CorrectionStatus> {
    const sessionId = this.requireRuntime(botName)
    const taken = this.takeQueued(botName, id)

    if (!taken) {
      return 'rejected'
    }

    this.chats.getState().beginSteer(botName, taken.entry.text, taken.entry.attachments)

    try {
      const result = await this.gateway.request('session.steer', {
        session_id: sessionId,
        profile: botName,
        text: taken.entry.text
      })

      if (result?.status === 'rejected') {
        this.unwindSteer(botName, taken)
      }

      return result?.status ?? 'queued'
    } catch (error) {
      this.unwindSteer(botName, taken)

      throw error
    }
  }

  /** A steer the gateway did not take: un-paint it, and park it again. */
  private unwindSteer(botName: string, taken: { entry: QueuedMessage; attachments: AttachmentInput[] }): void {
    this.chats.getState().dropSteer(botName, taken.entry.text)
    this.requeue(botName, taken)
  }

  private requeue(botName: string, taken: { entry: QueuedMessage; attachments: AttachmentInput[] }): void {
    this.queuedAttachments.set(taken.entry.id, taken.attachments)
    this.chats.getState().enqueue(botName, taken.entry)
  }

  /**
   * Put a file on the gateway, ready to be named in the next prompt.
   *
   * Everything about WHERE is decided here rather than by the caller, because
   * the answer depends on this session: the upload has to land under the
   * session's own working directory or the `@file:` reference will be refused as
   * outside the allowed workspace. `info.cwd` is that directory, and it arrived
   * with `session.resume`.
   */
  async uploadFile(
    botName: string,
    file: UploadableFile,
    options: { onProgress?: (fraction: number) => void } = {}
  ): Promise<UploadedFile> {
    const chat = this.chats.getState().chats[botName]

    if (!this.http) {
      throw new FileUploadError('failed', 'There is no gateway connection to upload to.')
    }

    return uploadFile({
      http: this.http,
      file,
      cwd: typeof chat?.info?.cwd === 'string' ? chat.info.cwd : undefined,
      ...(options.onProgress ? { onProgress: options.onProgress } : {})
    })
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
   *
   * Two things here are about the difference between a fake gateway and a real
   * one. The catalogue fetch is shared by every keystroke that arrives while it
   * is in the air — typing `/model` is six of them, and against a fake that
   * answers in the same tick the old `has()` check looked like a cache and was
   * really six concurrent catalogue builds on the gateway. And a FAILED fetch is
   * no longer remembered as an empty catalogue: it used to be, which meant one
   * bad answer left `knowsSlashCommand` saying no for the rest of the session,
   * so every `/model` after it went out as a prompt.
   */
  async querySlash(botName: string, typed: string): Promise<SlashCompletions> {
    const sessionId = this.requireRuntime(botName)
    let failure: SlashFailure | undefined

    if (!this.slashCatalogs.has(sessionId)) {
      failure = (await this.fetchSlashCatalog(botName, sessionId)) ?? undefined
    }

    try {
      const result = await this.gateway.request('complete.slash', { text: typed, session_id: sessionId })

      return {
        items: result?.items ?? [],
        // The COLUMN an accepted item replaces from, which is how the same call
        // completes a command name and then its arguments: the gateway says how
        // much of the line its answer stands for. A real gateway answers 1 for a
        // bare `/mo` — the slash is kept and the item's own `text` carries no
        // slash — and `text.rfind(' ') + 1` once there is an argument.
        ...(typeof result?.replace_from === 'number' ? { replaceFrom: result.replace_from } : {}),
        /*
          A catalogue that would not load is still worth saying even when the
          completions themselves arrived. `complete.slash` answers from the
          session, `commands.catalog` is what `knowsSlashCommand` routes on — so
          a reader whose catalogue is missing gets a list they can pick from and
          a Return that sends the pick as PROSE, which is the confusing half of
          this bug rather than the visible one.
        */
        ...(failure ? { failure } : {})
      }
    } catch (error) {
      const reported = this.noteRpcFailure('complete.slash', error)

      // The nearer failure wins: `complete.slash` is the call that was supposed
      // to fill this popover, and naming the catalogue instead would point a
      // reader at the call that did not fail last.
      return { items: [], failure: reported }
    }
  }

  /**
   * Fetch the catalogue once, however many keystrokes ask for it.
   *
   * The in-flight promise is the cache until it settles. A refusal leaves
   * NOTHING cached, so the next keystroke tries again — the alternative, which
   * is what shipped, was an empty catalogue pinned to the session for as long as
   * it lived.
   */
  private async fetchSlashCatalog(botName: string, sessionId: string): Promise<SlashFailure | null> {
    const inFlight = this.slashCatalogLoads.get(sessionId)

    if (inFlight) {
      return await inFlight
    }

    const load = this.gateway
      .request('commands.catalog', { session_id: sessionId, profile: botName })
      .then((catalog): SlashFailure | null => {
        this.slashCatalogs.set(sessionId, catalog ?? {})

        return null
      })
      .catch((error: unknown): SlashFailure | null => this.noteRpcFailure('commands.catalog', error))
      .finally(() => {
        this.slashCatalogLoads.delete(sessionId)
      })

    this.slashCatalogLoads.set(sessionId, load)

    return await load
  }

  /**
   * Does this session have a command by that name?
   *
   * The catalogue answers it, and the answer decides what Return does with a
   * line that starts with a slash: a name the gateway knows is a COMMAND and
   * goes to the gateway, and anything else is prose that happens to begin with
   * `/` and goes out as an ordinary prompt. Names, aliases and skills all count
   * — they are all things the gateway will run, though not all down the same
   * road; see `slashRouteFor`.
   *
   * The three conversation-starting commands answer yes whatever the catalogue
   * says, INCLUDING before it has arrived. Every other command degrades
   * harmlessly when the catalogue is late — the line goes out as a prompt, and
   * the gateway understands a leading slash — but `/new` does not: sent as a
   * prompt it becomes a message asking the MODEL to start a new session, which
   * is the one shape of this bug worse than the bug itself.
   */
  knowsSlashCommand(botName: string, name: string): boolean {
    return this.slashRouteFor(botName, name) !== null
  }

  /**
   * WHICH gateway method will accept this command.
   *
   * `slash.exec` runs worker commands. It refuses a SKILL outright —
   * `4018 skill command: use command.dispatch for /docx`, measured against
   * `hermes serve` 0.21.3 on 2026-09-21 — and a real gateway's catalogue lists
   * fifty-three of them next to the built-ins, every one of which
   * `knowsSlashCommand` used to wave straight into the method that will not take
   * it. The fake gateway answered `/docx` with cheerful text, which is exactly
   * how a suite stays green over a command that cannot work.
   */
  slashRouteFor(botName: string, name: string): SlashRoute | null {
    const wanted = name.toLowerCase()

    // Before the catalogue, and regardless of what it says: this client owns
    // these three, and it owns them whether or not the gateway lists them.
    if (NEW_CONVERSATION_COMMANDS.has(wanted)) {
      return 'local'
    }

    const catalog = this.slashCatalog(botName)

    if (!catalog || !name) {
      return null
    }

    const named = (raw: string) => raw.replace(/^\//u, '').toLowerCase() === wanted

    if (Object.keys(catalog.skills ?? {}).some(named)) {
      return 'dispatch'
    }

    const known =
      Object.keys(catalog.commands ?? {}).some(named) ||
      Object.keys(catalog.canon ?? {}).some(named) ||
      (catalog.pairs ?? []).some(pair => named(pair[0] ?? '')) ||
      (catalog.categories ?? []).some(category => (category.pairs ?? []).some(pair => named(pair[0] ?? '')))

    return known ? 'exec' : null
  }

  /** The catalogue behind `querySlash`, for a picker that wants the whole list. */
  slashCatalog(botName: string): CommandsCatalogResult | undefined {
    const chat = this.chats.getState().chats[botName]

    return chat?.runtimeSessionId ? this.slashCatalogs.get(chat.runtimeSessionId) : undefined
  }

  /**
   * Run a slash command and put its answer in the transcript.
   *
   * There are two kinds of answer and the gateway does not label which one it is
   * about to give: plain worker text in `output`, or one of the six
   * `command.dispatch` DIRECTIVES with a `type` — which `slash.exec` also
   * returns, because upstream reroutes pending-input built-ins and skill bundles
   * into `command.dispatch` itself and hands the directive straight back.
   * `parseCommandDispatch` is the vendored narrowing for exactly that union; it
   * was vendored and then never called, and this method read
   * `output ?? message ?? notice` instead — so `/queue list`, which answers
   * `{type: 'send', message: 'list'}`, put the word `list` in the transcript as
   * though it were the result and never queued anything.
   *
   * `message` is model-facing scaffolding and no surface may render it. A skill
   * bundle's `message` is the whole expanded skill body; `display` is the line
   * the reader is meant to see.
   */
  async runSlash(botName: string, command: string): Promise<SlashOutcome> {
    return await this.dispatchSlash(botName, command, 0)
  }

  private async dispatchSlash(botName: string, command: string, depth: number): Promise<SlashOutcome> {
    const { arg, name } = parseSlashCommand(command)

    // BEFORE the catalogue lookup and before any round trip: a `/new` that
    // reaches the gateway has already failed, whichever method carries it.
    // Checked at every depth, so an alias resolving to one of these lands here
    // too rather than on the worker.
    if (NEW_CONVERSATION_COMMANDS.has(name)) {
      await this.startNewConversation(botName, arg, command)

      return {}
    }

    const sessionId = this.requireRuntime(botName)
    const result = await this.callSlash(botName, sessionId, command, name, arg)
    const directive = parseCommandDispatch(result)

    if (result?.warning) {
      this.commandRow(botName, sessionId, command, String(result.warning))
    }

    // No `type`: plain worker or plugin text, which is the common case.
    if (!directive) {
      this.slashOutput(botName, sessionId, command, result?.output ?? '')

      return {}
    }

    switch (directive.type) {
      case 'exec':
      case 'plugin':
        this.slashOutput(botName, sessionId, command, directive.output ?? '')

        return {}

      case 'alias': {
        // One hop only. An alias that points at an alias that points back would
        // otherwise pace the socket until something gave out.
        if (depth > 0 || !directive.target.trim()) {
          this.commandRow(botName, sessionId, command, 'That is an alias the gateway could not follow.')

          return {}
        }

        const target = directive.target.startsWith('/') ? directive.target : `/${directive.target}`

        return await this.dispatchSlash(botName, arg ? `${target} ${arg}` : target, depth + 1)
      }

      case 'prefill':
        if (directive.notice) {
          this.commandRow(botName, sessionId, command, directive.notice)
        }

        // The caller owns the composer; the controller does not reach into it.
        return { prefill: directive.message }

      case 'send':
      case 'skill': {
        const message = directive.message ?? ''
        // A skill directive carries no `notice` in the vendored union; a send
        // does. Read it off the raw result so both shapes reach the reader.
        const notice = typeof result?.notice === 'string' ? result.notice.trim() : ''

        if (notice) {
          this.commandRow(botName, sessionId, command, notice)
        }

        if (!message.trim()) {
          this.commandRow(botName, sessionId, command, directive.display ?? 'Nothing to send.')

          return {}
        }

        // The bubble shows the invocation; the gateway is sent the expansion.
        await this.send(botName, message, [], { display: directive.display ?? command })

        return {}
      }
    }
  }

  /**
   * Put this conversation away and start the next one, in place.
   *
   * Hermie's product model has no session browser: a bot has exactly ONE chat,
   * the hidden session on its profile titled exactly `Bot Chat`, resolved by
   * that title and nothing else (ADR-0007, and upstream's
   * `methods_profiles.py::_canonical_session_row` → `get_session_by_title`).
   * "Start fresh" therefore cannot mean "open another session" the way it does
   * on the desktop. It means: RETIRE the conversation that holds the title, and
   * mint the successor under it.
   *
   * The order is load-bearing and it is retire-then-create. The title is the
   * registry key, so while the old row still wears it a second `Bot Chat` is
   * either refused outright — `hermes_state_titles.py` raises "Title 'Bot Chat'
   * is already in use by session …" — or, on a gateway that let it through,
   * shadows the conversation it was meant to replace. Every step that can fail
   * is rolled back towards "nothing happened", because the one outcome worse
   * than `/new` doing nothing is `/new` leaving a bot with no chat.
   *
   * `arg` names the conversation being PUT AWAY, not the new one: the new one is
   * `Bot Chat`, which is not a name this app is free to change.
   */
  async startNewConversation(botName: string, arg = '', command = '/new'): Promise<void> {
    const sessionId = this.requireRuntime(botName)
    const chat = this.chats.getState().chats[botName]
    const storedId = chat?.storedSessionId
    const bot = this.bots.getState().byName[botName]

    if (!chat || !storedId || !bot) {
      throw new Error(`${botName}'s chat is not attached to the gateway yet.`)
    }

    if (chat.turn.active) {
      /*
        A turn in flight is bound to the session it started in, and closing that
        session underneath it would strand the answer somewhere the reader can
        no longer see. Refusing is the honest move, and it is a refusal the
        reader has to SEE — hence a command row rather than a thrown error the
        composer would turn into a transient banner.
      */
      this.commandRow(
        botName,
        sessionId,
        command,
        'This bot is still working on the last turn. Let it finish, or stop it, and run this again — a conversation cannot be put away mid-answer.'
      )

      return
    }

    const stamped = `${CANONICAL_CHAT_TITLE} · ${localStamp(this.now())}`
    const asked = arg.trim()
    let retired = asked || stamped
    let refusedName = ''

    await this.unhideForRetire(botName, sessionId)

    try {
      await this.renameSession(botName, sessionId, retired)
    } catch (error) {
      if (!asked) {
        await this.undoRetire(botName, sessionId, false)
        this.commandRow(botName, sessionId, command, retireFailed(messageOf(error)))

        return
      }

      /*
        A refused title is nearly always the ARGUMENT — too long, or already
        worn by another session — and what the owner asked for was a new
        conversation, not that name. So the fallback runs and the notice says
        what happened, rather than the whole command failing over a label.
      */
      refusedName = messageOf(error)
      retired = stamped

      try {
        await this.renameSession(botName, sessionId, retired)
      } catch (second) {
        await this.undoRetire(botName, sessionId, false)
        this.commandRow(botName, sessionId, command, retireFailed(messageOf(second)))

        return
      }
    }

    let created

    try {
      created = await createCanonicalSession(this.gateway, botName, { parentSessionId: storedId })
    } catch (error) {
      // Nothing was created, so the conversation now sitting under the retired
      // name IS still this bot's chat. Its name goes back, or the next open
      // finds no canonical row and mints a third one beside it.
      await this.undoRetire(botName, sessionId, true)
      this.commandRow(
        botName,
        sessionId,
        command,
        `The gateway would not start a new conversation (${messageOf(error)}). You are still in the one you were in.`
      )

      return
    }

    /*
      Write the title onto the NEW session at once.

      `session.create` deliberately persists no row for an empty draft
      (`methods_session.py`: eagerly creating one "left an 'Untitled' empty
      session behind for every launch the user never typed into"), so the title
      and the hidden flag ride as `pending_title` / `pending_hidden` until the
      first prompt. `session.title` takes the other road — `_ensure_session_db_row`,
      which applies the queued hidden flag on the way — so the successor is a
      real, findable, hidden `Bot Chat` before anybody has typed into it. Without
      this, a relaunch before the first message would resolve no canonical row at
      all and mint a third chat.

      Best effort: the create landed, so the app is switching either way.
    */
    if (created.runtimeSessionId) {
      try {
        await this.renameSession(botName, created.runtimeSessionId, CANONICAL_CHAT_TITLE)
      } catch (error) {
        this.noteRpcFailure('session.title', error)
      }
    }

    // A full conversation boundary, which is what upstream's own `/new` is. Best
    // effort: a session the gateway has already reaped answers 4001, and the
    // transcript is on disk either way.
    try {
      await this.gateway.request('session.close', { session_id: sessionId, profile: botName })
    } catch (error) {
      this.noteRpcFailure('session.close', error)
    }

    await this.switchCanonical(bot, created.canonical)

    // In the NEW transcript, and last, so it is the only thing in it.
    this.commandRow(
      botName,
      this.chats.getState().chats[botName]?.runtimeSessionId ?? '',
      command,
      newConversationNotice(retired, asked, refusedName)
    )
  }

  /**
   * Point this bot at a different canonical chat and open it.
   *
   * Everything keyed by the OLD session or by the bot is dropped and the normal
   * open path runs again, rather than a second hydration written specially for
   * this: `session.resume` binds the new runtime id, the empty transcript
   * paints, the hydration states move in the order every other open moves them,
   * and whatever was queued or parked on the old session goes with it.
   */
  private async switchCanonical(bot: Bot, canonical: BotCanonicalSession): Promise<void> {
    const botName = bot.name
    const previous = this.chats.getState().chats[botName]?.runtimeSessionId

    // The roster is the one thing that would undo this, so it is told first —
    // and told in a way a poll already in the air cannot reverse. See
    // `canonicalPins` in the bots store.
    this.bots.getState().setCanonical(botName, canonical)

    if (previous) {
      this.slashCatalogs.delete(previous)
      this.parked.delete(previous)
    }

    this.windows.delete(botName)
    this.loadingOlder.delete(botName)

    /*
      The transcript cache is keyed by BOT, not by session, so what is on disk is
      the conversation just put away. Left there, `paintFromCache` would paint it
      under the new session's ids and the history reconcile would merge an empty
      live transcript into it — the new chat would open holding the old one.
    */
    if (this.cache) {
      try {
        await this.cache.forget(botName)
      } catch {
        // A cache that cannot be cleared is one more reason not to read it.
      }
    }

    this.chats.getState().forget(botName)

    await this.openChat({ ...bot, canonical })
  }

  /**
   * Take the canonical chat out of hiding, so that its title can change at all.
   *
   * Upstream refuses to rename a HIDDEN session titled `Bot Chat` away from that
   * title — `hermes_state_titles.py::_set_session_title` raises "This is the
   * bot's canonical Bot Chat — its name is its identity, and renaming it would
   * orphan the conversation." Hidden is the discriminator the guard tests, and
   * upstream's own comment beside it says what that means: "a visible session
   * merely named 'Bot Chat' stays renameable". So lifting the flag is the
   * documented way past the guard rather than a trick played on it — and the
   * retired conversation becoming an ordinary visible session is where a reader
   * would go looking for it anyway.
   *
   * Best effort. A gateway without the guard does not need this, and one that
   * refuses the call will refuse the rename next with a message worth reading.
   */
  private async unhideForRetire(botName: string, sessionId: string): Promise<void> {
    try {
      await this.gateway.request('session.set_hidden', { session_id: sessionId, profile: botName, hidden: false })
    } catch (error) {
      this.noteRpcFailure('session.set_hidden', error)
    }
  }

  /**
   * Rename the session a RUNTIME id names.
   *
   * The runtime id, not the durable one: `session.title` is session-scoped
   * upstream (`_with_db(session_scoped=True)` over `_sess_nowait`), so it is
   * looked up in the live `_sessions` map and a stored id comes back 4001
   * "session not found". What it renames is that session's `session_key`, which
   * IS the durable row.
   */
  private async renameSession(botName: string, sessionId: string, title: string): Promise<void> {
    await this.gateway.request('session.title', { session_id: sessionId, profile: botName, title })
  }

  /** Undo a retire that could not be followed through; best effort throughout. */
  private async undoRetire(botName: string, sessionId: string, renamed: boolean): Promise<void> {
    if (renamed) {
      try {
        await this.renameSession(botName, sessionId, CANONICAL_CHAT_TITLE)
      } catch (error) {
        this.noteRpcFailure('session.title', error)
      }
    }

    try {
      await this.gateway.request('session.set_hidden', { session_id: sessionId, profile: botName, hidden: true })
    } catch (error) {
      this.noteRpcFailure('session.set_hidden', error)
    }
  }

  // ── the conversations beside the canonical chat ────────────────────────────

  /**
   * Fork this chat into a branch, from one row of its transcript.
   *
   * **Read `SessionBranchParams` before changing anything here.** It is
   * `{session_id, profile?, name?, count?}` — there is no row index and no row
   * id, so "branch from THIS message" is not something the method takes
   * literally. `count` is the only parameter that can express a position, and
   * the reading this app is built on is that it is **how many of the parent's
   * messages the child starts with**. `branchCountFor` turns a transcript row
   * into that number, and the fake gateway's handler implements the same
   * reading.
   *
   * That reading is an ASSUMPTION. It has not been checked against a running
   * gateway, because there is none here; `docs/platform-notes.md` says so in as
   * many words. If upstream means "the last `count` messages" instead, this call
   * and that handler are the two places that change.
   *
   * The runtime id, not the stored one: the contract's description is "fork a
   * LIVE session", and every session-scoped method upstream resolves through
   * `_sess_nowait`. A stored id would come back 4001.
   *
   * The branch is an ordinary VISIBLE session of the same profile — nothing in
   * the parameters can ask for a hidden one — so the canonical chat this was
   * taken from is untouched by construction rather than by care.
   */
  async branchFrom(botName: string, options: { messageCount: number; title: string }): Promise<Conversation> {
    const sessionId = this.requireRuntime(botName)
    const result = await this.gateway.request('session.branch', {
      session_id: sessionId,
      profile: botName,
      name: options.title,
      // Never zero: a branch of no messages is a branch of nothing, and a
      // gateway that took it literally would hand back an empty conversation
      // with a name that promised otherwise.
      count: Math.max(1, Math.floor(options.messageCount))
    })

    const storedId = typeof result?.stored_session_id === 'string' ? result.stored_session_id : ''

    if (!storedId) {
      throw new Error(`The gateway branched ${botName}'s chat without returning its id.`)
    }

    return {
      id: storedId,
      resolvedId: storedId,
      // The title the gateway SETTLED on, not the one that was asked for: a name
      // already worn is refused upstream and the branch keeps whatever it ended
      // up with, so a list drawn from the asked-for name would not find it.
      title: typeof result?.title === 'string' && result.title ? result.title : options.title,
      preview: '',
      messageCount: typeof result?.message_count === 'number' ? result.message_count : 0,
      lastActive: Math.floor(this.now() / 1000),
      kind: 'branch'
    }
  }

  /**
   * Every conversation this profile has, grouped.
   *
   * `include_hidden` is on, and it has to be: the canonical chat is hidden by
   * definition (ADR-0007), so a listing without it is a listing with the one row
   * the reader is actually in missing from it.
   *
   * The roster's canonical id is passed through rather than re-derived from the
   * titles, because an id cannot be typed by hand into the wrong row — see
   * `classifyConversations`.
   */
  async listConversations(botName: string): Promise<ConversationGroups> {
    const result = await this.gateway.request('session.list', {
      profile: botName,
      include_hidden: true,
      limit: PROFILE_SESSION_LIST_LIMIT
    })

    const canonical = this.bots.getState().byName[botName]?.canonical

    return classifyConversations({
      rows: (result?.sessions ?? []) as SessionListRow[],
      ...(canonical?.id ? { canonicalId: canonical.id } : {}),
      ...(canonical?.resolvedId ? { canonicalResolvedId: canonical.resolvedId } : {})
    })
  }

  /**
   * Rename one conversation that is not the canonical chat.
   *
   * There is a round trip here that a reader will wonder about: the STORED id is
   * what a listing hands out, and `session.title` takes a RUNTIME one
   * (`_with_db(session_scoped=True)` over `_sess_nowait`). So a conversation
   * nothing is running has to be resumed before it can be renamed. Resuming is
   * cheap and idempotent — it is what opening the conversation would do anyway —
   * and the alternative is asking the reader to open a conversation before they
   * are allowed to name it.
   *
   * The refusals travel: `_set_session_title` raises on an empty title, on a
   * title another session already holds, and on renaming a hidden `Bot Chat`
   * away from its name. All three are the caller's to show, so nothing is
   * swallowed here.
   */
  async renameConversation(botName: string, storedId: string, title: string): Promise<string> {
    const runtimeId = await this.runtimeIdFor(botName, storedId)
    const result = await this.gateway.request('session.title', {
      session_id: runtimeId,
      profile: botName,
      title
    })

    return typeof result?.title === 'string' ? result.title : title
  }

  /**
   * Delete one conversation.
   *
   * The STORED id, which is what `SessionDeleteParams` documents and the
   * opposite of `session.title` above.
   *
   * **This method does not check whether the conversation is canonical, on
   * purpose.** The guard is a type rather than a check —
   * `features/sessions/session-model.ts`'s `conversationActions` answers an
   * empty action list for the canonical row, so no surface can offer Delete on
   * it. Repeating the check here would make it look as though the surfaces were
   * allowed to be careless.
   */
  async deleteConversation(botName: string, storedId: string): Promise<void> {
    await this.gateway.request('session.delete', { session_id: storedId, profile: botName })
  }

  /**
   * Make one of the past conversations this bot's Bot Chat again.
   *
   * A SWAP, and the order is the same load-bearing one `/new` uses and for the
   * same reason: the title is the registry key, so while the outgoing chat still
   * wears `Bot Chat` the incoming one cannot take it. Upstream refuses a
   * duplicate outright — "Title 'Bot Chat' is already in use by session …".
   *
   * So: retire the current one through the very machinery `/new` retires with
   * (unhide, then rename to `Bot Chat · <date time>`), then rename the incoming
   * one and hide it, then switch. Every step that can fail rolls back towards
   * "nothing happened", because a bot left with no canonical chat is worse than
   * a swap that did not happen — the next open would mint a third one beside the
   * two that are already there.
   *
   * The refusal path is the one worth testing and it is real: a gateway that
   * will not let the incoming conversation be called `Bot Chat` leaves the
   * outgoing one retired and nameless, so the rollback puts its name back.
   */
  async adoptAsCanonical(botName: string, storedId: string): Promise<void> {
    const bot = this.bots.getState().byName[botName]

    if (!bot) {
      throw new Error(`${botName} is not on the roster.`)
    }

    const current = this.chats.getState().chats[botName]?.runtimeSessionId
    const incoming = await this.runtimeIdFor(botName, storedId)
    const retired = `${CANONICAL_CHAT_TITLE} · ${localStamp(this.now())}`

    if (current) {
      await this.unhideForRetire(botName, current)

      try {
        await this.renameSession(botName, current, retired)
      } catch (error) {
        // Nothing has moved yet, so putting the hidden flag back is the whole of
        // the undo.
        await this.undoRetire(botName, current, false)

        throw error
      }
    }

    try {
      await this.renameSession(botName, incoming, CANONICAL_CHAT_TITLE)
    } catch (error) {
      // The title did not move. The outgoing chat is sitting under a retired
      // name with nothing holding the canonical title, which is precisely the
      // state that makes the next open mint a third chat — so its name goes
      // back before this throws.
      if (current) {
        await this.undoRetire(botName, current, true)
      }

      throw error
    }

    /*
      Hidden, because that is what makes it canonical to everything that looks
      for one: `_canonical_session_row` resolves by title, and the roster's own
      lookup sends `include_hidden`. Best effort — the title has already moved,
      so the swap has happened either way, and a visible `Bot Chat` still
      resolves.
    */
    try {
      await this.gateway.request('session.set_hidden', {
        session_id: incoming,
        profile: botName,
        hidden: true
      })
    } catch (error) {
      this.noteRpcFailure('session.set_hidden', error)
    }

    await this.switchCanonical(bot, {
      id: storedId,
      resolvedId: storedId,
      preview: '',
      lastActive: Math.floor(this.now() / 1000),
      messageCount: 0
    })
  }

  /**
   * A runtime id for a stored one, resuming the session if nothing is running.
   *
   * The live id is preferred where the app already holds one — resuming a
   * session that is already up mints nothing new but does cost a round trip and
   * a rebuild of its runtime state.
   */
  private async runtimeIdFor(botName: string, storedId: string): Promise<string> {
    const key = conversationKey(botName, storedId)
    const open = this.chats.getState().chats[key]?.runtimeSessionId
    const canonicalChat = this.chats.getState().chats[botName]

    if (open) {
      return open
    }

    if (canonicalChat?.storedSessionId === storedId && canonicalChat.runtimeSessionId) {
      return canonicalChat.runtimeSessionId
    }

    const resume = await this.gateway.request('session.resume', {
      session_id: storedId,
      profile: botName,
      omit_messages: true,
      source: 'hermie',
      cols: RESUME_COLS
    })

    const runtimeId = typeof resume?.session_id === 'string' ? resume.session_id : ''

    if (!runtimeId) {
      throw new Error(`The gateway resumed a conversation of ${botName}'s without a session id.`)
    }

    return runtimeId
  }

  /**
   * Put the command on the gateway, down whichever road takes it.
   *
   * The catalogue decides first, and the gateway's own refusal is the backstop:
   * a bundle is not in `skills`, and upstream answers it with the same
   * "use command.dispatch" 4018 that it answers a skill with. Reading that
   * refusal and retrying is cheaper than keeping a second copy of upstream's
   * rules here and hoping it stays true.
   */
  private async callSlash(
    botName: string,
    sessionId: string,
    command: string,
    name: string,
    arg: string
  ): Promise<SlashExecResult> {
    const dispatch = async (): Promise<SlashExecResult> =>
      await this.gateway.request('command.dispatch', {
        name,
        arg,
        session_id: sessionId,
        profile: botName
      })

    if (this.slashRouteFor(botName, name) === 'dispatch') {
      return await dispatch()
    }

    try {
      return await this.gateway.request('slash.exec', { session_id: sessionId, command, profile: botName })
    } catch (error) {
      if (!WANTS_DISPATCH_RE.test(error instanceof Error ? error.message : String(error))) {
        throw error
      }

      this.noteRpcFailure('slash.exec', error)

      return await dispatch()
    }
  }

  /** One command's output, as the row kind a reader cannot miss. */
  private slashOutput(botName: string, sessionId: string, command: string, output: string): void {
    this.commandRow(botName, sessionId, command, output.trim() || 'Ran, with no output.')
  }

  /**
   * A slash command's answer, in the ONE shape every command's answer has.
   *
   * Title is the line the owner typed and body is the whole answer — a warning,
   * a refusal, five kilobytes of `/help` ASCII table, or a single word. It used
   * to depend on the length: one line went into the TITLE and nothing into the
   * body, so `NoticePill` drew it with no disclosure at all, while a longer one
   * was titled `/help — 214 lines`. Two shapes meant the reader had to work out
   * which one they had before they could read it, and the short one could not be
   * folded at all.
   *
   * `noticeKind: 'command'` is what keeps the row on screen at `quiet` — the
   * default view, where every other notice is dropped — and what opens it
   * without a tap. The reducer accepts that kind from this event and no other
   * (`reducer.ts`, `case 'notice'`), so it is this client saying "the owner
   * asked for this", never the gateway promoting its own narration.
   */
  private commandRow(botName: string, sessionId: string, command: string, body: string): void {
    this.chats.getState().dispatchEvent(botName, {
      type: 'notice',
      session_id: sessionId,
      payload: { message: command.trim() || '/', detail: body, noticeKind: 'command' }
    })
  }

  /**
   * Remember a swallowed gateway refusal so the debug screen can show it, and
   * hand the caller the same failure in the shape a SURFACE can draw.
   *
   * The ring was the only reader for a long time, and that is exactly how the
   * composer's empty popover stayed invisible: a call failed, the developer
   * screen recorded it, and the reader saw nothing at all. A method that
   * absorbs a refusal now gets the words back and can decide to show them.
   */
  private noteRpcFailure(method: string, error: unknown): SlashFailure {
    const failure = describeRpcFailure(method, error, this.now())

    this.onRpcFailure?.(failure)

    return slashFailureOf(failure)
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

  /**
   * Ask the gateway how full this session's context window is.
   *
   * Nearly always unnecessary, and that is the shape of it: the reducer already
   * folds `session.usage` ticks and the `usage` on `message.complete` into
   * `ChatState.usage`, so a chat that has run a turn since it was opened is
   * already current. This covers the other case — a chat resumed and not yet
   * spoken to, whose `session.resume` answered without `info.usage`.
   *
   * **Capability-gated by the gateway's own refusal**, not by a version test. A
   * gateway that does not know the method answers an error once, that is
   * remembered for the life of the connection, and nothing asks again; the
   * caller sees `null` and the surfaces draw nothing. A missing method is not a
   * fault a reader should be told about, which is why this answers `null` rather
   * than throwing — but it is still recorded in the RPC failure ring, because a
   * swallowed error that nothing anywhere admits to is the defect
   * `rpc-failures.ts` was written for.
   */
  async refreshUsage(botName: string): Promise<Usage | null> {
    const chat = this.chats.getState().chats[botName]
    const sessionId = chat?.runtimeSessionId

    if (!sessionId || !this.usageSupported) {
      return null
    }

    let usage: Usage

    try {
      usage = (await this.gateway.request('session.usage', {
        session_id: sessionId,
        profile: botName
      })) as Usage
    } catch (error) {
      this.usageSupported = false
      this.noteRpcFailure('session.usage', error)

      return null
    }

    if (!usage || typeof usage !== 'object') {
      return null
    }

    this.chats.getState().dispatchEvent(botName, {
      type: 'session.usage',
      session_id: sessionId,
      payload: { usage } as unknown as Record<string, unknown>
    })

    return usage
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

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** `2026-09-21 23:16`, in the reader's own zone — a retired chat is filed by when they left it. */
function localStamp(now: number): string {
  const at = new Date(now)
  const pad = (value: number): string => String(value).padStart(2, '0')

  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`
}

const retireFailed = (reason: string): string =>
  `The gateway would not put this conversation away (${reason}), so nothing was changed.`

/** What `/new` says once it has worked; the retired name is the whole point of it. */
function newConversationNotice(retired: string, asked: string, refusedName: string): string {
  const kept = `New conversation started. The previous one is kept as “${retired}”.`

  if (refusedName) {
    return `${kept} The gateway would not take “${asked}” (${refusedName}), so it was filed under its own name instead.`
  }

  if (asked) {
    return `${kept} A name given to this command goes on the conversation being put away, not on the new one — a bot's chat is always called “${CANONICAL_CHAT_TITLE}”.`
  }

  return kept
}

/**
 * An image, which goes over the socket as bytes. `kind` is optional so every
 * existing call site keeps compiling and keeps meaning what it meant.
 */
/**
 * A completion call that did not answer, in the words a popover can print.
 *
 * Two fields and no error object: the surface that draws this is a row in a
 * list, and the one thing it has to be able to do is say WHICH call failed and
 * what the gateway said about it. `describeRpcFailure` has already pulled the
 * gateway's `{code, message}` out of the transport's envelope and capped it, so
 * nothing here re-parses anything.
 */
export interface SlashFailure {
  /** The JSON-RPC method that refused, e.g. `commands.catalog`. */
  method: string
  /** The gateway's own words, with its code in front when it sent one. */
  reason: string
}

/**
 * A ring entry, as a row.
 *
 * A transport failure carries no message at all — the socket went away, there
 * was nobody to say anything — and an empty reason would draw as a dangling
 * dash. `noAnswer` is the honest word for it and is the only text this layer
 * invents.
 */
export function slashFailureOf(failure: RpcFailure): SlashFailure {
  const said = failure.message.trim()
  const reason = failure.code === undefined ? said : `${failure.code} ${said}`.trim()

  return { method: failure.method, reason: reason || SLASH_NO_ANSWER }
}

/** What a failure with no words from the gateway says instead. */
export const SLASH_NO_ANSWER = 'no answer'

/** What `complete.slash` answered, and how much of the line it stands for. */
export interface SlashCompletions {
  items: CompletionItem[]
  replaceFrom?: number
  /**
   * The call that would not answer, when one of them did not.
   *
   * Present ALONGSIDE `items` rather than instead of them: a failed catalogue
   * and a working `complete.slash` is a real state, and it is the one where the
   * list looks fine and Return does the wrong thing.
   */
  failure?: SlashFailure
}

export interface ImageAttachmentInput {
  kind?: 'image'
  filename: string
  base64: string
}

/**
 * A file already uploaded to the gateway. Only the path travels with the prompt
 * — the bytes went over HTTP, because upstream has no file-attach RPC. See
 * `file-upload.ts`.
 */
export interface FileAttachmentInput {
  kind: 'file'
  filename: string
  /** The absolute path on the gateway, from the upload's own answer. */
  path: string
}

export type AttachmentInput = ImageAttachmentInput | FileAttachmentInput

const isFileAttachment = (attachment: AttachmentInput): attachment is FileAttachmentInput => attachment.kind === 'file'

/**
 * What the painted bubble records as its attachments: references, not names.
 *
 * `UserItem.attachments` is the same contract on both sides of the wire — the
 * `@file:` / `@image:` directive strings the persisted row carries — and
 * reconciliation pairs a sent turn with its row on them whenever the prompt had
 * no words to pair on. A display name here instead is a string the gateway has
 * never seen, and a file sent with no text then came back as a second bubble.
 *
 * A file's reference is the exact token the prompt names it by, so the two are
 * built the same way. An image's is not knowable: `image.attach_bytes` sends the
 * bytes out of band and the gateway decides where they land, writing its own
 * `@image:<path>` into the row. The name goes in the path position, which is
 * what both sides can still agree on, and the row's own reference replaces it
 * once it lands.
 */
function attachmentReferences(attachments: readonly AttachmentInput[]): string[] | undefined {
  if (!attachments.length) {
    return undefined
  }

  return attachments.map(attachment =>
    isFileAttachment(attachment) ? fileReferenceFor(attachment.path) : imageReferenceFor(attachment.filename)
  )
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
    // The gateway states this twice — once at the top level and once inside
    // `info` — and an older one states it only in `info`. The reducer needs it
    // to tell a reply the running turn wrote from the reply that ended the
    // previous turn, so read whichever half answered.
    turn_started_at: result.turn_started_at ?? result.info?.turn_started_at ?? null,
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
