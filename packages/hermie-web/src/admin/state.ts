/**
 * Everything `/admin` can change, on the service's own disk.
 *
 * ADR-0015's rule still holds and this file is written to respect it: **Hermie
 * Web has no user database and is not going to grow one.** Nothing here
 * authenticates anybody and nothing here is an account. What it holds is a list
 * of gateway user ids the operator has marked as administrators, a note of who
 * has been seen signing in, and a handful of settings about THIS SERVICE —
 * push, the cache, the branding the app bootstraps with, and the feature flags.
 *
 * Two consequences of that worth stating before anybody reads further:
 *
 *  - **An id in `admins` is not a credential.** It names somebody the gateway
 *    has to authenticate first; this service only decides what that person may
 *    then do here.
 *  - **The per-user options are SERVICE-level, not gateway-level.** They are
 *    what this proxy and this push daemon will do. They are not a permission
 *    system and the file says so wherever they are read; see `access.ts`.
 *
 * Stored the way the push state is stored, for the same reasons: one JSON file,
 * `0600`, in a `0700` directory, written through a temp file and a rename, and
 * every read failure answering an empty state rather than taking the service
 * down over a file it could ignore.
 */
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { PUSH_TYPES, type PushType } from '../push/registrations'

export const ADMIN_STATE_VERSION = 1
export const ADMIN_STATE_FILE = 'admin.json'

/** What the service will do about one person, as an operator decided it. */
export interface AdminUserOptions {
  /** Bot names this person may reach, or `null` for "all of them". */
  allowedBots: string[] | null
  /** Refuse this person's mutating HTTP requests. See `access.ts` for the limit. */
  readOnly: boolean
  /** Whether the push daemon may notify this person's devices. */
  pushAllowed: boolean
}

export interface AdminUserRow extends AdminUserOptions {
  userId: string
  displayName: string
  email: string
  /** Unix seconds this service last saw them make a request. */
  seenAt: number
}

/** What the push daemon does, as far as an operator gets to decide it. */
export interface AdminPushSettings {
  /** Which event kinds may be sent at all, whatever a device asked for. */
  types: Record<PushType, boolean>
  /**
   * What a notification may contain.
   *
   * `device` leaves it to each device's own `preview` flag, which is ADR-0017's
   * behaviour and the default. `never` overrides every device: the bot's name
   * and nothing else, on a shared or regulated deployment where a message
   * summary on a lock screen is not acceptable.
   */
  preview: 'device' | 'never'
}

export interface AdminCacheSettings {
  /**
   * Hours an entry may go unread before the service drops it, or `0` for "only
   * the size cap decides", which is ADR-0025's behaviour.
   */
  retentionHours: number
}

/** What the app bootstraps with, so a team's build looks like the team's. */
export interface AdminBranding {
  /** Shown instead of "Hermie" where the app names itself. Empty is the default. */
  name: string
  /** One of the app's accent names, or `''` for the reader's own choice. */
  accent: string
  /** A theme preset name the app starts on, or `''` to leave it to the reader. */
  theme: string
}

/** Service features an operator can turn off for everybody. */
export interface AdminFlags {
  /** ADR-0007's amendment: per-user chats. On by default. */
  userChats: boolean
  /** ADR-0025's message cache. Off here does not delete what is stored. */
  messageCache: boolean
  /** Whether the Settings screen may offer the self-update button at all. */
  selfUpdate: boolean
}

export interface AdminState {
  v: number
  /** Gateway user ids that may open `/admin`. */
  admins: string[]
  /**
   * The local administrator, for a gateway with no accounts.
   *
   * `scrypt`, a per-credential salt, and the hash — never the secret. A token
   * gateway names nobody, so there is no user id to put in `admins` and this is
   * the only way an operator can come back to the page they set up.
   */
  localAdmin?: { salt: string; hash: string }
  push: AdminPushSettings
  cache: AdminCacheSettings
  branding: AdminBranding
  flags: AdminFlags
  /** Everyone this service has seen, by gateway user id. */
  users: Record<string, AdminUserRow>
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '')
const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
const bool = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback)

export const DEFAULT_USER_OPTIONS: AdminUserOptions = { allowedBots: null, readOnly: false, pushAllowed: true }

