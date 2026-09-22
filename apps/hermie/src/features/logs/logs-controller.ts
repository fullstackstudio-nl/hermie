/**
 * The gateway-logs page's one round trip.
 *
 * This surface is REST and only REST. There is no socket method for logs
 * anywhere: upstream registers none in `tui_gateway/methods_*.py`, and the two
 * methods whose names look close are about something else — `groups.log` is a
 * hosted room's event log, `subagent.tail` is a child's transcript. What exists
 * is `GET /api/logs` in `hermes_cli/web_routers/status.py`, which answers
 * `{file, lines}` and hangs up.
 *
 * So there is no stream and no follow. "Following" on this page is a POLL, and
 * it is named that way in the copy rather than dressed up as a tail, because a
 * page that claimed to be live would be claiming something about the gateway
 * that is not true.
 *
 * `process.list` is a different thing and deliberately not folded in here: its
 * `output_tail` is one background process's stdout, scoped to the session that
 * spawned it, and calling that "the gateway's logs" would put a chat's shell
 * command under a heading about the server.
 */

/** The slice of the gateway's HTTP half this page needs. Injected so a test can watch it. */
export interface LogsHttp {
  get<T>(path: string): Promise<T>
}

/**
 * The six files `hermes_cli/logs.py::LOG_FILES` maps, in its own order.
 *
 * The keys are the API's, not ours — `file=` is looked up in that dict and an
 * unknown name is a 400 — so this list is a mirror of upstream and a name
 * invented here would simply fail.
 */
export const LOG_FILES = ['agent', 'errors', 'gateway', 'gui', 'desktop', 'mcp'] as const

export type LogFile = (typeof LOG_FILES)[number]

/** `hermes_logging._LEVEL_ORDER`, lowest first. The filter is a MINIMUM, not an equality. */
export const LOG_LEVELS = ['DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL'] as const

export type LogLevel = (typeof LOG_LEVELS)[number]

/**
 * `hermes_logging.COMPONENT_PREFIXES`' keys.
 *
 * The route validates against that dict and answers 400 for anything else, so
 * offering a component the gateway does not know would be offering a refusal.
 */
export const LOG_COMPONENTS = ['gateway', 'agent', 'tools', 'cli', 'cron', 'gui'] as const

export type LogComponent = (typeof LOG_COMPONENTS)[number]

/**
 * The route's own ceiling.
 *
 * `min(lines, 500)` is applied twice in `get_logs` — once before the filters
 * and once after the search — so asking for more is not refused, it is just
 * silently not honoured. The page asks for exactly this and says when it got a
 * full page back, rather than implying there is no more.
 */
export const LOG_LINE_CAP = 500

/** How often "Following" re-asks. Slow on purpose: every tick re-reads a file on the host. */
export const LOG_POLL_INTERVAL_MS = 3_000

export interface LogQuery {
  file: LogFile
  /** A MINIMUM level. `null` is the route's "ALL". */
  level?: LogLevel | null
  component?: LogComponent | null
  search?: string | null
  lines?: number
}

/** One parsed line: the level it declares, and the text as the gateway wrote it. */
export interface LogLine {
  /** Stable within one answer, for a list key. The gateway sends no line ids. */
  key: string
  text: string
  /** `null` for a continuation line — a traceback's body carries no level of its own. */
  level: LogLevel | null
}

export interface LogPage {
  file: LogFile
  lines: LogLine[]
  /** The answer filled the route's cap, so there is very likely more above it. */
  capped: boolean
}

/** Raised when the gateway has no `/api/logs` at all, so the page can offer the command. */
export class LogsUnavailable extends Error {
  constructor() {
    super('This gateway does not serve its logs over the API.')
    this.name = 'LogsUnavailable'
  }
}

/**
 * `LEVEL` as the formatter writes it: after the timestamp, before the logger.
 *
 * Deliberately the same shape as `hermes_cli/logs.py::_LEVEL_RE` — surrounded
 * by whitespace — so a line whose MESSAGE contains the word `ERROR` is not
 * coloured as an error. A line with no match is a continuation (a traceback
 * body, a wrapped message) and keeps the level `null` rather than being
 * guessed at.
 */
const LEVEL_RE = /\s(DEBUG|INFO|WARNING|ERROR|CRITICAL)\s/u

/** Exported for its own test: the level a line declares, or `null`. */
export const levelOf = (line: string): LogLevel | null => {
  const found = LEVEL_RE.exec(line)

  return found ? (found[1] as LogLevel) : null
}

/**
 * Build the query string the route parses.
 *
 * Exported because the parameter vocabulary is upstream's and every one of
 * these choices is a refusal waiting to happen:
 *
 *  - an absent `level`/`component` is OMITTED rather than sent as `all`. Both
 *    spellings work, but `get_logs` treats an unknown component as a 400 and
 *    the fewer names this app has to keep in step with upstream, the better.
 *  - `search` is sent raw and encoded. It is a case-insensitive substring on
 *    the far side, never a pattern, so nothing is escaped for it here.
 */
export const logsPath = (query: LogQuery): string => {
  const params = new URLSearchParams({
    file: query.file,
    lines: String(query.lines ?? LOG_LINE_CAP)
  })

  if (query.level) {
    params.set('level', query.level)
  }

  if (query.component) {
    params.set('component', query.component)
  }

  if (query.search?.trim()) {
    params.set('search', query.search.trim())
  }

  return `/api/logs?${params.toString()}`
}

export class LogsController {
  constructor(private readonly http: LogsHttp) {}

  /**
   * One page of one log file.
   *
   * A gateway that has never written the file answers `{file, lines: []}` with
   * a 200 — `get_logs` checks `log_path.exists()` first — so an empty list is
   * an ordinary answer and never an error. A gateway with no such ROUTE answers
   * 404, and that is the one the page has to handle differently, because the
   * remedy is a shell command rather than a retry.
   */
  async read(query: LogQuery): Promise<LogPage> {
    const wanted = query.lines ?? LOG_LINE_CAP

    let body: { file?: string; lines?: unknown }

    try {
      body = await this.http.get<{ file?: string; lines?: unknown }>(logsPath(query))
    } catch (cause) {
      if (isMissingRoute(cause)) {
        throw new LogsUnavailable()
      }

      throw cause
    }

    const lines = Array.isArray(body?.lines) ? body.lines : []

    return {
      file: (body?.file as LogFile) ?? query.file,
      capped: lines.length >= Math.min(wanted, LOG_LINE_CAP),
      lines: lines.map((line, index) => {
        const text = typeof line === 'string' ? line : String(line)

        return { key: `${index}:${text.slice(0, 64)}`, text, level: levelOf(text) }
      })
    }
  }
}

/**
 * Is this the gateway saying it has no such route?
 *
 * A 404 is the honest signal and a 405 is what a reverse proxy in front of
 * something else answers; both mean the same thing to this page. The status is
 * read off whichever shape the client threw, because `GatewayError` carries one
 * and a bare `fetch` failure does not — and a network error must NOT be read as
 * "no such route", or an offline phone would be told to go and run a command.
 */
const isMissingRoute = (cause: unknown): boolean => {
  const status = (cause as { status?: unknown } | null | undefined)?.status

  return status === 404 || status === 405
}
