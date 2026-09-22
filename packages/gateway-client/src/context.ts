/**
 * The `context` section of `hermie-app`, from the device's side of it.
 *
 * The gateway-side plugin reads a small description of the person and the
 * device they are on and renders it once into a bot's system prompt. The shape
 * it reads is fixed by `context/render.py` in the plugin repository:
 *
 * ```json
 * {"context": {"v": 1,
 *              "default": "<user id>",
 *              "users": {"<user id>": {"displayName": "…",
 *                                      "about": "…",
 *                                      "device": {"model": "…", "os": "…", "appVersion": "…"},
 *                                      "timezone": "Europe/Amsterdam",
 *                                      "locale": "nl-NL",
 *                                      "perBot": {"<bot>": "…"},
 *                                      "updatedAt": 1789957143}}}}
 * ```
 *
 * This module is the WRITER, and it sits beside `push.ts` for the same two
 * reasons that one gives:
 *
 *  - **A write carries the neighbours.** ADR-0016 replaces a `ui_meta` section
 *    WHOLE, so a device that wrote only its own user's row would erase every
 *    other person's context the moment somebody changed a toggle. Rows this
 *    device did not write are carried through untouched, including rows whose
 *    shape this build does not understand.
 *  - **The caps are applied HERE, not only on the far side.** The plugin
 *    truncates what it renders, so a long field costs nothing in the prompt
 *    either way — but an uncapped field still travels, still sits in the
 *    profile's `ui_meta`, and still has to be carried by every other device's
 *    write. Bounding it at the source is what keeps the section small for
 *    everybody.
 *
 * Every string is flattened to single spaces before it is cut, exactly as
 * `render.py` does with `" ".join(value.split())`. That is not cosmetic: the
 * plugin renders one fact per LINE, so a field with newlines in it would become
 * several lines that look like several facts.
 */

/** The section version this build writes. The plugin drops anything else. */
export const CONTEXT_SECTION_VERSION = 1

/** Where the context sits inside the `hermie-app` key. */
export const CONTEXT_SECTION_KEY = 'context'

/**
 * Per-field caps, mirroring `LIMITS` in the plugin's `context/render.py`.
 *
 * They are per field rather than one budget so that one long field cannot crowd
 * out the short ones that identify the person — the plugin says the same thing
 * about the same numbers, and the two have to agree or the app would show a
 * character count the gateway does not honour.
 */
export const CONTEXT_LIMITS = {
  displayName: 80,
  about: 600,
  model: 60,
  os: 40,
  appVersion: 30,
  timezone: 60,
  locale: 20,
  perBot: 400,
  /** Not the plugin's; `read_section` reads `default` with a cap of 128. */
  userId: 128
} as const

/** What the device knows about itself. Always sent; none of it is a decision. */
export interface ContextDevice {
  /** `iPhone 17 Pro`, or whatever the platform will admit to. */
  model: string
  /** `iOS 27.0`, `Android 15`, a browser's platform string. */
  os: string
  /** `0.1.0 (1284) · 7c838c4` — version, build and commit, as About shows it. */
  appVersion: string
}

/** One person's row, before it becomes JSON. */
export interface ContextUserInput {
  userId: string
  /** From the gateway identity, and only when the reader left the switch on. */
  displayName?: string
  /** What the reader wrote about themselves. Opt-in, so usually absent. */
  about?: string
  device: ContextDevice
  timezone?: string
  locale?: string
  /** Bot name → a note for that chat only. Empty notes are dropped. */
  perBot?: Record<string, string>
  /** Epoch SECONDS: the plugin compares it against `time.time()`. */
  updatedAt: number
}

export interface ContextSectionShape {
  v: number
  /** Whose context to use when the gateway cannot say who is asking. */
  default: string
  users: Record<string, unknown>
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/**
 * One field, flattened and cut, exactly as the plugin would.
 *
 * Exported because the settings screen counts against the same number: a field
 * that says "600 characters" and then sends 600 characters of something else
 * is a field that lied about what it stored.
 */
export function contextTextOf(value: unknown, limit: number): string {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return ''
  }

  return String(value).split(/\s+/u).filter(Boolean).join(' ').slice(0, limit)
}

/**
 * This device's row for one person.
 *
 * Empty fields are OMITTED rather than written as `""`. The plugin treats the
 * two identically, and an object full of empty strings is bytes every other
 * device has to carry through its own writes for ever.
 */
export function contextRowFor(input: ContextUserInput): Record<string, unknown> {
  const displayName = contextTextOf(input.displayName, CONTEXT_LIMITS.displayName)
  const about = contextTextOf(input.about, CONTEXT_LIMITS.about)
  const timezone = contextTextOf(input.timezone, CONTEXT_LIMITS.timezone)
  const locale = contextTextOf(input.locale, CONTEXT_LIMITS.locale)

  const device: Record<string, string> = {}
  const model = contextTextOf(input.device.model, CONTEXT_LIMITS.model)
  const os = contextTextOf(input.device.os, CONTEXT_LIMITS.os)
  const appVersion = contextTextOf(input.device.appVersion, CONTEXT_LIMITS.appVersion)

  if (model) {
    device.model = model
  }

  if (os) {
    device.os = os
  }

  if (appVersion) {
    device.appVersion = appVersion
  }

  const perBot: Record<string, string> = {}

  for (const [bot, note] of Object.entries(input.perBot ?? {})) {
    const text = contextTextOf(note, CONTEXT_LIMITS.perBot)

    if (bot && text) {
      perBot[bot] = text
    }
  }

  return {
    ...(displayName ? { displayName } : {}),
    ...(about ? { about } : {}),
    ...(Object.keys(device).length ? { device } : {}),
    ...(timezone ? { timezone } : {}),
    ...(locale ? { locale } : {}),
    ...(Object.keys(perBot).length ? { perBot } : {}),
    updatedAt: Math.floor(input.updatedAt)
  }
}

