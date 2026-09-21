/**
 * The daemon's one connection to its one gateway.
 *
 * This is the same JSON-RPC-over-WebSocket contract the app speaks — request
 * ids and a pending map, `event` notifications, the `gateway.ping` heartbeat,
 * and the `session.events.since` replay that makes a reconnect lossless. The
 * canonical implementation of that contract is
 * `packages/hermes-shared/src/json-rpc-gateway.ts`, and this file deliberately
 * mirrors its semantics rather than importing it: Hermie Web ships as a
 * self-contained CommonJS `dist/server` with **no `node_modules`** beside it
 * (see its Dockerfile and the release job), so a cross-package runtime import
 * would be a module the released artefact does not carry. Where the two differ,
 * that package is right and this one is the bug.
 *
 * Two things here are NOT in the shared client, and both come straight out of
 * [ADR-0017](../../../../docs/adr/0017-push-through-hermie-web.md):
 *
 *  - **It is a reader.** `ALLOWED_METHODS` is enforced in `request`, so there is
 *    no code path in this process that submits a prompt, answers a question or
 *    changes a setting. The one write it makes is `ui_meta`, and
 *    `profiles.configure` is refused here unless `ui_meta` is the only thing it
 *    carries.
 *  - **It never answers a server→client request, and by default it does not ask
 *    to receive one.** An approval belongs to the owner, not to a daemon.
 *    Advertising `client.capabilities {server_requests: true}` is what makes a
 *    backend route them to this connection, and whether that is SAFE depends on
 *    something upstream has not promised: if a session's transport fans a
 *    request out to every peer, the app receives it too and answers it, and the
 *    daemon holding it open costs nothing. If a real backend picks ONE peer
 *    instead, a daemon that holds the request open has taken the owner's
 *    question away from them.
 *
 *    So the default is not to ask. Open requests are learnt from the snapshot a
 *    `session.resume` answers with (`open_requests`, `pending_approval`) and
 *    from the watcher's `approval.pending` poll — the same method and the same
 *    30 s cadence the app already uses. `advertiseServerRequests` turns the live
 *    route back on for an operator who knows their gateway fans out; the flag is
 *    `--push-server-requests` and the documentation says what it risks.
 *
 * The transport is Node's own global `WebSocket`, for the same reason as above:
 * `ws` is a devDependency of this package and the shipped artefact installs
 * nothing.
 */

/** One decoded `event` notification. */
export interface LinkEvent {
  type: string
  session_id?: string
  seq?: number
  payload?: unknown
}

/** One inbound server→client request, reported and never answered. */
export interface LinkServerRequest {
  id: string
  method: string
  params: Record<string, unknown>
  /** True when it came from a resume's `open_requests` rather than off the wire. */
  replayed: boolean
}

/** Everything this process is allowed to ask its gateway for. */
export const ALLOWED_METHODS: ReadonlySet<string> = new Set([
  // Reading the approval QUEUE, never answering one. `approval.respond` is not
  // on this list and must never be.
  'approval.pending',
  'client.capabilities',
  'gateway.ping',
  'profiles.configure',
  'profiles.list',
  'session.events.since',
  'session.history',
  'session.list',
  'session.resume'
])

export interface DialPlan {
  url: string
  protocols?: string[]
}

