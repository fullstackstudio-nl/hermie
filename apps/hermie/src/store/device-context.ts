/**
 * What this device tells a bot about the person using it.
 *
 * The gateway-side plugin reads a `context` section out of the `hermie-app`
 * `ui_meta` key and renders it into a bot's system prompt once per session.
 * This store is the app's half: the reader's decisions, the facts the device
 * knows about itself, and the rows that belong to OTHER people on the same
 * gateway — which, exactly as with the push section, have to be carried through
 * every write or they are erased ([ADR-0016](../../../docs/adr/0016-ui-meta-sync.md)).
 *
 * Two switches are the reader's and are persisted here, and both start ON:
 *
 *  - **The name.** It is the gateway's own identity for them, which everybody
 *    with access to the gateway can already read off the roster; telling the
 *    bot who it is talking to is the whole point of the feature. The switch is
 *    about the DECISION and nothing else — see `effectiveDisplayName` for why
 *    it may not be read off whether a name happens to be known.
 *  - **The free text.** The switch is on and the text itself is EMPTY, which is
 *    the distinction that makes an on-by-default switch honest here: nothing is
 *    shared until somebody writes something, and when they do it works without
 *    a second control to find. Turning it off is what stops an existing note
 *    travelling.
 *
 * The device facts are not a switch at all. Model, OS, app version, timezone
 * and locale are always sent, and they are shown back verbatim in Settings
 * instead of being described, because a fact a reader cannot see is a fact they
 * cannot decide about.
 *
 * **`updatedAt` moves only when the content does.** `ui-meta-bridge.ts` decides
 * what to send by fingerprinting the projection, so a stamp taken at projection
 * time would differ on every comparison and the bridge would send the section
 * for ever. Every setter here stamps; nothing else does.
 */
import { contextTextOf, CONTEXT_LIMITS, type ContextUserInput } from '@hermie/gateway-client/context'
import { create } from 'zustand'

import { readDeviceFacts, type DeviceFacts } from '../platform/device-facts'
import { keyValueStore } from '../platform/key-value-store'

/** Everything this device stores about context, under one key. */
export const DEVICE_CONTEXT_KEY = 'hermie.context'

/**
 * The user id used where the gateway cannot name anybody.
 *
 * A session-token gateway has no identity to ask for — `/api/auth/me` answers
 * for a person and there is no person — and the plugin's resolution order ends
 * at "the only registered user, if there is exactly one". A fixed id is what
 * makes that case a hit rather than a coin toss, and `owner` is what the
 * gateway's own documentation calls whoever runs it.
 */
export const OWNER_USER_ID = 'owner'

const EMPTY_FACTS: DeviceFacts = { model: '', os: '', appVersion: '', timezone: '', locale: '' }

/**
 * A cap for the stored address. RFC 5321's longest path, and nothing rides on
 * the exact number: the address itself is never sent, only the part of it that
 * becomes a name, and that is cut again at `CONTEXT_LIMITS.displayName`.
 */
const EMAIL_LIMIT = 320

/** The part of this store that survives a launch. The reader's half only. */
interface PersistedContext {
  shareDisplayName: boolean
  shareAbout: boolean
  about: string
  perBot: Record<string, string>
  /**
   * The gateway whose sharing notice has been acknowledged.
   *
   * An address rather than a boolean: the notice says "everyone with access to
   * THIS gateway can read it", so the answer belongs to that gateway and moving
   * to another one is a new question.
   */
  acknowledgedFor: string
}

export interface DeviceContextState {
  /** The gateway this identity belongs to. Empty before one is configured. */
  baseUrl: string
  /** True where the gateway has accounts, which is where the notice applies. */
  gated: boolean
  /** Who the gateway says this is. Empty until an identity has been read. */
  userId: string
  /** The gateway's own display name for them. Often empty; see `effectiveDisplayName`. */
  displayName: string
  /** The address the gateway signed them in with, if it named one. Never sent. */
  email: string
  shareDisplayName: boolean
  shareAbout: boolean
  about: string
  /** Bot name → a note for that chat only. */
  perBot: Record<string, string>
  facts: DeviceFacts
  /** Epoch SECONDS. Moved by a setter, never by a projection. */
  updatedAt: number
  /** Rows belonging to other people, carried through a write untouched. */
  others: Record<string, unknown>
  /**
   * The gateway's own copy of THIS person's row, or `null` when it holds none.
   *
   * Two things hang off it, and both are about the second device somebody signs
   * in on. See `needsSharingNotice` for why its presence answers the sharing
   * question, and `carriedContextUsers` for why a device that cannot write a row
   * of its own has to carry this one instead of dropping it.
   */
  remoteOwnRow: unknown
  /** The `default` the section already carried, kept when this device has none. */
  remoteDefault: string
  acknowledgedFor: string
  loaded: boolean

