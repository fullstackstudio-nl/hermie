/**
 * The round trips behind the memory browser.
 *
 * A plain class taking a store shape rather than a hook, the way
 * `cron-controller.ts` is, so the whole feature is drivable from a test with a
 * hand-written `http` and no React at all.
 *
 * ## Every route names its profile, and that is not optional
 *
 * A plugin handler is handed no profile and otherwise runs under whichever home
 * the dashboard process started with — which on a gateway serving several bots
 * is somebody else's memory. The plugin makes `profile` required on all four
 * routes and refuses a name that carries a separator, a parent reference or
 * surrounding space rather than cleaning it. This side simply always sends it.
 *
 * ## Why a write is followed by a re-read
 *
 * The write answers the STORE's own result dict — `{"success": true}` and
 * little else — and the thing the screen needs afterwards is not in it: the
 * positional ids have all shifted, and the usage count has changed by the
 * delimiter as well as by the text. Rebuilding the listing from the answer
 * would mean this file holding a second opinion about how full a file is. So
 * every successful write refetches, and the refetch is the source of truth.
 *
 * ## What each status means here
 *
 * | Status | What the gateway is saying                                  |
 * | ------ | ----------------------------------------------------------- |
 * | 404    | no such route — the plugin is absent or too old              |
 * | 403    | the route exists and this profile has it switched off        |
 * | 400    | the profile name was refused, or a search had no query       |
 *
 * `GatewayHttp` folds 401 and 403 together into an `auth` error, so 403 is told
 * apart by its status rather than by its kind. A real 401 has already been
 * through the credential provider's one retry by the time it arrives here.
 */
import { type GatewayHttp, isGatewayError } from '@hermie/gateway-client'

import type { MemoryState } from '../../store/memory'
import {
  type MemoryEntry,
  memoryListingOf,
  memorySearchOf,
  type MemoryTarget,
  type MemoryWriteAnswer,
  memoryWriteOf
} from './model'
import { memoryStrings } from './strings'

/** The plugin mounts at its own name; the four routes hang off this. */
export const MEMORY_ROUTE = '/api/plugins/hermie/memory'

type StoreApi<T> = { getState: () => T; setState: (partial: Partial<T>) => void }

export interface MemoryControllerOptions {
  /** Null on a connection that has not come up; every call then refuses early. */
  http: GatewayHttp | null
  store: StoreApi<MemoryState>
  /** The bot whose memory this is. */
  profile: string
  /** The advert offers browsing and not editing. */
  readOnly?: boolean
}

/** A write, named the way the plugin names it. */
export type MemoryOp = 'add' | 'replace' | 'remove'

/**
 * The route said no, in a sentence a page can show.
 *
 * `status` is kept because the page draws three different things for the three
 * refusals — an install panel, a switched-off line, and an ordinary error.
 */
export class MemoryRouteError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message)
    this.name = 'MemoryRouteError'
  }
}

export class MemoryController {
  private readonly http: GatewayHttp | null
  private readonly store: StoreApi<MemoryState>
  readonly profile: string
  readonly readOnly: boolean
  /** Bumped on every fetch; a late answer to an older one is dropped. */
  private generation = 0
  private stopped = false

  constructor(options: MemoryControllerOptions) {
    this.http = options.http
    this.store = options.store
    this.profile = options.profile
    this.readOnly = options.readOnly === true
  }

  start(): void {
    this.store.getState().open(this.profile, this.readOnly)
    void this.refresh()
  }

  stop(): void {
    this.stopped = true
    this.generation += 1
    this.store.getState().reset()
  }

  /** `GET …/memory/list`. The one call that produces the page. */
  async refresh(): Promise<void> {
    const mine = ++this.generation

    this.store.setState({ loading: true })

    try {
      const body = await this.get(`${MEMORY_ROUTE}/list?profile=${encodeURIComponent(this.profile)}`)

      if (this.current(mine)) {
        this.store.getState().setListing(memoryListingOf(body))
      }
    } catch (failure) {
      if (this.current(mine)) {
        this.store.getState().setError(asRouteError(failure).message)
      }
    }
  }