export interface GatewayLinkOptions {
  /**
   * Mint everything one dial needs, immediately before it happens.
   *
   * A gated gateway's WebSocket ticket is single-use with a 30 s TTL, so the
   * URL cannot be computed once and kept — which is also why this is a function
   * and not a string.
   */
  dial: () => Promise<DialPlan>
  /** Every event, live or replayed, in seq order per session. */
  onEvent: (event: LinkEvent) => void
  /** Reported, never answered. See the note at the top of this file. */
  onServerRequest?: (request: LinkServerRequest) => void
  /** Ran after every successful connect, before the replay. Resume the chats here. */
  onOpen?: () => Promise<void> | void
  /** A connection generation ended. The link is already scheduling the next dial. */
  onClosed?: (reason: string) => void
  /** One line per state change, so `--push` has something to print. */
  log?: (line: string) => void
  requestTimeoutMs?: number
  heartbeatIntervalMs?: number
  heartbeatDeadlineMs?: number
  connectTimeoutMs?: number
  /** Full-jitter ladder, as `packages/hermes-shared/src/reconnect-backoff.ts` computes it. */
  backoffBaseMs?: number
  backoffCapMs?: number
  /**
   * Ask the backend to route server→client requests here.
   *
   * Off by default, and the reason is at the top of this file: it is only safe
   * on a gateway that fans a request out to every peer of a session.
   */
  advertiseServerRequests?: boolean
  /** Injected by the tests; defaults to Node's global `WebSocket`. */
  socketFactory?: (url: string, protocols?: string[]) => WebSocket
  /** Injected by the tests so a reconnect does not cost real seconds. */
  sleep?: (ms: number) => Promise<void>
  random?: () => number
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000
const DEFAULT_HEARTBEAT_DEADLINE_MS = 45_000
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000
const DEFAULT_BACKOFF_BASE_MS = 300
const DEFAULT_BACKOFF_CAP_MS = 15_000
/** Bounded so a wedged backend cannot hold the replay open. */
const REPLAY_TIMEOUT_MS = 10_000
const MAX_EXPONENT = 32

/**
 * Full jitter, restated from `reconnect-backoff.ts`.
 *
 * A bare exponential ladder lets every client that dropped together redial
 * together; a random sleep inside the ceiling spreads the herd out.
 */
export function backoffDelayMs(attempt: number, base: number, cap: number, random: () => number): number {
  const exponent = Math.min(Math.max(0, Math.trunc(attempt)), MAX_EXPONENT)

  return random() * Math.min(cap, base * 2 ** exponent)
}

export class GatewayLink {
  private socket: WebSocket | null = null
  private nextId = 0
  private readonly pending = new Map<string, Pending>()
  private readonly outstandingPings = new Set<string>()
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private lastInboundAt = 0
  private running = false
  private attempt = 0
  /** session id → the highest seq this link has handed on. */
  private readonly watermarks = new Map<string, number>()
  /**
   * The backend's process identity. Seq counters are in-process upstream, so a
   * restart resets them while we still hold high watermarks — without this a
   * replay from an old watermark returns nothing, for ever, and the daemon
   * silently believes it missed nothing.
   */
  private epoch: string | null = null
  private loop: Promise<void> | null = null

  constructor(private readonly options: GatewayLinkOptions) {}

  get connected(): boolean {
    return this.socket?.readyState === 1
  }

  /** The seq the next replay for this session will ask from. */
  watermarkOf(sessionId: string): number {
    return this.watermarks.get(sessionId) ?? 0
  }

  /** Every watermark this link holds, so the daemon can persist them. */
  snapshotWatermarks(): Record<string, number> {
    return Object.fromEntries(this.watermarks)
  }

  /** Seed a watermark from the persisted state, so a restart is not a replay of everything. */
  seedWatermark(sessionId: string, seq: number): void {
    if (seq > this.watermarkOf(sessionId)) {
      this.watermarks.set(sessionId, seq)
    }
  }

  /** Start dialling, and keep dialling for as long as `stop` has not been called. */
  start(): void {
    if (this.running) {
      return
    }

    this.running = true
    this.loop = this.run()
  }

  async stop(): Promise<void> {
    this.running = false
    this.dropSocket('stopped')
    await this.loop?.catch(() => undefined)
    this.loop = null
  }

  private log(line: string): void {
    this.options.log?.(line)
  }

