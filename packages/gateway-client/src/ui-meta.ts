/**
 * ADR-0016's client: Hermie's own settings, in the gateway's `ui_meta`.
 *
 * `ui_meta` is a free-form object on a profile row with a revision counter PER
 * TOP-LEVEL KEY, and `profiles.configure` takes `ui_meta` together with
 * `ui_meta_expected_revisions` — upstream's docstring, carried verbatim into the
 * generated contract, calls that a per-key compare-and-swap. Everything here
 * follows from that one sentence:
 *
 *  - **A write names only the keys it changes.** `ui_meta` is not ours. The
 *    marker `{"hermes-bots": {}}` is what makes a profile show up as a bot at all
 *    and it belongs to another tool, so a client that stored its settings by
 *    replacing the bag would un-bot every profile it touched. Per-key writes are
 *    what make the scope safe to use, not merely convenient.
 *  - **A section is replaced whole.** The key is the unit, so removing a field
 *    means sending the section without it. There is no merge.
 *  - **Last writer wins, per section, guarded by the revision.** A refused write
 *    comes back as `applied.ui_meta_conflicts[key] = { expected, actual }`; the
 *    client takes the actual revision and writes its own value again. There is no
 *    merge of two divergent arrangements either: an order is a list, and a list
 *    merged with another list is neither of them.
 *
 * **This module owns no state the UI reads.** The device's own store stays the
 * thing the app paints from, so it paints before the socket has answered and
 * works with no gateway at all. What lives here is the revision table, the set of
 * sections that have not reached the gateway yet, and the round trips. The app
 * hands in a `read` for what it currently holds and an `apply` for what the
 * gateway turned out to hold.
 *
 * **The local-only fallback is a mode, not an error.** A gateway too old to carry
 * `ui_meta`, or one that refuses the write, leaves Hermie exactly where ADR-0012
 * left it: keyed by gateway address, on the device. `mode` says which of the two
 * is in force so a screen can be honest about it, and a refusal is retried on the
 * next reconcile rather than being retried forever.
 */
import type { ProfileRow, ProfilesConfigureResult, ProfilesListResult } from '@hermes/shared/gateway-contract'

/** That bot's profile: everything about one conversation. */
export const HERMIE_KEY = 'hermie'

/** The default profile: everything about the window. */
export const HERMIE_APP_KEY = 'hermie-app'

/** The marker another tool owns. Named here only so that a test can say it. */
export const BOT_MARKER_KEY = 'hermes-bots'

/**
 * The schema version each section carries.
 *
 * Two keys, two versions, because they will not move together. A reader that
 * meets a `v` it does not know ignores that section and keeps its local copy
 * rather than guessing at a shape; a writer never lowers it.
 */
export const HERMIE_SECTION_VERSION = 1
export const HERMIE_APP_SECTION_VERSION = 1

/** One bot's section. Anything about one conversation, and nothing else. */
export interface HermieBotSection {
  v: number
  archived?: boolean
  colour?: string
}

/**
 * The app-wide section.
 *
 * Deliberately typed loosely past `v`: the chat list's arrangement and the theme
 * set are the app's shapes, not this module's, and duplicating them here would be
 * a second definition to keep in step with the first. What this module promises
 * about them is only what ADR-0016 promises — that the section travels whole and
 * that its revision guards it.
 */
export interface HermieAppSection {
  v: number
  [key: string]: unknown
}

/** What the app holds, and what the gateway turned out to hold. */
export interface UiMetaSnapshot {
  app: HermieAppSection | null
  /** Bot name → its section. A bot with no section is simply absent. */
  bots: Record<string, HermieBotSection>
}

export type UiMetaMode = 'synced' | 'local'

/** The two calls this needs, so a test can hand over two functions. */
export interface UiMetaGateway {
  request: (method: string, params?: Record<string, unknown>) => Promise<unknown>
}

