/**
 * What one `profiles.list` tells the daemon.
 *
 * Three things, and they all come off the same round trip because asking twice
 * would mean two answers that can disagree:
 *
 *  - **which chats to watch** — each bot's canonical Bot Chat, resolved exactly
 *    as the app resolves one ([ADR-0007](../../../../docs/adr/0007-canonical-bot-chats-only.md)):
 *    `canonical_session.resolved_id` is the live compression tip and `id` is the
 *    registry row, so the tip is what a resume must name;
 *  - **who asked to be told** — the `hermie-app` key on the DEFAULT profile,
 *    which is where [ADR-0016](../../../../docs/adr/0016-ui-meta-sync.md) puts
 *    everything app-wide;
 *  - **the revision that guards a write to it**, so the availability stamp the
 *    daemon leaves behind is a compare-and-swap and not a clobber.
 *
 * Everything here is defensive. What arrives is a bag of JSON off a wire, and a
 * roster row that cannot be read costs that row rather than the sweep.
 */
import { HERMIE_APP_KEY, type PushSection, readPushSection } from './registrations'

export interface WatchedBot {
  /** The profile name, which is the bot's identity everywhere else. */
  name: string
  /** What a notification's title says, when the roster offers one. */
  label: string
  /** The session a resume must name: the live compression tip. */
  sessionId: string
  /** The registry row id, kept because `sessions.changed` and the app both speak it. */
  storedId: string
}

export interface Roster {
  bots: WatchedBot[]
  /** The profile `hermie-app` lives on, or empty when the gateway has no default row. */
  defaultProfile: string
  /** The `hermie-app` bag exactly as the gateway holds it, for a read-modify-write. */
  appSection: Record<string, unknown> | null
  /** The revision of `hermie-app` on the default profile; 0 when it has never been written. */
  appRevision: number
  push: PushSection
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const str = (value: unknown): string => (typeof value === 'string' ? value : '')

export function readRoster(result: unknown): Roster {
  const rows = Array.isArray((result as { profiles?: unknown } | null)?.profiles)
    ? ((result as { profiles: unknown[] }).profiles as Record<string, unknown>[])
    : []
  const bots: WatchedBot[] = []
  let defaultProfile = ''
  let appSection: Record<string, unknown> | null = null
  let appRevision = 0
  let push: PushSection = { registrations: [], seen: {} }

  for (const row of rows) {
    const name = str(row?.name)

    if (!name) {
      continue
    }

    const canonical = isObject(row.canonical_session) ? row.canonical_session : null
    // `resolved_id` first: a chat that has been compressed lives on under a new
    // id, and resuming the registry row would attach to the wrong end of it.
    const sessionId = canonical ? str(canonical.resolved_id) || str(canonical.id) : ''

    if (sessionId) {
      bots.push({
        name,
        label: str(row.display_name) || name,
        sessionId,
        storedId: canonical ? str(canonical.id) || sessionId : sessionId
      })
    }

    if (row.is_default === true) {
      defaultProfile = name
      const bag = isObject(row.ui_meta) ? row.ui_meta : null
      appSection = bag && isObject(bag[HERMIE_APP_KEY]) ? (bag[HERMIE_APP_KEY] as Record<string, unknown>) : null
      const revisions = isObject(row.ui_meta_revisions) ? row.ui_meta_revisions : {}
      const revision = revisions[HERMIE_APP_KEY]
      appRevision = typeof revision === 'number' && Number.isFinite(revision) ? revision : 0
      push = readPushSection(appSection)
    }
  }

  // A stable order, so a run's log reads the same twice; object key order off a
  // wire is not a promise anybody made.
  bots.sort((a, b) => a.name.localeCompare(b.name))

  return { bots, defaultProfile, appSection, appRevision, push }
}
