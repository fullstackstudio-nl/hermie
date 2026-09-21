/**
 * `GET /api/sessions/search` — the gateway's full-text search over transcripts.
 *
 * Three facts about that route decide the whole shape of this module, and every
 * one of them is the opposite of what the name suggests. They were read from
 * `hermes_cli/web_routers/sessions.py::search_sessions` at the pin in
 * `packages/hermes-shared/upstream.json`, and the field list was confirmed by
 * running `SessionDB.search_messages` on a scratch database.
 *
 *  1. **It is scoped to ONE profile.** The handler opens
 *     `_open_session_db_for_profile(profile)`, and a profile's sessions live in
 *     its own `state.db` under its own home. There is no "search everything"
 *     call: searching a roster is one request per bot, which is what
 *     `searchBotChats` does.
 *  2. **It answers at most one hit per conversation.** Hits are collapsed onto
 *     the compression lineage root, first hit wins, so a chat with forty
 *     matching messages is one result carrying the best-ranked snippet. A UI
 *     that promises "every message that matches" cannot be built on this.
 *  3. **A hit does not name a message.** The projection upstream asks for is
 *     `(session_id, role, snippet, source, model, session_started)` — no row id
 *     and no message timestamp, although `search_messages` can return both. So
 *     the only thing a tap can open is the CONVERSATION, and finding the row
 *     inside it is the client's own problem.
 *
 * `limit` is clamped to 1…100 server-side; `q` that is blank or whitespace
 * answers `{"results": []}` without touching the database.
 */
import type { RequestOptions } from './http'

/** The server's own clamp on `limit`, mirrored so a caller can stay inside it. */
export const SESSION_SEARCH_LIMIT_CAP = 100

/** What `snippet(messages_fts, -1, '>>>', '<<<', '...', 40)` wraps a match in. */
export const SNIPPET_MATCH_OPEN = '>>>'
export const SNIPPET_MATCH_CLOSE = '<<<'

/** One conversation that matched, as this client reads it. */
export interface SessionSearchHit {
  /** The lineage TIP — the session id that is live today. */
  sessionId: string
  /** The compression root the tip was found from, when the gateway names one. */
  lineageRoot?: string
  /** The gateway's snippet, markers and all. See `snippetSegments`. */
  snippet: string
  role?: string
  title?: string
  /** Seconds since the epoch: `last_active`, else `started_at`, else the hit's own session stamp. */
  at?: number
  messageCount?: number
  archived: boolean
}

export interface SessionSearchOptions {
  query: string
  /** The bot whose `state.db` is searched. Omitted means the serving profile's. */
  profile?: string
  limit?: number
  signal?: AbortSignal
  timeoutMs?: number
}

/** The slice of `GatewayHttp` this module needs; a test hands it one function. */
export interface SessionSearchHttp {
  get<T = unknown>(path: string, options?: RequestOptions): Promise<T>
}

const numberOr = (value: unknown, fallback?: number): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback

const stringOr = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value : undefined)

/**
 * Read one `results` row.
 *
 * A row that names no session is dropped rather than repaired: every caller's
 * next move is to address that session, and a hit nobody can open is a row that
 * does nothing when it is tapped.
 */
export function sessionSearchHitOf(row: unknown): SessionSearchHit | null {
  if (!row || typeof row !== 'object') {
    return null
  }

  const source = row as Record<string, unknown>
  const sessionId = stringOr(source.session_id) ?? stringOr(source.id)

  if (!sessionId) {
    return null
  }

  const at = numberOr(source.last_active) ?? numberOr(source.started_at) ?? numberOr(source.session_started)

  return {
    sessionId,
    ...(stringOr(source.lineage_root) === undefined ? {} : { lineageRoot: stringOr(source.lineage_root) as string }),
    snippet: typeof source.snippet === 'string' ? source.snippet : '',
    ...(stringOr(source.role) === undefined ? {} : { role: stringOr(source.role) as string }),
    ...(stringOr(source.title) === undefined ? {} : { title: stringOr(source.title) as string }),
    ...(at === undefined ? {} : { at }),
    ...(numberOr(source.message_count) === undefined ? {} : { messageCount: numberOr(source.message_count) as number }),
    archived: source.archived === true
  }
}

/** Every readable row of a `{ results: [...] }` body. */
export function parseSessionSearch(body: unknown): SessionSearchHit[] {
  const rows = (body as { results?: unknown })?.results

  if (!Array.isArray(rows)) {
    return []
  }

  const hits: SessionSearchHit[] = []

  for (const row of rows) {
    const hit = sessionSearchHitOf(row)

    if (hit) {
      hits.push(hit)
    }
  }

  return hits
}

/** One search, against one profile. A blank query never leaves the device. */
export async function searchSessions(
  http: SessionSearchHttp,
  options: SessionSearchOptions
): Promise<SessionSearchHit[]> {
  const query = options.query.trim()

  if (!query) {
    return []
  }

  const limit = Math.max(1, Math.min(options.limit ?? 20, SESSION_SEARCH_LIMIT_CAP))
  const params = new URLSearchParams({ q: query, limit: String(limit) })

  if (options.profile) {
    params.set('profile', options.profile)
  }

  const body = await http.get(`/api/sessions/search?${params.toString()}`, {
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs })
  })

  return parseSessionSearch(body)
}

export interface SnippetSegment {
  text: string
  match: boolean
}

/**
 * Split a snippet into plain and matched runs.
 *
 * `>>>` and `<<<` are ordinary characters that a message may legitimately
 * contain — a shell redirect, a diff conflict marker — so an unpaired opener is
 * treated as text rather than as the start of a highlight that runs to the end
 * of the line.
 */
export function snippetSegments(snippet: string): SnippetSegment[] {
  const out: SnippetSegment[] = []
  let rest = snippet
  let plain = ''

  const flush = (): void => {
    if (plain) {
      out.push({ match: false, text: plain })
      plain = ''
    }
  }

  while (rest) {
    const open = rest.indexOf(SNIPPET_MATCH_OPEN)

    if (open < 0) {
      plain += rest
      break
    }

    const close = rest.indexOf(SNIPPET_MATCH_CLOSE, open + SNIPPET_MATCH_OPEN.length)

    if (close < 0) {
      plain += rest
      break
    }

    plain += rest.slice(0, open)
    flush()
    out.push({ match: true, text: rest.slice(open + SNIPPET_MATCH_OPEN.length, close) })
    rest = rest.slice(close + SNIPPET_MATCH_CLOSE.length)
  }

  flush()

  return out
}

/**
 * The snippet as one line of prose.
 *
 * Two cosmetic passes, both there because of what the index holds: the FTS row
 * is the JSON-ENCODED message, so a window into it routinely opens or closes
 * mid-structure (`invoices there."}` was the first snippet the probe produced).
 * Whitespace is collapsed because a snippet can span a fenced code block, and a
 * run of JSON punctuation is trimmed off each END only — never from the middle,
 * where it may be the message's own text.
 */
export function plainSnippet(snippet: string): string {
  const text = snippetSegments(snippet)
    .map(segment => segment.text)
    .join('')
    .replace(/\s+/g, ' ')
    .trim()

  return text.replace(/^[{}[\]",:\\]+\s*/, '').replace(/\s*[{}[\]",:\\]+$/, '')
}