export interface UiMetaSyncOptions {
  gateway: UiMetaGateway
  /** What the app is holding right now. Asked for at the moment of a write. */
  read: () => UiMetaSnapshot
  /** Hand the gateway's copy to the app. Called once per reconcile. */
  apply: (snapshot: UiMetaSnapshot) => void
  /**
   * How many times a conflicted section is re-sent before it is left dirty.
   *
   * One retry is the whole design: the conflict answer carries the revision that
   * won, so the second attempt cannot fail for the same reason. A second retry
   * would only be needed if a THIRD writer landed between the two, and in that
   * case leaving the section dirty for the next reconcile is the right answer
   * rather than spinning.
   */
  retries?: number
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/**
 * Read a section, or `null`.
 *
 * A `v` this build does not know is `null` on purpose — see the note on the
 * version constants. So is a section that is not an object: whatever wrote it,
 * it is not this.
 */
export function readSection<T extends { v: number }>(bag: unknown, key: string, known: number): T | null {
  if (!isObject(bag) || !isObject(bag[key])) {
    return null
  }

  const section = bag[key]
  const version = typeof section.v === 'number' ? section.v : 0

  return version > 0 && version <= known ? (section as unknown as T) : null
}

/** One roster row's revisions, defensively. */
function revisionsOf(row: ProfileRow): Record<string, number> {
  const out: Record<string, number> = {}

  for (const [key, value] of Object.entries(row.ui_meta_revisions ?? {})) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      out[key] = value
    }
  }

  return out
}

/** What one section's write asked for and what came back. */
interface Conflict {
  expected: unknown
  actual: number
}

function conflictsOf(result: unknown): Record<string, Conflict> {
  const applied = isObject(result) && isObject(result.applied) ? result.applied : null
  const raw = applied && isObject(applied.ui_meta_conflicts) ? applied.ui_meta_conflicts : null
  const out: Record<string, Conflict> = {}

  for (const [key, value] of Object.entries(raw ?? {})) {
    if (isObject(value) && typeof value.actual === 'number') {
      out[key] = { expected: value.expected, actual: value.actual }
    }
  }

  return out
}

function appliedRevisions(result: unknown): Record<string, number> {
  const applied = isObject(result) && isObject(result.applied) ? result.applied : null
  const raw = applied && isObject(applied.ui_meta_revisions) ? applied.ui_meta_revisions : null
  const out: Record<string, number> = {}

  for (const [key, value] of Object.entries(raw ?? {})) {
    if (typeof value === 'number') {
      out[key] = value
    }
  }

  return out
}

export class UiMetaSync {
  private readonly gateway: UiMetaGateway
  private readonly read: () => UiMetaSnapshot
  private readonly apply: (snapshot: UiMetaSnapshot) => void
  private readonly retries: number

  /** profile name → the revision this client last read for ITS OWN key there. */
  private readonly revisions = new Map<string, number>()

  /** The default profile, learnt from the roster. `hermie-app` lives on it. */
  private defaultProfile: string | null = null

  /** Sections written locally that the gateway has not taken yet. */
  private readonly dirtyBots = new Set<string>()
  private dirtyApp = false

  private currentMode: UiMetaMode = 'local'
  private flushing: Promise<void> | null = null

  constructor(options: UiMetaSyncOptions) {
    this.gateway = options.gateway
    this.read = options.read
    this.apply = options.apply
    this.retries = options.retries ?? 1
  }

  /** `synced` once a roster has been read and no write has been refused since. */
  get mode(): UiMetaMode {
    return this.currentMode
  }

  /** True while something written locally has not reached the gateway. */
  get pending(): boolean {
    return this.dirtyApp || this.dirtyBots.size > 0
  }

  /**
   * Record that one bot's section changed locally.
   *
   * It does NOT take the section: the app's store is the source, and passing a
   * value here would let the two disagree in the window between the call and the
   * flush. `read()` is asked at the moment the write goes out.
   */
  markBot(botName: string): void {
    this.dirtyBots.add(botName)
  }

  markApp(): void {
    this.dirtyApp = true
  }

