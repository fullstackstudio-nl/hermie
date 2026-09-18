import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { type AddressInfo } from 'node:net'
import { URL } from 'node:url'

import { WebSocket, WebSocketServer } from 'ws'

/**
 * A stand-in for `hermes serve` that speaks enough of the gateway contract to
 * drive the real client: the public status endpoints, both auth flows, the
 * native PKCE round trip, single-use WebSocket tickets, and the JSON-RPC
 * surface Hermie calls.
 *
 * Shapes follow `apps/shared/src/gateway-contract.generated.ts`. Behaviour that
 * only exists for tests (forcing a close code, dropping a socket without a
 * close frame) is on the handle, never on the wire.
 */

export type FakeAuthMode = 'none' | 'token' | 'native'

export interface ScenarioReply {
  /** Substring of the prompt this reply answers; omitted means "anything". */
  match?: string
  deltas?: string[]
  text?: string
  tool?: { name: string; args?: Record<string, unknown>; summary?: string; result?: unknown }
}

export interface Scenario {
  replies?: ScenarioReply[]
}

export interface FakeGatewayOptions {
  port?: number
  host?: string
  auth?: FakeAuthMode
  token?: string
  /** Close code used when a WebSocket upgrade fails auth (default 4401). */
  closeCode?: number
  scenario?: Scenario
  version?: string
  /** How many events per session the replay ring keeps. */
  replayRingSize?: number
  /** Delay between streamed frames, in ms. */
  streamDelayMs?: number
}

export interface FakeSession {
  id: string
  storedId: string
  profile: string
  title: string
  messages: TranscriptRow[]
  seq: number
  ring: RingEntry[]
}

export interface TranscriptRow {
  role: string
  text?: string
  row_id?: number
  timestamp?: number
  display_kind?: string | null
  name?: string | null
  args?: Record<string, unknown> | null
}

interface RingEntry {
  type: string
  session_id: string
  seq: number
  payload: unknown
}

export interface FakeGatewayState {
  auth: FakeAuthMode
  token: string
  closeCode: number
  replayEpoch: string
  /** Access tokens the gateway currently honours. */
  accessTokens: Set<string>
  ticketsMinted: number
  ticketsConsumed: number
  tokenExchanges: number
  refreshCalls: number
  /** Successful WebSocket sessions since boot. */
  connections: number
  /** WebSocket upgrades rejected with a close code. */
  rejectedUpgrades: number
  /** Force the next N upgrades to fail auth even with a valid credential. */
  rejectNextUpgrades: number
  /** `session.events.since` calls, newest last. */
  eventsSinceCalls: { session_id: string; last_seen: number }[]
  /** Every JSON-RPC method the server handled, in order. */
  methodLog: string[]
  /** Mark the next replay answer as truncated. */
  truncateNextReplay: boolean
  /** Methods the server accepts and never answers, so a caller's timeout fires. */
  hangMethods: Set<string>
  sessions: Map<string, FakeSession>
  profiles: ProfileRow[]
  cronJobs: CronJob[]
}

interface ProfileRow {
  name: string
  path: string
  description: string
  display_name: string
  is_default?: boolean
  canonical_session?: {
    id: string
    resolved_id: string
    title: string
    preview: string
    last_active: number
    message_count: number
  }
  ui_meta?: Record<string, unknown>
}

interface CronJob {
  job_id: string
  name: string
  schedule: string
  prompt_preview: string
  deliver: string
  enabled: boolean
  state: string
  next_run_at: string | null
  last_run_at: string | null
  last_status: string | null
  runs: { id: string; started_at: string; status: string }[]
}

export interface FakeGateway {
  port: number
  url: string
  wsUrl: string
  state: FakeGatewayState
  /** Publish one gateway event to every connected socket. */
  emit(type: string, options?: { sessionId?: string; payload?: unknown }): void
  /** Push a server→client `approval` request and resolve with the client's answer. */
  requestApproval(params: Record<string, unknown>): Promise<unknown>
  /** Close every live socket with a code, the way the gateway does on a policy refusal. */
  closeSockets(code: number, reason?: string): void
  /** Kill every live socket without a close frame: the client sees 1006. */
  dropSockets(): void
  close(): Promise<void>
}

