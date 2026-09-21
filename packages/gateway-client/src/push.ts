/**
 * ADR-0017's registration, from the device's side of it.
 *
 * [ADR-0017](../../../docs/adr/0017-push-through-hermie-web.md) puts a device's
 * push registration in the `hermie-app` key of the default profile's `ui_meta`
 * rather than at an endpoint: the app never talks to the daemon, so there is no
 * inbound surface and nothing on the network can make a phone buzz. The daemon's
 * READER lives in `packages/hermie-web/src/push/registrations.ts`; this is the
 * WRITER, and it is here rather than in the app because the browser build and
 * the native build both have to produce the same bytes.
 *
 * Two properties are the whole of what this module exists for, and both are
 * about a section that belongs to more than one device:
 *
 *  - **A write carries the neighbours.** ADR-0016 replaces a `ui_meta` section
 *    WHOLE — there is no merge — so a device that wrote only its own row would
 *    silently unregister every other device the moment it changed a toggle. The
 *    rows this device did not write are read back and passed through untouched,
 *    including rows whose `v` this build does not understand: carrying bytes
 *    forward needs no schema, and dropping a future build's row because it is
 *    unreadable here would turn a version skew into a phone that goes quiet.
 *  - **The address decides the shape.** `token` for `expo`, `endpoint` + `keys`
 *    for `webpush`, never both — the reader drops an entry that carries the
 *    fields of both transports rather than guessing which one was meant, so a
 *    writer that emitted both would be writing an entry that is ignored.
 *
 * Nothing here talks to a gateway. The section this builds is handed to
 * `UiMetaSync` as part of the app-wide snapshot, which is what gives it the
 * compare-and-swap, the retry and the local-only fallback for free.
 */

/** The section version this build writes. The reader checks it per row. */
export const PUSH_SECTION_VERSION = 1

/** Where the registrations sit inside the `hermie-app` key. */
export const PUSH_SECTION_KEY = 'push'

/**
 * Every event a device can ask about. A registration that names none is off.
 *
 * `dm` is deliberately NOT here any more. ADR-0017's amendment records why: a
 * bot-to-bot DM has no hook in Hermes, so the plugin — which is now the default
 * notifier — cannot produce one and does not advertise it. The type stays in
 * the wire schema, because a registration written by an older build still
 * carries it and `hermie-web --push` can still send one; what changed is that
 * this app no longer offers a switch for something that will never arrive.
 *
 * `turn_done` and `turn_failed` are the amendment's two additions, from
 * `on_session_end`. An INTERRUPTED turn is deliberately neither: somebody
 * pressed stop, and they know.
 */
export const PUSH_TYPES = ['message', 'request', 'cron', 'turn_done', 'turn_failed'] as const

export type PushType = (typeof PUSH_TYPES)[number]

export type PushTransport = 'expo' | 'webpush'

export interface WebPushKeys {
  p256dh: string
  auth: string
}

/**
 * Where a notification is sent, as the platform handed it over.
 *
 * A union rather than a bag of optional fields, because "both" is the one shape
 * the daemon refuses and a type that can express it is a type that will.
 */
export type PushAddress =
  { transport: 'expo'; token: string } | { transport: 'webpush'; endpoint: string; keys: WebPushKeys }

/** This device's registration, before it becomes a row. */
export interface PushRegistrationInput {
  installationId: string
  address: PushAddress
  /** `ios`, `android` or `web`. Informational; the daemon does not route on it. */
  platform: string
  types: Record<PushType, boolean>
  /** Whether this device wants the message text as well as the bot's name. */
  preview: boolean
  /** Seconds, not milliseconds: the daemon compares it against `time.time()`. */
  updatedAt: number
}

