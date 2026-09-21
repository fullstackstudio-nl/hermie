/**
 * The devices that asked to be told, as they appear on the gateway.
 *
 * [ADR-0017](../../../../docs/adr/0017-push-through-hermie-web.md) puts a
 * device's push registration in its own `ui_meta` section rather than at an
 * endpoint on this process: the app never talks to the daemon, so there is no
 * inbound surface and nothing on the network can make a phone buzz. What
 * reaches this module is therefore a bag of JSON that came off a gateway, and
 * it is read the way anything off a wire is read — one unreadable entry costs
 * that entry and nothing else.
 *
 * The schema is ADR-0017's, and `v` is checked rather than assumed. A reader
 * that meets a version it does not know DROPS that registration instead of
 * guessing at a shape: the cost is one device that stops being notified until
 * it is updated, and the alternative is sending a token somewhere it does not
 * belong.
 */

/** The section version this build writes and accepts. */
export const PUSH_SECTION_VERSION = 1

/** Where the registrations sit inside the `hermie-app` key. */
export const PUSH_SECTION_KEY = 'push'

/**
 * The app-wide `ui_meta` key, on the default profile.
 *
 * [ADR-0016](../../../../docs/adr/0016-ui-meta-sync.md) put it there because the
 * default row is the one every client can find without being told which bot to
 * ask, and ADR-0017 hangs `push` off it for the same reason.
 */
export const HERMIE_APP_KEY = 'hermie-app'

/** Every event a device can ask about. A registration that names none is off. */
export const PUSH_TYPES = ['message', 'request', 'dm', 'cron'] as const

export type PushType = (typeof PUSH_TYPES)[number]

export type PushTransport = 'expo' | 'webpush'

export interface WebPushKeys {
  p256dh: string
  auth: string
}

export interface PushRegistration {
  /** The installation that wrote it; the key it was stored under. */
  installationId: string
  transport: PushTransport
  /** Expo only: the push token, which is the whole address. */
  token?: string
  /** Web Push only: the subscription endpoint and its keys. */
  endpoint?: string
  keys?: WebPushKeys
  platform: string
  types: Record<PushType, boolean>
  /** Whether this device wants the message text as well as the bot's name. */
  preview: boolean
  updatedAt: number
}

export interface PushSection {
  registrations: PushRegistration[]
  /** installation id → the last time that device said a chat was on screen. */
  seen: Record<string, number>
}

const EMPTY: PushSection = { registrations: [], seen: {} }

const str = (value: unknown): string => (typeof value === 'string' ? value : '')

const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

function typesOf(value: unknown): Record<PushType, boolean> {
  const source = (value ?? {}) as Record<string, unknown>
  const out = {} as Record<PushType, boolean>

  for (const type of PUSH_TYPES) {
    // Absent means OFF. A device that has never heard of a type cannot have
    // agreed to it, and a new event kind must not start notifying every
    // registration that predates it.
    out[type] = source[type] === true
  }

  return out
}

/**
 * Read one registration, or nothing.
 *
 * The address is what decides: an `expo` entry is useless without its token and
 * a `webpush` one without its endpoint AND both keys, and an entry that carries
 * the fields of both transports is a confusion rather than a choice — it is
 * dropped rather than resolved in favour of one.
 */
export function pushRegistrationOf(installationId: string, value: unknown): PushRegistration | null {
  if (!installationId || !value || typeof value !== 'object') {
    return null
  }

  const row = value as Record<string, unknown>

  if (num(row.v) !== PUSH_SECTION_VERSION) {
    return null
  }

  const transport = str(row.transport)
  const token = str(row.token)
  const endpoint = str(row.endpoint)
  const keys = (row.keys ?? {}) as Record<string, unknown>
  const p256dh = str(keys.p256dh)
  const auth = str(keys.auth)

  const common = {
    installationId,
    platform: str(row.platform) || 'unknown',
    types: typesOf(row.types),
    preview: row.preview === true,
    updatedAt: num(row.updatedAt)
  }

  if (transport === 'expo') {
    return token && !endpoint ? { ...common, transport: 'expo', token } : null
  }

  if (transport === 'webpush') {
    return endpoint && p256dh && auth && !token
      ? { ...common, transport: 'webpush', endpoint, keys: { auth, p256dh } }
      : null
  }

  return null
}

/** Read the whole `push` section out of a `hermie-app` bag. */
export function readPushSection(section: unknown): PushSection {
  const push = (section as { push?: unknown } | null)?.push

  if (!push || typeof push !== 'object') {
    return EMPTY
  }

  const body = push as Record<string, unknown>
  const rows = (body.registrations ?? {}) as Record<string, unknown>
  const registrations: PushRegistration[] = []

  for (const [installationId, value] of Object.entries(rows)) {
    const registration = pushRegistrationOf(installationId, value)

    if (registration) {
      registrations.push(registration)
    }
  }

  const rawSeen = (body.seen ?? {}) as Record<string, unknown>
  const seen: Record<string, number> = {}

  for (const [installationId, value] of Object.entries(rawSeen)) {
    /*
      Two shapes. A bare number is what every app before `push.seen.per_chat`
      wrote; `{bot, at}` is what a newer one writes where the gateway said it
      could be read. This daemon suppresses on "somebody is reading SOMETHING",
      which is what the number always meant, so it takes `at` and ignores the
      chat name — over-suppressing in the direction ADR-0017 already chose,
      rather than reading a newer section as a device that looks away for ever.
    */
    const at =
      value && typeof value === 'object' && !Array.isArray(value) ? num((value as { at?: unknown }).at) : num(value)

    if (at > 0) {
      seen[installationId] = at
    }
  }

  // A stable order, so a run's log and a test read the same twice. The gateway
  // hands back an object, and object key order is not a promise anybody made.
  registrations.sort((a, b) => a.installationId.localeCompare(b.installationId))

  return { registrations, seen }
}

/** The registrations that asked about this kind of event. */
export function registrationsFor(section: PushSection, type: PushType): PushRegistration[] {
  return section.registrations.filter(registration => registration.types[type])
}

/**
 * Was any device looking at a chat within the window?
 *
 * The gateway cannot be asked who is attached — `session.active_list` reports
 * the CALLING connection's own session and nobody else's — so ADR-0017 makes
 * this a heartbeat the app writes and this reads. It is a heuristic and it
 * fails towards a redundant notification for a chat somebody is already
 * reading, which is the right direction.
 */
export function someoneAttached(section: PushSection, now: number, windowSeconds: number): boolean {
  return Object.values(section.seen).some(at => now - at <= windowSeconds)
}
