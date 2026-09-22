/**
 * The gateway-logs page's one route, and the places it is not shaped like a tail.
 *
 * `GET /api/logs` is all there is — no socket method, no stream, no follow —
 * and most of these cases are about the difference between "the gateway
 * answered something empty" and "the gateway cannot answer at all", because
 * only one of those is worth sending somebody to a shell over.
 */
import {
  LOG_LINE_CAP,
  LogsController,
  LogsShapeError,
  LogsUnavailable,
  levelOf,
  linesOf,
  logsPath,
  type LogsHttp
} from '../src/features/logs/logs-controller'

/** A `LogsHttp` that records the paths asked for and answers a canned body. */
const http = (answer: unknown | (() => unknown)): LogsHttp & { paths: string[] } => {
  const paths: string[] = []

  return {
    paths,
    get: async <T>(path: string) => {
      paths.push(path)

      return (typeof answer === 'function' ? (answer as () => unknown)() : answer) as T
    }
  }
}

/** What the gateway's HTTP half throws, which is what carries the status. */
const httpStatus = (status: number): LogsHttp => ({
  get: async () => {
    throw Object.assign(new Error(`HTTP ${status}`), { status })
  }
})

describe('levelOf', () => {
  it('reads the level the formatter wrote', () => {
    expect(levelOf('2026-09-22 09:00:00,123 INFO gateway.run: listening')).toBe('INFO')
    expect(levelOf('2026-09-22 09:00:00 ERROR [sess_a] tools.terminal_tool: boom')).toBe('ERROR')
  })

  /**
   * The case a looser pattern gets wrong. `_LEVEL_RE` upstream requires
   * whitespace on both sides, so a MESSAGE that happens to contain the word is
   * not a level — otherwise a line reading "no ERROR was found" would be
   * painted red.
   */
  it('does not mistake the word in a message for the line’s level', () => {
    expect(levelOf('2026-09-22 09:00:00 INFO gateway.run: no ERRORS today')).toBe('INFO')
    expect(levelOf('  File "run.py", line 3, in <module>')).toBeNull()
  })

  /** A traceback's body has no level of its own and must not inherit one. */
  it('calls a continuation line level-less rather than guessing', () => {
    expect(levelOf('Traceback (most recent call last):')).toBeNull()
  })
})

describe('logsPath', () => {
  it('always names a file and a line count', () => {
    expect(logsPath({ file: 'gateway' })).toBe(`/api/logs?file=gateway&lines=${LOG_LINE_CAP}`)
  })

  /**
   * An absent filter is OMITTED rather than sent as `all`. `get_logs` answers
   * 400 for a component it does not know, so the fewer names this app has to
   * keep in step with `COMPONENT_PREFIXES`, the fewer ways it can 400.
   */
  it('leaves an absent level or component out of the query entirely', () => {
    const path = logsPath({ file: 'agent', level: null, component: null })

    expect(path).not.toMatch(/level=/u)
    expect(path).not.toMatch(/component=/u)
  })

  it('sends the filters that were asked for', () => {
    const path = logsPath({ file: 'errors', level: 'WARNING', component: 'cron', search: 'boom' })

    expect(path).toContain('level=WARNING')
    expect(path).toContain('component=cron')
    expect(path).toContain('search=boom')
  })

  it('encodes a search that is not URL-safe', () => {
    expect(logsPath({ file: 'agent', search: 'a b&c' })).toContain('search=a+b%26c')
  })

  /** Whitespace is not a search, and sending it would filter everything out. */
  it('ignores a search that is only whitespace', () => {
    expect(logsPath({ file: 'agent', search: '   ' })).not.toMatch(/search=/u)
  })
})