/** The section as it travels, which is a plain bag both sides read defensively. */
export interface PushSectionShape {
  registrations: Record<string, unknown>
  seen: Record<string, number>
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** Epoch SECONDS from a millisecond clock, floored — the daemon's unit. */
export const pushStampOf = (nowMs: number): number => Math.floor(nowMs / 1000)

/** Every type off. The starting point, and what a device that never opted in sends. */
export function noPushTypes(): Record<PushType, boolean> {
  const types = {} as Record<PushType, boolean>

  for (const type of PUSH_TYPES) {
    types[type] = false
  }

  return types
}

/** Read a types bag defensively: absent means OFF, exactly as the daemon reads it. */
export function pushTypesOf(value: unknown): Record<PushType, boolean> {
  const source = isObject(value) ? value : {}
  const types = noPushTypes()

  for (const type of PUSH_TYPES) {
    types[type] = source[type] === true
  }

  return types
}

/** True when this registration has asked about nothing, which is "off". */
export const noTypeWanted = (types: Record<PushType, boolean>): boolean =>
  PUSH_TYPES.every(type => types[type] !== true)

/**
 * One device's row.
 *
 * Exported on its own so a test can assert the bytes rather than the round trip,
 * and so the browser build and the native build cannot drift into two shapes.
 */
export function pushRowFor(input: PushRegistrationInput): Record<string, unknown> {
  const common = {
    v: PUSH_SECTION_VERSION,
    platform: input.platform,
    types: { ...input.types },
    preview: input.preview,
    updatedAt: input.updatedAt
  }

  return input.address.transport === 'expo'
    ? { ...common, transport: 'expo', token: input.address.token }
    : {
        ...common,
        transport: 'webpush',
        endpoint: input.address.endpoint,
        keys: { p256dh: input.address.keys.p256dh, auth: input.address.keys.auth }
      }
}

/**
 * The rows in a section that some OTHER installation wrote.
 *
 * Deliberately unvalidated. This is what a write carries forward, and a row is
 * carried because of who wrote it, not because this build can read it — see the
 * note at the top. The one thing it will not carry is a row under this device's
 * own id, which is ours to replace.
 */
export function foreignPushRows(section: unknown, installationId: string): Record<string, unknown> {
  const push = isObject(section) ? section[PUSH_SECTION_KEY] : null
  const rows = isObject(push) && isObject(push.registrations) ? push.registrations : {}
  const out: Record<string, unknown> = {}

  for (const [id, row] of Object.entries(rows)) {
    if (id && id !== installationId && row !== null && row !== undefined) {
      out[id] = row
    }
  }

  return out
}

/** The `seen` stamps in a section, as numbers, dropping anything that is not one. */
export function pushSeenOf(section: unknown): Record<string, number> {
  const push = isObject(section) ? section[PUSH_SECTION_KEY] : null
  const raw = isObject(push) && isObject(push.seen) ? push.seen : {}
  const out: Record<string, number> = {}

  for (const [id, value] of Object.entries(raw)) {
    if (id && typeof value === 'number' && Number.isFinite(value) && value > 0) {
      out[id] = Math.floor(value)
    }
  }

  return out
}

/**
 * How long a `seen` stamp is kept before it is swept out of the section.
 *
 * It is not the daemon's suppression window — that is the daemon's to choose and
 * is much shorter. This is only about a section that would otherwise accumulate
 * one number per device that ever read a chat, for ever. A day is long enough
 * that no live device is ever dropped and short enough that a phone which was
 * reinstalled stops taking up room.
 */
export const PUSH_SEEN_TTL_SECONDS = 86_400

export interface PushSectionInput {
  /** Rows belonging to other installations, from `foreignPushRows`. */
  others: Record<string, unknown>
  /** This device's registration, or `null` when it is off. */
  own: PushRegistrationInput | null
  /** Every `seen` stamp this device knows about, including its own. */
  seen: Record<string, number>
  /** Epoch seconds. Sweeps `seen`; does NOT stamp the registration. */
  now: number
}

/**
 * The whole `push` section, or `undefined` when there is nothing to say.
 *
 * `undefined` rather than an empty object on purpose: the caller spreads the
 * result into the app-wide section, and a `push: {registrations: {}, seen: {}}`
 * on a profile belonging to somebody who has never turned notifications on is a
 * key that means nothing and a revision that moves for no reason.
 */
export function pushSectionFor(input: PushSectionInput): PushSectionShape | undefined {
  const registrations: Record<string, unknown> = { ...input.others }

  if (input.own && input.own.installationId && !noTypeWanted(input.own.types)) {
    registrations[input.own.installationId] = pushRowFor(input.own)
  }

  const seen: Record<string, number> = {}

  for (const [id, at] of Object.entries(input.seen)) {
    // A stamp from the future is a device with a wrong clock, not a reason to
    // drop it: only the old ones are swept.
    if (at > 0 && input.now - at <= PUSH_SEEN_TTL_SECONDS) {
      seen[id] = at
    }
  }

  return Object.keys(registrations).length || Object.keys(seen).length ? { registrations, seen } : undefined
}