  /**
   * `GET …/memory/search?q=…`, across both targets.
   *
   * An empty query is not sent: the route refuses it with a 400, and an error
   * banner for "you have not typed anything yet" is noise. Clearing the field
   * drops the results, which the store does on `setQuery`.
   */
  async search(query: string): Promise<void> {
    const state = this.store.getState()

    state.setQuery(query)

    if (!query.trim()) {
      return
    }

    const mine = ++this.generation

    state.setSearching(true)

    try {
      const body = await this.get(
        `${MEMORY_ROUTE}/search?profile=${encodeURIComponent(this.profile)}&q=${encodeURIComponent(query)}`
      )

      if (this.current(mine)) {
        this.store.getState().setResults(memorySearchOf(body).results)
      }
    } catch (failure) {
      if (this.current(mine)) {
        this.store.getState().setSearching(false)
        this.store.getState().setNotice(asRouteError(failure).message)
      }
    }
  }

  add(target: MemoryTarget, content: string): Promise<MemoryWriteAnswer> {
    return this.write({ target, op: 'add', content })
  }

  /**
   * Replace one entry.
   *
   * `old_text` and not `index`: the plugin prefers the text it is given and
   * only falls back to a position, and the text is what the store matches on.
   * An index that went stale between the read and the write would otherwise
   * overwrite whichever entry moved into that place.
   */
  replace(entry: MemoryEntry, content: string): Promise<MemoryWriteAnswer> {
    return this.write({ target: entry.target, op: 'replace', content, old_text: entry.text, index: entry.index })
  }

  remove(entry: MemoryEntry): Promise<MemoryWriteAnswer> {
    return this.write({ target: entry.target, op: 'remove', old_text: entry.text, index: entry.index })
  }

  private async write(body: Record<string, unknown>): Promise<MemoryWriteAnswer> {
    const state = this.store.getState()

    state.setBusy(true)
    state.setNotice(null)

    try {
      const answer = memoryWriteOf(
        await this.requireHttp().post(`${MEMORY_ROUTE}/edit`, { profile: this.profile, ...body })
      )

      if (answer.success) {
        // The ids have all shifted and the usage has moved by the delimiter as
        // well as by the text; only a re-read knows both.
        await this.refresh()
      } else if (answer.error) {
        this.store.getState().setNotice(answer.error)
      }

      return answer
    } catch (failure) {
      const refused = asRouteError(failure)

      this.store.getState().setNotice(refused.message)

      return { success: false, error: refused.message, currentEntries: null }
    } finally {
      this.store.getState().setBusy(false)
    }
  }

  protected get(path: string): Promise<unknown> {
    return this.requireHttp().get(path)
  }

  private requireHttp(): GatewayHttp {
    if (!this.http) {
      throw new MemoryRouteError(memoryStrings.failed('there is no gateway connection yet'))
    }

    return this.http
  }

  private current(generation: number): boolean {
    return !this.stopped && generation === this.generation
  }
}

/**
 * A thrown thing, as the sentence and the status a page can act on.
 *
 * The 404 wording is the load-bearing one. `GatewayHttp` words it as "the
 * gateway has no such endpoint", which is exactly right and is also what the
 * page needs in order to offer the install panel rather than an error.
 */
export function asRouteError(failure: unknown): MemoryRouteError {
  if (failure instanceof MemoryRouteError) {
    return failure
  }

  if (isGatewayError(failure)) {
    return new MemoryRouteError(failure.message, failure.status)
  }

  return new MemoryRouteError(failure instanceof Error ? failure.message : String(failure))
}

/** Is this the gateway saying the memory routes are not mounted at all? */
export function isMissingRoute(status: number | undefined): boolean {
  return status === 404
}