  hydrate: () => Promise<void>
  /** Who this device is on which gateway. Empty `userId` writes no row at all. */
  setIdentity: (identity: {
    baseUrl: string
    gated: boolean
    userId: string
    displayName: string
    email: string
  }) => void
  setShareDisplayName: (on: boolean, stamp: number) => void
  setShareAbout: (on: boolean, stamp: number) => void
  setAbout: (about: string, stamp: number) => void
  setBotNote: (bot: string, note: string, stamp: number) => void
  /** Re-read the device's own facts. A no-op when nothing actually changed. */
  refreshFacts: (stamp: number, facts?: DeviceFacts) => void
  /** Remember that the sharing notice was accepted for this gateway. */
  acknowledge: (baseUrl: string) => void
  applyRemote: (patch: { others: Record<string, unknown>; remoteDefault: string; own?: unknown }) => void
  /**
   * Re-date this device's row so the next write replaces the gateway's copy.
   *
   * The section is keyed by PERSON and one row serves every device they use, so
   * the last writer owns it. A device that has changed nothing of its own has
   * nothing for the bridge to notice — and the bridge is a diff over this
   * store — so claiming the row is a state change or it is nothing at all.
   */
  claimRow: (stamp: number) => void
  /** Forget the identity and the neighbours: a sign-out, or another gateway. */
  retire: () => void
  reset: () => void
}

let writeQueue: Promise<void> = Promise.resolve()

function persist(state: PersistedContext): void {
  writeQueue = writeQueue
    .then(() => keyValueStore.setJson(DEVICE_CONTEXT_KEY, state))
    .catch(() => {
      // A preference that failed to persist comes back to its default on the
      // next launch. That is a switch to set again, not an error worth a screen.
    })
}

const textOf = (value: unknown, limit: number): string => (typeof value === 'string' ? value.slice(0, limit) : '')

function perBotOf(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }

  const out: Record<string, string> = {}

  for (const [bot, note] of Object.entries(value as Record<string, unknown>)) {
    const text = textOf(note, CONTEXT_LIMITS.perBot)

    if (bot && text) {
      out[bot] = text
    }
  }

  return out
}

