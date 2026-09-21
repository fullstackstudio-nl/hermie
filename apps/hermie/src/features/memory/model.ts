/**
 * The plugin's memory answers, as this app reads them.
 *
 * Every shape here is read off `memory/browse.py` in the plugin repository and
 * its tests, not guessed from what a browser would find convenient. Three of
 * its decisions reach all the way into this file and are worth stating where
 * somebody will read them before changing a reader:
 *
 *  - **An id is POSITIONAL.** A memory file is plain text with entries joined
 *    by `"\n§\n"` — no ids, no timestamps — so `memory:3` means "the fourth
 *    entry of MEMORY.md as it reads right now" and stops being true the moment
 *    one above it is removed. It is a way of naming a row on screen and nothing
 *    else. Every write therefore sends the entry's TEXT, which is what the
 *    store itself matches on, so an index that went stale between a read and a
 *    write cannot delete the entry that moved into its place.
 *  - **There are exactly two targets.** The store dispatches on a bare
 *    `target === "user"` and the tool layer refuses anything else. A third
 *    would be our invention.
 *  - **`chars` is counted the way the store SPENDS it**, delimiter included.
 *    That is why the usage bar reads `chars` off the answer rather than summing
 *    the entries it drew: a bar that disagreed with the store about how full a
 *    file is would have somebody deleting entries to fix a number that was
 *    never true.
 */

/** The two files a profile has. Named by the plugin, not by us. */
export const MEMORY_TARGETS = ['memory', 'user'] as const

export type MemoryTarget = (typeof MEMORY_TARGETS)[number]

export interface MemoryEntry {
  /** `memory:3`. Positional, and stale the moment an entry above it goes. */
  id: string
  target: MemoryTarget
  index: number
  text: string
  chars: number
  /** The plugin's cheap topics: capitals, `@handles`, `#hashtags`, ISO dates. */
  topics: string[]
}

export interface MemorySection {
  target: MemoryTarget
  entries: MemoryEntry[]
  /** What this file costs, delimiter included — the store's own number. */
  chars: number
  /** `0` on a gateway that configured no limit; the bar is not drawn then. */
  limit: number
  percent: number
}

/**
 * A memory provider the gateway has.
 *
 * `enumerable` is `false` on every external row and that is not a placeholder:
 * `MemoryProvider` offers `prefetch(query)` returning opaque formatted text and
 * no call that returns entries, and mem0's own surface is `search(query,
 * top_k)` with no `get_all`. So a provider's memories cannot be shown even
 * read-only without inventing an API Hermes does not have, and naming the
 * provider while saying it cannot be opened is the honest version of that.
 */
export interface MemoryProvider {
  name: string
  description: string
  available: boolean
  enumerable: boolean
}

export interface MemoryListing {
  profile: string
  sections: MemorySection[]
  providers: MemoryProvider[]
}

export interface MemorySearchAnswer {
  query: string
  count: number
  results: MemoryEntry[]
}

/**
 * What a write answered.
 *
 * The plugin hands back the STORE's own result dict rather than a translation
 * of it, so `error` is Hermes' sentence about what went wrong — a char limit,
 * an entry that has moved — and the screen shows it verbatim. A sentence we
 * invented here would be a second opinion about a file we did not write.
 */
export interface MemoryWriteAnswer {
  success: boolean
  error: string | null
  /**
   * The target as the store re-read it after a stale-index refusal.
   *
   * Present only on that one failure. It is not applied automatically: the
   * screen refetches, because a listing rebuilt from a half-answer would have
   * the usage bar and the entries disagreeing.
   */
  currentEntries: string[] | null
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const str = (value: unknown): string => (typeof value === 'string' ? value : '')
const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

const isTarget = (value: unknown): value is MemoryTarget =>
  typeof value === 'string' && (MEMORY_TARGETS as readonly string[]).includes(value)

function entryOf(value: unknown, fallbackTarget: MemoryTarget, fallbackIndex: number): MemoryEntry {
  const row = isObject(value) ? value : {}
  const target = isTarget(row.target) ? row.target : fallbackTarget
  const index = num(row.index) || fallbackIndex
  const text = str(row.text)

  return {
    id: str(row.id) || `${target}:${index}`,
    target,
    index,
    text,
    // `chars` off the answer, and the text's own length only when the gateway
    // sent none: the two differ on a file whose entries carry surrogate pairs.
    chars: typeof row.chars === 'number' ? num(row.chars) : text.length,
    topics: Array.isArray(row.topics) ? row.topics.filter((topic): topic is string => typeof topic === 'string') : []
  }
}

/**
 * `GET …/memory/list`.
 *
 * Both targets are always named, in the plugin's own order, even when one is
 * empty — an absent section would read as "this gateway has no USER.md", which
 * is a different thing from one that has nothing in it yet.
 */
export function memoryListingOf(value: unknown): MemoryListing {
  const body = isObject(value) ? value : {}
  const sent = Array.isArray(body.targets) ? body.targets : []
  const byTarget = new Map<MemoryTarget, Record<string, unknown>>()

  for (const row of sent) {
    if (isObject(row) && isTarget(row.target)) {
      byTarget.set(row.target, row)
    }
  }

  return {
    profile: str(body.profile),
    sections: MEMORY_TARGETS.map(target => {
      const row = byTarget.get(target) ?? {}
      const entries = Array.isArray(row.entries) ? row.entries : []

      return {
        target,
        entries: entries.map((entry, index) => entryOf(entry, target, index)),
        chars: num(row.chars),
        limit: num(row.limit),
        percent: num(row.percent)
      }
    }),
    providers: (Array.isArray(body.providers) ? body.providers : []).flatMap(row =>
      isObject(row) && str(row.name)
        ? [
            {
              name: str(row.name),
              description: str(row.description),
              available: row.available !== false,
              enumerable: row.enumerable === true
            }
          ]
        : []
    )
  }
}

/** `GET …/memory/search?q=…`. One list, across both targets, ids kept. */
export function memorySearchOf(value: unknown): MemorySearchAnswer {
  const body = isObject(value) ? value : {}
  const results = (Array.isArray(body.results) ? body.results : []).map((row, index) => entryOf(row, 'memory', index))

  return {
    query: str(body.query),
    // The plugin sends a count; trusting the array is what keeps the header and
    // the rows from disagreeing when one row was unreadable.
    count: results.length,
    results
  }
}

/** `POST …/memory/edit`. The store's own dict, with nothing added to it. */
export function memoryWriteOf(value: unknown): MemoryWriteAnswer {
  const body = isObject(value) ? value : {}
  const entries = body.current_entries

  return {
    success: body.success === true,
    error: str(body.error) || null,
    currentEntries: Array.isArray(entries)
      ? entries.filter((entry): entry is string => typeof entry === 'string')
      : null
  }
}

/** Every entry the listing holds, in the order the screen draws them. */
export function entriesOf(listing: MemoryListing | null): MemoryEntry[] {
  return (listing?.sections ?? []).flatMap(section => section.entries)
}

/** The external providers, which are the rows that say they cannot be opened. */
export function externalProviders(listing: MemoryListing | null): MemoryProvider[] {
  return (listing?.providers ?? []).filter(provider => !provider.enumerable)
}