const WS_PATH = '/api/ws'
const GATEWAY_WS_PROTOCOL = 'hermes-gateway-v1'
const TICKET_PROTOCOL_PREFIX = 'hermes-gateway-ticket.'
const TICKET_TTL_SECONDS = 30

const DEFAULT_SCENARIO: Scenario = {
  replies: [
    {
      deltas: ['Looking that up', ' for you.'],
      text: 'Looking that up for you.',
      tool: { name: 'read_file', args: { path: 'README.md' }, summary: 'read README.md', result: '# Hermie' }
    }
  ]
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

/** base64url(SHA-256(verifier)) — the `code_challenge` the client sent (RFC 7636 S256). */
function s256(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url')
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

function html(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' })
  res.end(body)
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []

  for await (const chunk of req) {
    chunks.push(chunk as Buffer)
  }

  const raw = Buffer.concat(chunks).toString('utf8')

  if (!raw.trim()) {
    return {}
  }

  try {
    const parsed: unknown = JSON.parse(raw)

    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function makeSession(profile: string, title: string): FakeSession {
  const storedId = `stored-${profile}-${randomUUID().slice(0, 8)}`

  return {
    id: `runtime-${randomUUID().slice(0, 8)}`,
    storedId,
    profile,
    title,
    seq: 0,
    ring: [],
    messages: [
      { role: 'user', text: 'Introduce yourself in one line.', row_id: 1, timestamp: nowSeconds() - 600 },
      {
        role: 'assistant',
        text: `I am ${profile}, at your service.`,
        row_id: 2,
        timestamp: nowSeconds() - 599
      }
    ]
  }
}

function initialState(options: FakeGatewayOptions): FakeGatewayState {
  const researcher = makeSession('researcher', 'Bot Chat')
  const writer = makeSession('writer', 'Bot Chat')
  const sessions = new Map<string, FakeSession>()

  for (const session of [researcher, writer]) {
    sessions.set(session.storedId, session)
  }

  const profileRow = (session: FakeSession, description: string): ProfileRow => ({
    name: session.profile,
    path: `/root/.hermes/profiles/${session.profile}`,
    description,
    display_name: session.profile,
    canonical_session: {
      id: session.storedId,
      resolved_id: session.storedId,
      title: session.title,
      preview: session.messages[session.messages.length - 1]?.text ?? '',
      last_active: nowSeconds() - 60,
      message_count: session.messages.length
    },
    ui_meta: { 'hermes-bots': {} }
  })

  return {
    auth: options.auth ?? 'none',
    token: options.token ?? 'fake-session-token',
    closeCode: options.closeCode ?? 4401,
    replayEpoch: randomUUID(),
    accessTokens: new Set<string>(),
    ticketsMinted: 0,
    ticketsConsumed: 0,
    tokenExchanges: 0,
    refreshCalls: 0,
    connections: 0,
    rejectedUpgrades: 0,
    rejectNextUpgrades: 0,
    eventsSinceCalls: [],
    methodLog: [],
    truncateNextReplay: false,
    hangMethods: new Set<string>(),
    sessions,
    profiles: [profileRow(researcher, 'Finds things out.'), profileRow(writer, 'Writes things down.')],
    cronJobs: [
      {
        job_id: 'job-heartbeat',
        name: 'VM heartbeat',
        schedule: 'every 2h',
        prompt_preview: 'Check the VM and report.',
        deliver: 'local',
        enabled: true,
        state: 'active',
        next_run_at: new Date(Date.now() + 7_200_000).toISOString(),
        last_run_at: new Date(Date.now() - 3_600_000).toISOString(),
        last_status: 'ok',
        runs: [{ id: 'cron_heartbeat_1', started_at: new Date(Date.now() - 3_600_000).toISOString(), status: 'ok' }]
      }
    ]
  }
}

export async function startFakeGateway(options: FakeGatewayOptions = {}): Promise<FakeGateway> {
  const state = initialState(options)
  const scenario = options.scenario ?? DEFAULT_SCENARIO
  const ringSize = options.replayRingSize ?? 512
  const streamDelayMs = options.streamDelayMs ?? 2
  const version = options.version ?? '0.21.3-fake'

  const tickets = new Map<string, { expiresAt: number; userId: string; provider: string }>()
  const codes = new Map<string, { challenge: string; provider: string }>()
  const refreshTokens = new Map<string, { provider: string; userId: string }>()
  const sockets = new Set<WebSocket>()
  const pendingServerRequests = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  const timers = new Set<ReturnType<typeof setTimeout>>()
  let serverRequestSequence = 0

  const later = (fn: () => void, ms: number) => {
    const timer = setTimeout(() => {
      timers.delete(timer)
      fn()
    }, ms)
    timers.add(timer)
    timer.unref?.()
  }

  const gated = () => state.auth === 'native'

  function bearerOf(req: IncomingMessage): string {
    const header = req.headers.authorization ?? ''

    return header.startsWith('Bearer ') ? header.slice(7) : ''
  }

  function httpAuthorized(req: IncomingMessage): boolean {
    if (state.auth === 'none') {
      return true
    }

    if (state.auth === 'token') {
      return req.headers['x-hermes-session-token'] === state.token
    }

    const token = bearerOf(req)

    return token.length > 0 && state.accessTokens.has(token)
  }

  function issueTokens(provider: string, userId: string) {
    const accessToken = `at-${randomUUID()}`
    const refreshToken = `rt-${randomUUID()}`
    state.accessTokens.add(accessToken)
    refreshTokens.set(refreshToken, { provider, userId })

    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: 'Bearer',
      expires_at: nowSeconds() + 3600,
      provider,
      user_id: userId
    }
  }

  function publish(type: string, sessionId: string | undefined, payload: unknown): void {
    let seq: number | undefined

    if (sessionId) {
      const session = state.sessions.get(sessionId) ?? findByRuntimeId(sessionId)

      if (session) {
        session.seq += 1
        seq = session.seq
        session.ring.push({ type, session_id: session.id, seq, payload })

        if (session.ring.length > ringSize) {
          session.ring.shift()
        }
      }
    }

    const frame = JSON.stringify({
      jsonrpc: '2.0',
      method: 'event',
      params: {
        type,
        ...(sessionId ? { session_id: resolveRuntimeId(sessionId) } : {}),
        ...(seq === undefined ? {} : { seq }),
        ...(payload === undefined ? {} : { payload })
      }
    })

    for (const socket of sockets) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(`${frame}\n`)
      }
    }
  }

  function findByRuntimeId(id: string): FakeSession | undefined {
    for (const session of state.sessions.values()) {
      if (session.id === id) {
        return session
      }
    }

    return undefined
  }

  function resolveSession(id: string): FakeSession | undefined {
    return state.sessions.get(id) ?? findByRuntimeId(id)
  }

  function resolveRuntimeId(id: string): string {
    return resolveSession(id)?.id ?? id
  }

  // ---------------------------------------------------------------- HTTP ---

  const httpServer = createServer((req, res) => {
    void handleHttp(req, res).catch(error => {
      json(res, 500, { error: String(error) })
    })
  })

  async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const path = url.pathname
    const method = req.method ?? 'GET'

    if (path === '/api/status') {
      json(res, 200, {
        version,
        release_date: '2026.9.14',
        gateway_running: true,
        active_sessions: state.sessions.size,
        auth_required: gated(),
        auth_providers: gated() ? ['self-hosted'] : [],
        auth_flows: gated() ? ['cookie', 'native_pkce'] : [],
        profiles: state.profiles.map(profile => profile.name),
        overall: 'ok'
      })

      return
    }

    if (path === '/api/auth/providers') {
      if (!gated()) {
        json(res, 503, { detail: 'No interactive session providers are configured.' })

        return
      }

      json(res, 200, {
        providers: [{ name: 'self-hosted', display_name: 'Self-Hosted OIDC', supports_password: false }]
      })

      return
    }

    if (path === '/auth/native/authorize') {
      handleAuthorize(url, res)

      return
    }

    if (path === '/auth/native/token' && method === 'POST') {
      const body = await readBody(req)
      const code = String(body.code ?? '')
      const verifier = String(body.code_verifier ?? '')
      const issued = codes.get(code)

      // The real gateway consumes the code on every path: no verifier oracle.
      codes.delete(code)

      if (!issued || issued.challenge !== s256(verifier)) {
        json(res, 400, { detail: 'Invalid or expired authorization code.' })

        return
      }

      state.tokenExchanges += 1
      json(res, 200, issueTokens(issued.provider, 'tester@example.invalid'))

      return
    }

    if (path === '/auth/native/refresh' && method === 'POST') {
      const body = await readBody(req)
      state.refreshCalls += 1
      const token = String(body.refresh_token ?? '')
      const known = refreshTokens.get(token)

      if (!known) {
        json(res, 401, { error: 'session_expired', detail: 'Refresh token expired or invalid; start a new sign-in.' })

        return
      }

      refreshTokens.delete(token)
      json(res, 200, issueTokens(known.provider, known.userId))

      return
    }

    if (!httpAuthorized(req)) {
      json(res, 401, { detail: 'Unauthorized' })

      return
    }

    if (path === '/api/auth/me') {
      json(res, 200, {
        user_id: 'tester@example.invalid',
        email: 'tester@example.invalid',
        display_name: 'Fake Tester',
        org_id: '',
        provider: gated() ? 'self-hosted' : 'none',
        expires_at: nowSeconds() + 3600
      })

      return
    }

    if (path === '/api/auth/ws-ticket' && method === 'POST') {
      const ticket = `tk-${randomUUID()}`
      tickets.set(ticket, {
        expiresAt: Date.now() + TICKET_TTL_SECONDS * 1000,
        userId: 'tester@example.invalid',
        provider: gated() ? 'self-hosted' : 'none'
      })
      state.ticketsMinted += 1
      json(res, 200, { ticket, ttl_seconds: TICKET_TTL_SECONDS })

      return
    }

    if (path === '/api/profiles') {
      json(res, 200, { profiles: state.profiles })

      return
    }

    if (path.startsWith('/api/cron/jobs')) {
      await handleCron(req, res, path, method)

      return
    }

    const messagesMatch = /^\/api\/sessions\/([^/]+)\/messages$/.exec(path)

    if (messagesMatch) {
      const session = resolveSession(decodeURIComponent(messagesMatch[1] as string))

      if (!session) {
        json(res, 404, { detail: 'Unknown session' })

        return
      }

      const limit = Number.parseInt(url.searchParams.get('limit') ?? '200', 10)
      const order = url.searchParams.get('order') ?? 'latest'
      const rows = order === 'latest' ? session.messages.slice(-limit) : session.messages.slice(0, limit)
      json(res, 200, { messages: rows, count: rows.length })

      return
    }

    json(res, 404, { detail: `No route for ${method} ${path}` })
  }

  function handleAuthorize(url: URL, res: ServerResponse): void {
    const challenge = url.searchParams.get('code_challenge') ?? ''
    const method = url.searchParams.get('code_challenge_method') ?? ''
    const redirectUri = url.searchParams.get('redirect_uri') ?? ''
    const clientState = url.searchParams.get('state') ?? ''
    const provider = url.searchParams.get('provider') || 'self-hosted'

    if (method.toUpperCase() !== 'S256' || !challenge) {
      json(res, 400, { detail: 'code_challenge_method must be S256' })

      return
    }

    if (!/^http:\/\/(127\.0\.0\.1|\[::1\])(:\d+)?\//.test(redirectUri)) {
      json(res, 400, { detail: 'native redirect_uri host must be a loopback IP literal (127.0.0.1 / ::1)' })

      return
    }

    const redirect = () => {
      const code = `code-${randomUUID()}`
      // The fake gateway is its own identity provider: it stores the challenge
      // and checks the verifier against it at the token endpoint, like the real
      // one does.
      codes.set(code, { challenge, provider })
      const target = new URL(redirectUri)
      target.searchParams.set('code', code)
      target.searchParams.set('state', clientState)
      res.writeHead(302, { location: target.toString() })
      res.end()
    }

    if (url.searchParams.get('auto') === '1') {
      redirect()

      return
    }

    const formAction = new URL(url.toString())
    formAction.searchParams.set('auto', '1')

    html(
      res,
      200,
      `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Fake Hermes sign-in</title></head>
  <body style="font-family: system-ui; margin: 3rem auto; max-width: 30rem">
    <h1>Fake Hermes gateway</h1>
    <p>No real identity provider is involved. Approving issues a loopback code for
      <code>${escapeHtml(redirectUri)}</code>.</p>
    <form method="get" action="${escapeHtml(formAction.pathname)}">
      ${[...formAction.searchParams.entries()]
        .map(([key, value]) => `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}">`)
        .join('\n      ')}
      <button type="submit">Approve as tester</button>
    </form>
  </body>
</html>`
    )
  }

  async function handleCron(req: IncomingMessage, res: ServerResponse, path: string, method: string): Promise<void> {
    if (path === '/api/cron/jobs') {
      if (method === 'GET') {
        json(res, 200, { jobs: state.cronJobs, count: state.cronJobs.length, gateway_running: true })

        return
      }

      if (method === 'POST') {
        const body = await readBody(req)
        const job: CronJob = {
          job_id: `job-${randomUUID().slice(0, 8)}`,
          name: String(body.name ?? 'New job'),
          schedule: String(body.schedule ?? 'every 1h'),
          prompt_preview: String(body.prompt ?? ''),
          deliver: String(body.deliver ?? 'local'),
          enabled: true,
          state: 'active',
          next_run_at: new Date(Date.now() + 3_600_000).toISOString(),
          last_run_at: null,
          last_status: null,
          runs: []
        }
        state.cronJobs.push(job)
        publish('cron.changed', undefined, {})
        json(res, 200, { job, success: true })

        return
      }
    }

    const match = /^\/api\/cron\/jobs\/([^/]+)(\/(pause|resume|trigger|runs))?$/.exec(path)

    if (!match) {
      json(res, 404, { detail: `No cron route for ${method} ${path}` })

      return
    }

    const job = state.cronJobs.find(entry => entry.job_id === match[1])

    if (!job) {
      json(res, 404, { detail: 'Unknown job' })

      return
    }

    const action = match[3]

    if (action === 'runs') {
      json(res, 200, { runs: job.runs, count: job.runs.length })

      return
    }

    if (action === 'pause' || action === 'resume') {
      job.enabled = action === 'resume'
      job.state = job.enabled ? 'active' : 'paused'
      publish('cron.changed', undefined, {})
      json(res, 200, { job, success: true })

      return
    }

    if (action === 'trigger') {
      const run = { id: `cron_${job.job_id}_${Date.now()}`, started_at: new Date().toISOString(), status: 'running' }
      job.runs.push(run)
      job.last_run_at = run.started_at
      publish('cron.changed', undefined, {})
      json(res, 200, { run, success: true })

      return
    }

    if (method === 'GET') {
      json(res, 200, { job })

      return
    }

    if (method === 'PUT') {
      const body = await readBody(req)
      const updates = (body.updates ?? body) as Record<string, unknown>
      Object.assign(job, updates)
      publish('cron.changed', undefined, {})
      json(res, 200, { job, success: true })

      return
    }

    if (method === 'DELETE') {
      state.cronJobs = state.cronJobs.filter(entry => entry.job_id !== job.job_id)
      publish('cron.changed', undefined, {})
      json(res, 200, { removed_job: job, success: true })

      return
    }

    json(res, 405, { detail: `Method ${method} not allowed on ${path}` })
  }

  // ------------------------------------------------------------ WebSocket ---

  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: protocols => (protocols.has(GATEWAY_WS_PROTOCOL) ? GATEWAY_WS_PROTOCOL : false)
  })

  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)

    if (url.pathname !== WS_PATH) {
      socket.destroy()

      return
    }

    wss.handleUpgrade(req, socket, head, ws => {
      wss.emit('connection', ws, req)
    })
  })

  wss.on('connection', (socket: WebSocket, req: IncomingMessage) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const rejection = authorizeUpgrade(url, req)

    if (rejection !== null) {
      state.rejectedUpgrades += 1
      socket.close(rejection, 'unauthorized')

      return
    }

    state.connections += 1
    sockets.add(socket)

    socket.on('close', () => sockets.delete(socket))
    socket.on('message', data => {
      for (const line of String(data).split('\n')) {
        if (line.trim()) {
          void handleFrame(socket, line)
        }
      }
    })

    send(socket, {
      jsonrpc: '2.0',
      method: 'event',
      params: {
        type: 'gateway.ready',
        payload: { skin: {}, change_events: true, replay_epoch: state.replayEpoch, heartbeat: true }
      }
    })
  })

  function authorizeUpgrade(url: URL, req: IncomingMessage): number | null {
    if (state.rejectNextUpgrades > 0) {
      state.rejectNextUpgrades -= 1

      return state.closeCode
    }

    if (state.auth === 'none') {
      return null
    }

    if (state.auth === 'token') {
      return url.searchParams.get('token') === state.token ? null : state.closeCode
    }

    const offered = String(req.headers['sec-websocket-protocol'] ?? '')
      .split(',')
      .map(value => value.trim())
      .filter(Boolean)
    const ticketProtocols = offered.filter(value => value.startsWith(TICKET_PROTOCOL_PREFIX))

    if (ticketProtocols.length !== 1 || !offered.includes(GATEWAY_WS_PROTOCOL)) {
      return state.closeCode
    }

    const ticket = (ticketProtocols[0] as string).slice(TICKET_PROTOCOL_PREFIX.length)
    const issued = tickets.get(ticket)
    // Single use, 30 s: consume on sight whether or not it was still valid.
    tickets.delete(ticket)

    if (!issued || issued.expiresAt < Date.now()) {
      return state.closeCode
    }

    state.ticketsConsumed += 1

    return null
  }

  function send(socket: WebSocket, frame: unknown): void {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(`${JSON.stringify(frame)}\n`)
    }
  }

  async function handleFrame(socket: WebSocket, text: string): Promise<void> {
    let frame: { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: unknown }

    try {
      frame = JSON.parse(text)
    } catch {
      return
    }

    if (typeof frame.method !== 'string') {
      // A response to one of our server→client requests.
      const id = typeof frame.id === 'string' ? frame.id : ''
      const pending = pendingServerRequests.get(id)

      if (pending) {
        pendingServerRequests.delete(id)

        if (frame.error) {
          pending.reject(new Error(JSON.stringify(frame.error)))
        } else {
          pending.resolve(frame.result)
        }
      }

      return
    }

    const method = frame.method
    const params = (frame.params ?? {}) as Record<string, unknown>
    state.methodLog.push(method)

    try {
      const result = await dispatch(method, params)

      if (frame.id !== undefined && frame.id !== null) {
        send(socket, { jsonrpc: '2.0', id: frame.id, result })
      }
    } catch (error) {
      if (frame.id !== undefined && frame.id !== null) {
        send(socket, {
          jsonrpc: '2.0',
          id: frame.id,
          error: { code: -32603, message: error instanceof Error ? error.message : String(error) }
        })
      }
    }
  }

  async function dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (state.hangMethods.has(method)) {
      // Never resolves: the caller's own timeout is what should fire.
      return new Promise<never>(() => undefined)
    }

    switch (method) {
      case 'client.capabilities':
        return { server_requests: ['approval', 'clarify', 'sudo', 'secret'] }

      case 'gateway.capabilities':
        return { per_session_exclusive_submit: true }

      case 'gateway.ping':
        return { ok: true }

      case 'profiles.list':
        return { profiles: state.profiles, bot_mode_protocol: true }

      case 'session.list': {
        const title = typeof params.title === 'string' ? params.title : null
        const profile = typeof params.profile === 'string' ? params.profile : null
        const rows = [...state.sessions.values()]
          .filter(session => (profile ? session.profile === profile : true))
          .filter(session => (title ? session.title === title : true))
          .map(session => ({
            id: session.storedId,
            resolved_id: session.storedId,
            title: session.title,
            preview: session.messages[session.messages.length - 1]?.text ?? '',
            message_count: session.messages.length
          }))

        return { sessions: rows }
      }

      case 'session.create': {
        const profile = typeof params.profile === 'string' ? params.profile : 'default'
        const session = makeSession(profile, typeof params.title === 'string' ? params.title : 'Bot Chat')
        session.messages = []
        state.sessions.set(session.storedId, session)

        return {
          session_id: session.id,
          stored_session_id: session.storedId,
          message_count: 0,
          messages: [],
          info: sessionInfo(session)
        }
      }

      case 'session.resume': {
        const session = resolveSession(String(params.session_id ?? ''))

        if (!session) {
          throw new Error(`Unknown session: ${String(params.session_id)}`)
        }

        const omit = params.omit_messages === true

        return {
          session_id: session.id,
          stored_session_id: session.storedId,
          message_count: session.messages.length,
          messages: omit ? [] : session.messages,
          messages_omitted: omit,
          info: sessionInfo(session),
          open_requests: []
        }
      }

      case 'session.history': {
        const session = resolveSession(String(params.session_id ?? ''))

        if (!session) {
          throw new Error(`Unknown session: ${String(params.session_id)}`)
        }

        return { count: session.messages.length, messages: session.messages }
      }

      case 'session.events.since': {
        const sessionId = String(params.session_id ?? '')
        const lastSeen = typeof params.last_seen === 'number' ? params.last_seen : 0
        state.eventsSinceCalls.push({ session_id: sessionId, last_seen: lastSeen })
        const session = resolveSession(sessionId)
        const entries = (session?.ring ?? []).filter(entry => entry.seq > lastSeen)
        const truncated = state.truncateNextReplay
        state.truncateNextReplay = false

        return {
          events: entries.map(entry => ({
            type: entry.type,
            session_id: entry.session_id,
            seq: entry.seq,
            payload: entry.payload
          })),
          latest_seq: session?.seq ?? 0,
          truncated,
          count: entries.length,
          epoch: state.replayEpoch,
          open_requests: []
        }
      }

      case 'prompt.submit': {
        const session = resolveSession(String(params.session_id ?? ''))

        if (!session) {
          throw new Error(`Unknown session: ${String(params.session_id)}`)
        }

        streamReply(session, typeof params.text === 'string' ? params.text : '')

        return { status: 'streaming' }
      }

      case 'session.interrupt':
        return { status: 'interrupted', interrupted: true }

      case 'session.active_list':
        return { sessions: [] }

      case 'cron.manage':
        return cronManage(params)

      case 'config.get':
        return { value: 'verbose', tool_progress: 'verbose' }

      case 'approval.received':
        return { acknowledged: true }

      case 'approval.respond':
        return { resolved: 1 }

      default:
        throw new Error(`Unknown method: ${method}`)
    }
  }

  function sessionInfo(session: FakeSession): Record<string, unknown> {
    return {
      model: 'example-provider/example-model',
      provider: 'anthropic',
      reasoning_effort: 'medium',
      fast: false,
      yolo: false,
      approval_mode: 'ask',
      title: session.title,
      profile_name: session.profile,
      stored_session_id: session.storedId,
      desktop_contract: 7,
      version,
      running: false
    }
  }

  function cronManage(params: Record<string, unknown>): Record<string, unknown> {
    const action = typeof params.action === 'string' ? params.action : 'list'
    const name = typeof params.name === 'string' ? params.name : ''

    if (action === 'list') {
      return { success: true, jobs: state.cronJobs, count: state.cronJobs.length, gateway_running: true }
    }

    if (action === 'add') {
      const job: CronJob = {
        job_id: `job-${randomUUID().slice(0, 8)}`,
        name: name || 'New job',
        schedule: typeof params.schedule === 'string' ? params.schedule : 'every 1h',
        prompt_preview: typeof params.prompt === 'string' ? params.prompt : '',
        deliver: typeof params.deliver === 'string' ? params.deliver : 'local',
        enabled: true,
        state: 'active',
        next_run_at: new Date(Date.now() + 3_600_000).toISOString(),
        last_run_at: null,
        last_status: null,
        runs: []
      }
      state.cronJobs.push(job)
      publish('cron.changed', undefined, {})

      return { success: true, job, job_id: job.job_id, jobs: state.cronJobs, gateway_running: true }
    }

    const job = state.cronJobs.find(entry => entry.name === name || entry.job_id === name)

    if (!job) {
      return { success: false, error: `No such job: ${name}` }
    }

    if (action === 'remove') {
      state.cronJobs = state.cronJobs.filter(entry => entry.job_id !== job.job_id)
      publish('cron.changed', undefined, {})

      return { success: true, removed_job: job, jobs: state.cronJobs, gateway_running: true }
    }

    job.enabled = action === 'resume'
    job.state = job.enabled ? 'active' : 'paused'
    publish('cron.changed', undefined, {})

    return { success: true, job, jobs: state.cronJobs, gateway_running: true }
  }

  function streamReply(session: FakeSession, prompt: string): void {
    const reply =
      scenario.replies?.find(entry => !entry.match || prompt.includes(entry.match)) ??
      DEFAULT_SCENARIO.replies?.[0] ??
      {}
    const deltas = reply.deltas ?? ['Working on it.']
    const text = reply.text ?? deltas.join('')
    const sid = session.storedId
    let at = streamDelayMs

    session.messages.push({
      role: 'user',
      text: prompt,
      row_id: session.messages.length + 1,
      timestamp: nowSeconds()
    })

    later(() => publish('message.start', sid, {}), at)

    for (const delta of deltas) {
      at += streamDelayMs
      later(() => publish('message.delta', sid, { text: delta }), at)
    }

    if (reply.tool) {
      const toolId = `tool-${randomUUID().slice(0, 8)}`
      at += streamDelayMs
      later(
        () =>
          publish('tool.start', sid, {
            tool_id: toolId,
            name: reply.tool?.name,
            context: reply.tool?.summary ?? '',
            args: reply.tool?.args ?? {}
          }),
        at
      )
      at += streamDelayMs
      later(
        () =>
          publish('tool.complete', sid, {
            tool_id: toolId,
            name: reply.tool?.name,
            args: reply.tool?.args ?? {},
            duration_s: 0.2,
            result: reply.tool?.result ?? null,
            summary: reply.tool?.summary ?? ''
          }),
        at
      )
    }

    at += streamDelayMs
    later(() => {
      session.messages.push({ role: 'assistant', text, row_id: session.messages.length + 1, timestamp: nowSeconds() })
      publish('message.complete', sid, {
        text,
        status: 'ok',
        usage: { input: 12, output: 34, total: 46 }
      })
      publish('sessions.changed', undefined, {})
    }, at)
  }

  await new Promise<void>(resolve => {
    httpServer.listen(options.port ?? 0, options.host ?? '127.0.0.1', resolve)
  })

  const address = httpServer.address() as AddressInfo
  const host = options.host ?? '127.0.0.1'
  const url = `http://${host}:${address.port}`

  return {
    port: address.port,
    url,
    wsUrl: `ws://${host}:${address.port}${WS_PATH}`,
    state,
    emit(type, emitOptions = {}) {
      publish(type, emitOptions.sessionId, emitOptions.payload)
    },
    requestApproval(params) {
      const id = `srq-${++serverRequestSequence}`

      return new Promise<unknown>((resolve, reject) => {
        pendingServerRequests.set(id, { resolve, reject })

        for (const socket of sockets) {
          send(socket, { jsonrpc: '2.0', id, method: 'approval', params })
        }
      })
    },
    closeSockets(code, reason = '') {
      for (const socket of sockets) {
        socket.close(code, reason)
      }
    },
    dropSockets() {
      for (const socket of sockets) {
        // No close frame: the client observes 1006.
        socket.terminate()
      }
    },
    async close() {
      for (const timer of timers) {
        clearTimeout(timer)
      }

      timers.clear()

      for (const socket of sockets) {
        socket.terminate()
      }

      sockets.clear()
      await new Promise<void>(resolve => wss.close(() => resolve()))
      await new Promise<void>(resolve => httpServer.close(() => resolve()))
    }
  }
}
