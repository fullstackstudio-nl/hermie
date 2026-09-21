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

/**
 * How the fake gateway authenticates.
 *
 * `cookie` is the browser flow: a sign-in page, a session cookie, and REST plus
 * the ticket mint gated on that cookie rather than on a bearer. It exists so
 * Hermie Web can be driven end to end without a real `hermes serve` — and,
 * with `publicHost`, so the Host/Origin guard the proxy has to satisfy is
 * actually enforced rather than assumed.
 */
export type FakeAuthMode = 'none' | 'token' | 'native' | 'cookie'

export interface ScenarioReply {
  /** Substring of the prompt this reply answers; omitted means "anything". */
  match?: string
  deltas?: string[]
  text?: string
  /**
   * Chunks of the model's reasoning, streamed BEFORE the first `message.delta`.
   *
   * The real gateway sends these from `agent_callbacks._agent_cbs` while the model
   * is still thinking, which means the client's assistant item comes into existence
   * — and therefore the transcript's typing header comes and goes — before a single
   * word of the reply exists. Nothing here emitted them, so the one transcript bug
   * that depends on that ordering could not be reproduced against this server at
   * all. See the 2026-09-20 section of docs/platform-notes.md.
   */
  reasoning?: string[]
  /**
   * One `reasoning.available` frame, which REPLACES the accumulated reasoning
   * rather than appending to it. `tool_progress._progress_reasoning` sends it, and
   * the client's reducer treats the two differently, so a fake that only ever sent
   * deltas left half of that branch unexercised.
   */
  reasoningAvailable?: string
  /**
   * Announce the tool by name before its call id exists (`tool.generating`).
   *
   * The real gateway does this whenever a tool is being drafted; the reason it is a
   * flag rather than automatic is that the in-process tests pass their own scenarios
   * and several of them count frames. The default scenario turns it on, so
   * `npm run fake-gateway` exercises it.
   */
  toolGenerating?: boolean
  tool?: { name: string; args?: Record<string, unknown>; summary?: string; result?: unknown }
  /**
   * How many deltas go out BEFORE the tool call, so the tool lands mid-reply.
   *
   * Absent puts the whole tool block after the last delta, which is the shape
   * every existing scenario expects. With a number, the reply is cut in two and
   * the tool goes in the cut — which is the only way to produce the turn the
   * client's `sealAssistantForTool` exists for: the half-streamed bubble is
   * sealed as an INTERIM note, a tool row lands under it, and the deltas that
   * follow open a second bubble that `message.complete` then settles. Three item
   * kinds arriving in one turn, in the order a real agent produces them.
   */
  toolAfterDeltas?: number
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
  /**
   * The host this gateway believes it is served on (`dashboard.public_url`).
   *
   * When set, the DNS-rebinding guard upstream runs is enforced here too: a
   * request whose `Host`, or whose `Origin`, names a different host is refused.
   * That is the guard Hermie Web exists to satisfy, so a test that does not
   * turn it on proves nothing about the proxy's header rewrite.
   */
  publicHost?: string
  /** User name and password accepted by `/auth/password-login` in cookie mode. */
  password?: { username: string; password: string }
  scenario?: Scenario
  version?: string
  /** How many events per session the replay ring keeps. */
  replayRingSize?: number
  /** Delay between streamed frames, in ms. */
  streamDelayMs?: number
  /**
   * Delay between two frames of a delegation, in ms.
   *
   * Deliberately its own knob and deliberately slow by default: the agents bar,
   * the sheet's stream lines and Steer/Stop only exist while children are
   * RUNNING, and a fan-out that finishes inside one frame cannot be looked at,
   * let alone steered. A test that only cares about the end state passes 1.
   */
  subagentStepMs?: number
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

/**
 * One row as the REST transcript route answers it, rather than as the socket does.
 *
 * `sessions.py` reads `dict(messages_row)`, so the body is **`content`**, with
 * `display_content` and `display_kind` beside it as projections — and it carries
 * `id`, the messages table's own primary key, on every row including a tool
 * call. The socket's `session.history` is the surface that says `text` and
 * `row_id`. The fake used to answer `text` on both, so the path a real gateway
 * ALWAYS takes was the one path nothing here ever exercised.
 */
/**
 * One search hit, built the way `sessions.py::search_sessions` builds one.
 *
 * The payload is `hit_payload` (snippet, role, source, model, session_started)
 * merged with the rich session row, and it deliberately carries NO message id
 * and NO message timestamp: upstream's projection is
 * `("session_id", "role", "snippet", "source", "model", "session_started")`,
 * although `SessionDB.search_messages` can return `id` and `timestamp` too. A
 * fake that offered them would let the app grow a dependency the real gateway
 * cannot satisfy — which is the one failure mode this file exists to prevent.
 */
function searchHitRow(session: FakeSession, snippet: string, role: string | null, at: number): Record<string, unknown> {
  const last = session.messages[session.messages.length - 1]

  return {
    snippet,
    role,
    source: 'hermie',
    model: 'example-provider/example-model',
    session_started: at,
    session_id: session.storedId,
    lineage_root: session.storedId,
    id: session.storedId,
    title: session.title,
    started_at: at,
    ended_at: null,
    last_active: at,
    is_active: true,
    message_count: session.messages.length,
    tool_call_count: 0,
    input_tokens: 0,
    output_tokens: 0,
    preview: last?.text ?? '',
    parent_session_id: null,
    archived: false
  }
}

/**
 * The FTS5 query shapes the route actually reaches this fake with.
 *
 * Upstream appends `*` to every bare token before it hands the query to FTS5
 * ("nimb" -> "nimb*"), keeps a quoted phrase whole, and joins them with FTS5's
 * implicit AND. So: every term must hit the SAME message, a bare term matches a
 * word that STARTS with it, and a quoted term matches that substring exactly.
 */
function searchTermsOf(query: string): { needle: string; phrase: boolean }[] {
  const terms: { needle: string; phrase: boolean }[] = []

  for (const raw of query.trim().match(/"[^"]*"|\S+/g) ?? []) {
    const phrase = raw.startsWith('"')
    const needle = (phrase ? raw.slice(1, -1) : raw.replace(/\*+$/, '')).trim().toLowerCase()

    if (needle) {
      terms.push({ needle, phrase })
    }
  }

  return terms
}

function messageMatches(text: string, terms: readonly { needle: string; phrase: boolean }[]): boolean {
  const haystack = text.toLowerCase()
  const words = haystack.split(/[^\p{L}\p{N}]+/u).filter(Boolean)

  return terms.every(term =>
    term.phrase ? haystack.includes(term.needle) : words.some(word => word.startsWith(term.needle))
  )
}

/** Where the first term lands in this message, or -1. */
function matchOffsetOf(text: string, terms: readonly { needle: string; phrase: boolean }[]): number {
  const first = terms[0]

  return first ? text.toLowerCase().indexOf(first.needle) : -1
}

/**
 * `snippet(messages_fts, -1, '>>>', '<<<', '...', 40)`, near enough.
 *
 * Near enough because the marker pair and the ellipsis are the parts the client
 * parses; the exact token budget is FTS5's business and no test may depend on
 * it. The matched run is wrapped where it was found, and a window that starts
 * or ends inside the message says so with `...`, exactly as the real one does.
 */
function snippetFor(text: string, terms: readonly { needle: string; phrase: boolean }[]): string {
  const at = matchOffsetOf(text, terms)

  if (at < 0) {
    return text.slice(0, 120)
  }

  const length = terms[0]?.needle.length ?? 0
  const start = Math.max(0, at - 40)
  const end = Math.min(text.length, at + length + 80)

  return `${start > 0 ? '...' : ''}${text.slice(start, at)}>>>${text.slice(at, at + length)}<<<${text.slice(at + length, end)}${end < text.length ? '...' : ''}`
}

/**
 * Sessions that match, one hit each, id matches before content matches.
 *
 * "One hit each" is the behaviour worth holding onto: upstream keys `seen` by
 * the lineage root and lets the first hit win, so forty matching messages in a
 * chat are ONE result. This fake has no compression lineage, so the key is the
 * session id — the same collapse by a shorter route.
 */
export function searchFakeSessions(
  sessions: readonly FakeSession[],
  query: string,
  limit: number
): Record<string, unknown>[] {
  const terms = searchTermsOf(query)
  const needle = query.trim().toLowerCase()
  const seen = new Map<string, Record<string, unknown>>()
  const at = nowSeconds() - 60

  for (const session of sessions) {
    if (seen.size >= limit) {
      break
    }

    if (session.storedId.toLowerCase().includes(needle) || session.id.toLowerCase().includes(needle)) {
      const preview = session.messages[session.messages.length - 1]?.text ?? ''

      seen.set(session.storedId, searchHitRow(session, preview || `Session ID: ${session.storedId}`, null, at))
    }
  }

  if (terms.length) {
    for (const session of sessions) {
      if (seen.size >= limit || seen.has(session.storedId)) {
        continue
      }

      const hit = session.messages.find(row => messageMatches(row.text ?? '', terms))

      if (hit) {
        seen.set(session.storedId, searchHitRow(session, snippetFor(hit.text ?? '', terms), hit.role, at))
      }
    }
  }

  return [...seen.values()]
}

function restMessageRow(row: TranscriptRow, index: number): Record<string, unknown> {
  return {
    id: row.row_id ?? index + 1,
    role: row.role,
    content: row.text ?? '',
    ...(row.display_kind ? { display_content: row.text ?? '', display_kind: row.display_kind } : {}),
    ...(row.display_metadata ? { display_metadata: row.display_metadata } : {}),
    ...(row.timestamp === undefined ? {} : { timestamp: row.timestamp }),
    ...(row.name === undefined || row.name === null ? {} : { name: row.name }),
    ...(row.tool_id === undefined || row.tool_id === null ? {} : { tool_id: row.tool_id }),
    ...(row.context === undefined || row.context === null ? {} : { context: row.context }),
    ...(row.args === undefined || row.args === null ? {} : { args: row.args }),
    ...(row.reasoning === undefined || row.reasoning === null ? {} : { reasoning: row.reasoning })
  }
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
  /**
   * Answer the next N ticket mints with 503.
   *
   * A dial can fail for a reason that has nothing to do with the credential, and
   * the mint is where that is cheapest to stage: upstream's ws-ticket route is an
   * ordinary authenticated POST, so a proxy hiccup in front of it looks exactly
   * like this and must NOT count as a rejection of the credential.
   */
  failNextTicketMints: number
  /** Ticket mints answered with 503 because of `failNextTicketMints`. */
  ticketMintsFailed: number
  /**
   * Refresh tokens this gateway has already rotated away.
   *
   * Upstream keeps no refresh-token store of its own — rotation and invalidation
   * happen at the identity provider — but a rotating IdP with reuse detection is
   * the case that costs a session, so the fake models it: presenting a spent
   * token is refused rather than quietly accepted.
   */
  spentRefreshTokens: Set<string>
  /** Refresh calls that presented an already-rotated token. */
  refreshReuseAttempts: number
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
   * The profile `hermes serve` was launched with. `cron.manage` binds
   * HERMES_HOME to its `profile` param and falls back to this one, so it is the
   * only store an unscoped socket call can see.
   */
  cronLaunchProfile: string
  /**
   * `gateway_running` in every `cron.manage` answer: whether the scheduler
   * process is up. Flip it to false to drive the Crons banner.
   */
  cronGatewayRunning: boolean
  /** Stored ids of the sessions the gateway reports as busy. */
  runningSessions: Set<string>
  /** Session-scoped configuration `config.get` / `config.set` read and write. */
  sessionConfig: Map<string, Record<string, string>>
  /** Approvals raised and not yet answered, by queue id. */
  pendingApprovals: Map<string, { session_id: string; payload: Record<string, unknown> }>
  /**
   * Server→client requests still waiting on an answer, by request id.
   *
   * The real gateway reports these as `open_requests` on `session.resume` and
   * `session.events.since`, and the channel re-delivers them to the client's
   * request handlers BEFORE the call they rode in on resolves. A fake without
   * them cannot reproduce the window where an inherited approval arrives for a
   * session nothing has bound yet.
   */
  openServerRequests: Map<string, { session_id: string; method: string; params: Record<string, unknown> }>
  /** Images accepted through `image.attach_bytes`, newest last. */
  attachedImages: { session_id: string; filename: string; bytes: number }[]
  /**
   * Files accepted through `POST /api/files/upload-stream`, by resolved path.
   *
   * Held in memory rather than written anywhere: a test wants to know that the
   * bytes arrived, how many there were, and at which path — never to read them
   * back off a disk the test then has to clean up.
   */
  uploadedFiles: Map<string, { path: string; filename: string; bytes: number; contentType: string }>
  /**
   * Children a delegation has spawned and not yet finished, by subagent id.
   *
   * `subagent.list` and `delegation.status` both read this. A real gateway only
   * knows about LIVE children — a finished one is dropped from the registry and
   * lives on only in the transcript — so a completed child is deleted here too,
   * which is exactly the case a client's reconcile has to survive.
   */
  liveSubagents: Map<string, LiveSubagent>
  /**
   * Background processes `agents.list` reports. A queued `message_agent` puts a
   * `bot_mode_dm.py --run-delivery` row in here until the reply lands.
   */
  agentProcesses: Map<string, { session_id: string; command: string; status: string; startedAt: number }>
}

/** One live delegated child, in the shape `subagent.list` projects. */
export interface LiveSubagent {
  subagent_id: string
  parent_id: string | null
  depth: number
  goal: string
  delegation_id: string
  model: string
  started_at: number
  status: string
  tool_count: number
  last_tool: string | null
  accepting_steer: boolean
  child_session_id: string
  owner_session_id: string
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
  /**
   * Whose cron store holds it. There is no such field on a real stored job —
   * each profile has its own `cron/jobs.json` — so it is stripped from every WS
   * row and re-attached on HTTP ones the way `_annotate_cron_job` does.
   */
  profile: string
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

/**
 * A run session, in the `list_sessions_rich` row shape `/runs` answers with.
 *
 * `end_reason` and NOT `status`: a session row is `dict(sqlite_row)` over the
 * sessions table, and that table has no status column at all. The fake used to
 * invent one, which meant the app's run history read "ok" against this server
 * whatever it said — and would have read "ok" against a real gateway for every
 * run, including the ones that died.
 */
interface CronRunRow {
  id: string
  source: string
  title: string
  end_reason: string | null
  started_at: number
  ended_at: number | null
  last_active: number
  message_count: number
  preview: string
  archived: boolean
  is_active: boolean
  profile: string
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
  /** The same for any server→client method, so `clarify` can be driven too. */
  requestServerSide(method: string, params: Record<string, unknown>): Promise<unknown>
  /** Close every live socket with a code, the way the gateway does on a policy refusal. */
  closeSockets(code: number, reason?: string): void
  /** Kill every live socket without a close frame: the client sees 1006. */
  dropSockets(): void
  close(): Promise<void>
}

/**
 * The profile `hermes serve` runs as. The fixture bots (`researcher`,
 * `writer`) are secondary profiles, so a cron in one of them is only reachable
 * with an explicit scope.
 */
const LAUNCH_PROFILE = 'default'

const WS_PATH = '/api/ws'
const GATEWAY_WS_PROTOCOL = 'hermes-gateway-v1'
const TICKET_PROTOCOL_PREFIX = 'hermes-gateway-ticket.'
/** The access-token cookie, as `dashboard_auth/cookies.py` names it over plain HTTP. */
const SESSION_COOKIE = 'hermes_session_at'
const TICKET_TTL_SECONDS = 30

/** Frames one delegated child runs through: requested, start, thinking, tool, progress, complete. */
const FRAMES_PER_CHILD = 6

/**
 * A reply long enough to fold, cut in half by a tool call.
 *
 * The transcript's own bug — the column jumping while a reply streams — needs a
 * turn that lasts long enough to watch and that produces all three item kinds:
 * an interim note sealed by the tool, the tool row, and a second bubble that
 * grows past the fold's fourteen lines before it settles. Two deltas of
 * `Looking that up for you.` produce none of that and finish inside one frame.
 *
 * Reached with a prompt containing `long`, so the short default is still what
 * every other manual run and every test gets.
 */
const LONG_REPLY_DELTAS: string[] = [
  'Right — let me walk through what I found, ',
  'because there are a few threads here and they do not all point the same way.\n\n',
  'First, the **release notes**. ',
  'The changelog for 0.21 lists the gateway rewrite, ',
  'but it does not mention the token refresh path at all, ',
  'which is the part you were actually asking about.\n\n',
  'Second, the tests. ',
  'There are two suites that cover this and they disagree: ',
  'one asserts the refresh happens before the socket opens, ',
  'the other asserts it happens on the first 401. ',
  'Both pass, because they stub different layers.\n\n',
  'Let me read the file before I say which one is right.\n\n',
  'So: the refresh is attempted **before** the socket opens, ',
  'and the 401 path is a fallback that only runs when the stored token ',
  'was still inside its validity window when the attempt started.\n\n',
  'That means the second suite is testing a path that a healthy client ',
  'reaches roughly never, which is why nobody noticed it had drifted.\n\n',
  'Three things follow from that:\n\n',
  '1. The refresh timer is the thing to instrument, not the 401 handler.\n',
  '2. The second suite needs a comment saying which case it pins down.\n',
  '3. The changelog entry is worth writing before this is forgotten again.\n\n',
  'I can start with the first of those if you want.'
]

const DEFAULT_SCENARIO: Scenario = {
  replies: [
    {
      match: 'long',
      reasoning: ['Reading the ', 'refresh path.'],
      reasoningAvailable: 'Read the refresh path.',
      toolGenerating: true,
      deltas: LONG_REPLY_DELTAS,
      text: LONG_REPLY_DELTAS.join(''),
      // In the cut after "Let me read the file", which is where a real agent
      // would reach for one.
      toolAfterDeltas: 12,
      tool: {
        name: 'read_file',
        args: { path: 'gateway/auth.py' },
        summary: 'read gateway/auth.py',
        result: 'def refresh(...):'
      }
    },
    {
      // Thinking first, then words: the order a real turn arrives in, and the order
      // the transcript's typing header has to survive.
      reasoning: ['Checking the ', 'README first.'],
      reasoningAvailable: 'Checked the README.',
      toolGenerating: true,
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
 * One outbound `message_agent` plus, optionally, the `process_complete` row that
 * carries the answer back.
 *
 * A run of these is what the app rolls up into one "five messages to Researcher"
 * card, so the fixture has to produce the run the way a real transcript does: the
 * dispatch is a tool row with no result, and the reply is a separate row later,
 * joined by the recipient named in the background command. A dispatch without one
 * is a hand-off still in flight, which is the state the roll-up has to survive.
 */
function dispatchRunRows(
  target: string,
  index: number,
  message: string,
  reply: { text: string; rowId: number; timestamp: number } | null
): TranscriptRow[] {
  const suffix = `dm${index}`
  const command =
    `/usr/bin/python3 /opt/hermes/tools/bot_mode_dm.py --run-delivery query-file ` +
    `/root/.hermes/dm/${suffix}.json hermes -p ${target} chat -c "Bot Chat" -Q -q @/root/.hermes/dm/${suffix}.json`

  const rows: TranscriptRow[] = [
    {
      role: 'tool',
      name: 'message_agent',
      tool_id: `call_${suffix}`,
      context: `message_agent(${target})`,
      args: { target: `@${target}`, message }
    }
  ]

  if (reply !== null) {
    const display = `${target[0]?.toUpperCase()}${target.slice(1)}`

    rows.push({
      role: 'user',
      text: [
        `[IMPORTANT: Background process proc-${suffix} completed (exit code 0).`,
        `Command: ${command}`,
        'Output:',
        `Message from 🤖 ${display} (@${target}): ${reply.text}]`
      ].join('\n'),
      row_id: reply.rowId,
      timestamp: reply.timestamp,
      display_kind: 'process_complete',
      display_metadata: { display_text: 'Background Process Finished: bot_mode_dm.py' }
    })
  }

  return rows
}

/**
 * The header `cron/scheduler_delivery.py::_deliver_to_bot_chat` splices in front
 * of a report it injects into a bot's chat, verbatim: the em dash, the quotes
 * around the job name and the BLANK line before the body are all part of it.
 *
 * The row carries no `display_kind` and no metadata, exactly as upstream writes
 * it — which is the whole reason the transcript engine has to recognise it from
 * the header. The name matches `job-inbox-scan`, the fixture cron that delivers
 * to `bot-chat:researcher`, so the report and the job that produced it agree.
 */
const CRON_DELIVERY_TEXT = [
  '[Cronjob "Source scan" output — scheduled job, not the user. Review it, act on ' +
    'anything that needs action, and summarize for the chat.]',
  '',
  '### Source scan — 4 new items',
  '',
  '| Source | Item | Why it matters |',
  '| --- | --- | --- |',
  '| docs.example.com | Retry semantics rewritten | Contradicts our own guide |',
  '| status.example.org | Two incidents, both closed | No action |',
  '| blog.example.net | Long post on session resume | Worth reading in full |',
  '| docs.example.com | Changelog for 1.4 | Three flags renamed |',
  '',
  'The first one needs a decision: our guide still documents the old behaviour.',
  '',
  'Nothing else is urgent. Next scan in four hours.'
].join('\n')

/**
 * A report long enough that the app has to fold it, with the three structures
 * that make folding awkward: a table, a fenced code block and a nested list.
 * Well over twenty rendered lines on purpose.
 */
const LONG_REPORT_MARKDOWN = [
  '## Retry semantics: what actually changed',
  '',
  'Short version: the backoff is now computed per attempt instead of per call, so a',
  'long-running request no longer inherits the delay of the one before it.',
  '',
  '| Behaviour | Before | After |',
  '| --- | --- | --- |',
  '| First retry delay | 1s | 1s |',
  '| Second retry delay | 1s | 2s |',
  '| Ceiling | none | 30s |',
  '| Jitter | none | ±20% |',
  '| Budget | per call | per attempt |',
  '',
  'Where this bites us:',
  '',
  '- The reconnect loop, which assumed a flat delay.',
  '  - It reads the delay once and caches it.',
  '  - Caching it is what makes the ceiling invisible.',
  '- The upload path, which retries on its own.',
  '  - Two retry budgets now overlap.',
  '    - Worst case is eight attempts where we documented three.',
  '- Nothing in the transcript path: it does not retry.',
  '',
  'The shape we should move to:',
  '',
  '```ts',
  'export function backoff(attempt: number): number {',
  '  const base = Math.min(2 ** attempt * 1000, 30_000)',
  '  // Jitter is not decoration: without it every client in a fleet retries',
  '  // on the same tick and the recovery looks like a second outage.',
  '  return base * (0.8 + Math.random() * 0.4)',
  '}',
  '',
  'export async function withRetries<T>(run: () => Promise<T>, attempts = 3): Promise<T> {',
  '  for (let attempt = 0; ; attempt += 1) {',
  '    try {',
  '      return await run()',
  '    } catch (error) {',
  '      if (attempt >= attempts - 1) {',
  '        throw error',
  '      }',
  '',
  '      await new Promise(resolve => setTimeout(resolve, backoff(attempt)))',
  '    }',
  '  }',
  '}',
  '```',
  '',
  '> The ceiling matters more than the curve. A retry that waits four minutes is',
  '> indistinguishable from a hang.',
  '',
  'I would change the reconnect loop first — it is the one a user can see.'
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

/** `_MANAGED_FILE_MAX_BYTES` in `hermes_cli/web_server.py`. */
const MANAGED_FILE_MAX_BYTES = 100 * 1024 * 1024

interface MultipartForm {
  fields: Record<string, string>
  file: { filename: string; contentType: string; bytes: number } | null
}

/**
 * Enough of RFC 7578 to read what the upload route declares: a few small text
 * fields and one file part, of which only the SIZE is kept.
 *
 * Deliberately not a general parser and deliberately not a dependency. The file
 * part is measured and its bytes are dropped, which is what lets the size cap be
 * exercised without holding a second copy of the payload.
 */
async function readMultipart(req: IncomingMessage): Promise<MultipartForm> {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(req.headers['content-type'] ?? '')
  const marker = boundary?.[1] ?? boundary?.[2]

  if (!marker) {
    throw new Error('Multipart body has no boundary')
  }

  const chunks: Buffer[] = []

  for await (const chunk of req) {
    chunks.push(chunk as Buffer)
  }

  const form: MultipartForm = { fields: {}, file: null }
  // `binary` (latin1) is one JS character per byte, so a part's length IS its
  // byte count and a split on the boundary cannot cut a multi-byte sequence.
  const parts = Buffer.concat(chunks).toString('binary').split(`--${marker}`)

  for (const part of parts) {
    const split = part.indexOf('\r\n\r\n')

    if (split === -1) {
      // The preamble and the closing `--`: neither is a part.
      continue
    }

    const headers = part.slice(0, split)
    const name = /name="([^"]*)"/i.exec(headers)?.[1]

    if (!name) {
      continue
    }

    // A part's body ends with the CRLF that precedes the next boundary.
    const raw = part.slice(split + 4).replace(/\r\n$/, '')
    const filename = /filename="([^"]*)"/i.exec(headers)?.[1]

    if (filename === undefined) {
      form.fields[name] = Buffer.from(raw, 'binary').toString('utf8')

      continue
    }

    form.file = {
      filename,
      contentType: /content-type:\s*([^\r\n;]+)/i.exec(headers)?.[1]?.trim() || 'application/octet-stream',
      bytes: raw.length
    }
  }

  return form
}

/**
 * `tools/cronjob_job_args.py::_format_job` — the row `cron.manage list` answers
 * with. Deliberately carries NO `profile`: the socket answers out of one
 * profile's store, so a row has no owner to name, and a client that wants to
 * know has to use the REST list. Dropping it here is what makes a client that
 * lists over the socket and then mutates fail in the test rather than in the app.
 */
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
 * `hermes_cli/web_server_cron.py::_annotate_cron_job` — what the REST routes
 * add to a stored job on the way out. The dashboard reads `profile` off this,
 * and so does Hermie: it is the only surface that says which store a job came
 * from, because the stored record itself does not know.
 *
 * `runs` is dropped: the run sessions live behind `/runs` on a real gateway,
 * not inside the job.
 */
function annotateCronJob(job: CronJob): Record<string, unknown> {
  const { runs: _runs, ...stored } = job

  return {
    ...stored,
    profile: job.profile,
    profile_name: job.profile,
    hermes_home: `/root/.hermes/profiles/${job.profile}`,
    is_default_profile: job.profile === 'default',
    scheduler_heartbeat_age_s: 4
  }
}

/**
 * A cron run: an ordinary session whose id is `cron_{job_id}_{timestamp}`.
 *
 * That is the whole binding between a job and its runs on a real gateway — the
 * id prefix plus `source='cron'` — so the fake keeps run transcripts in the
 * same session map as chats and answers `session.history` for them unchanged.
 */
function makeCronRunSession(
  jobId: string,
  startedAt: number,
  prompt: string,
  answer: string,
  profile: string
): FakeSession {
  const id = `cron_${jobId}_${startedAt}`

  return {
    id,
    storedId: id,
    profile,
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

    // The scheduled job's report, exactly as the scheduler injects it: a plain
    // `user` row with NO display_kind, recognised only by its header. This is the
    // row Hermie used to draw as the owner's own bubble with raw markdown in it.
    messages.push({ role: 'user', text: CRON_DELIVERY_TEXT, row_id: 5, timestamp: base + 120 })

    // …and the summary the header asked for: long enough to need folding, with a
    // table, a fenced code block and a nested list inside it.
    messages.push({ role: 'assistant', text: LONG_REPORT_MARKDOWN, row_id: 6, timestamp: base + 140 })
  }

  if (profile === 'writer') {
    // A RUN of dispatches to the same target, back to back, because the app shows
    // one roll-up instead of five near-identical cards. The joined replies emit no
    // item of their own, so all five stay consecutive in the projection; the last
    // two are still in flight and have no answer yet.
    //
    // It lives in the writer's chat rather than the researcher's so that the two
    // DM fixtures stay separable: one exchange to read, one run to collapse.
    messages.push(
      ...dispatchRunRows('researcher', 3, 'Which sources back the retry claim?', {
        text: 'Two: the changelog and the long post. I sent both links.',
        rowId: 3,
        timestamp: base + 70
      }),
      ...dispatchRunRows('researcher', 4, 'Is the ceiling documented anywhere upstream?', {
        text: 'Only in the changelog, not in the guide.',
        rowId: 4,
        timestamp: base + 80
      }),
      ...dispatchRunRows('researcher', 5, 'Any incident that was actually caused by the old backoff?', {
        text: 'One, last quarter. I noted the reference.',
        rowId: 5,
        timestamp: base + 90
      }),
      ...dispatchRunRows('researcher', 6, 'Can you re-check the second source before I quote it?', null),
      ...dispatchRunRows('researcher', 7, 'And whether the guide has an owner listed.', null)
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
        run.end_reason === 'done' ? 'Done — nothing needs your attention.' : 'The check did not complete.',
        job.profile
      )

      session.id = run.id
      session.storedId = run.id
      sessions.set(run.id, session)
    }
  }