  /**
   * Read the gateway's copy, hand it to the app, then send whatever is dirty.
   *
   * This is the whole of the reconciliation ADR-0016 asks for on connect and on a
   * profile-change event. The order matters: reading first is what gives a
   * conflicted write the revision it needs, and sending after is what stops a
   * remote copy from overwriting a change made while the socket was down —
   * because that change is still dirty and goes out immediately behind it.
   */
  async reconcile(): Promise<UiMetaSnapshot | null> {
    const remote = await this.pull()

    if (!remote) {
      return null
    }

    const snapshot = this.withPendingKept(remote)

    this.apply(snapshot)
    this.seedWhatTheGatewayLacks(remote)
    await this.flush()

    return snapshot
  }

  /**
   * A section this device has and the gateway does not is SENT, not dropped.
   *
   * Without this, a gateway only ever learns an arrangement from a device that
   * changes one AFTER connecting: somebody who spent an afternoon ordering their
   * list and then signed in on a tablet would find the tablet empty and the
   * gateway still empty, with both devices politely waiting for the other to go
   * first. An absent key is not a decision anybody made; a present one is, and
   * that is the asymmetry this leans on.
   *
   * It is deliberately not the reverse. A section the GATEWAY has and this device
   * does not is simply taken, which is what `apply` just did.
   */
  private seedWhatTheGatewayLacks(remote: UiMetaSnapshot): void {
    const local = this.read()

    if (!remote.app && local.app) {
      this.dirtyApp = true
    }

    for (const [name, section] of Object.entries(local.bots)) {
      if (section && !remote.bots[name]) {
        this.dirtyBots.add(name)
      }
    }
  }

  /**
   * The gateway's copy, except where this device is still holding a change.
   *
   * Without this, a reconcile after a spell with no socket would hand the app the
   * remote value, overwrite the change that was made offline, and then flush THAT
   * back — so a change made on a plane would not merely fail to arrive, it would
   * be erased on landing by the device that made it. A dirty section is a section
   * whose newest value is the local one by definition; every other section is the
   * gateway's.
   */
  private withPendingKept(remote: UiMetaSnapshot): UiMetaSnapshot {
    if (!this.pending) {
      return remote
    }

    const local = this.read()
    const bots = { ...remote.bots }

    for (const botName of this.dirtyBots) {
      const section = local.bots[botName]

      if (section) {
        bots[botName] = section
      } else {
        delete bots[botName]
      }
    }

    return { app: this.dirtyApp ? local.app : remote.app, bots }
  }

  /** Read `profiles.list` and project the two keys out of it. */
  async pull(): Promise<UiMetaSnapshot | null> {
    let result: ProfilesListResult

    try {
      result = (await this.gateway.request('profiles.list', {})) as ProfilesListResult
    } catch {
      // A roster this client cannot read is a gateway it cannot sync with. That
      // is the local-only path, not an error to put in front of anybody.
      this.currentMode = 'local'

      return null
    }

    const rows = Array.isArray(result?.profiles) ? result.profiles : []
    const bots: Record<string, HermieBotSection> = {}
    let app: HermieAppSection | null = null

    for (const row of rows) {
      const name = typeof row?.name === 'string' ? row.name : ''

      if (!name) {
        continue
      }

      const revisions = revisionsOf(row)
      const section = readSection<HermieBotSection>(row.ui_meta, HERMIE_KEY, HERMIE_SECTION_VERSION)

      this.revisions.set(`${name}:${HERMIE_KEY}`, revisions[HERMIE_KEY] ?? 0)

      if (section) {
        bots[name] = section
      }

      if (row.is_default === true) {
        this.defaultProfile = name
        this.revisions.set(`${name}:${HERMIE_APP_KEY}`, revisions[HERMIE_APP_KEY] ?? 0)
        app = readSection<HermieAppSection>(row.ui_meta, HERMIE_APP_KEY, HERMIE_APP_SECTION_VERSION)
      }
    }

    this.currentMode = 'synced'

    return { app, bots }
  }

