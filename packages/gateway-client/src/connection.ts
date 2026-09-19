import type { GatewayReadyPayload, RpcMethods, SessionLiveInfo } from '@hermes/shared/gateway-contract'
import type { GatewayEvent, GatewayEventName } from '@hermes/shared/gateway-events'
import type { ServerRequestHandler } from '@hermes/shared/json-rpc-channel'
import { JsonRpcGatewayClient } from '@hermes/shared/json-rpc-gateway'
import { reconnectBackoffDelayMs } from '@hermes/shared/reconnect-backoff'

import type { CredentialProvider } from './credentials'
import type { FetchLike } from './fetch-json'
import { GatewayHttp } from './http'
import type { DialPlanSocketFactory } from './socket-factory'
import { asGatewayError, type ConnectionStatus, GatewayError, type GatewayConfig } from './types'
import { normalizeBaseUrl, normalizeHeaders, wsUrlFor } from './url'

/** How long after the socket opens we wait for the first `gateway.ready` frame. */
export const READY_TIMEOUT_MS = 10_000
/** Default window for one JSON-RPC call. */
export const DEFAULT_RPC_TIMEOUT_MS = 30_000
/** A turn can legitimately run for half an hour. */
export const PROMPT_SUBMIT_TIMEOUT_MS = 1_800_000
/** The first `session.resume` / `session.create` after a connect rebuilds an agent; give it room. */
export const FIRST_SESSION_TIMEOUT_MS = 60_000
/** Ceiling on the reconnect ladder. */
export const RECONNECT_CAP_MS = 15_000

/**
 * How long a NetInfo "offline" has to hold before the socket comes down.
 *
 * On a phone, connectivity reports flap: a Wi-Fi/cellular handover, a VPN
 * coming up, walking past a lift. Each flap used to tear the connection down
 * and redial with `attempt = 0`, which mints a fresh ticket and rebuilds every
 * session — for a gap the socket would have ridden out untouched.
 */
export const OFFLINE_GRACE_MS = 2_500

/**
 * A dial that failed this recently means the ladder is still climbing, so a
 * network flap must not reset it back to the bottom.
 */
export const DIAL_FAILURE_RECENT_MS = 30_000
/** The oldest `SessionLiveInfo.desktop_contract` this client speaks. */
export const MIN_DESKTOP_CONTRACT = 7

/** Close codes the gateway uses to say "this is a configuration problem, not a blip". */
const CONFIG_CLOSE_CODES: Record<number, string> = {
  4403: 'The gateway rejected the connection because the address you used is not one it trusts. Set the gateway’s `dashboard.public_url` to this address and restart it.',
  4408: 'Another client took this connection over. Reopen Hermie to reclaim it.',
  4404: 'Chat is switched off on this gateway.'
}

const FIRST_SESSION_METHODS = new Set<string>(['session.resume', 'session.create'])

/**
 * How long one call gets. A prompt may legitimately run for half an hour; the
 * first `session.resume` / `session.create` after a connect rebuilds an agent
 * process and is far slower than the ones after it.
 */
export function rpcTimeoutMs(method: string, firstSessionCallDone: boolean): number {
  if (method === 'prompt.submit') {
    return PROMPT_SUBMIT_TIMEOUT_MS
  }

  if (!firstSessionCallDone && FIRST_SESSION_METHODS.has(method)) {
    return FIRST_SESSION_TIMEOUT_MS
  }

  return DEFAULT_RPC_TIMEOUT_MS
}

export type StatusHandler = (status: ConnectionStatus, error: GatewayError | null) => void

export interface GatewayConnectionOptions {
  config: GatewayConfig
  credentials: CredentialProvider
  socketFactory: DialPlanSocketFactory
  fetchImpl?: FetchLike
  /** Override the reconnect ladder (tests pass a deterministic one). */
  backoffDelayMs?: (attempt: number) => number
  readyTimeoutMs?: number
  /** Heartbeat interval; 0 disables it (the gateway still drives `gateway.ready.heartbeat`). */
  heartbeatIntervalMs?: number
  heartbeatDeadlineMs?: number
  connectTimeoutMs?: number
  /** How long an offline report must hold before the socket comes down. */
  offlineGraceMs?: number
  /** Injectable clock, so the backoff-preserving rules are testable. */
  now?: () => number
}

