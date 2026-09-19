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
  display_metadata?: Record<string, unknown> | null
  name?: string | null
  tool_id?: string | null
  context?: string | null
  args?: Record<string, unknown> | null
  reasoning?: string | null
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
  /**
   * `gateway_running` in every `cron.manage` answer: whether the scheduler
   * process is up. Flip it to false to drive the Routines banner.
   */
  cronGatewayRunning: boolean
  /** Stored ids of the sessions the gateway reports as busy. */
  runningSessions: Set<string>
  /** Session-scoped configuration `config.get` / `config.set` read and write. */
  sessionConfig: Map<string, Record<string, string>>
  /** Approvals raised and not yet answered, by queue id. */
  pendingApprovals: Map<string, { session_id: string; payload: Record<string, unknown> }>
  /** Images accepted through `image.attach_bytes`, newest last. */
  attachedImages: { session_id: string; filename: string; bytes: number }[]
}

interface ProfileRow {
  name: string
  path: string
  description: string
  display_name: string
  model: string
  provider: string
  has_avatar: boolean
  ui_meta_revisions: Record<string, number>
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

/**
 * A cron job as the store holds it.
 *
 * The two gateway surfaces disagree about its shape and the fake reproduces
 * that on purpose, because a client that only ever sees one of them breaks the
 * first time it meets the other: `cron.manage` answers `_format_job` rows
 * (`job_id`, `prompt_preview`, no full prompt), the REST detail route answers
 * the stored job (`id`, full `prompt`).
 */
interface CronJob {
  id: string
  name: string
  schedule: string
  prompt: string
  deliver: string
  enabled: boolean
  state: string
  next_run_at: string | null
  last_run_at: string | null
  last_status: string | null
  last_error: string | null
  paused_at: string | null
  paused_reason: string | null
  repeat: number | null
  skills: string[]
  model: string | null
  runs: CronRunRow[]
}

/** A run session, in the `list_sessions_rich` row shape `/runs` answers with. */
interface CronRunRow {
  id: string
  title: string
  status: string
  started_at: number
  ended_at: number | null
  last_active: number
  message_count: number
  preview: string
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

/**
 * The delivery command a `message_agent` hand-off spawns. The transcript engine
 * recognises bot-to-bot traffic from this string, so it is copied verbatim from
 * `tools/bot_mode_dm.py`.
 */
const DM_DELIVERY_COMMAND =
  '/usr/bin/python3 /opt/hermes/tools/bot_mode_dm.py --run-delivery query-file ' +
  '/root/.hermes/dm/2f9c.json hermes -p writer chat -c "Bot Chat" -Q -q @/root/.hermes/dm/2f9c.json'

const DM_REPLY_PROCESS_TEXT = [
  '[IMPORTANT: Background process proc-2f9c completed (exit code 0).',
  `Command: ${DM_DELIVERY_COMMAND}`,
  'Output:',
  'Message from 🤖 Writer (@writer): Draft is ready, I pushed it to the shared folder.]'
].join('\n')

/**
 * A 1×1 half-opaque red PNG. Deliberately NOT transparent: scaled up behind an
 * avatar's tint it paints a visible dot, which is how a run against this server
 * shows at a glance that `profiles.get_asset` was fetched and rendered rather
 * than quietly falling back to the generated initial.
 */
const AVATAR_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/**
 * A canonical Bot Chat with enough shape to exercise the whole engine: a tool
 * row, an outbound `message_agent` dispatch and the `process_complete` row that
 * carries the teammate's answer back.
 */
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/** `tools/cronjob_job_args.py::_format_job` — the row `cron.manage list` answers with. */
function formatCronJob(job: CronJob): Record<string, unknown> {
  return {
    job_id: job.id,
    name: job.name,
    schedule: job.schedule,
    prompt_preview: job.prompt.slice(0, 120),
    deliver: job.deliver,
    enabled: job.enabled,
    state: job.state,
    next_run_at: job.next_run_at,
    last_run_at: job.last_run_at,
    last_status: job.last_status,
    last_error: job.last_error,
    paused_at: job.paused_at,
    paused_reason: job.paused_reason,
    repeat: job.repeat,
    skills: job.skills,
    model: job.model
  }
}

/**
 * A cron run: an ordinary session whose id is `cron_{job_id}_{timestamp}`.
 *
 * That is the whole binding between a job and its runs on a real gateway — the
 * id prefix plus `source='cron'` — so the fake keeps run transcripts in the
 * same session map as chats and answers `session.history` for them unchanged.
 */
function makeCronRunSession(jobId: string, startedAt: number, prompt: string, answer: string): FakeSession {
  const id = `cron_${jobId}_${startedAt}`

  return {
    id,
    storedId: id,
    profile: 'default',
    title: `Cron: ${jobId}`,
    seq: 0,
    ring: [],
    messages: [
      { role: 'user', text: prompt, row_id: 1, timestamp: startedAt },
      {
        role: 'tool',
        name: 'read_file',
        tool_id: `call_${jobId}_${startedAt}`,
        context: 'read_file(status.md)',
        args: { path: 'status.md' }
      },
      { role: 'assistant', text: answer, row_id: 2, timestamp: startedAt + 12 }
    ]
  }
}

function makeSession(profile: string, title: string): FakeSession {
  const storedId = `stored-${profile}-${randomUUID().slice(0, 8)}`
  const base = nowSeconds() - 600

  const messages: TranscriptRow[] = [
    { role: 'user', text: 'Introduce yourself in one line.', row_id: 1, timestamp: base },
    {
      role: 'assistant',
      text: `I am ${profile}, at your service.`,
      reasoning: 'Keep it to one line.',
      row_id: 2,
      timestamp: base + 1
    },
    {
      role: 'tool',
      name: 'read_file',
      tool_id: `call_read_${profile}`,
      context: 'read_file(SOUL.md)',
      args: { path: 'SOUL.md' }
    }
  ]

  if (profile === 'researcher') {
    messages.push(
      {
        role: 'tool',
        name: 'message_agent',
        tool_id: 'call_dm_1',
        context: 'message_agent(writer)',
        args: { target: '@writer', message: 'Can you draft the announcement?' }
      },
      {
        role: 'user',
        text: DM_REPLY_PROCESS_TEXT,
        row_id: 3,
        timestamp: base + 60,
        display_kind: 'process_complete',
        display_metadata: { display_text: 'Background Process Finished: bot_mode_dm.py' }
      },
      { role: 'assistant', text: 'Thanks — I will fold that in.', row_id: 4, timestamp: base + 61 }
    )
  }

  return {
    id: `runtime-${randomUUID().slice(0, 8)}`,
    storedId,
    profile,
    title,
    seq: 0,
    ring: [],
    messages
  }
}

function initialState(options: FakeGatewayOptions): FakeGatewayState {
  const researcher = makeSession('researcher', 'Bot Chat')
  const writer = makeSession('writer', 'Bot Chat')
  const sessions = new Map<string, FakeSession>()

  for (const session of [researcher, writer]) {
    sessions.set(session.storedId, session)
  }

  const cronJobs = initialCronJobs()

  for (const job of cronJobs) {
    for (const run of job.runs) {
      const session = makeCronRunSession(
        job.id,
        run.started_at,
        job.prompt,
        run.status === 'error' ? 'The check did not complete.' : 'Done — nothing needs your attention.'
      )

      session.id = run.id
      session.storedId = run.id
      sessions.set(run.id, session)
    }
  }

  const profileRow = (session: FakeSession, description: string): ProfileRow => ({
    name: session.profile,
    path: `/root/.hermes/profiles/${session.profile}`,
    description,
    display_name: session.profile[0]?.toUpperCase() + session.profile.slice(1),
    model: 'example-provider/example-model',
    provider: 'example-provider',
    has_avatar: true,
    ui_meta_revisions: { avatar: 1 },
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
    runningSessions: new Set<string>(),
    sessionConfig: new Map<string, Record<string, string>>(),
    pendingApprovals: new Map<string, { session_id: string; payload: Record<string, unknown> }>(),
    attachedImages: [],
    cronGatewayRunning: true,
    cronJobs
  }
}

/**
 * Three routines, chosen to cover the three rows the list has to draw: a
 * healthy one with run history, one whose last attempt failed (with the
 * exception-wrapped `last_error` the scheduler really writes), and a paused one.
 */
function initialCronJobs(): CronJob[] {
  const hourAgo = Math.floor(Date.now() / 1000) - 3_600
  const yesterday = hourAgo - 86_400

  return [
    {
      id: 'job-heartbeat',
      name: 'VM heartbeat',
      schedule: 'every 2h',
      prompt: 'Check the VM, summarize disk and memory, and flag anything unusual.',
      deliver: 'local',
      enabled: true,
      state: 'active',
      next_run_at: new Date(Date.now() + 7_200_000).toISOString(),
      last_run_at: new Date(hourAgo * 1000).toISOString(),
      last_status: 'ok',
      last_error: null,
      paused_at: null,
      paused_reason: null,
      repeat: null,
      skills: [],
      model: null,
      runs: [
        {
          id: `cron_job-heartbeat_${hourAgo}`,
          title: 'VM heartbeat',
          status: 'ok',
          started_at: hourAgo,
          ended_at: hourAgo + 42,
          last_active: hourAgo + 42,
          message_count: 3,
          preview: 'Done — nothing needs your attention.'
        },
        {
          id: `cron_job-heartbeat_${yesterday}`,
          title: 'VM heartbeat',
          status: 'ok',
          started_at: yesterday,
          ended_at: yesterday + 38,
          last_active: yesterday + 38,
          message_count: 3,
          preview: 'Done — nothing needs your attention.'
        }
      ]
    },
    {
      id: 'job-digest',
      name: 'Weekly digest',
      schedule: 'every friday 16:30',
      prompt: 'Write a short digest of this week for the team.',
      deliver: 'bot-chat:researcher',
      enabled: true,
      state: 'active',
      next_run_at: new Date(Date.now() + 86_400_000).toISOString(),
      last_run_at: new Date((hourAgo - 7_200) * 1000).toISOString(),
      last_status: 'error',
      last_error: "RuntimeError: Cron job 'Weekly digest' has no model configured. Set one with `hermes cron edit`.",
      paused_at: null,
      paused_reason: null,
      repeat: null,
      skills: ['research'],
      model: null,
      runs: []
    },
    {
      id: 'job-cleanup',
      name: 'Inbox cleanup',
      schedule: 'every day at 6pm',
      prompt: 'Archive anything already answered and list what is still open.',
      deliver: 'local',
      enabled: false,
      state: 'paused',
      next_run_at: null,
      last_run_at: null,
      last_status: null,
      last_error: null,
      paused_at: new Date((hourAgo - 86_400) * 1000).toISOString(),
      paused_reason: 'Paused from the desktop app',
      repeat: null,
      skills: [],
      model: null,
      runs: []
    }
  ]
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

    if (path === '/__fake/inject' && method === 'POST') {
      // A control surface, never part of the gateway contract: it fakes a turn
      // somebody else ran — a teammate bot, a cron delivery, the same chat open
      // on a desktop — so a client can be checked against a foreign turn it
      // never submitted.
      const body = await readBody(req)
      const profile = String(body.profile ?? 'researcher')
      const session = [...state.sessions.values()].find(entry => entry.profile === profile)

      if (!session) {
        json(res, 404, { detail: `No session for profile ${profile}` })

        return
      }

      injectForeignTurn(session, {
        user: String(body.user ?? 'Message from 🤖 Writer (@writer): the draft is ready.'),
        assistant: String(body.assistant ?? 'Noted — I will fold that in.'),
        stream: body.stream !== false
      })

      json(res, 200, { injected: true, session_id: session.id, stored_session_id: session.storedId })

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

    if (path === '/api/cron/delivery-targets') {
      // `local` is implicit on every gateway; the second one is a configured
      // bot chat, which is what a delivery target looks like once the messaging
      // gateway is set up.
      json(res, 200, {
        targets: [
          { id: 'local', name: 'Local (save only)', home_target_set: true, home_env_var: null },
          { id: 'bot-chat:researcher', name: 'Bot chat · researcher', home_target_set: true, home_env_var: null }
        ]
      })

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

  /**
   * The REST cron surface, in `hermes_cli/web_routers/cron.py`'s shapes:
   * the list is a bare array, the detail routes answer the stored job itself
   * (no `{job: …}` wrapper), `/runs` answers `{runs, limit}` of session rows,
   * and `DELETE` answers `{ok: true}`.
   */
  async function handleCron(req: IncomingMessage, res: ServerResponse, path: string, method: string): Promise<void> {
    if (path === '/api/cron/jobs') {
      if (method === 'GET') {
        json(res, 200, state.cronJobs)

        return
      }

      if (method === 'POST') {
        const body = await readBody(req)
        const job = addCronJob(body)
        json(res, 200, job)

        return
      }
    }

    const match = /^\/api\/cron\/jobs\/([^/]+)(\/(pause|resume|trigger|runs))?$/.exec(path)

    if (!match) {
      json(res, 404, { detail: `No cron route for ${method} ${path}` })

      return
    }

    const wanted = decodeURIComponent(match[1] as string)
    const job = state.cronJobs.find(entry => entry.id === wanted || entry.name === wanted)

    if (!job) {
      json(res, 404, { detail: 'Unknown job' })

      return
    }

    const action = match[3]

    if (action === 'runs') {
      // Newest first, the way the id-range scan returns them.
      const runs = [...job.runs].sort((a, b) => b.started_at - a.started_at)
      json(res, 200, { runs, limit: runs.length })

      return
    }

    if (action === 'pause' || action === 'resume') {
      setCronPaused(job, action === 'pause')
      publish('cron.changed', undefined, {})
      json(res, 200, job)

      return
    }

    if (action === 'trigger') {
      json(res, 200, triggerCronJob(job))

      return
    }

    if (method === 'GET') {
      json(res, 200, job)

      return
    }

    if (method === 'PUT') {
      const body = await readBody(req)
      // `CronJobUpdate` is `{updates: {...}}` and the route MERGES it; a client
      // that sends only a schedule must not lose the prompt.
      const updates = (isRecord(body.updates) ? body.updates : body) as Record<string, unknown>
      Object.assign(job, updates)

      if (typeof updates.schedule === 'string') {
        job.next_run_at = nextRunFor(updates.schedule)
      }

      publish('cron.changed', undefined, {})
      json(res, 200, job)

      return
    }

    if (method === 'DELETE') {
      state.cronJobs = state.cronJobs.filter(entry => entry.id !== job.id)
      publish('cron.changed', undefined, {})
      json(res, 200, { ok: true })

      return
    }

    json(res, 405, { detail: `Method ${method} not allowed on ${path}` })
  }

  function addCronJob(body: Record<string, unknown>): CronJob {
    const schedule = typeof body.schedule === 'string' && body.schedule ? body.schedule : 'every 1h'
    const job: CronJob = {
      id: `job-${randomUUID().slice(0, 8)}`,
      name: typeof body.name === 'string' && body.name ? body.name : 'New job',
      schedule,
      prompt: typeof body.prompt === 'string' ? body.prompt : '',
      deliver: typeof body.deliver === 'string' && body.deliver ? body.deliver : 'local',
      enabled: true,
      state: 'active',
      next_run_at: nextRunFor(schedule),
      last_run_at: null,
      last_status: null,
      last_error: null,
      paused_at: null,
      paused_reason: null,
      repeat: typeof body.repeat === 'number' ? body.repeat : null,
      skills: Array.isArray(body.skills)
        ? body.skills.filter((skill): skill is string => typeof skill === 'string')
        : [],
      model: typeof body.model === 'string' ? body.model : null,
      runs: []
    }

    state.cronJobs.push(job)
    publish('cron.changed', undefined, {})

    return job
  }

  function setCronPaused(job: CronJob, paused: boolean): void {
    job.enabled = !paused
    job.state = paused ? 'paused' : 'active'
    job.paused_at = paused ? new Date().toISOString() : null
    job.paused_reason = paused ? 'Paused from Hermie' : null
    job.next_run_at = paused ? null : nextRunFor(job.schedule)
  }

  /** Fire now: record a run, register its transcript, and answer the refreshed job. */
  function triggerCronJob(job: CronJob): CronJob {
    const startedAt = nowSeconds()
    const run: CronRunRow = {
      id: `cron_${job.id}_${startedAt}`,
      title: job.name,
      status: 'ok',
      started_at: startedAt,
      ended_at: startedAt + 9,
      last_active: startedAt + 9,
      message_count: 3,
      preview: 'Done — nothing needs your attention.'
    }

    job.runs.push(run)
    job.last_run_at = new Date(startedAt * 1000).toISOString()
    job.last_status = 'ok'
    job.last_error = null

    const session = makeCronRunSession(job.id, startedAt, job.prompt, 'Done — nothing needs your attention.')
    state.sessions.set(run.id, session)

    publish('cron.changed', undefined, {})

    return job
  }

  /**
   * A plausible `next_run_at`.
   *
   * The real scheduler parses the schedule in the gateway's timezone; this only
   * has to move when the schedule does, so that a client showing the server's
   * answer can be told apart from one that kept its own guess.
   */
  function nextRunFor(schedule: string): string {
    const interval = /^every\s+(\d+)\s*(m|h|d)/i.exec(schedule.trim())

    if (interval) {
      const unit = interval[2]!.toLowerCase()
      const minutes = Number(interval[1]) * (unit === 'h' ? 60 : unit === 'd' ? 1440 : 1)

      return new Date(Date.now() + minutes * 60_000).toISOString()
    }

    const once = /^in\s+(\d+)\s*(m|h|d)/i.exec(schedule.trim())

    if (once) {
      const unit = once[2]!.toLowerCase()
      const minutes = Number(once[1]) * (unit === 'h' ? 60 : unit === 'd' ? 1440 : 1)

      return new Date(Date.now() + minutes * 60_000).toISOString()
    }

    return new Date(Date.now() + 86_400_000).toISOString()
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

      case 'session.interrupt': {
        const session = resolveSession(String(params.session_id ?? ''))

        if (session) {
          state.runningSessions.delete(session.storedId)
          publish('message.complete', session.storedId, { text: '', status: 'interrupted' })
        }

        return { status: 'interrupted', interrupted: true }
      }

      case 'session.active_list': {
        const profile = typeof params.profile === 'string' ? params.profile : null
        const sessions = [...state.sessions.values()]
          .filter(session => (profile ? session.profile === profile : true))
          .filter(session => state.runningSessions.has(session.storedId))
          .map(session => ({
            current: false,
            id: session.id,
            last_active: nowSeconds(),
            message_count: session.messages.length,
            model: 'example-provider/example-model',
            preview: session.messages[session.messages.length - 1]?.text ?? '',
            session_key: session.storedId,
            started_at: nowSeconds() - 600,
            status: 'working',
            title: session.title
          }))

        return { sessions }
      }

      case 'cron.manage':
        return cronManage(params)

      case 'profiles.get_asset': {
        const name = String(params.name ?? '')
        const profile = state.profiles.find(entry => entry.name === name)

        if (!profile?.has_avatar) {
          return { found: false }
        }

        return {
          found: true,
          mime: 'image/png',
          size: 68,
          data: `data:image/png;base64,${AVATAR_PNG_BASE64}`
        }
      }

      case 'commands.catalog':
        return {
          pairs: [
            ['/model', 'Switch the model'],
            ['/reasoning', 'Set the reasoning effort'],
            ['/status', 'Show the session status']
          ],
          commands: {
            model: { argument_mode: 'required' },
            reasoning: { argument_mode: 'required' },
            status: { argument_mode: 'none' }
          },
          skills: { 'release-notes': { description: 'Draft release notes' } },
          skill_count: 1
        }

      case 'complete.slash': {
        const text = String(params.text ?? '')
        const all = [
          { text: '/model', display: '/model', meta: 'Switch the model', kind: 'command' },
          { text: '/reasoning', display: '/reasoning', meta: 'Set the reasoning effort', kind: 'command' },
          { text: '/status', display: '/status', meta: 'Show the session status', kind: 'command' },
          { text: '/release-notes', display: '/release-notes', meta: 'Draft release notes', kind: 'skill' }
        ]

        return { items: all.filter(item => item.text.startsWith(text)), replace_from: 0 }
      }

      case 'slash.exec': {
        const command = String(params.command ?? '')

        return { output: `${command} is not a real command on a fake gateway, but it ran.` }
      }

      case 'config.get': {
        const key = String(params.key ?? 'verbose')
        const sessionId = String(params.session_id ?? '')
        const stored = state.sessionConfig.get(resolveSession(sessionId)?.storedId ?? sessionId) ?? {}

        if (key === 'verbose') {
          return { value: 'verbose', tool_progress: 'verbose' }
        }

        return { value: stored[key] ?? '' }
      }

      case 'config.set': {
        const key = String(params.key ?? '')
        const value = typeof params.value === 'string' ? params.value : String(params.value ?? '')
        const session = resolveSession(String(params.session_id ?? ''))

        if (key === 'model' && value.includes('expensive') && params.confirm_expensive_model !== true) {
          return { key, value, confirm_required: true, confirm_message: `${value} is an expensive model. Continue?` }
        }

        if (session) {
          const config = { ...(state.sessionConfig.get(session.storedId) ?? {}), [key]: value }
          state.sessionConfig.set(session.storedId, config)
          publish('session.info', session.storedId, sessionInfo(session))

          return {
            key,
            value,
            scope: typeof params.scope === 'string' ? params.scope : 'session',
            info: sessionInfo(session)
          }
        }

        return { key, value }
      }

      case 'model.options':
        // The inventory's own shape: a provider slug plus plain model ids, the
        // way `hermes_cli/inventory.py::build_models_payload` writes them.
        return {
          providers: [
            {
              slug: 'example-provider',
              name: 'Example Provider',
              models: ['example-model', 'expensive-model'],
              total_models: 2,
              is_current: true
            }
          ],
          model: 'example-provider/example-model',
          provider: 'example-provider'
        }

      case 'image.attach_bytes': {
        const base64 = String(params.content_base64 ?? params.data ?? '')
        state.attachedImages.push({
          session_id: String(params.session_id ?? ''),
          filename: String(params.filename ?? 'image.png'),
          bytes: Math.floor((base64.length * 3) / 4)
        })

        return { attached: true, name: String(params.filename ?? 'image.png'), width: 1, height: 1, count: 1 }
      }

      case 'approval.received':
        return { acknowledged: true }

      case 'approval.pending': {
        const session = resolveSession(String(params.session_id ?? ''))
        const approvals = [...state.pendingApprovals.values()]
          .filter(entry => !session || entry.session_id === session.storedId)
          .map(entry => entry.payload)

        return { approvals }
      }

      case 'approval.respond': {
        const requestId = typeof params.request_id === 'string' ? params.request_id : ''

        if (params.all === true) {
          const resolved = state.pendingApprovals.size
          state.pendingApprovals.clear()

          return { resolved }
        }

        return { resolved: state.pendingApprovals.delete(requestId) ? 1 : 0 }
      }

      case 'clarify.lock':
        return { status: 'ok', remaining: [] }

      case 'subagent.list':
        return { subagents: [], delegations: [] }

      case 'subagent.steer':
        return { status: 'queued', subagent_id: String(params.subagent_id ?? ''), text: String(params.text ?? '') }

      case 'subagent.interrupt':
        return { found: true, subagent_id: String(params.subagent_id ?? '') }

      case 'subagent.tail':
        return {
          subagent_id: String(params.subagent_id ?? ''),
          available: true,
          text: 'child transcript tail',
          truncated: false
        }

      default:
        throw new Error(`Unknown method: ${method}`)
    }
  }

  function sessionInfo(session: FakeSession): Record<string, unknown> {
    const config = state.sessionConfig.get(session.storedId) ?? {}

    return {
      model: config.model ?? 'example-provider/example-model',
      provider: 'example-provider',
      reasoning_effort: config.reasoning ?? 'medium',
      fast: config.fast === 'fast',
      yolo: config.yolo === 'on' || config.yolo === '1',
      approval_mode: 'ask',
      title: session.title,
      profile_name: session.profile,
      stored_session_id: session.storedId,
      desktop_contract: 7,
      version,
      running: state.runningSessions.has(session.storedId)
    }
  }

  /**
   * `cron.manage`, the WS half.
   *
   * Every answer carries `gateway_running`: it is the only place a client can
   * learn whether the scheduler process (`hermes gateway`, not `hermes serve`)
   * is up, and a list of healthy-looking jobs with it false is exactly the case
   * the Routines banner exists for. Rows are `_format_job` shaped, so they key
   * the job as `job_id` and carry a preview rather than the full prompt.
   */
  function cronManage(params: Record<string, unknown>): Record<string, unknown> {
    const action = typeof params.action === 'string' ? params.action : 'list'
    const name = typeof params.name === 'string' ? params.name : ''
    const listed = () => state.cronJobs.map(formatCronJob)

    if (action === 'list') {
      return {
        success: true,
        jobs: listed(),
        count: state.cronJobs.length,
        gateway_running: state.cronGatewayRunning
      }
    }

    if (action === 'add') {
      const job = addCronJob({
        name,
        schedule: params.schedule,
        prompt: params.prompt,
        deliver: params.deliver,
        repeat: params.repeat
      })

      return {
        success: true,
        job: formatCronJob(job),
        job_id: job.id,
        jobs: listed(),
        next_run_at: job.next_run_at,
        gateway_running: state.cronGatewayRunning
      }
    }

    const job = state.cronJobs.find(entry => entry.name === name || entry.id === name)

    if (!job) {
      return { success: false, error: `No such job: ${name}` }
    }

    if (action === 'remove') {
      state.cronJobs = state.cronJobs.filter(entry => entry.id !== job.id)
      publish('cron.changed', undefined, {})

      return {
        success: true,
        removed_job: { id: job.id, name: job.name, schedule: job.schedule },
        jobs: listed(),
        gateway_running: state.cronGatewayRunning
      }
    }

    setCronPaused(job, action === 'pause')
    publish('cron.changed', undefined, {})

    return { success: true, job: formatCronJob(job), jobs: listed(), gateway_running: state.cronGatewayRunning }
  }

  /**
   * Answer one prompt.
   *
   * Three keywords steer it, because those are the three paths a client has to
   * be able to survive: a prompt containing "approve" raises a server→client
   * approval and parks the turn until it is answered, "delegate" fans out
   * subagent events, and anything else streams a reply with one tool call.
   */
  function streamReply(session: FakeSession, prompt: string): void {
    const reply =
      scenario.replies?.find(entry => !entry.match || prompt.includes(entry.match)) ??
      DEFAULT_SCENARIO.replies?.[0] ??
      {}
    const deltas = reply.deltas ?? ['Working on it.']
    const text = reply.text ?? deltas.join('')
    const sid = session.storedId
    let at = streamDelayMs

    state.runningSessions.add(sid)
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

    if (/delegate/i.test(prompt)) {
      at = streamSubagents(sid, at)
    }

    const finish = () => {
      state.runningSessions.delete(sid)
      session.messages.push({ role: 'assistant', text, row_id: session.messages.length + 1, timestamp: nowSeconds() })
      publish('message.complete', sid, {
        text,
        status: 'ok',
        usage: { input: 12, output: 34, total: 46 }
      })
      publish('sessions.changed', undefined, {})
    }

    if (/approve/i.test(prompt)) {
      // The turn parks on the question, exactly as the real approval queue does:
      // nothing completes until a client answers.
      at += streamDelayMs
      later(() => void raiseApproval(session).then(finish), at)

      return
    }

    at += streamDelayMs
    later(finish, at)
  }

  /** One `delegate_task` fan-out, start to finish. */
  function streamSubagents(sid: string, startAt: number): number {
    const subagentId = `sub-${randomUUID().slice(0, 6)}`
    const delegationId = `del-${randomUUID().slice(0, 6)}`
    const common = {
      subagent_id: subagentId,
      delegation_id: delegationId,
      parent_id: null,
      goal: 'Audit the dependencies',
      task_index: 0,
      task_count: 1,
      depth: 1,
      model: 'example-provider/example-model'
    }
    let at = startAt

    for (const [type, payload] of [
      ['subagent.spawn_requested', {}],
      ['subagent.start', { status: 'running' }],
      ['subagent.thinking', { text: 'Reading the lockfile.' }],
      ['subagent.tool', { tool_name: 'read_file', text: 'package-lock.json' }],
      ['subagent.progress', { text: 'Two packages behind.' }],
      ['subagent.complete', { status: 'completed', summary: 'Two packages behind; no advisories.' }]
    ] as [string, Record<string, unknown>][]) {
      at += streamDelayMs
      later(() => publish(type, sid, { ...common, ...payload }), at)
    }

    return at
  }

  /** Raise an approval and wait for the answer, the way the queue does. */
  async function raiseApproval(session: FakeSession): Promise<void> {
    const requestId = `appr-${randomUUID().slice(0, 8)}`
    const payload = {
      request_id: requestId,
      command: 'rm -rf ./build',
      description: 'Remove the build directory',
      tool_name: 'run_command',
      choices: ['once', 'session', 'always', 'deny'],
      allow_permanent: true,
      allow_session: true
    }

    state.pendingApprovals.set(requestId, { session_id: session.storedId, payload })

    try {
      await sendServerRequest('approval', session.id, payload)
    } catch {
      // A client that declines the request leaves the queue entry withdrawn.
    } finally {
      state.pendingApprovals.delete(requestId)
    }
  }

  /**
   * A turn this client never submitted: someone else prompted the same session.
   * The rows land in history and the socket sees the same event sequence a live
   * turn produces, so a foreign-turn placeholder has something to reconcile
   * against.
   */
  function injectForeignTurn(session: FakeSession, turn: { user: string; assistant: string; stream: boolean }): void {
    const sid = session.storedId

    session.messages.push({
      role: 'user',
      text: turn.user,
      row_id: session.messages.length + 1,
      timestamp: nowSeconds()
    })

    if (turn.stream) {
      publish('message.start', sid, {})
      publish('message.delta', sid, { text: turn.assistant })
    }

    session.messages.push({
      role: 'assistant',
      text: turn.assistant,
      row_id: session.messages.length + 1,
      timestamp: nowSeconds()
    })

    if (turn.stream) {
      publish('message.complete', sid, { text: turn.assistant, status: 'ok' })
    }

    publish('sessions.changed', undefined, {})
  }

  /** Send one server→client request and resolve with the client's answer. */
  function sendServerRequest(method: string, sessionId: string, params: Record<string, unknown>): Promise<unknown> {
    const id = `srq-${++serverRequestSequence}`

    return new Promise<unknown>((resolve, reject) => {
      pendingServerRequests.set(id, { resolve, reject })

      for (const socket of sockets) {
        send(socket, { jsonrpc: '2.0', id, method, params: { session_id: sessionId, ...params } })
      }
    })
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
      const sessionId = typeof params.session_id === 'string' ? params.session_id : ''
      const { session_id: _ignored, ...rest } = params

      return sendServerRequest('approval', sessionId, rest)
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