export const useDeviceContextStore = create<DeviceContextState>((set, get) => {
  const save = (): void => {
    const { shareDisplayName, shareAbout, about, perBot, acknowledgedFor } = get()

    persist({ shareDisplayName, shareAbout, about, perBot, acknowledgedFor })
  }

  return {
    baseUrl: '',
    gated: false,
    userId: '',
    displayName: '',
    email: '',
    // Both on: see the note at the top about what an on-by-default switch over
    // an empty field does and does not share.
    shareDisplayName: true,
    shareAbout: true,
    about: '',
    perBot: {},
    facts: EMPTY_FACTS,
    updatedAt: 0,
    others: {},
    remoteOwnRow: null,
    remoteDefault: '',
    acknowledgedFor: '',
    loaded: false,

    async hydrate() {
      if (get().loaded) {
        return
      }

      const stored = await keyValueStore.getJson<PersistedContext>(DEVICE_CONTEXT_KEY)

      set({
        shareDisplayName: stored?.shareDisplayName !== false,
        shareAbout: stored?.shareAbout !== false,
        about: textOf(stored?.about, CONTEXT_LIMITS.about),
        perBot: perBotOf(stored?.perBot),
        acknowledgedFor: textOf(stored?.acknowledgedFor, 512),
        facts: readDeviceFacts(),
        /*
          Stamped here, and this is the only place a clock is read outside a
          setter. Without it the FIRST row a device ever writes carries
          `updatedAt: 0` — measured on the simulator, where the section reached
          the gateway complete and dated 1970. The projection still never reads
          a clock, which is what keeps the bridge from sending for ever.
        */
        updatedAt: Math.floor(Date.now() / 1000),
        loaded: true
      })
    },

    setIdentity({ baseUrl, gated, userId, displayName, email }) {
      const id = contextTextOf(userId, CONTEXT_LIMITS.userId)
      const name = contextTextOf(displayName, CONTEXT_LIMITS.displayName)
      const address = contextTextOf(email, EMAIL_LIMIT)
      const current = get()

      if (
        current.userId === id &&
        current.displayName === name &&
        current.email === address &&
        current.baseUrl === baseUrl &&
        current.gated === gated
      ) {
        return
      }

      set({ baseUrl, gated, userId: id, displayName: name, email: address })
    },

    setShareDisplayName(on, stamp) {
      set({ shareDisplayName: on, updatedAt: stamp })
      save()
    },

    setShareAbout(on, stamp) {
      set({ shareAbout: on, updatedAt: stamp })
      save()
    },

    setAbout(about, stamp) {
      set({ about: about.slice(0, CONTEXT_LIMITS.about), updatedAt: stamp })
      save()
    },

    setBotNote(bot, note, stamp) {
      const perBot = { ...get().perBot }
      const text = note.slice(0, CONTEXT_LIMITS.perBot)

      if (text.trim()) {
        perBot[bot] = text
      } else {
        // An emptied field removes the note rather than storing a blank one:
        // the section is rewritten whole and a key with nothing under it is a
        // key every other device has to carry for ever.
        delete perBot[bot]
      }

      set({ perBot, updatedAt: stamp })
      save()
    },

    refreshFacts(stamp, facts) {
      const next = facts ?? readDeviceFacts()
      const current = get().facts
      const changed = (Object.keys(next) as (keyof DeviceFacts)[]).some(key => current[key] !== next[key])

      if (!changed) {
        return
      }

      // A new app version, a flight across a timezone, a phone that was
      // renamed. The stamp moves with it so the gateway can see the row is
      // current rather than merely present.
      set({ facts: next, updatedAt: stamp })
    },

    acknowledge(baseUrl) {
      set({ acknowledgedFor: baseUrl })
      save()
    },

    applyRemote(patch) {
      set({
        others: patch.others,
        remoteDefault: patch.remoteDefault,
        // `undefined` is a caller that did not look, which is not the same
        // answer as "the gateway holds no row for this person" and must not be
        // read as one — the sharing notice turns on the difference.
        ...(patch.own === undefined ? {} : { remoteOwnRow: patch.own })
      })
    },

    claimRow(stamp) {
      set({ updatedAt: stamp })
    },

    retire() {
      /*
        The identity goes and the preferences stay — a sign-out is not a change
        of mind about what somebody is willing to share. The OTHER people's rows
        stay too, for the same reason the push store keeps its neighbours: this
        store is what the next write of the section is built from, and clearing
        them here would write a section with only the leaving person's absence
        in it and take everybody else's context with it. They are replaced
        wholesale by the next gateway's reconcile, which runs before its first
        flush.
      */
      set({ baseUrl: '', gated: false, userId: '', displayName: '', email: '', remoteOwnRow: null })
    },

    reset() {
      set({
        baseUrl: '',
        gated: false,
        userId: '',
        displayName: '',
        email: '',
        shareDisplayName: true,
        shareAbout: true,
        about: '',
        perBot: {},
        facts: EMPTY_FACTS,
        updatedAt: 0,
        others: {},
        remoteOwnRow: null,
        remoteDefault: '',
        acknowledgedFor: '',
        loaded: false
      })
    }
  }
})

/**
 * Whether this gateway's sharing notice still has to be shown.
 *
 * Only on a gateway that can have more than one person on it. A session-token
 * gateway has no accounts, so "everyone with access to this gateway" is the
 * person holding the phone, and telling them that their own gateway can read
 * their own context is noise.
 *
 * **A row already on the gateway is an answer.** The acknowledgement is stored
 * on the device that gave it, and the question is not the device's: the notice
 * says "everyone with access to THIS gateway can read it", so it is answered
 * per gateway — which is why what is remembered is an address and not a
 * boolean. A second device therefore asked a question the person had already
 * answered, and until they answered it again on that device too, `ownContextRow`
 * stayed `null` there: the phone beside the desktop never said which machine it
 * was, and — worse — wrote a section with the person missing from it. Their own
 * row, found on the gateway under their own id, is that answer.
 */
export function needsSharingNotice(state: DeviceContextState): boolean {
  if (!state.gated || !state.baseUrl || state.acknowledgedFor === state.baseUrl) {
    return false
  }

  return state.remoteOwnRow === null || state.remoteOwnRow === undefined
}

/** `sebas@example.invalid` → `sebas`. Nothing at all for something that is not one. */
const EMAIL_LOCAL_PART = /^([^@\s]+)@[^@\s]+$/u