/**
 * The connection state machine: one long-lived `JsonRpcGatewayClient` over a
 * socket this class dials, drops and redials.
 *
 * The client instance is deliberately never replaced. Its per-session
 * `lastSeenSeq` watermarks are what make `session.events.since` replay work
 * across a reconnect, and a fresh instance would start from an empty map and
 * silently lose every event that happened while the socket was down.
 */
export class GatewayConnection {
  readonly http: GatewayHttp

  private readonly client: JsonRpcGatewayClient
  private readonly credentials: CredentialProvider
  private readonly factory: DialPlanSocketFactory
  private readonly wsUrl: string
  private readonly extraHeaders: Record<string, string>
  private readonly backoff: (attempt: number) => number
  private readonly readyTimeoutMs: number
  private readonly offlineGraceMs: number
  private readonly now: () => number

  private currentStatus: ConnectionStatus = 'disconnected'
  private currentError: GatewayError | null = null
  private readonly statusHandlers = new Set<StatusHandler>()

  private running = false
  private paused = false
  private online = true
  private attempt = 0
  private consecutiveAuthFailures = 0
  private dialToken = 0
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private offlineTimer: ReturnType<typeof setTimeout> | undefined
  private lastDialFailureAt: number | null = null
  private lastCloseCode: number | null = null
  private readyWaiter: {
    resolve: () => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
  } | null = null

  private currentReplayEpoch: string | null = null
  private currentLastReadyAt: number | null = null
  private firstSessionCallDone = false

  constructor(options: GatewayConnectionOptions) {
    const baseUrl = normalizeBaseUrl(options.config.baseUrl)
    this.credentials = options.credentials
    this.factory = options.socketFactory
    this.extraHeaders = normalizeHeaders(options.config.extraHeaders)
    this.wsUrl = wsUrlFor(baseUrl)
    this.readyTimeoutMs = options.readyTimeoutMs ?? READY_TIMEOUT_MS
    this.offlineGraceMs = options.offlineGraceMs ?? OFFLINE_GRACE_MS
    this.now = options.now ?? (() => Date.now())
    this.backoff = options.backoffDelayMs ?? (attempt => reconnectBackoffDelayMs(attempt, { capMs: RECONNECT_CAP_MS }))

    this.http = new GatewayHttp({
      baseUrl,
      credentials: options.credentials,
      extraHeaders: options.config.extraHeaders ?? {},
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {})
    })

    this.client = new JsonRpcGatewayClient({
      socketFactory: this.factory.create,
      requestTimeoutMs: DEFAULT_RPC_TIMEOUT_MS,
      ...(options.heartbeatIntervalMs === undefined ? {} : { heartbeatIntervalMs: options.heartbeatIntervalMs }),
      ...(options.heartbeatDeadlineMs === undefined ? {} : { heartbeatDeadlineMs: options.heartbeatDeadlineMs }),
      ...(options.connectTimeoutMs === undefined ? {} : { connectTimeoutMs: options.connectTimeoutMs })
    })

    this.factory.setOnClose(info => {
      this.lastCloseCode = info.code
    })