describe('LogsController.read', () => {
  it('parses each line’s level and keeps the text as the gateway wrote it', async () => {
    const door = http({ file: 'gateway', lines: ['2026-09-22 09:00:00 ERROR gateway.run: boom'] })
    const page = await new LogsController(door).read({ file: 'gateway' })

    expect(page.lines).toHaveLength(1)
    expect(page.lines[0]?.level).toBe('ERROR')
    expect(page.lines[0]?.text).toBe('2026-09-22 09:00:00 ERROR gateway.run: boom')
  })

  /**
   * A file that has never been written answers 200 with an empty list —
   * `get_logs` checks `log_path.exists()` before it reads. That is an ordinary
   * answer, and a controller that treated an empty list as a failure would
   * report a broken gateway for a log nobody has filled yet.
   */
  it('treats an empty log as an answer, not as a failure', async () => {
    const page = await new LogsController(http({ file: 'desktop', lines: [] })).read({ file: 'desktop' })

    expect(page.lines).toEqual([])
    expect(page.capped).toBe(false)
  })

  /**
   * The route clamps to 500 twice over and says nothing about it, so a full
   * page is the only signal that there is more above. The page says "the API
   * will not serve more" rather than implying this is the whole file.
   */
  it('notices when the answer filled the route’s own ceiling', async () => {
    const full = Array.from({ length: LOG_LINE_CAP }, (_, index) => `line ${index}`)
    const page = await new LogsController(http({ file: 'agent', lines: full })).read({ file: 'agent' })

    expect(page.capped).toBe(true)
  })

  /**
   * The one failure with a different remedy. A gateway older than the route, or
   * one with no dashboard mounted, cannot be retried into working — so it is
   * its own error type and the page offers the command.
   */
  it('turns a missing route into the error that offers the command', async () => {
    await expect(new LogsController(httpStatus(404)).read({ file: 'gateway' })).rejects.toBeInstanceOf(LogsUnavailable)
    await expect(new LogsController(httpStatus(405)).read({ file: 'gateway' })).rejects.toBeInstanceOf(LogsUnavailable)
  })

  /**
   * And the failure that must NOT be read that way. An offline phone, a 500, a
   * refused connection — telling that reader the gateway has no log route
   * would send them to a shell to fix something that is not broken.
   */
  it('lets an ordinary failure through as itself', async () => {
    await expect(new LogsController(httpStatus(500)).read({ file: 'gateway' })).rejects.not.toBeInstanceOf(
      LogsUnavailable
    )

    const offline: LogsHttp = {
      get: async () => {
        throw new TypeError('Network request failed')
      }
    }

    await expect(new LogsController(offline).read({ file: 'gateway' })).rejects.toThrow('Network request failed')
  })

  /**
   * The bug the Logs page shipped with, inverted.
   *
   * The reader used to answer `[]` to every shape it did not recognise, so a
   * gateway that replied with something else was reported as an empty file and
   * Follow went on polling it. An unrecognised body is now LOUD, and it says
   * what came back so the reader can pass it on.
   */
  it('refuses a body that is not a log page rather than calling the file empty', async () => {
    await expect(new LogsController(http({ file: 'agent' })).read({ file: 'agent' })).rejects.toBeInstanceOf(
      LogsShapeError
    )
    // The message names what came back, which is the only part of this a reader
    // can pass on to whoever runs the gateway.
    await expect(new LogsController(http({ ok: true })).read({ file: 'agent' })).rejects.toThrow(/ok/u)
    await expect(new LogsController(http(42)).read({ file: 'agent' })).rejects.toBeInstanceOf(LogsShapeError)
    await expect(new LogsController(http(undefined)).read({ file: 'agent' })).rejects.toBeInstanceOf(LogsShapeError)
  })

  it('asks the route for the filters it was given', async () => {
    const door = http({ file: 'errors', lines: [] })

    await new LogsController(door).read({ file: 'errors', level: 'ERROR', component: 'gateway', search: 'x' })

    expect(door.paths[0]).toContain('file=errors')
    expect(door.paths[0]).toContain('level=ERROR')
    expect(door.paths[0]).toContain('component=gateway')
    expect(door.paths[0]).toContain('search=x')
  })

  /** Two identical lines are two rows, so the key cannot be the text alone. */
  it('keys repeated lines apart', async () => {
    const page = await new LogsController(http({ file: 'agent', lines: ['same', 'same'] })).read({ file: 'agent' })

    expect(page.lines[0]?.key).not.toBe(page.lines[1]?.key)
  })
})

/**
 * Which bodies count as a log page.
 *
 * This block exists because of a failure one route over. `GET /api/cron/jobs`
 * answers a BARE ARRAY on a real gateway while the fake answered
 * `{jobs: [...]}`, and the crons list was empty for two releases — every test
 * drove the fake, the fake agreed with the app, and neither had been compared
 * with a real `hermes serve`. `/api/logs` is in the same upstream package, is
 * written down in this repo only as prose, and had exactly the same
 * single-spelling reader. So the shapes are pinned here rather than assumed.
 *
 * The case that matters is the last one: `null` and `[]` are different answers.
 * `[]` is a gateway saying the file is empty; `null` is this client saying it
 * did not understand, and only one of those may reach a reader as "This log is
 * empty".
 */
describe('linesOf takes every shape a tail can arrive in', () => {
  it('takes the documented envelope', () => {
    expect(linesOf({ file: 'gateway', lines: ['one', 'two'] })).toEqual(['one', 'two'])
  })

  it('takes a bare array, which is how the neighbouring route actually answers', () => {
    expect(linesOf(['one', 'two'])).toEqual(['one', 'two'])
  })

  it('takes the other two spellings of the same envelope', () => {
    expect(linesOf({ logs: ['one'] })).toEqual(['one'])
    expect(linesOf({ entries: ['one'] })).toEqual(['one'])
  })

  it('takes one block of text, because a log file is one string with newlines', () => {
    expect(linesOf({ lines: 'one\ntwo' })).toEqual(['one', 'two'])
    expect(linesOf({ lines: '' })).toEqual([])
  })

  it('takes structured lines and rebuilds the text the level reader wants', () => {
    expect(linesOf({ lines: [{ time: '2026-09-22 09:00:00', level: 'error', message: 'boom' }] })).toEqual([
      '2026-09-22 09:00:00 ERROR boom'
    ])
    expect(linesOf({ lines: [{ text: 'plain' }] })).toEqual(['plain'])
  })

  it('keeps an empty list as an empty file rather than as a failure', () => {
    expect(linesOf({ file: 'errors', lines: [] })).toEqual([])
    expect(linesOf([])).toEqual([])
  })

  it('answers null — not an empty page — for anything else', () => {
    expect(linesOf({ ok: true })).toBeNull()
    expect(linesOf({ lines: 42 })).toBeNull()
    expect(linesOf({ lines: [{ id: 1 }, { id: 2 }] })).toBeNull()
    expect(linesOf(undefined)).toBeNull()
    expect(linesOf(null)).toBeNull()
    expect(linesOf('a plain string')).toBeNull()
  })
})

describe('a page built from a shape other than the documented one', () => {
  it('reads the levels off a bare array exactly as off the envelope', async () => {
    const page = await new LogsController(
      http(['2026-09-22 09:00:00 ERROR gateway.run: boom', 'Traceback (most recent call last):'])
    ).read({ file: 'gateway' })

    expect(page.lines.map(line => line.level)).toEqual(['ERROR', null])
    // No `file` field in a bare array, so the page keeps the one it asked about.
    expect(page.file).toBe('gateway')
  })
})