  private async run(): Promise<void> {
    const sleep = this.options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms).unref()))
    const random = this.options.random ?? Math.random

    while (this.running) {
      try {
        await this.connectOnce()
        this.attempt = 0
        await this.waitForClose()
      } catch (error) {
        // A failure caused by `stop()` is not news; it is what was asked for.
        if (this.running) {
          this.log(`push: gateway connection failed — ${error instanceof Error ? error.message : String(error)}`)
        }
      }

      if (!this.running) {
        return
      }

      const delay = backoffDelayMs(
        this.attempt,
        this.options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS,
        this.options.backoffCapMs ?? DEFAULT_BACKOFF_CAP_MS,
        random
      )
      this.attempt += 1
      await sleep(delay)
    }
  }

  private closeWaiters: (() => void)[] = []

  private waitForClose(): Promise<void> {
    if (!this.socket) {
      return Promise.resolve()
    }

    return new Promise<void>(resolve => {
      this.closeWaiters.push(resolve)
    })
  }

  private async connectOnce(): Promise<void> {
    const plan = await this.options.dial()
    const factory =
      this.options.socketFactory ??
      ((url: string, protocols?: string[]) => (protocols?.length ? new WebSocket(url, protocols) : new WebSocket(url)))
    const socket = factory(plan.url, plan.protocols)
    this.socket = socket
    this.lastInboundAt = Date.now()

    socket.addEventListener('message', event => {
      if (this.socket !== socket) {
        return
      }

      this.handleFrame(frameText((event as { data?: unknown }).data))
    })

    socket.addEventListener('close', event => {
      if (this.socket !== socket) {
        return
      }

      this.dropSocket(`closed (${String((event as { code?: number }).code ?? 0)})`)
    })

    await new Promise<void>((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) {
          return
        }

        settled = true
        this.dropSocket('connect timed out')
        reject(new Error('the gateway did not complete the WebSocket handshake'))
      }, this.options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS)
      ;(timer as { unref?: () => void }).unref?.()

      socket.addEventListener(
        'open',
        () => {
          if (settled) {
            return
          }

          settled = true
          clearTimeout(timer)
          resolve()
        },
        { once: true }
      )

      const fail = () => {
        if (settled) {
          return
        }

        settled = true
        clearTimeout(timer)
        reject(new Error('the gateway refused the WebSocket connection'))
      }

      socket.addEventListener('error', fail, { once: true })
      socket.addEventListener('close', fail, { once: true })
    })

    this.log('push: connected to the gateway')
    this.startHeartbeat(socket)

    if (this.options.advertiseServerRequests) {
      // Opt-in only. We answer none of them either way; see the top of this file
      // for why asking to receive them is the part that carries a risk.
      void this.request('client.capabilities', { server_requests: true }).catch(() => undefined)
    }

    await this.options.onOpen?.()
    await this.replay()
  }

  private startHeartbeat(socket: WebSocket): void {
    this.stopHeartbeat()

    const interval = this.options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS
    const deadline = this.options.heartbeatDeadlineMs ?? DEFAULT_HEARTBEAT_DEADLINE_MS

    if (interval <= 0 || deadline <= 0) {
      return
    }

    this.heartbeatTimer = setInterval(() => {
      if (this.socket !== socket) {
        return
      }

      if (Date.now() - this.lastInboundAt >= deadline) {
        // A silent drop — sleep, a proxy idle timeout, a VPN reconnect — kills
        // the TCP socket without a close event. Without this the daemon sits on
        // a dead socket and notifies nobody, for ever.
        this.dropSocket('heartbeat timed out')

        return
      }

      const id = `hb-${this.outstandingPings.size}-${Date.now()}`
      this.outstandingPings.add(id)

      if (this.outstandingPings.size > 8) {
        this.outstandingPings.delete(this.outstandingPings.values().next().value as string)
      }

      try {
        socket.send(JSON.stringify({ jsonrpc: '2.0', id, method: 'gateway.ping', params: {} }))
      } catch {
        this.dropSocket('heartbeat send failed')
      }
    }, interval)
    ;(this.heartbeatTimer as { unref?: () => void }).unref?.()
  }

  private stopHeartbeat(): void {
    this.outstandingPings.clear()

    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  private dropSocket(reason: string): void {
    const socket = this.socket

    if (!socket) {
      return
    }

    this.socket = null
    this.stopHeartbeat()

    for (const [id, call] of this.pending) {
      clearTimeout(call.timer)
      this.pending.delete(id)
      call.reject(new Error(`gateway connection ${reason}`))
    }

    try {
      socket.close()
    } catch {
      // Already gone; the dial loop owns what happens next.
    }

    this.options.onClosed?.(reason)
    this.log(`push: gateway connection ${reason}`)

    const waiters = this.closeWaiters
    this.closeWaiters = []

    for (const waiter of waiters) {
      waiter()
    }
  }

  /**
   * One RPC.
   *
   * Refuses anything outside `ALLOWED_METHODS`, and refuses a
   * `profiles.configure` that carries more than `ui_meta`. Both are asserted in
   * the tests: "it is a reader" is a property of this process, and a property
   * nothing enforces is a sentence in a document.
   */
  request<T>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    if (!ALLOWED_METHODS.has(method)) {
      return Promise.reject(new Error(`the push daemon does not call ${method}`))
    }

    if (method === 'profiles.configure') {
      const extra = Object.keys(params).filter(
        key => key !== 'ui_meta' && key !== 'ui_meta_expected_revisions' && key !== 'name' && key !== 'profile'
      )

      if (extra.length) {
        return Promise.reject(new Error(`the push daemon writes ui_meta only, not ${extra.join(', ')}`))
      }
    }

    const socket = this.socket

    if (!socket || socket.readyState !== 1) {
      return Promise.reject(new Error('the gateway is not connected'))
    }

    const id = `p${++this.nextId}`
    const wait = timeoutMs ?? this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`request timed out after ${Math.round(wait / 1000)}s: ${method}`))
        }
      }, wait)
      ;(timer as { unref?: () => void }).unref?.()

      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer })

      try {
        socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
      } catch (error) {
        const call = this.pending.get(id)

        if (call) {
          clearTimeout(call.timer)
          this.pending.delete(id)
        }

        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private handleFrame(text: string | null): void {
    if (text === null) {
      return
    }

    this.lastInboundAt = Date.now()

    let frame: Record<string, unknown>

    try {
      frame = JSON.parse(text) as Record<string, unknown>
    } catch {
      return
    }

    if (!frame || typeof frame !== 'object') {
      return
    }

    const id = frame.id
    const method = frame.method

    // A server→client request: an id AND a method, which a response never has.
    if (typeof id === 'string' && typeof method === 'string' && method !== 'event') {
      const params = (frame.params ?? {}) as Record<string, unknown>
      this.options.onServerRequest?.({ id, method, params, replayed: false })

      return
    }

    if (typeof id === 'string') {
      if (this.outstandingPings.delete(id)) {
        return
      }

      const call = this.pending.get(id)

      if (!call) {
        return
      }

      clearTimeout(call.timer)
      this.pending.delete(id)

      if (frame.error) {
        const error = frame.error as { message?: unknown }
        call.reject(new Error(typeof error?.message === 'string' ? error.message : 'the gateway refused the call'))

        return
      }

      this.deliverOpenRequests(frame.result)
      call.resolve(frame.result)

      return
    }

    if (method === 'event') {
      const event = (frame.params ?? {}) as LinkEvent

      if (typeof event.type !== 'string') {
        return
      }

      if (event.type === 'gateway.ready') {
        const epoch = (event.payload as { replay_epoch?: unknown } | null)?.replay_epoch

        if (typeof epoch === 'string' && epoch) {
          this.adoptEpoch(epoch)
        }
      }

      this.dispatch(event)
    }
  }

  /**
   * `session.resume` and `session.events.since` answer with the server→client
   * requests still waiting on that session. They cannot ride the event ring, so
   * they come back on the response — which is the only way the daemon learns
   * about a question that was already open when it connected.
   */
  private deliverOpenRequests(result: unknown): void {
    const snapshot = (result ?? {}) as { open_requests?: unknown; pending_approval?: unknown; session_id?: unknown }
    const open = snapshot.open_requests

    if (Array.isArray(open)) {
      for (const entry of open as { id?: unknown; method?: unknown; params?: unknown }[]) {
        if (typeof entry?.id === 'string' && typeof entry.method === 'string') {
          this.options.onServerRequest?.({
            id: entry.id,
            method: entry.method,
            params: (entry.params ?? {}) as Record<string, unknown>,
            replayed: true
          })
        }
      }
    }

    /*
      `pending_approval` is the QUEUE entry, not a live JSON-RPC request: an
      approval raised before this connection existed has no `open_requests` row
      to carry it, because there is no inbound call here to answer. Without
      reading it, a daemon that started while a bot was already blocked on a
      question would say nothing until the next poll — and on the safe default
      the poll is the only other source there is.
    */
    const pending = snapshot.pending_approval

    if (pending && typeof pending === 'object') {
      const row = pending as Record<string, unknown>
      const requestId = typeof row.request_id === 'string' ? row.request_id : ''
      const sessionId = typeof snapshot.session_id === 'string' ? snapshot.session_id : ''

      this.options.onServerRequest?.({
        // `pending:` marks a card with no live reply behind it, the same prefix
        // the app's own snapshot and poll synthesize.
        id: `pending:${requestId || 'approval'}`,
        method: 'approval',
        params: { ...row, ...(sessionId ? { session_id: sessionId } : {}) },
        replayed: true
      })
    }
  }

  private adoptEpoch(epoch: string): void {
    if (this.epoch && this.epoch !== epoch) {
      // The backend restarted: its seq numbering began again, so every
      // watermark we hold points past the end of a counter that no longer
      // exists. Forget them rather than replaying from a number that will never
      // come round again.
      this.watermarks.clear()
      this.log('push: the gateway restarted; sequence watermarks were dropped')
    }

    this.epoch = epoch
  }

  /** Hand an event on if it is newer than what this session has already produced. */
  private dispatch(event: LinkEvent): void {
    const sid = event.session_id
    const seq = event.seq

    if (sid && typeof seq === 'number' && Number.isFinite(seq)) {
      if (seq <= this.watermarkOf(sid)) {
        return
      }

      this.watermarks.set(sid, seq)
    }

    this.options.onEvent(event)
  }

  /**
   * Drain what was emitted while the socket was down.
   *
   * One call per known session; sessions are few. A failure is swallowed — the
   * next reconnect asks again, and the alternative to a best-effort replay is
   * not a better replay, it is no connection.
   */
  private async replay(): Promise<void> {
    const entries = [...this.watermarks.entries()]

    for (const [sessionId, lastSeen] of entries) {
      let result: { events?: LinkEvent[]; epoch?: unknown; truncated?: unknown }

      try {
        result = await this.request(
          'session.events.since',
          { session_id: sessionId, last_seen: lastSeen },
          REPLAY_TIMEOUT_MS
        )
      } catch {
        continue
      }

      const epoch = result?.epoch

      if (typeof epoch === 'string' && epoch) {
        if (this.epoch && epoch !== this.epoch) {
          this.adoptEpoch(epoch)

          continue
        }

        this.epoch = epoch
      }

      for (const event of Array.isArray(result?.events) ? result.events : []) {
        if (event?.type) {
          this.dispatch(event)
        }
      }
    }
  }
}

const decoder = new TextDecoder()

/** Decode a socket message to text; `null` for anything that is not one. */
export function frameText(raw: unknown): string | null {
  if (typeof raw === 'string') {
    return raw
  }

  if (raw instanceof ArrayBuffer || ArrayBuffer.isView(raw)) {
    return decoder.decode(raw as ArrayBuffer)
  }

  return null
}