    this.client.on('gateway.ready', event => this.onGatewayReady(event))
    this.client.onState(state => {
      if (state === 'closed' || state === 'error') {
        this.onTransportClosed()
      }
    })
  }

  get status(): ConnectionStatus {
    return this.currentStatus
  }

  get lastError(): GatewayError | null {
    return this.currentError
  }

  /** `replay_epoch` from the most recent `gateway.ready`; a change means the backend restarted. */
  get replayEpoch(): string | null {
    return this.currentReplayEpoch
  }

  /** `Date.now()` of the most recent `gateway.ready`. */
  get lastReadyAt(): number | null {
    return this.currentLastReadyAt
  }

  /** Begin dialling and keep the connection up until `stop()`. */
  start(): void {
    if (this.running) {
      return
    }

    this.running = true
    this.paused = false
    this.attempt = 0
    this.consecutiveAuthFailures = 0

    if (!this.online) {
      this.setStatus('offline')

      return
    }

    void this.runDial()
  }

  /** Tear the connection down for good (sign-out, gateway change, app shutdown). */
  stop(): void {
    this.running = false
    this.paused = false
    this.teardown()
    this.setStatus('disconnected', null)
  }

  /**
   * Close the socket cleanly and stop every timer — the app went to the
   * background.
   *
   * A connection that is not running has already stopped for a reason it can
   * explain: `needs_signin`, a rejected certificate, a gateway that refused the
   * address. Overwriting that with `paused` loses the only account of why there
   * is no connection, and the user comes back to a blank screen.
   */
  pause(): void {
    if (this.paused || !this.running) {
      return
    }

    this.paused = true
    this.teardown()
    this.setStatus('paused', null)
  }

  /** Come back from the background: dial straight away, no backoff. */
  resume(): void {
    if (!this.paused && this.running) {
      return
    }

    this.paused = false
    this.running = true
    this.attempt = 0
    // A resume follows a fresh sign-in as often as it follows a foreground.
    // Keeping the old tally would send the next single rejection straight to
    // `needs_signin` with the new credential barely tried.
    this.consecutiveAuthFailures = 0
    this.clearOfflineTimer()

    if (!this.online) {
      this.setStatus('offline')

      return
    }

    void this.runDial()
  }

  /**
   * NetInfo says the device has (no) connectivity.
   *
   * Offline is acted on after a grace period rather than immediately: the
   * reports flap, and a socket that is actually fine must not be rebuilt for a
   * gap shorter than the rebuild itself. Coming back online inside the grace
   * cancels the whole thing, so the connection never notices.
   */
  setOnline(online: boolean): void {
    // True while the grace is still running, which means the socket is still up
    // and coming back online is a no-op rather than a redial.
    const withinGrace = this.offlineTimer !== undefined

    if (online) {
      this.clearOfflineTimer()
    }

    if (this.online === online) {
      return
    }

    this.online = online

    if (!online) {
      if (this.currentStatus !== 'ready') {
        // Nothing established to protect: a dial in progress or a ladder
        // waiting out its backoff is pure battery while the radio is down.
        this.teardown()
        this.setStatus('offline', null)

        return
      }

      this.offlineTimer = setTimeout(() => {
        this.offlineTimer = undefined
        this.teardown()
        this.setStatus('offline', null)
      }, this.offlineGraceMs)

      return
    }

    if (withinGrace || !this.running || this.paused) {
      // The flap ended before the socket came down; there is nothing to redial.
      return
    }

    // A dial that failed moments ago means the gateway, not the radio, is what
    // is unreachable. Resetting the ladder there would hammer it once per flap,
    // so the backoff it had earned is kept.
    if (this.lastDialFailureAt === null || this.now() - this.lastDialFailureAt > DIAL_FAILURE_RECENT_MS) {
      this.attempt = 0
    }

    void this.runDial()
  }

  /**
   * One JSON-RPC call, typed from the generated contract. Timeouts follow the
   * method: a prompt may run for half an hour, the first session call after a
   * connect rebuilds an agent, everything else gets 30 seconds.
   */
  request<M extends keyof RpcMethods>(
    method: M,
    params?: RpcMethods[M]['params'],
    options: { timeoutMs?: number; signal?: AbortSignal } = {}
  ): Promise<RpcMethods[M]['result']> {
    const timeoutMs = options.timeoutMs ?? rpcTimeoutMs(method as string, this.firstSessionCallDone)

    if (FIRST_SESSION_METHODS.has(method as string)) {
      this.firstSessionCallDone = true
    }

    return this.client.request<RpcMethods[M]['result']>(
      method as string,
      (params ?? {}) as Record<string, unknown>,
      timeoutMs,
      options.signal
    )
  }

  /** Subscribe to one gateway event type. */
  on<K extends GatewayEventName>(type: K, handler: (event: GatewayEvent<K>) => void): () => void {
    return this.client.on(type, handler)
  }

  /** Subscribe to every gateway event. */
  onAny(handler: (event: GatewayEvent) => void): () => void {
    return this.client.onAny(handler)
  }

  /** Server→client requests (approval, clarify, …). Unhandled ones are answered -32601 for us. */
  onRequest(handler: ServerRequestHandler): () => void {
    return this.client.onRequest(handler)
  }

  /** Subscribe to status transitions; the handler is called once with the current status. */
  onStatus(handler: StatusHandler): () => void {
    this.statusHandlers.add(handler)
    handler(this.currentStatus, this.currentError)

    return () => this.statusHandlers.delete(handler)
  }

  private async runDial(): Promise<void> {
    const token = ++this.dialToken
    const alive = () => token === this.dialToken && this.running && !this.paused && this.online

    this.clearRetryTimer()
    this.lastCloseCode = null

    try {
      this.setStatus('authenticating')
      const plan = await this.credentials.dialPlan(this.wsUrl, this.extraHeaders)

      if (!alive()) {
        return
      }

      this.factory.arm(plan)
      // Register the waiter before connecting: `gateway.ready` can land in the
      // same tick the socket opens, and a gateway that refuses the credential
      // closes the socket instead of ever sending it.
      const ready = this.waitForReady()
      // The dial loop below awaits this; the no-op keeps a rejection that lands
      // while `connect()` is still pending from being reported as unhandled.
      ready.catch(() => undefined)
      this.setStatus('connecting')

      try {
        await this.client.connect(plan.url)
        await ready
      } finally {
        this.factory.disarm()
      }

      if (!alive()) {
        return
      }

      this.attempt = 0
      this.consecutiveAuthFailures = 0
      this.firstSessionCallDone = false
      this.lastDialFailureAt = null
      this.currentLastReadyAt = Date.now()
      this.setStatus('ready', null)
    } catch (error) {
      this.factory.disarm()

      if (!alive()) {
        return
      }

      await this.handleFailure(error)
    }
  }

  private waitForReady(): Promise<void> {
    this.rejectReadyWaiter(new GatewayError('network', 'A newer dial replaced this one.'))

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.readyWaiter = null
        reject(
          new GatewayError(
            'timeout',
            `The gateway accepted the socket but sent no gateway.ready within ${this.readyTimeoutMs / 1000} seconds.`
          )
        )
      }, this.readyTimeoutMs)

      this.readyWaiter = { resolve, reject, timer }
    })
  }

  private rejectReadyWaiter(error: Error): void {
    const waiter = this.readyWaiter

    if (!waiter) {
      return
    }

    this.readyWaiter = null
    clearTimeout(waiter.timer)
    waiter.reject(error)
  }

  private onGatewayReady(event: GatewayEvent<'gateway.ready'>): void {
    const payload = event.payload as GatewayReadyPayload | undefined
    const epoch = payload?.replay_epoch

    if (typeof epoch === 'string' && epoch) {
      this.currentReplayEpoch = epoch
    }

    this.currentLastReadyAt = Date.now()

    const waiter = this.readyWaiter

    if (waiter) {
      this.readyWaiter = null
      clearTimeout(waiter.timer)
      waiter.resolve()
    }
  }

  private onTransportClosed(): void {
    if (!this.running || this.paused || !this.online) {
      return
    }

    // A gated gateway accepts the upgrade and *then* closes with 4401/4403, so
    // the socket opens and no `gateway.ready` ever arrives. Fail the waiting
    // dial straight away instead of sitting out the ready timeout.
    if (this.readyWaiter) {
      this.rejectReadyWaiter(
        new GatewayError('network', 'The gateway closed the connection during the handshake.', {
          ...(this.lastCloseCode === null ? {} : { closeCode: this.lastCloseCode })
        })
      )

      return
    }

    // A drop mid-dial is already the dial loop's problem; only a live connection
    // losing its socket has to re-enter the loop from here.
    if (this.currentStatus !== 'ready') {
      return
    }

    void this.handleFailure(
      new GatewayError('network', 'The gateway connection dropped.', {
        ...(this.lastCloseCode === null ? {} : { closeCode: this.lastCloseCode })
      })
    )
  }

  private async handleFailure(raw: unknown): Promise<void> {
    const error = asGatewayError(raw, 'network', 'The gateway connection failed.')
    const closeCode = error.closeCode ?? this.lastCloseCode
    this.lastDialFailureAt = this.now()

    if (closeCode !== null && closeCode !== undefined && CONFIG_CLOSE_CODES[closeCode]) {
      this.running = false
      this.teardown()
      this.setStatus(
        'disconnected',
        new GatewayError('config', CONFIG_CLOSE_CODES[closeCode] as string, { closeCode, cause: error })
      )

      return
    }

    if (error.kind === 'tls') {
      // Retrying a rejected certificate just fails the same way; stop and explain.
      this.running = false
      this.teardown()
      this.setStatus('disconnected', error)

      return
    }

    if (error.kind === 'config') {
      this.running = false
      this.teardown()
      this.setStatus('disconnected', error)

      return
    }

    if (closeCode === 4401 || error.kind === 'auth') {
      await this.handleAuthFailure(error)

      return
    }

    this.scheduleReconnect(error)
  }

  private async handleAuthFailure(error: GatewayError): Promise<void> {
    this.consecutiveAuthFailures += 1
    this.teardownSocket()

    if (this.consecutiveAuthFailures > 1) {
      this.running = false
      this.teardown()
      this.setStatus(
        'needs_signin',
        new GatewayError('auth', 'The gateway rejected the credentials twice in a row. Sign in again.', {
          ...(error.closeCode === undefined ? {} : { closeCode: error.closeCode }),
          cause: error
        })
      )

      return
    }

    let verdict: 'retry' | 'reauth'

    try {
      verdict = await this.credentials.onRejected()
    } catch (refreshError) {
      this.scheduleReconnect(asGatewayError(refreshError, 'network', 'Refreshing the credentials failed.'))

      return
    }

    if (!this.running || this.paused || !this.online) {
      return
    }

    if (verdict === 'reauth') {
      this.running = false
      this.teardown()
      this.setStatus(
        'needs_signin',
        new GatewayError('auth', 'Your session has expired. Sign in again.', {
          cause: error
        })
      )

      return
    }

    this.currentError = error
    void this.runDial()
  }

  private scheduleReconnect(error: GatewayError): void {
    this.teardownSocket()

    if (!this.running || this.paused || !this.online) {
      return
    }

    const delay = this.backoff(this.attempt)
    this.attempt += 1
    this.setStatus('reconnecting', error)
    this.clearRetryTimer()
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined
      void this.runDial()
    }, delay)
  }

  private teardown(): void {
    this.dialToken += 1
    this.clearRetryTimer()
    this.clearOfflineTimer()
    this.teardownSocket()
    this.factory.disarm()
  }

  private teardownSocket(): void {
    this.rejectReadyWaiter(new GatewayError('network', 'The gateway connection was closed.'))
    this.client.close()
  }

  private clearRetryTimer(): void {
    if (this.retryTimer !== undefined) {
      clearTimeout(this.retryTimer)
      this.retryTimer = undefined
    }
  }

  private clearOfflineTimer(): void {
    if (this.offlineTimer !== undefined) {
      clearTimeout(this.offlineTimer)
      this.offlineTimer = undefined
    }
  }

  private setStatus(status: ConnectionStatus, error: GatewayError | null | undefined = undefined): void {
    if (error !== undefined) {
      this.currentError = error
    }

    if (this.currentStatus === status) {
      return
    }

    this.currentStatus = status

    for (const handler of this.statusHandlers) {
      handler(status, this.currentError)
    }
  }
}

/**
 * Version gate. `SessionLiveInfo.desktop_contract` is the gateway's promise about
 * the shape of the session surface; below 7 the events this client reduces are
 * not all there, so refusing up front beats half-rendering a transcript.
 */
export function assertDesktopContract(info: SessionLiveInfo | null | undefined): number {
  const raw = info?.desktop_contract
  const contract = typeof raw === 'string' ? Number.parseInt(raw, 10) : raw

  if (typeof contract !== 'number' || Number.isNaN(contract)) {
    throw new GatewayError(
      'incompatible',
      'This gateway does not report a desktop contract version, so it predates the session surface Hermie needs. Update Hermes on the gateway.'
    )
  }

  if (contract < MIN_DESKTOP_CONTRACT) {
    throw new GatewayError(
      'incompatible',
      `This gateway speaks desktop contract ${contract}; Hermie needs at least ${MIN_DESKTOP_CONTRACT}. Update Hermes on the gateway.`
    )
  }

  return contract
}