/**
 * `authentik:7f3a…` → `7f3a…`, and `https://issuer/…` left alone.
 *
 * The gateway addresses a person as `<provider>:<subject>`, and the provider is
 * the half that says nothing about WHO: two people on the same gateway share
 * it. The negative lookahead is the whole reason this is a regular expression
 * rather than a `split(':')` — an issuer URL used as a subject also has a colon
 * in it, and cutting at that one turns `https://issuer/x` into `//issuer/x`.
 */
const PROVIDER_PREFIX = /^[A-Za-z][A-Za-z0-9._-]*:(?!\/\/)(.+)$/u

/**
 * The name a bot is actually told, which is rarely the one the gateway sends.
 *
 * Measured on a real gateway with OIDC: `/api/auth/me` answered with a user id
 * and NOTHING else — no `display_name`, no `email`. The switch above used to be
 * rendered from `shareDisplayName && displayName`, so it showed OFF on a
 * gateway where the setting was on, and the only honest reading of an off
 * switch is "this is not being sent". Hence two separate things:
 *
 *  - **the switch is the decision**, and it is on by default;
 *  - **the name is whatever can be found**, down this ladder.
 *
 * The rungs, in order, are the gateway's own display name, the local part of
 * the address it signed them in with, and last the user id with the provider
 * prefix taken off. The last rung is deliberately not prettified: an OIDC
 * subject is an opaque string and guessing a person's name out of it would put
 * a wrong name in a system prompt, which is worse than an ugly right one. On a
 * gateway with no accounts the id is `owner`, and `owner` is what it says.
 *
 * Empty only when the gateway has not named anybody at all — in which case the
 * switch stays on and the row simply carries no name.
 */
export function effectiveDisplayName(state: Pick<DeviceContextState, 'displayName' | 'email' | 'userId'>): string {
  const given = contextTextOf(state.displayName, CONTEXT_LIMITS.displayName)

  if (given) {
    return given
  }

  const local = EMAIL_LOCAL_PART.exec(contextTextOf(state.email, EMAIL_LIMIT))?.[1]

  if (local) {
    return contextTextOf(local, CONTEXT_LIMITS.displayName)
  }

  const id = contextTextOf(state.userId, CONTEXT_LIMITS.userId)

  return contextTextOf(PROVIDER_PREFIX.exec(id)?.[1] ?? id, CONTEXT_LIMITS.displayName)
}

/**
 * This device's row for the section, or `null` when nothing may be written.
 *
 * `null` in three cases, and the third is the one that matters: before the disk
 * read, before the gateway has named anybody, and — on a gateway that can have
 * more than one person on it — before the reader has been told who can read
 * this and said yes. The device facts are sent without being asked about, so
 * "the first save" is not a moment the reader chooses; the notice is what makes
 * it one.
 */
export function ownContextRow(state: DeviceContextState): ContextUserInput | null {
  if (!state.loaded || !state.userId || needsSharingNotice(state)) {
    return null
  }

  const displayName = state.shareDisplayName ? effectiveDisplayName(state) : ''

  return {
    userId: state.userId,
    ...(displayName ? { displayName } : {}),
    ...(state.shareAbout && state.about.trim() ? { about: state.about } : {}),
    device: { model: state.facts.model, os: state.facts.os, appVersion: state.facts.appVersion },
    timezone: state.facts.timezone,
    locale: state.facts.locale,
    perBot: state.perBot,
    updatedAt: state.updatedAt
  }
}

/**
 * The rows a write from this device has to carry, `ownContextRow` aside.
 *
 * `others` is what `foreignContextUsers` found, and it drops this person's own
 * row on purpose: the whole point is that this device replaces it. When this
 * device has no row to replace it WITH, that drop is a deletion — the section
 * is written whole, so a person whose row is in neither half simply stops
 * being in it, and the gateway plugin then renders an empty section into the
 * next chat's system prompt. Measured on a gateway with one person and two
 * devices: the desktop's row vanished the first time the phone wrote anything
 * at all, and came back, unchanged and still dated that morning, the next time
 * the desktop wrote.
 *
 * So a device with nothing of its own to say carries the person's row exactly
 * as it carries a colleague's — unread, and put back the way it was found.
 */
export function carriedContextUsers(state: DeviceContextState): Record<string, unknown> {
  if (!state.userId || state.remoteOwnRow === null || state.remoteOwnRow === undefined || ownContextRow(state)) {
    return state.others
  }

  return { ...state.others, [state.userId]: state.remoteOwnRow }
}