  /**
   * Writer deliberately has NO avatar.
   *
   * Every profile used to answer `has_avatar: true`, so the generated-initial
   * fallback — the thing a real gateway shows for most bots, because uploading a
   * picture is opt-in — was unreachable from a run against this server and went
   * unlooked-at for two passes. One bot with a picture and one without is what
   * makes both paths visible side by side in the same list.
   */
  const hasAvatar = (profile: string): boolean => profile !== 'writer'

  /**
   * `is_default` marks the profile `hermes serve` is running as.
   *
   * It matters to more than a badge in the roster: ADR-0016 puts Hermie's
   * app-wide section (`hermie-app`) on the default profile, because that is the
   * one row every client can find without being told which bot to ask. A roster
   * with no default row is a gateway with nowhere to keep app-wide settings, and
   * the fake answered exactly that until this round — so the client's
   * local-only fallback was the only path a test could ever reach.
   */
  const profileRow = (session: FakeSession, description: string): ProfileRow => ({
    name: session.profile,
    path: `/root/.hermes/profiles/${session.profile}`,
    is_default: session.profile === researcher.profile,
    description,
    display_name: session.profile[0]?.toUpperCase() + session.profile.slice(1),
    model: 'example-provider/example-model',
    provider: 'example-provider',
    has_avatar: hasAvatar(session.profile),
    ui_meta_revisions: hasAvatar(session.profile) ? { avatar: 1 } : {},
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
    failNextTicketMints: 0,
    ticketMintsFailed: 0,
    spentRefreshTokens: new Set<string>(),
    refreshReuseAttempts: 0,
    eventsSinceCalls: [],
    methodLog: [],
    truncateNextReplay: false,
    hangMethods: new Set<string>(),
    sessions,
    profiles: [profileRow(researcher, 'Finds things out.'), profileRow(writer, 'Writes things down.')],
    runningSessions: new Set<string>(),
    sessionConfig: new Map<string, Record<string, string>>(),
    pendingApprovals: new Map<string, { session_id: string; payload: Record<string, unknown> }>(),
    openServerRequests: new Map<string, { session_id: string; method: string; params: Record<string, unknown> }>(),
    attachedImages: [],
    uploadedFiles: new Map(),
    liveSubagents: new Map<string, LiveSubagent>(),
    agentProcesses: new Map<string, { session_id: string; command: string; status: string; startedAt: number }>(),
    cronGatewayRunning: true,
    cronLaunchProfile: LAUNCH_PROFILE,
    cronJobs
  }
}

/**
 * The rows the list has to draw: a healthy one with run history, one whose last
 * attempt failed (with the exception-wrapped `last_error` the scheduler really
 * writes), and a paused one — all three in the launch profile — plus one that
 * lives in `researcher`'s own cron store.
 *
 * That last one is the whole point of the fixture set. It is invisible to
 * `cron.manage {action:'list'}` without a `profile`, exactly as on a real
 * gateway, so a client that lists over the socket silently loses it while the
 * dashboard shows it.
 */
/**
 * One run row, with the keys a session row really carries.
 *
 * `hermes_state_portability.py::list_sessions_rich` hands back the whole
 * sessions row plus `preview` and `last_active`, and the cron route stamps
 * `is_active`, `archived` and `profile` on top. The outcome lives in
 * `end_reason`; there is no status column to read.
 */
function cronRunRow(row: {
  id: string
  title: string
  profile: string
  started_at: number
  ended_at: number
  preview: string
  end_reason?: string
}): CronRunRow {
  return {
    id: row.id,
    source: 'cron',
    title: row.title,
    end_reason: row.end_reason ?? 'done',
    started_at: row.started_at,
    ended_at: row.ended_at,
    last_active: row.ended_at,
    message_count: 3,
    preview: row.preview,
    archived: false,
    is_active: false,
    profile: row.profile
  }
}

function initialCronJobs(): CronJob[] {
  const hourAgo = Math.floor(Date.now() / 1000) - 3_600
  const yesterday = hourAgo - 86_400

  return [
    {
      id: 'job-heartbeat',
      profile: LAUNCH_PROFILE,
      name: 'VM heartbeat',
      schedule: 'every 2h',
      prompt: 'Check the VM, summarize disk and memory, and flag anything unusual.',
      deliver: 'local',
      enabled: true,
      state: 'scheduled',
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
        cronRunRow({
          id: `cron_job-heartbeat_${hourAgo}`,
          title: 'VM heartbeat',
          profile: LAUNCH_PROFILE,
          started_at: hourAgo,
          ended_at: hourAgo + 42,
          preview: 'Done — nothing needs your attention.'
        }),
        // The one that did NOT finish. A run history where every row says the
        // same word cannot show that the row is reading anything at all.
        cronRunRow({
          id: `cron_job-heartbeat_${yesterday}`,
          title: 'VM heartbeat',
          profile: LAUNCH_PROFILE,
          started_at: yesterday,
          ended_at: yesterday + 38,
          end_reason: 'interrupted',
          preview: 'The check did not complete.'
        })
      ]
    },
    {
      id: 'job-digest',
      profile: LAUNCH_PROFILE,
      name: 'Weekly digest',
      schedule: 'every friday 16:30',
      prompt: 'Write a short digest of this week for the team.',
      deliver: 'bot-chat:researcher',
      enabled: true,
      state: 'scheduled',
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
      // The profile-owned one: `cron.manage` without a `profile` cannot see it.
      id: 'job-inbox-scan',
      profile: 'researcher',
      name: 'Source scan',
      schedule: 'every 4h',
      prompt: 'Scan the watched sources and note anything new worth reading.',
      deliver: 'bot-chat:researcher',
      enabled: true,
      state: 'scheduled',
      next_run_at: new Date(Date.now() + 14_400_000).toISOString(),
      last_run_at: new Date((hourAgo - 1_800) * 1000).toISOString(),
      last_status: 'ok',
      last_error: null,
      paused_at: null,
      paused_reason: null,
      repeat: null,
      skills: ['research'],
      model: null,
      runs: []
    },
    {
      id: 'job-cleanup',
      profile: LAUNCH_PROFILE,
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
  const subagentStepMs = options.subagentStepMs ?? 900
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

  const gated = () => state.auth === 'native' || state.auth === 'cookie'
  const publicHost = options.publicHost ?? ''
  const passwordAccount = options.password ?? { username: 'tester', password: 'hunter2' }
  const sessionCookies = new Set<string>()

  /** Read one cookie out of a request's `Cookie` header. */
  function cookieOf(req: IncomingMessage, name: string): string {
    for (const part of String(req.headers.cookie ?? '').split(';')) {
      const [key, ...rest] = part.trim().split('=')

      if (key === name) {
        return decodeURIComponent(rest.join('='))
      }
    }

    return ''
  }

  /**
   * The DNS-rebinding guard, as `web_server.py` and `web_server_chat.py` run it:
   * the `Host` must be the host we believe we are, and an `Origin`, when there
   * is one, must name the same host. Off unless `publicHost` was given, because
   * every other test in this repository dials `127.0.0.1` directly.
   */
  function hostOriginRejection(req: IncomingMessage): string | null {
    if (!publicHost) {
      return null
    }

    const host = String(req.headers.host ?? '')

    if (host !== publicHost) {
      return `host_mismatch host=${host || '?'} expected=${publicHost}`
    }

    const origin = String(req.headers.origin ?? '')

    if (origin) {
      try {
        if (new URL(origin).host !== publicHost) {
          return `origin_mismatch origin=${origin} expected=${publicHost}`
        }
      } catch {
        return `origin_unparseable origin=${origin}`
      }
    }

    return null
  }

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

    if (state.auth === 'cookie') {
      const cookie = cookieOf(req, SESSION_COOKIE)

      return cookie.length > 0 && sessionCookies.has(cookie)
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

  /** The live children owned by one session, in spawn order. */
  function liveSubagentsFor(storedId: string | undefined): LiveSubagent[] {
    return [...state.liveSubagents.values()]
      .filter(child => !storedId || child.owner_session_id === storedId)
      .sort((a, b) => a.started_at - b.started_at || a.goal.localeCompare(b.goal))
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

    const rejection = hostOriginRejection(req)

    if (rejection !== null) {
      json(res, 403, { detail: rejection })

      return
    }

    if (state.auth === 'cookie' && path === '/login') {
      // The gateway's own sign-in page. A form rather than JSON, because that is
      // what a browser lands on when `/auth/login` redirects a password
      // provider — and because the proxy has to carry HTML as happily as JSON.
      html(
        res,
        200,
        `<!doctype html><meta charset="utf-8"><title>Sign in</title><form id="f"><input name="username"><input name="password" type="password"><button>Sign in</button></form>`
      )

      return
    }

    if (state.auth === 'cookie' && path === '/auth/login') {
      // Upstream redirects a password provider to its own /login page and an
      // OAuth provider to the identity provider. The fake has no identity
      // provider, so both land on /login.
      const next = url.searchParams.get('next') ?? '/'
      res.writeHead(302, { location: `/login?next=${encodeURIComponent(next)}` })
      res.end()

      return
    }

    if (state.auth === 'cookie' && path === '/auth/password-login' && method === 'POST') {
      const body = await readBody(req)

      if (
        String(body.username ?? '') !== passwordAccount.username ||
        String(body.password ?? '') !== passwordAccount.password
      ) {
        json(res, 401, { detail: 'Invalid credentials' })

        return
      }

      const value = `sess-${randomUUID()}`
      sessionCookies.add(value)
      // `HttpOnly` and `SameSite=Lax`, no `Secure`: this fake is only ever
      // reached over plain HTTP, and a `Secure` cookie there is discarded.
      res.setHeader('set-cookie', `${SESSION_COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/`)
      json(res, 200, { ok: true, next: String(body.next ?? '/') })

      return
    }

    if (state.auth === 'cookie' && path === '/auth/logout' && method === 'POST') {
      sessionCookies.delete(cookieOf(req, SESSION_COOKIE))
      res.writeHead(302, {
        location: '/login',
        'set-cookie': `${SESSION_COOKIE}=; Max-Age=0; HttpOnly; SameSite=Lax; Path=/`
      })
      res.end()

      return
    }

    if (path === '/api/status') {
      json(res, 200, {
        version,
        release_date: '2026.9.14',
        gateway_running: true,
        active_sessions: state.sessions.size,
        auth_required: gated(),
        auth_providers: gated() ? ['self-hosted'] : [],
        auth_flows: state.auth === 'cookie' ? ['cookie'] : gated() ? ['cookie', 'native_pkce'] : [],
        // `status.py` puts the TOPOLOGY rows here, not a list of names. Nothing
        // in the app reads them, which is exactly why the fake could get away
        // with a different type for as long as it did.
        profiles: state.profiles.map(profile => ({
          name: profile.name,
          path: profile.path,
          display_name: profile.display_name,
          is_default: profile.name === LAUNCH_PROFILE
        })),
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
        providers: [
          {
            name: 'self-hosted',
            display_name: 'Self-Hosted OIDC',
            supports_password: state.auth === 'cookie'
          }
        ]
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

      if (!token) {
        // `dashboard_auth/routes.py:501-502` — the one 400 this route answers.
        json(res, 400, { detail: 'refresh_token required' })

        return
      }

      if (state.spentRefreshTokens.has(token)) {
        state.refreshReuseAttempts += 1
      }

      const known = refreshTokens.get(token)

      if (!known) {
        // Upstream collapses expired, unknown and provider-rejected into this one
        // answer, with `error` alongside `detail` — an envelope no other route in
        // `dashboard_auth` uses (`routes.py:517-519`).
        json(res, 401, { error: 'session_expired', detail: 'Refresh token expired or invalid; start a new sign-in.' })

        return
      }

      refreshTokens.delete(token)
      state.spentRefreshTokens.add(token)
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
      if (state.failNextTicketMints > 0) {
        state.failNextTicketMints -= 1
        state.ticketMintsFailed += 1
        json(res, 503, { detail: 'ticket store unavailable' })

        return
      }

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

    if (path === '/api/files/upload-stream' && method === 'POST') {
      await handleFileUpload(req, res)

      return
    }

    if (path === '/api/cron/delivery-targets') {
      // `local` is implicit on every gateway; the second one is a configured
      // bot chat, which is what a delivery target looks like once the messaging
      // gateway is set up.
      json(res, 200, {
        targets: [
          { id: 'local', name: 'Local (save only)', home_target_set: true, home_env_var: null },
          { id: 'bot-chat:researcher', name: 'Bot Chat (researcher)', home_target_set: true, home_env_var: null }
        ]
      })

      return
    }

    if (path.startsWith('/api/cron/jobs')) {
      await handleCron(req, res, path, method, url.searchParams)

      return
    }

    /*
     * `GET /api/sessions/search` — `sessions.py::search_sessions`.
     *
     * Declared before the templated `/api/sessions/{id}/messages` for the same
     * reason upstream mounts `search_router` before `manage_router`: an
     * unconstrained `{session_id}` would otherwise swallow the literal path.
     *
     * Three behaviours are reproduced because the app depends on each of them,
     * and one is deliberately NOT: there is no compression lineage in this
     * fake, so a session is its own root and the dedup below is by session id.
     *
     *  - A blank or whitespace `q` answers `{"results": []}` without reading
     *    anything, so a debounce that fires on an empty field is free.
     *  - `limit` is clamped to 1…100.
     *  - The search is PER PROFILE. Upstream opens that profile's own
     *    `state.db`; an unknown profile is a 404 from `_cron_profile_home`, not
     *    an empty result, and the app's fan-out has to survive one.
     *  - Hits collapse to one per session, id matches first, and the snippet
     *    wraps the matched run in `>>>`/`<<<` the way
     *    `snippet(messages_fts, -1, '>>>', '<<<', '...', 40)` does.
     */
    if (path === '/api/sessions/search') {
      const rawQuery = url.searchParams.get('q') ?? ''
      const profile = url.searchParams.get('profile')

      if (!rawQuery.trim()) {
        json(res, 200, { results: [] })

        return
      }

      if (profile && !state.profiles.some(entry => entry.name === profile)) {
        json(res, 404, { detail: `Profile '${profile}' does not exist.` })

        return
      }

      const limit = Math.max(1, Math.min(Number.parseInt(url.searchParams.get('limit') ?? '20', 10) || 20, 100))
      const sessions = [...state.sessions.values()].filter(session => !profile || session.profile === profile)

      json(res, 200, { results: searchFakeSessions(sessions, rawQuery, limit) })

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
      const offset = Math.max(0, Number.parseInt(url.searchParams.get('offset') ?? '0', 10) || 0)
      // `order` defaults to `oldest` upstream, not `latest`. The fake said
      // `latest`, which nothing noticed because every caller sends the parameter.
      const order = url.searchParams.get('order') ?? 'oldest'
      /*
        `offset` used to be parsed, echoed in `pagination` and then ignored —
        a fake advertising paging it did not do, which is the one kind of
        infidelity that cannot be caught by a test written against the fake.

        It skips from the end `order` names: from the NEWEST row for `latest`,
        from the oldest otherwise. Either way the page comes back oldest first.
        Measured against a real gateway on 2026-09-21: on a six-row session,
        `?limit=2&order=latest&offset=2` answers the third and fourth rows, in
        that order, and an offset past the end answers an empty list rather than
        an error.
      */
      const rows =
        order === 'latest'
          ? session.messages.slice(
              Math.max(0, session.messages.length - offset - limit),
              Math.max(0, session.messages.length - offset)
            )
          : session.messages.slice(offset, offset + limit)
      // `sessions.py::_get_session_messages` — the envelope names the session it
      // read and pages with `pagination`. It has no `count`, which is what the
      // fake used to send and what nothing on either side ever read.
      json(res, 200, {
        session_id: session.storedId,
        profile: session.profile,
        messages: rows.map(restMessageRow),
        pagination: { limit, offset, order, returned: rows.length }
      })

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
  async function handleCron(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    method: string,
    query: URLSearchParams
  ): Promise<void> {
    const profile = (query.get('profile') ?? '').trim()

    if (path === '/api/cron/jobs') {
      if (method === 'GET') {
        // `_list_cron_jobs_sync` defaults to "all" and walks every profile's
        // store; anything else is one profile. Either way each row comes back
        // annotated with the profile it was read out of.
        const wanted = profile || 'all'
        const rows =
          wanted.toLowerCase() === 'all' ? state.cronJobs : state.cronJobs.filter(entry => entry.profile === wanted)

        json(res, 200, rows.map(annotateCronJob))

        return
      }

      if (method === 'POST') {
        const body = await readBody(req)
        const job = addCronJob({ ...body, profile: profile || state.cronLaunchProfile })
        json(res, 200, annotateCronJob(job))

        return
      }
    }

    const match = /^\/api\/cron\/jobs\/([^/]+)(\/(pause|resume|trigger|runs))?$/.exec(path)

    if (!match) {
      json(res, 404, { detail: `No cron route for ${method} ${path}` })

      return
    }

    const wanted = decodeURIComponent(match[1] as string)
    // `_job_profile`: the given profile, else the first store that has a job by
    // that id or name. The walk is why these routes work without the parameter
    // and why two profiles with the same job name make it a coin toss.
    const candidates = profile ? state.cronJobs.filter(entry => entry.profile === profile) : state.cronJobs
    const action = match[3]
    // …but WHICH job, once the store is chosen, is `get_job`, and that matches
    // on the id alone. Only `/trigger` goes through `resolve_job_ref`, which is
    // the one place a name is allowed to stand in for an id. Accepting names
    // everywhere made `GET /api/cron/jobs/VM heartbeat` work here and 404 on a
    // real gateway.
    const byName = action === 'trigger'
    const job = candidates.find(entry => entry.id === wanted || (byName && entry.name === wanted))

    if (!job) {
      json(res, 404, { detail: 'Unknown job' })

      return
    }

    if (action === 'runs') {
      // Newest first, the way the id-range scan returns them. The echoed limit
      // is the REQUESTED one clamped to 1..100, not how many came back.
      const asked = Number.parseInt(query.get('limit') ?? '20', 10)
      const limit = Number.isFinite(asked) ? Math.min(100, Math.max(1, asked)) : 20
      const runs = [...job.runs].sort((a, b) => b.started_at - a.started_at).slice(0, limit)
      json(res, 200, { runs, limit })

      return
    }

    if (action === 'pause' || action === 'resume') {
      setCronPaused(job, action === 'pause')
      publish('cron.changed', undefined, {})
      json(res, 200, annotateCronJob(job))

      return
    }

    if (action === 'trigger') {
      json(res, 200, annotateCronJob(triggerCronJob(job)))

      return
    }

    if (method === 'GET') {
      json(res, 200, annotateCronJob(job))

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
      json(res, 200, annotateCronJob(job))

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

  /**
   * `POST /api/files/upload-stream`, in `hermes_cli/web_routers/files.py`'s shape.
   *
   * The interesting parts are the ones a client can get wrong, so all three are
   * reproduced: `path` is resolved through the managed-files policy (which has
   * NO locked root here, so it must be absolute — the real 400 a relative path
   * earns), the 100 MB cap answers 413 as the stream crosses it rather than
   * afterwards, and the result carries `path` as the RESOLVED path plus the
   * policy metadata the dashboard reads.
   */
  async function handleFileUpload(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let form: MultipartForm

    try {
      form = await readMultipart(req)
    } catch (error) {
      json(res, 400, { detail: error instanceof Error ? error.message : 'Malformed multipart body' })

      return
    }

    const requested = (form.fields.path ?? '').trim()

    if (!requested) {
      json(res, 422, { detail: 'path is required' })

      return
    }

    if (!requested.startsWith('/')) {
      // `_resolve_managed_path`: with no locked managed-files root, a relative
      // path is refused outright. Clients that assume otherwise fail here.
      json(res, 400, { detail: 'Path must be absolute' })

      return
    }

    if (requested.split('/').includes('..')) {
      json(res, 400, { detail: "Path cannot contain '..'" })

      return
    }

    if (!form.file) {
      json(res, 422, { detail: 'file is required' })

      return
    }

    if (form.file.bytes > MANAGED_FILE_MAX_BYTES) {
      json(res, 413, { detail: 'File is too large' })

      return
    }

    if (state.uploadedFiles.has(requested) && (form.fields.overwrite ?? 'true') === 'false') {
      json(res, 409, { detail: 'File already exists' })

      return
    }

    const entry = {
      path: requested,
      filename: form.file.filename,
      bytes: form.file.bytes,
      contentType: form.file.contentType
    }

    state.uploadedFiles.set(requested, entry)

    json(res, 200, {
      ok: true,
      path: requested,
      entry: {
        name: form.file.filename,
        path: requested,
        is_directory: false,
        size: form.file.bytes,
        mtime: Date.now() / 1000,
        mime_type: form.file.contentType
      },
      // `_managed_response_meta` for the unlocked policy: no root, and the
      // browser may point itself anywhere the user can read.
      root: null,
      locked_root: null,
      can_change_path: true
    })
  }

  function addCronJob(body: Record<string, unknown>): CronJob {
    const schedule = typeof body.schedule === 'string' && body.schedule ? body.schedule : 'every 1h'
    const job: CronJob = {
      id: `job-${randomUUID().slice(0, 8)}`,
      // Which store it lands in is decided by the caller's scope, never by a
      // field in the payload — there is no owner field on a stored job.
      profile: typeof body.profile === 'string' && body.profile ? body.profile : state.cronLaunchProfile,
      name: typeof body.name === 'string' && body.name ? body.name : 'New job',
      schedule,
      prompt: typeof body.prompt === 'string' ? body.prompt : '',
      deliver: typeof body.deliver === 'string' && body.deliver ? body.deliver : 'local',
      enabled: true,
      state: 'scheduled',
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
    job.state = paused ? 'paused' : 'scheduled'
    job.paused_at = paused ? new Date().toISOString() : null
    job.paused_reason = paused ? 'Paused from Hermie' : null
    job.next_run_at = paused ? null : nextRunFor(job.schedule)
  }

  /** Fire now: record a run, register its transcript, and answer the refreshed job. */
  function triggerCronJob(job: CronJob): CronJob {
    const startedAt = nowSeconds()
    const run = cronRunRow({
      id: `cron_${job.id}_${startedAt}`,
      title: job.name,
      profile: job.profile,
      started_at: startedAt,
      ended_at: startedAt + 9,
      preview: 'Done — nothing needs your attention.'
    })

    job.runs.push(run)
    job.last_run_at = new Date(startedAt * 1000).toISOString()
    job.last_status = 'ok'
    job.last_error = null

    const session = makeCronRunSession(
      job.id,
      startedAt,
      job.prompt,
      'Done — nothing needs your attention.',
      job.profile
    )
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

    // HTTP middleware does not run for a WebSocket route upstream either, so the
    // guard is repeated here rather than assumed.
    const upgradeRejection = hostOriginRejection(req)

    if (upgradeRejection !== null) {
      state.rejectedUpgrades += 1
      socket.end(`HTTP/1.1 403 Forbidden\r\nconnection: close\r\n\r\n${upgradeRejection}`)

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

    // Cookie and native both dial with a ticket: a browser cannot put a
    // credential anywhere else on an upgrade, which is why the ticket exists.
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

      /**
       * `ui_meta` only, which is the section a client has any business writing.
       *
       * Upstream's docstring is the specification and the generated contract
       * carries it verbatim: "Sections are independent; `ui_meta_expected_revisions`
       * is a per-key compare-and-swap." So the unit is the TOP-LEVEL KEY:
       *
       *  - a key the request does not name is left exactly as it was, which is
       *    what keeps a client from wiping the `hermes-bots` marker another tool
       *    put there by writing only its own key;
       *  - a key the request does name REPLACES that key's value whole, and its
       *    revision goes up by one;
       *  - a key whose `ui_meta_expected_revisions` entry disagrees with the
       *    stored revision writes nothing and comes back in `ui_meta_conflicts`
       *    as `{ expected, actual }` — and the other keys in the same request
       *    still apply, because the sections are independent.
       *
       * The revision of a key that has never been written is 0, so a client
       * claiming a key for the first time sends `0` and finds out whether
       * somebody beat it to it.
       *
       * **A key written as `null` is REMOVED.** That is not a guess: the
       * 2026-09-21 probe against `hermes serve` 0.21.3 wrote `{"hermie": null}`
       * to a profile and read the bag back holding only `hermes-bots` — the key
       * was gone, not stored as a null. The fake kept the null until that probe,
       * which made it the more forgiving of the two: a client that removes a
       * section by writing null passed here and would have left a dead key on a
       * real profile. The revision still goes up, because a removal is a write.
       *
       * Everything else `profiles.configure` can set (soul, model, skills) is
       * deliberately absent: the fake answers what it can honestly reproduce,
       * and a section it pretended to write would be a green test about nothing.
       */
      case 'profiles.configure': {
        const name = typeof params.name === 'string' && params.name ? params.name : String(params.profile ?? '')
        const profile = state.profiles.find(entry => entry.name === name)

        if (!profile) {
          throw new Error(`Unknown profile: ${name}`)
        }

        const patch = params.ui_meta

        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
          return { ok: true, applied: {} }
        }

        const expected = (
          params.ui_meta_expected_revisions && typeof params.ui_meta_expected_revisions === 'object'
            ? params.ui_meta_expected_revisions
            : {}
        ) as Record<string, unknown>
        const stored = { ...(profile.ui_meta ?? {}) }
        const revisions = { ...profile.ui_meta_revisions }
        const conflicts: Record<string, { expected: unknown; actual: number }> = {}
        let wrote = false

        for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
          const actual = revisions[key] ?? 0

          if (key in expected && expected[key] !== actual) {
            conflicts[key] = { expected: expected[key], actual }

            continue
          }

          if (value === null) {
            delete stored[key]
          } else {
            stored[key] = value
          }

          revisions[key] = actual + 1
          wrote = true
        }

        profile.ui_meta = stored
        profile.ui_meta_revisions = revisions

        return {
          ok: true,
          applied: {
            ui_meta: wrote,
            ui_meta_revisions: revisions,
            ...(Object.keys(conflicts).length ? { ui_meta_conflicts: conflicts } : {})
          }
        }
      }

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
          open_requests: openRequestsFor(session.id)
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
          open_requests: session ? openRequestsFor(session.id) : []
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
        // Deliberately IGNORES `profile`, because upstream does: the method is a
        // plain one over the process's live sessions and never reads the profile
        // it accepts (`tui_gateway/methods_session.py`). Honouring it here hid
        // the bug where one busy session marked every bot as working.
        const sessions = [...state.sessions.values()]
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

      case 'clarify.lock': {
        const requestId = String(params.request_id ?? '')
        const open = state.openServerRequests.get(requestId)

        // `lock_answer` only knows batch clarify; a single question has no qid
        // set to lock against, so the real gateway reports it expired and the
        // agent keeps waiting. A client has to use `request.answer` for those.
        if (!open || open.method !== 'clarify' || !Array.isArray(open.params.questions)) {
          return { status: 'expired' }
        }

        return { status: 'ok', remaining: [] }
      }

      case 'request.answer': {
        // `methods_prompt.request.answer`: settle an open server→client request
        // for a client that cannot answer it on its own reply frame. It takes
        // the request's own id and the result that frame would have carried —
        // no session id anywhere.
        const requestId = String(params.id ?? '')
        const result = params.result

        if (!result || typeof result !== 'object' || Array.isArray(result)) {
          throw new Error('id and an object result required')
        }

        const pending = pendingServerRequests.get(requestId)

        if (!pending) {
          return { status: 'expired' }
        }

        pendingServerRequests.delete(requestId)
        pending.resolve(result)

        return { status: 'ok' }
      }

      case 'subagent.list': {
        const session = resolveSession(String(params.session_id ?? ''))
        const children = liveSubagentsFor(session?.storedId)

        return {
          subagents: children,
          delegations: [...new Set(children.map(child => child.delegation_id))].map(id => ({
            delegation_id: id,
            child_count: children.filter(child => child.delegation_id === id).length
          }))
        }
      }

      case 'delegation.status': {
        // Addressed at a PROFILE, not a session: it answers for the bot's whole
        // backend, which is what makes it the right source for a cross-bot
        // counter.
        const profile = typeof params.profile === 'string' ? params.profile : null
        const owned = [...state.liveSubagents.values()].filter(child => {
          const owner = state.sessions.get(child.owner_session_id)

          return !profile || owner?.profile === profile
        })

        return {
          active: owned.map(child => ({
            subagent_id: child.subagent_id,
            parent_id: child.parent_id,
            depth: child.depth,
            goal: child.goal,
            delegation_id: child.delegation_id,
            model: child.model,
            started_at: child.started_at,
            status: child.status,
            tool_count: child.tool_count,
            owner_agent_session_id: child.owner_session_id
          })),
          paused: false,
          max_spawn_depth: 3,
          max_concurrent_children: 4
        }
      }

      case 'agents.list': {
        const profile = typeof params.profile === 'string' ? params.profile : null
        const processes = [...state.agentProcesses.values()]
          .filter(entry => {
            const owner = state.sessions.get(entry.session_id)

            return !profile || owner?.profile === profile
          })
          .map(entry => ({
            session_id: entry.session_id,
            command: entry.command,
            status: entry.status,
            uptime: Math.max(0, nowSeconds() - entry.startedAt)
          }))

        return { processes }
      }

      case 'subagent.steer': {
        const id = String(params.subagent_id ?? '')
        const child = state.liveSubagents.get(id)

        if (child) {
          child.last_tool = 'steer'
        }

        return { status: child ? 'queued' : 'rejected', subagent_id: id, text: String(params.text ?? '') }
      }

      case 'subagent.interrupt': {
        const id = String(params.subagent_id ?? '')
        const child = state.liveSubagents.get(id)

        if (child) {
          state.liveSubagents.delete(id)
          publish('subagent.complete', child.owner_session_id, {
            subagent_id: id,
            delegation_id: child.delegation_id,
            parent_id: child.parent_id,
            goal: child.goal,
            depth: child.depth,
            status: 'interrupted',
            summary: 'Stopped by the user.'
          })
        }

        return { found: Boolean(child), subagent_id: id }
      }

      case 'subagent.tail': {
        const id = String(params.subagent_id ?? '')
        const child = state.liveSubagents.get(id)

        if (!child) {
          return { subagent_id: id, available: false, text: '', truncated: false }
        }

        return {
          subagent_id: id,
          available: true,
          text: [
            `> ${child.goal}`,
            `· ${child.last_tool ?? 'thinking'}`,
            `· ${child.tool_count} tool call${child.tool_count === 1 ? '' : 's'} so far`
          ].join('\n'),
          truncated: false
        }
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
      /*
       * The session's working directory, which a real gateway reports here and
       * this server did not report at all.
       *
       * It is what makes the upload route above reachable. A client cannot
       * invent this path — `@file:` is expanded with `allowed_root` set to the
       * session's own cwd, so a file has to be uploaded INTO it — and Hermie
       * refuses to upload rather than guess when the resume carries no `cwd`.
       * Omitting it therefore meant `POST /api/files/upload-stream`, the 100 MB
       * cap, the absolute-path rule and the "I received N bytes" reply below
       * were all written against a path no run could ever take: every attach
       * stopped at "No workspace to upload into" before a request was made.
       *
       * Absolute on purpose. With no locked managed-files root a relative path
       * earns a 400, and that is the rule the upload route reproduces.
       */
      cwd: `/root/projects/${session.profile}`,
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
    // The scope, exactly as `_profile_scoped_rpc` resolves it: the `profile`
    // param when there is one, the launch profile otherwise. Nothing outside it
    // exists for the rest of this call — not to list, not to find, not to touch.
    const requested = typeof params.profile === 'string' ? params.profile.trim() : ''
    const scope = requested || state.cronLaunchProfile
    const inScope = () => state.cronJobs.filter(entry => entry.profile === scope)
    const listed = () => inScope().map(formatCronJob)
    // `scoped` proves the profile was honoured; the real handler adds it only
    // when one was passed, and clients key an older-gateway fallback off that.
    const scopedEcho = requested ? { scoped: requested } : {}

    if (action === 'list') {
      return {
        success: true,
        jobs: listed(),
        count: inScope().length,
        ...scopedEcho,
        gateway_running: state.cronGatewayRunning
      }
    }

    if (action === 'add') {
      const job = addCronJob({
        name,
        schedule: params.schedule,
        prompt: params.prompt,
        deliver: params.deliver,
        repeat: params.repeat,
        profile: scope
      })

      return {
        success: true,
        job: formatCronJob(job),
        job_id: job.id,
        jobs: listed(),
        ...scopedEcho,
        next_run_at: job.next_run_at,
        gateway_running: state.cronGatewayRunning
      }
    }

    const job = inScope().find(entry => entry.name === name || entry.id === name)

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
        ...scopedEcho,
        gateway_running: state.cronGatewayRunning
      }
    }

    setCronPaused(job, action === 'pause')
    publish('cron.changed', undefined, {})

    return {
      success: true,
      job: formatCronJob(job),
      jobs: listed(),
      ...scopedEcho,
      gateway_running: state.cronGatewayRunning
    }
  }

  /**
   * Every `@file:` reference in a prompt whose file was actually uploaded.
   *
   * The wrappers are the ones `agent/context_references.py` strips: backticks
   * around a path with a space in it. A reference to a path nothing uploaded is
   * ignored rather than answered for, which is what makes "the upload failed and
   * the prompt went anyway" visible as a reply that mentions nothing.
   */
  function referencedUploads(prompt: string): { path: string; filename: string; bytes: number }[] {
    const found: { path: string; filename: string; bytes: number }[] = []

    for (const match of prompt.matchAll(/@file:(?:`([^`]+)`|(\S+))/g)) {
      const entry = state.uploadedFiles.get(match[1] ?? match[2] ?? '')

      if (entry) {
        found.push({ path: entry.path, filename: entry.filename, bytes: entry.bytes })
      }
    }

    return found
  }

  /**
   * Answer one prompt.
   *
   * Three keywords steer it, because those are the three paths a client has to
   * be able to survive: a prompt containing "approve" raises a server→client
   * approval and parks the turn until it is answered, "delegate" fans out
   * subagent events, and anything else streams a reply with one tool call.
   *
   * A prompt that references an uploaded file gets that named back in the reply.
   * Not decoration: it is the only way an end-to-end test can tell a file that
   * reached the agent from one that was uploaded and then never mentioned,
   * which is the whole failure mode the reference text exists to prevent.
   */
  function streamReply(session: FakeSession, prompt: string): void {
    const reply =
      scenario.replies?.find(entry => !entry.match || prompt.includes(entry.match)) ??
      DEFAULT_SCENARIO.replies?.[0] ??
      {}
    const uploads = referencedUploads(prompt)
    const received = uploads.map(file => `I received ${file.filename} (${file.bytes} bytes) at ${file.path}.`)
    const deltas = [...received, ...(reply.deltas ?? ['Working on it.'])]
    const text = received.length ? deltas.join('') : (reply.text ?? deltas.join(''))
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

    // Reasoning before words. The client's reducer creates its assistant item on the
    // first frame of EITHER kind, so this ordering is what decides whether the
    // transcript's typing bubble is replaced before or after any text exists.
    for (const chunk of reply.reasoning ?? []) {
      at += streamDelayMs
      later(() => publish('reasoning.delta', sid, { text: chunk }), at)
    }

    if (reply.reasoningAvailable) {
      at += streamDelayMs
      later(() => publish('reasoning.available', sid, { text: reply.reasoningAvailable }), at)
    }

    // Where the tool call goes. Past the end means "after everything", which is
    // what a scenario without `toolAfterDeltas` asks for.
    const cut = reply.toolAfterDeltas ?? deltas.length

    const emitDeltas = (from: number, to: number) => {
      for (const delta of deltas.slice(from, to)) {
        at += streamDelayMs
        later(() => publish('message.delta', sid, { text: delta }), at)
      }
    }

    emitDeltas(0, cut)

    if (reply.tool) {
      const toolId = `tool-${randomUUID().slice(0, 8)}`

      if (reply.toolGenerating) {
        at += streamDelayMs
        later(() => publish('tool.generating', sid, { name: reply.tool?.name }), at)
      }

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

    emitDeltas(cut, deltas.length)

    if (/delegate/i.test(prompt)) {
      at = streamSubagents(sid, at)
    }

    if (/\bdm\b/i.test(prompt)) {
      at = streamBotDm(session, prompt, at)
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

  /**
   * One `delegate_task` fan-out, start to finish.
   *
   * Three children rather than one, staggered over `subagentStepMs` per frame,
   * and the third one FAILS. All three properties are load-bearing for what a
   * client has to get right: a tree with siblings, a window in which the bar,
   * the sheet, Steer and Stop actually exist, and a failure that has to reach
   * the group card without taking the other two down with it.
   *
   * The fan-out is wrapped in a real `delegate_task` tool call, because that is
   * how the group card learns its goals before any child has reported and how
   * it gets a completion summary at the end.
   */
  function streamSubagents(sid: string, startAt: number): number {
    const delegationId = `del-${randomUUID().slice(0, 6)}`
    const toolId = `tool-${randomUUID().slice(0, 8)}`
    const children = [
      {
        goal: 'Audit the dependencies',
        thinking: 'Reading the lockfile.',
        tool: { tool_name: 'read_file', text: 'package-lock.json' },
        progress: 'Two packages behind.',
        status: 'completed',
        summary: 'Two packages behind; no advisories.'
      },
      {
        goal: 'Summarize the changelog',
        thinking: 'Skimming the last three releases.',
        tool: { tool_name: 'read_file', text: 'CHANGELOG.md' },
        progress: 'Nine entries since the last tag.',
        status: 'completed',
        summary: 'Nine entries since the last tag; two are breaking.'
      },
      {
        goal: 'Check the licence headers',
        thinking: 'Walking src/.',
        tool: { tool_name: 'run_command', text: 'rg -l "SPDX"' },
        progress: 'The scanner is not installed here.',
        status: 'failed',
        summary: 'Could not run the scanner: rg is not installed.'
      }
    ]

    const tasks = children.map(child => ({ goal: child.goal }))
    let at = startAt + subagentStepMs

    later(
      () =>
        publish('tool.start', sid, {
          tool_id: toolId,
          name: 'delegate_task',
          context: `delegate_task(${children.length} tasks)`,
          args: { tasks }
        }),
      at
    )

    children.forEach((child, index) => {
      const subagentId = `sub-${randomUUID().slice(0, 6)}`
      const common = {
        subagent_id: subagentId,
        delegation_id: delegationId,
        parent_id: null,
        goal: child.goal,
        task_index: index,
        task_count: children.length,
        depth: 1,
        model: 'example-provider/example-model',
        child_session_id: `child-${subagentId}`
      }

      const frames: [string, Record<string, unknown>][] = [
        ['subagent.spawn_requested', {}],
        ['subagent.start', { status: 'running' }],
        ['subagent.thinking', { text: child.thinking }],
        ['subagent.tool', { ...child.tool, status: 'running' }],
        ['subagent.progress', { text: child.progress }],
        [
          'subagent.complete',
          {
            status: child.status,
            summary: child.summary,
            duration_seconds: (FRAMES_PER_CHILD + index) * (subagentStepMs / 1000),
            ...(child.status === 'failed' ? { error: child.summary } : {})
          }
        ]
      ]

      // Children are staggered: the second starts a step after the first, so
      // the bar counts up rather than jumping from nothing to three.
      frames.forEach(([type, payload], frame) => {
        const when = at + (frame + 1 + index) * subagentStepMs

        later(() => {
          if (type === 'subagent.start' || type === 'subagent.spawn_requested') {
            state.liveSubagents.set(subagentId, {
              subagent_id: subagentId,
              parent_id: null,
              depth: 1,
              goal: child.goal,
              delegation_id: delegationId,
              model: 'example-provider/example-model',
              started_at: nowSeconds(),
              status: type === 'subagent.start' ? 'running' : 'queued',
              tool_count: 0,
              last_tool: null,
              accepting_steer: true,
              child_session_id: `child-${subagentId}`,
              owner_session_id: sid
            })
            ensureChildSession(`child-${subagentId}`, child.goal, child.summary)
          }

          const live = state.liveSubagents.get(subagentId)

          if (live && type === 'subagent.tool') {
            live.tool_count += 1
            live.last_tool = String(child.tool.tool_name)
          }

          if (type === 'subagent.complete') {
            // A real gateway drops a finished child from the live registry.
            state.liveSubagents.delete(subagentId)
          }

          publish(type, sid, { ...common, ...payload })
        }, when)
      })
    })

    // One step past the last child's completion, so the card's summary lands
    // after every row it summarizes.
    at += (FRAMES_PER_CHILD + children.length) * subagentStepMs

    later(
      () =>
        publish('tool.complete', sid, {
          tool_id: toolId,
          name: 'delegate_task',
          args: { tasks },
          duration_s: ((FRAMES_PER_CHILD + children.length) * subagentStepMs) / 1000,
          error: true,
          summary: `${children.length - 1} of ${children.length} finished; the licence check failed.`
        }),
      at
    )

    return at
  }

  /**
   * One live `message_agent` hand-off, end to end.
   *
   * Fire-and-forget on purpose, because that is what the real tool is: the call
   * answers `queued` with a `process_id` and the teammate's reply lands much
   * later as a `process_complete` ROW, joined back onto the dispatch by that id.
   * While the delivery is out, a `bot_mode_dm.py --run-delivery` process sits in
   * `agents.list` — which is the only place a client can count deliveries that
   * are in flight.
   *
   * The recipient's own chat gets the inbound row too, so both sides of the
   * conversation are real and the Activity timeline has something to dedupe.
   */
  function streamBotDm(session: FakeSession, prompt: string, startAt: number): number {
    const target = session.profile === 'writer' ? 'researcher' : 'writer'
    const recipient = [...state.sessions.values()].find(entry => entry.profile === target && entry.title === 'Bot Chat')
    const message = prompt.replace(/^.*?\bdm\b[:\s]*/iu, '').trim() || 'Can you take a look at this?'
    const toolId = `tool-${randomUUID().slice(0, 8)}`
    const processId = `proc-${randomUUID().slice(0, 6)}`
    const sid = session.storedId
    const senderName = session.profile[0]?.toUpperCase() + session.profile.slice(1)
    const command = DM_DELIVERY_COMMAND.replace('-p writer', `-p ${target}`)
    let at = startAt + streamDelayMs

    later(
      () =>
        publish('tool.start', sid, {
          tool_id: toolId,
          name: 'message_agent',
          context: `message_agent(${target})`,
          args: { target: `@${target}`, message }
        }),
      at
    )

    at += streamDelayMs
    later(() => {
      publish('tool.complete', sid, {
        tool_id: toolId,
        name: 'message_agent',
        args: { target: `@${target}`, message },
        duration_s: 0.1,
        result: { status: 'queued', delivery_id: `dlv-${processId}`, to: target, process_id: processId }
      })

      state.agentProcesses.set(processId, {
        session_id: sid,
        command,
        status: 'running',
        startedAt: nowSeconds()
      })
    }, at)

    // The recipient's side: an inbound row, and its reply.
    const reply = `Got it — ${message.slice(0, 48)}${message.length > 48 ? '…' : ''} is in hand.`

    at += subagentStepMs
    later(() => {
      if (recipient) {
        recipient.messages.push({
          role: 'user',
          text: `Message from 🤖 ${senderName} (@${session.profile}): ${message}`,
          row_id: recipient.messages.length + 1,
          timestamp: nowSeconds()
        })
        recipient.messages.push({
          role: 'assistant',
          text: reply,
          row_id: recipient.messages.length + 1,
          timestamp: nowSeconds()
        })
      }

      publish('sessions.changed', undefined, {})
    }, at)

    // …and the sender's side: the background process reporting back.
    at += subagentStepMs
    later(() => {
      state.agentProcesses.delete(processId)
      session.messages.push({
        role: 'user',
        text: [
          `[IMPORTANT: Background process ${processId} completed (exit code 0).`,
          `Command: ${command}`,
          'Output:',
          `Message from 🤖 ${target[0]?.toUpperCase()}${target.slice(1)} (@${target}): ${reply}]`
        ].join('\n'),
        row_id: session.messages.length + 1,
        timestamp: nowSeconds(),
        display_kind: 'process_complete',
        display_metadata: { display_text: 'Background Process Finished: bot_mode_dm.py' }
      })

      publish('sessions.changed', undefined, {})
    }, at)

    return at
  }

  /**
   * A stand-in transcript for a delegated child, so "Open transcript" has
   * something real to read through `session.history`.
   */
  function ensureChildSession(id: string, goal: string, summary: string): void {
    if (state.sessions.has(id)) {
      return
    }

    state.sessions.set(id, {
      id,
      storedId: id,
      profile: 'subagent',
      title: goal,
      seq: 0,
      ring: [],
      messages: [
        { role: 'user', text: goal, row_id: 1, timestamp: nowSeconds() },
        {
          role: 'tool',
          name: 'read_file',
          tool_id: `${id}-call-1`,
          context: 'read_file(package-lock.json)',
          args: { path: 'package-lock.json' }
        },
        { role: 'assistant', text: summary, row_id: 2, timestamp: nowSeconds() + 1 }
      ]
    })
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
    const runtimeId = resolveRuntimeId(sessionId)

    state.openServerRequests.set(id, { session_id: runtimeId, method, params })

    return new Promise<unknown>((resolve, reject) => {
      pendingServerRequests.set(id, { resolve, reject })

      for (const socket of sockets) {
        send(socket, { jsonrpc: '2.0', id, method, params: { session_id: runtimeId, ...params } })
      }
    }).finally(() => {
      state.openServerRequests.delete(id)
    })
  }

  /** Push one server→client request and resolve with whatever the client answers. */
  function requestServerSide(method: string, params: Record<string, unknown>): Promise<unknown> {
    const sessionId = typeof params.session_id === 'string' ? params.session_id : ''
    const { session_id: _ignored, ...rest } = params

    return sendServerRequest(method, sessionId, rest)
  }

  /** `server_requests.Request.snapshot()`: what a resume re-delivers. */
  function openRequestsFor(sessionId: string): { id: string; method: string; params: Record<string, unknown> }[] {
    const runtimeId = resolveRuntimeId(sessionId)

    return [...state.openServerRequests.entries()]
      .filter(([, entry]) => entry.session_id === runtimeId)
      .map(([id, entry]) => ({ id, method: entry.method, params: { session_id: runtimeId, ...entry.params } }))
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
      return requestServerSide('approval', params)
    },
    requestServerSide,
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
