/**
 * Every literal the gateway-logs page paints.
 *
 * The two that carry an argument are `tailHint` and `absent`. The first says
 * the page POLLS, because `/api/logs` has no follow and calling a one-second
 * refetch a "live tail" would be a claim about the gateway that is not true.
 * The second is what a gateway without the route gets: the real command, not
 * an empty page and not a scrape.
 */
import { localised } from '../../i18n/catalogue'

const logStringsEn = {
  settings: {
    row: 'Logs',
    hint: 'What the gateway has been writing down'
  },

  title: 'Gateway logs',
  back: 'Settings',

  loading: 'Reading the log…',
  failed: (reason: string) => `Could not read the log: ${reason}`,

  /**
   * The route answered something this app does not recognise.
   *
   * Said out loud, with what came back in it, because the alternative is what
   * this page used to do: draw "This log is empty" over a gateway that had in
   * fact replied. A reader can read this sentence down a phone to whoever runs
   * the gateway, which is the only way the shape gets fixed.
   */
  unexpected: (saw: string) => `The gateway answered ${saw} rather than a log page.`,
  unexpectedHint:
    'The page can read a list of lines, an object carrying one, or one block of text. Check what the gateway serves:',
  unexpectedCommand: 'curl -sS "$GATEWAY/api/logs?file=gateway&lines=5"',

  /** A file that exists as a name but has nothing in it yet. */
  empty: 'This log is empty.',
  /** A filter that matched nothing, which is not the same as an empty file. */
  noMatches: 'No lines match those filters.',

  /**
   * The gateway has no `/api/logs`.
   *
   * Every route on this page is one call, so a 404 is the whole answer: the
   * gateway is older than the route, or its dashboard is not mounted. The page
   * says so and names the command, because the alternative — reading the files
   * off the host some other way — is a scrape, and a scrape of somebody else's
   * machine is not something this app should invent.
   */
  absent: 'This gateway does not serve its logs over the API.',
  absentHint: 'Read them on the machine that runs it:',
  command: 'hermes logs gateway -f',

  file: 'FILE',
  /** The six names `hermes_cli/logs.py::LOG_FILES` maps, in its own order. */
  files: {
    agent: 'Agent',
    errors: 'Errors',
    gateway: 'Gateway',
    gui: 'Dashboard',
    desktop: 'Desktop',
    mcp: 'MCP output'
  },

  level: 'LEVEL',
  levelAll: 'All',

  component: 'COMPONENT',
  componentAll: 'All',

  search: 'Search',
  searchPlaceholder: 'Find in these lines',

  /**
   * Polling, said as polling.
   *
   * `/api/logs` answers a tail and hangs up — there is no follow, no stream and
   * no socket behind it, so this page asks again every few seconds. Pausing
   * stops asking; it does not stop the gateway writing.
   */
  tail: 'Follow',
  tailOn: 'Following',
  tailOff: 'Paused',
  tailHint: 'Follow re-reads the file every few seconds. The gateway offers no live stream, so this is a poll.',

  copy: 'Copy',
  copied: 'Copied.',

  /** `min(lines, 500)` is the route's own ceiling, so the page says when it hit it. */
  truncated: (count: number) => `Showing the last ${count} lines — the API will not serve more.`,
  lineCount: (count: number) => `${count} ${count === 1 ? 'line' : 'lines'}`
}

/*
 * The English table above is the SOURCE, and `localised` is what makes it one
 * language among three: a read resolves against the active locale's catalogue
 * first and falls back to the sentence written here. See `i18n/catalogue.ts`.
 *
 * `logStringsEn` stays un-exported so there is exactly one way into these strings, and
 * so nothing can read past the layer by accident.
 */
export const logStrings = localised('logs', logStringsEn)