  /**
   * Send every dirty section, one request per profile.
   *
   * One request per PROFILE rather than one per section, because `ui_meta` is
   * per profile and a profile's sections are independent inside one request —
   * the fake pins that a request whose `hermie` conflicts still lands its
   * `hermie-app`.
   *
   * Concurrent callers share one flush: a reconcile landing on top of a
   * `sessions.changed` sweep must not send the same section twice.
   */
  flush(): Promise<void> {
    if (this.flushing) {
      return this.flushing
    }

    const run = this.run().finally(() => {
      this.flushing = null
    })

    this.flushing = run

    return run
  }

  private async run(): Promise<void> {
    const snapshot = this.read()
    /*
      Grouped by profile, which matters in exactly one case and that case is the
      common one: the default profile is also a BOT, so a reader who colours the
      default bot and changes a theme in the same breath has two dirty sections
      on one row. Two requests would be two round trips and, worse, two
      compare-and-swaps where the protocol offers one — `hermie` and `hermie-app`
      are independent inside a single request, which is the whole point of
      sections being independent.
    */
    const byProfile = new Map<string, Record<string, unknown>>()

    const at = (profile: string): Record<string, unknown> => {
      const existing = byProfile.get(profile)

      if (existing) {
        return existing
      }

      const created: Record<string, unknown> = {}

      byProfile.set(profile, created)

      return created
    }

    for (const botName of this.dirtyBots) {
      const section = snapshot.bots[botName]

      at(botName)[HERMIE_KEY] = section ? { ...section, v: HERMIE_SECTION_VERSION } : null
    }

    if (this.dirtyApp && this.defaultProfile) {
      at(this.defaultProfile)[HERMIE_APP_KEY] = snapshot.app ? { ...snapshot.app, v: HERMIE_APP_SECTION_VERSION } : null
    }

    for (const [profile, sections] of byProfile) {
      await this.send(profile, sections)
    }
  }

  /**
   * One `profiles.configure`, with the retry the compare-and-swap asks for.
   *
   * `null` for a section is how a section is REMOVED — a bot that is no longer
   * archived and has no colour has nothing to say, and leaving an empty object
   * behind would be a key on somebody's profile that means nothing.
   */
  private async send(profile: string, sections: Record<string, unknown>): Promise<void> {
    const keys = Object.keys(sections)

    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      const expected: Record<string, number> = {}

      for (const key of keys) {
        expected[key] = this.revisions.get(`${profile}:${key}`) ?? 0
      }

      let result: ProfilesConfigureResult

      try {
        result = (await this.gateway.request('profiles.configure', {
          name: profile,
          ui_meta: sections,
          ui_meta_expected_revisions: expected
        })) as ProfilesConfigureResult
      } catch {
        // Refused, unreachable, or a gateway with no `profiles.configure` at
        // all. The section stays dirty and the next reconcile tries again; the
        // device's own copy is already correct, which is why this is a mode
        // rather than a failure.
        this.currentMode = 'local'

        return
      }

      const conflicts = conflictsOf(result)

      for (const [key, revision] of Object.entries(appliedRevisions(result))) {
        this.revisions.set(`${profile}:${key}`, revision)
      }

      for (const [key, conflict] of Object.entries(conflicts)) {
        // Take the revision that won. The VALUE that won is deliberately not
        // read: last writer wins per section, and this client is the later
        // writer — it is about to say so again with the right revision.
        this.revisions.set(`${profile}:${key}`, conflict.actual)
      }

      if (!Object.keys(conflicts).length) {
        this.clearDirty(profile, keys)

        return
      }
    }

    // Out of retries with a conflict still standing: something else is writing
    // this section as fast as we are. Leave it dirty for the next reconcile.
  }

  private clearDirty(profile: string, keys: readonly string[]): void {
    for (const key of keys) {
      if (key === HERMIE_APP_KEY) {
        this.dirtyApp = false
      } else {
        this.dirtyBots.delete(profile)
      }
    }
  }

  /** Forget everything. A different gateway is a different set of revisions. */
  reset(): void {
    this.revisions.clear()
    this.dirtyBots.clear()
    this.dirtyApp = false
    this.defaultProfile = null
    this.currentMode = 'local'
  }
}
