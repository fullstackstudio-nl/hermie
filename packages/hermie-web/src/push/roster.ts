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
 *  - **who asked to be told** — the app-wide keys on the DEFAULT profile, which
 *    is where [ADR-0016](../../../../docs/adr/0016-ui-meta-sync.md) puts
 *    everything app-wide. There is one key PER PERSON now
 *    (`hermie-app:<user_id>`), so every one of them is read and their
 *    registrations pooled: a notifier's job is to reach every device that asked,
 *    and which person's key a device wrote itself into is not its business;
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
  /**
   * The bare `hermie-app` bag exactly as the gateway holds it.
   *
   * The LEGACY key deliberately, and only for the availability stamp
   * `announce.ts` leaves behind. Per-person keys carry a compare-and-swap the
   * app is using, and a write from this side would make that app's next write
   * fail — the same reasoning ADR-0017's amendment gives for the plugin
   * advertising under a key of its own.
   */
  appSection: Record<string, unknown> | null
  /** The revision of `hermie-app` on the default profile; 0 when it has never been written. */
  appRevision: number
  push: PushSection
}

/** Every app-wide key on one profile: the per-person ones, then the legacy one. */
function appKeysOf(bag: Record<string, unknown>): string[] {
  const perPerson = Object.keys(bag)
    .filter(key => key.startsWith(`${HERMIE_APP_KEY}:`))
    .sort()

  // The legacy key is a FALLBACK, not another source. A device that has been
  // migrated wrote itself into a person's key and left its old row behind;
  // pooling both would send to that device twice, which is the one failure a
  // notifier must not have. So the bare key counts only while no person has one.
  return perPerson.length > 0 ? perPerson : [HERMIE_APP_KEY]
}

/**
 * Pool the registrations of every app-wide key, one row per installation.
 *
 * A person is not the unit here: a device is. The same installation appearing
 * under two keys — somebody who signed in as themselves on a gateway that once
 * held an anonymous arrangement — is one phone, and it is notified once. The
 * NEWEST row wins, because that is the one whose token was most recently proved.
 */
function pooledPush(bag: Record<string, unknown>): PushSection {
  const byInstallation = new Map<string, PushSection['registrations'][number]>()
  const seen: Record<string, number> = {}

  for (const key of appKeysOf(bag)) {
    const section = readPushSection(isObject(bag[key]) ? bag[key] : null)

    for (const registration of section.registrations) {
      const held = byInstallation.get(registration.installationId)

      if (!held || registration.updatedAt >= held.updatedAt) {
        byInstallation.set(registration.installationId, registration)
      }
    }

    for (const [installationId, stamp] of Object.entries(section.seen)) {
      // The LATEST heartbeat, so a chat somebody is reading on one of their
      // devices stays suppressed however many keys mention it.
      seen[installationId] = Math.max(seen[installationId] ?? 0, stamp)
    }
  }

  return {
    registrations: [...byInstallation.values()].sort((a, b) => a.installationId.localeCompare(b.installationId)),
    seen
  }
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
      push = pooledPush(bag ?? {})
    }
  }

  // A stable order, so a run's log reads the same twice; object key order off a
  // wire is not a promise anybody made.
  bots.sort((a, b) => a.name.localeCompare(b.name))

  return { bots, defaultProfile, appSection, appRevision, push }
}