/**
 * The rows in a section that belong to somebody else.
 *
 * Deliberately unvalidated, for the reason `foreignPushRows` gives: a row is
 * carried because of whose it is, not because this build can read it. Dropping
 * a row written by a newer app would take a colleague's context away on the
 * next toggle somebody here touches.
 */
export function foreignContextUsers(section: unknown, userId: string): Record<string, unknown> {
  const context = isObject(section) ? section[CONTEXT_SECTION_KEY] : null
  const users = isObject(context) && isObject(context.users) ? context.users : {}
  const out: Record<string, unknown> = {}

  for (const [id, row] of Object.entries(users)) {
    if (id && id !== userId && row !== null && row !== undefined) {
      out[id] = row
    }
  }

  return out
}

/**
 * The row a section holds for one person, or `null` when it holds none.
 *
 * Returned unread, like `foreignContextUsers` returns its rows and for the same
 * reason: a row written by a newer app is still that person's row, and a reader
 * that dropped what it could not parse would drop it from the next write too.
 */
export function contextRowOf(section: unknown, userId: string): unknown {
  const context = isObject(section) ? section[CONTEXT_SECTION_KEY] : null
  const users = isObject(context) && isObject(context.users) ? context.users : {}
  const row = userId ? users[userId] : undefined

  return row === undefined ? null : row
}

/**
 * The device half of a row, flattened, so two copies can be compared.
 *
 * The person half — their name, what they wrote about themselves, a note for
 * one chat — is deliberately not in here. That half is the same wherever they
 * are sitting; only these five fields say which machine the row was written
 * from, and they are the only reason a row has to be written again by a device
 * that changed nothing.
 */
function deviceFactsOf(row: unknown): string {
  const source = isObject(row) ? row : {}
  const device = isObject(source.device) ? source.device : {}

  return [
    contextTextOf(device.model, CONTEXT_LIMITS.model),
    contextTextOf(device.os, CONTEXT_LIMITS.os),
    contextTextOf(device.appVersion, CONTEXT_LIMITS.appVersion),
    contextTextOf(source.timezone, CONTEXT_LIMITS.timezone),
    contextTextOf(source.locale, CONTEXT_LIMITS.locale)
  ].join(' ')
}

/**
 * Whether a stored row was written from somewhere other than here.
 *
 * The section is keyed by PERSON, so one row serves every device they use and
 * the last writer owns it. A phone that opens the same gateway an hour after a
 * desktop wrote it has changed nothing of its own and would never send — while
 * the bot goes on being told about the desktop. This is the question that says
 * the row is somebody else's machine, asked against the same normalisation the
 * write uses so that a cap or a collapsed space is never mistaken for a change.
 */
export function contextDeviceFactsDiffer(row: unknown, own: ContextUserInput): boolean {
  return deviceFactsOf(row) !== deviceFactsOf(contextRowFor(own))
}

export interface ContextSectionInput {
  /** Rows belonging to other people, from `foreignContextUsers`. */
  others: Record<string, unknown>
  /** This device's row, or `null` when there is no identity to write one under. */
  own: ContextUserInput | null
  /**
   * The `default` the section already carried, from `contextDefaultOf`.
   *
   * Used only when this device has no identity of its own. Blanking a default
   * that somebody else's app set would take the fallback away from the gateway
   * on the next write this device happens to make.
   */
  fallbackDefault?: string
}

/**
 * The whole `context` section, or `undefined` when there is nothing to say.
 *
 * `undefined` rather than an empty object, for the same reason `pushSectionFor`
 * answers that way: the caller spreads this into the app-wide section, and a
 * `context` key on the profile of somebody who has never been identified is a
 * revision that moves for no reason.
 */
export function contextSectionFor(input: ContextSectionInput): ContextSectionShape | undefined {
  const users: Record<string, unknown> = { ...input.others }
  const ownId = contextTextOf(input.own?.userId, CONTEXT_LIMITS.userId)

  if (input.own && ownId) {
    users[ownId] = contextRowFor({ ...input.own, userId: ownId })
  }

  if (!Object.keys(users).length) {
    return undefined
  }

  /*
    `default` is this device's person when there is one, and otherwise whatever
    the section already said. Blanking it because this device happens not to
    know who it is would take the fallback away from a gateway where somebody
    else's app had set it.
  */
  return {
    v: CONTEXT_SECTION_VERSION,
    default: ownId || contextTextOf(input.fallbackDefault, CONTEXT_LIMITS.userId),
    users
  }
}

/** Read the `default` a section already carries, for a write that keeps it. */
export function contextDefaultOf(section: unknown): string {
  const context = isObject(section) ? section[CONTEXT_SECTION_KEY] : null

  return isObject(context) ? contextTextOf(context.default, CONTEXT_LIMITS.userId) : ''
}