export function emptyAdminState(): AdminState {
  return {
    v: ADMIN_STATE_VERSION,
    admins: [],
    push: {
      // Everything on: this is a CEILING an operator can lower, not a second
      // opt-in on top of the one each device already made. A default of "off"
      // would silence every phone the moment the file appeared.
      types: Object.fromEntries(PUSH_TYPES.map(type => [type, true])) as Record<PushType, boolean>,
      preview: 'device'
    },
    cache: { retentionHours: 0 },
    branding: { name: '', accent: '', theme: '' },
    flags: { userChats: true, messageCache: true, selfUpdate: true },
    users: {}
  }
}

function userRowOf(userId: string, raw: Record<string, unknown>): AdminUserRow {
  const allowed = raw.allowedBots

  return {
    userId,
    displayName: str(raw.displayName),
    email: str(raw.email),
    seenAt: num(raw.seenAt),
    // `null` and `[]` are different answers: no list is "every bot", an empty
    // list is "no bots at all", and an operator has to be able to say both.
    allowedBots: Array.isArray(allowed) ? allowed.filter((name): name is string => typeof name === 'string') : null,
    readOnly: bool(raw.readOnly, false),
    pushAllowed: bool(raw.pushAllowed, true)
  }
}

/** Read the file defensively — an operator may have edited it by hand. */
export function adminStateOf(parsed: unknown): AdminState {
  const raw = (parsed ?? {}) as Record<string, unknown>

  if (num(raw.v) !== ADMIN_STATE_VERSION) {
    return emptyAdminState()
  }

  const base = emptyAdminState()
  const push = (raw.push ?? {}) as Record<string, unknown>
  const types = (push.types ?? {}) as Record<string, unknown>
  const cache = (raw.cache ?? {}) as Record<string, unknown>
  const branding = (raw.branding ?? {}) as Record<string, unknown>
  const flags = (raw.flags ?? {}) as Record<string, unknown>
  const local = (raw.localAdmin ?? {}) as Record<string, unknown>
  const users: Record<string, AdminUserRow> = {}

  for (const [userId, row] of Object.entries((raw.users ?? {}) as Record<string, Record<string, unknown>>)) {
    if (userId) {
      users[userId] = userRowOf(userId, row ?? {})
    }
  }

  return {
    v: ADMIN_STATE_VERSION,
    admins: Array.isArray(raw.admins) ? raw.admins.filter((id): id is string => typeof id === 'string' && !!id) : [],
    ...(str(local.salt) && str(local.hash) ? { localAdmin: { salt: str(local.salt), hash: str(local.hash) } } : {}),
    push: {
      types: Object.fromEntries(PUSH_TYPES.map(type => [type, bool(types[type], base.push.types[type])])) as Record<
        PushType,
        boolean
      >,
      preview: push.preview === 'never' ? 'never' : 'device'
    },
    cache: { retentionHours: Math.max(0, Math.floor(num(cache.retentionHours))) },
    branding: { name: str(branding.name), accent: str(branding.accent), theme: str(branding.theme) },
    flags: {
      userChats: bool(flags.userChats, true),
      messageCache: bool(flags.messageCache, true),
      selfUpdate: bool(flags.selfUpdate, true)
    },
    users
  }
}

export function adminStatePath(stateDir: string): string {
  return path.join(stateDir, ADMIN_STATE_FILE)
}

export async function loadAdminState(stateDir: string): Promise<AdminState> {
  try {
    return adminStateOf(JSON.parse(await readFile(adminStatePath(stateDir), 'utf8')))
  } catch {
    // No file, an unreadable one, or one from a version this build does not
    // know. All three are the same answer: nothing is configured yet.
    return emptyAdminState()
  }
}

export async function saveAdminState(stateDir: string, state: AdminState): Promise<void> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 })
  // `mkdir`'s mode only applies on create, so a directory that existed with
  // wider permissions is narrowed here — the same thing `savePushState` does.
  await chmod(stateDir, 0o700).catch(() => undefined)

  const target = adminStatePath(stateDir)
  const temporary = `${target}.${process.pid}.tmp`

  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, target)
}

/** This person's options, or the defaults for somebody nobody has decided about. */
export function optionsFor(state: AdminState, userId: string): AdminUserOptions {
  const row = state.users[userId]

  return row
    ? { allowedBots: row.allowedBots, readOnly: row.readOnly, pushAllowed: row.pushAllowed }
    : DEFAULT_USER_OPTIONS
}

/** Is this bot one this person may reach? `null` means every bot. */
export function mayReachBot(options: AdminUserOptions, bot: string): boolean {
  return options.allowedBots === null || options.allowedBots.includes(bot)
}
