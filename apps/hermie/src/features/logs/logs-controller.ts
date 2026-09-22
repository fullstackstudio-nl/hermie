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
 *
 * **What `{file, lines}` is, and is not.** That shape is written down in this
 * repo as prose citing upstream; nothing here has ever been compared with a
 * real `hermes serve`, and the owner's gateway shows an empty page. The
 * neighbouring route is the precedent: `GET /api/cron/jobs` answers a BARE
 * ARRAY on a real gateway while the fake answered `{jobs: [...]}`, and the
 * crons list was empty for two releases because the app and the fake agreed
 * with each other and neither had been asked. So `linesOf` takes the envelope,
 * the bare array, and a blob of text, and anything it does not recognise is a
 * LOUD failure (`LogsShapeError`) rather than a quiet empty page.
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
 * The route answered, and the answer was not a log page.
 *
 * This exists because its absence is what made the page look empty on a real
 * gateway. The reader used to be one line — `Array.isArray(body?.lines) ?
 * body.lines : []` — so EVERY shape it did not recognise became a page of zero
 * lines with no error, no notice, and a Follow that went on polling. "This log
 * is empty" is a claim about the gateway's disk; it must not be what a client
 * says when it failed to understand the reply.
 *
 * It carries what actually came back, because that sentence is the only thing
 * that makes the failure reportable from a phone: a reader can read it out, and
 * `linesOf` below can then be taught the shape.
 */
export class LogsShapeError extends Error {
  constructor(readonly saw: string) {
    super(`The gateway answered ${saw}, which is not a log page.`)
    this.name = 'LogsShapeError'
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

/**
 * The keys an envelope may carry its lines under.
 *
 * `lines` is what `get_logs` is documented to answer. The others are here
 * because the route next door in the same upstream package taught this repo the
 * lesson the hard way: `GET /api/cron/jobs` answers a BARE ARRAY on a real
 * gateway while the fake answered `{jobs: [...]}`, and the crons list was empty
 * for two releases because every test drove the fake and the fake agreed with
 * the app. A reader that accepts one spelling is a reader that reports a
 * disagreement as an empty file.
 */
const LINE_KEYS = ['lines', 'logs', 'entries'] as const

/** The fields a line carries its text in, when a line is an object rather than a string. */
const TEXT_KEYS = ['text', 'line', 'message', 'msg'] as const

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** What came back, in few enough words to put on a phone screen. */
const describe = (body: unknown): string => {
  if (body === undefined || body === null) {
    return 'nothing'
  }

  if (Array.isArray(body)) {
    return 'a list of something other than log lines'
  }

  if (isRecord(body)) {
    const keys = Object.keys(body)

    return keys.length ? `an object with ${keys.slice(0, 6).join(', ')}` : 'an empty object'
  }

  return `a ${typeof body}`
}

/** One line's text, whether the gateway wrote a string or an object. */
const textOf = (line: unknown): string | null => {
  if (typeof line === 'string') {
    return line
  }

  if (typeof line === 'number' || typeof line === 'boolean') {
    return String(line)
  }

  if (isRecord(line)) {
    for (const key of TEXT_KEYS) {
      const value = line[key]

      if (typeof value === 'string') {
        // A structured line puts the level in a field of its own, so rebuild the
        // shape `levelOf` reads rather than losing the colour.
        const level = typeof line.level === 'string' ? line.level.toUpperCase() : null
        const stamp =
          typeof line.time === 'string' ? line.time : typeof line.timestamp === 'string' ? line.timestamp : null

        return [stamp, level, value].filter(part => part !== null && part !== '').join(' ')
      }
    }
  }

  return null
}

/**
 * The lines out of whatever the route answered, or `null` for "not a log page".
 *
 * `null` and `[]` are deliberately different answers. `[]` is a gateway saying
 * the file is empty, which `get_logs` does with a 200 when `log_path.exists()`
 * is false; `null` is this client saying it did not understand, which is a bug
 * report and not a fact about a file.
 *
 * Exported so the shapes it tolerates are pinned by a test rather than by this
 * comment.
 */
export function linesOf(body: unknown): string[] | null {
  const raw = Array.isArray(body) ? body : isRecord(body) ? LINE_KEYS.map(key => body[key]).find(Array.isArray) : null

  if (Array.isArray(raw)) {
    const texts = raw.map(textOf)

    // One unreadable element among readable ones is dropped; a list where NONE
    // of them is readable is a different shape wearing a familiar key.
    return texts.some(text => text !== null) || texts.length === 0
      ? texts.filter((text): text is string => text !== null)
      : null
  }

  // A single blob of text under a familiar key: one log file is, after all, one
  // string with newlines in it.
  if (isRecord(body)) {
    for (const key of LINE_KEYS) {
      const value = body[key]

      if (typeof value === 'string') {
        return value.length ? value.split('\n') : []
      }
    }
  }

  return null
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

    let body: unknown

    try {
      body = await this.http.get<unknown>(logsPath(query))
    } catch (cause) {
      if (isMissingRoute(cause)) {
        throw new LogsUnavailable()
      }

      throw cause
    }

    const lines = linesOf(body)

    if (lines === null) {
      throw new LogsShapeError(describe(body))
    }

    const file = isRecord(body) && typeof body.file === 'string' ? (body.file as LogFile) : query.file

    return {
      file,
      capped: lines.length >= Math.min(wanted, LOG_LINE_CAP),
      lines: lines.map((text, index) => ({
        key: `${index}:${text.slice(0, 64)}`,
        text,
        level: levelOf(text)
      }))
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
