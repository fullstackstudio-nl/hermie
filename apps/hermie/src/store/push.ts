/**
 * What this device asked to be told about, and what it read back from the others.
 *
 * ADR-0017's registration lives in the `hermie-app` `ui_meta` key, which
 * ADR-0016 replaces WHOLE. That one sentence decides the shape of this store:
 * it holds not only this device's own preferences but also the rows and the
 * heartbeat stamps belonging to every OTHER installation on the gateway, because
 * the next write of that section has to carry them or erase them.
 *
 * So there are two halves here and they are owned by different people:
 *
 *  - **Ours.** `enabled`, `types`, `preview` and the platform `address`. These
 *    are decisions made on this device, persisted on this device, and sent up.
 *  - **Theirs.** `others` and the `seen` stamps that are not ours. These arrive
 *    from the gateway on every reconcile, are never edited here, and are written
 *    back out unchanged. They are deliberately NOT persisted: a copy of another
 *    phone's push token on this disk would be a copy of something we were only
 *    ever passing through, and the gateway re-reads it on the next connect
 *    anyway.
 *
 * The `installationId` is minted once and then never changes, because it is the
 * key the whole section is addressed by: a device that re-minted it on every
 * launch would leave a dead registration behind each time and the daemon would
 * go on sending to tokens that nothing answers.
 *
 * **Nothing in here writes to a gateway.** `ui-meta-bridge.ts` notices this
 * store the same way it notices the other two and sends the app-wide section;
 * that is what gives the registration ADR-0016's compare-and-swap and its
 * local-only fallback without a second protocol.
 */
import {
  noPushTypes,
  pushTypesOf,
  type PushAddress,
  type PushRegistrationInput,
  type PushSeenEntry,
  type PushType,
  type PushTypeOverrides
} from '@hermie/gateway-client/push'
import { create } from 'zustand'

import type { PushAddressFailure } from '../features/push/platform-contract'
import { keyValueStore } from '../platform/key-value-store'
import { randomBytes } from '../platform/random'

/** Everything this device stores about push, under one key. */
export const PUSH_KEY = 'hermie.push'

/**
 * The types a reader who has just switched notifications on gets: all of them.
 *
 * Every one, rather than a careful subset, because the plugin only ever sends
 * what the gateway can actually produce — a gateway with the `cron` type
 * switched off sends no cron notification however loudly a device asks — and
 * because the alternative is a reader who turned notifications on, heard
 * nothing about the turn that failed overnight, and had no reason to suspect
 * there was a switch for it.
 *
 * Turning one OFF is the decision worth making, and it is one switch away.
 */
export const DEFAULT_PUSH_TYPES: Record<PushType, boolean> = {
  // A messenger that does not tell you about a message is not one.
  message: true,
  // A question with a countdown on it is the one thing worth waking a phone for.
  request: true,
  cron: true,
  turn_done: true,
  turn_failed: true
}

/** The part of this store that survives a launch. Ours only; never theirs. */
interface PersistedPush {
  installationId: string
  enabled: boolean
  types: Record<string, boolean>
  preview: boolean
}

export interface PushState {
  /** Minted once, on the first hydrate. Empty until then. */
  installationId: string
  /** What the reader asked for. Independent of whether a token was obtained. */
  enabled: boolean
  types: Record<PushType, boolean>
  /**
   * Chat name → the types that chat overrides, where it overrides any.
   *
   * PARTIAL, so a type a chat has not been given an opinion about follows the
   * global switch as the global switch moves. About the READER rather than
   * about this device, which is why it rides in the app-wide section beside the
   * mutes and not in this device's own registration row: silencing one bot's
   * cron deliveries means it on the phone and on the Mac.
   *
   * NOT persisted locally, for the reason the neighbours' rows are not: it is
   * the gateway's copy that is authoritative and the gateway is read on every
   * reconnect.
   */
  perBot: Record<string, PushTypeOverrides>
  /** Off by default: ADR-0017's payload says who, not what. */
  preview: boolean
  /** Where the platform says to send. Null until permission and a token. */
  address: PushAddress | null
  /** Epoch SECONDS this device's row was last stamped. */
  updatedAt: number
  /** Rows written by other installations, carried through a write untouched. */
  others: Record<string, unknown>
  /** installation id → last time that device said a chat was on screen. */
  seen: Record<string, PushSeenEntry>
  /** False until the first disk read finishes; nothing is projected before it. */
  loaded: boolean
  /**
   * Why there is no address, when there should be one.
   *
   * Deliberately NOT persisted: it describes this launch's attempt, and a
   * reason carried over from a previous one would be shown beside a switch
   * whose flow has not run yet. Cleared by an address arriving.
   */
  addressFailure: PushAddressFailure | null

  hydrate: () => Promise<void>
  /** Turn the whole section on or off. The address is set separately. */
  setEnabled: (enabled: boolean) => void
  setType: (type: PushType, on: boolean) => void
  /**
   * Override one type for one chat, or let it follow the global switch again.
   *
   * `null` REMOVES the override rather than writing `false`, which is the
   * difference between "this chat never wants a cron notice" and "this chat has
   * no opinion". An empty bag is dropped, so a chat that has been put back to
   * following the default leaves nothing behind in the section.
   */
  setBotType: (botName: string, type: PushType, on: boolean | null) => void
  /** Drop every override for one chat, so it follows the global types again. */
  resetBotTypes: (botName: string) => void
  setPreview: (preview: boolean) => void
  /** Record the address the platform handed over, and stamp the row. */
  setAddress: (address: PushAddress | null, stamp: number) => void
  /** Record — or clear, with `null` — why the platform would not give one. */
  setAddressFailure: (failure: PushAddressFailure | null) => void
  /** Re-stamp without changing anything else, so a refresh is visible upstream. */
  touch: (stamp: number) => void
  /** Note WHICH chat is on screen on THIS device, at `stamp` (epoch seconds). */
  beat: (bot: string, stamp: number) => void
  /** Fold the gateway's copy of the section in. Never written back out by itself. */
  applyRemote: (patch: {
    others: Record<string, unknown>
    seen: Record<string, PushSeenEntry>
    perBot?: Record<string, PushTypeOverrides>
  }) => void
  /** Forget this device's registration: sign-out, or a different gateway. */
  retire: () => void
  reset: () => void
}

let writeQueue: Promise<void> = Promise.resolve()

function persist(state: PersistedPush): void {
  writeQueue = writeQueue
    .then(() => keyValueStore.setJson(PUSH_KEY, state))
    .catch(() => {
      // A preference that failed to persist resets on the next launch. That is a
      // notification toggle to set again, not an error to put in front of anybody.
    })
}

/**
 * An id for this installation.
 *
 * `randomBytes` is the platform's own CSPRNG (expo-crypto natively, Web Crypto
 * in a browser). The id does not have to be unguessable — the section it keys is
 * already behind the gateway's authentication — but it does have to not collide
 * with another device on the same gateway, and a counter or a timestamp would.
 */
const newInstallationId = (): string =>
  `i${[...randomBytes(8)].map(byte => byte.toString(16).padStart(2, '0')).join('')}`

export const usePushStore = create<PushState>((set, get) => {
  const save = (): void => {
    const { installationId, enabled, types, preview } = get()

    persist({ installationId, enabled, types, preview })
  }

  return {
    installationId: '',
    enabled: false,
    types: noPushTypes(),
    preview: false,
    address: null,
    updatedAt: 0,
    others: {},
    perBot: {},
    seen: {},
    loaded: false,
    addressFailure: null,

    async hydrate() {
      if (get().loaded) {
        return
      }

      const stored = await keyValueStore.getJson<PersistedPush>(PUSH_KEY)
      const installationId =
        typeof stored?.installationId === 'string' && stored.installationId
          ? stored.installationId
          : newInstallationId()

      set({
        installationId,
        enabled: stored?.enabled === true,
        types: stored?.types ? pushTypesOf(stored.types) : noPushTypes(),
        preview: stored?.preview === true,
        loaded: true
      })

      // Written back even when nothing was stored, so the id this launch minted
      // is the id the next launch finds. Everything else round-trips unchanged.
      save()
    },

    setEnabled(enabled) {
      // Turning it on with nothing selected would register a device that asked
      // about nothing, which the section treats as absent — so the defaults come
      // back with the switch unless the reader has already chosen.
      const types = enabled && Object.values(get().types).every(on => !on) ? { ...DEFAULT_PUSH_TYPES } : get().types

      // The reason goes with the switch either way: turning it off retires the
      // question, and turning it on is a fresh attempt whose answer is not in
      // yet. A stale reason under a switch that has just moved is a lie about
      // what was tried.
      set({ enabled, types, addressFailure: null, ...(enabled ? {} : { address: null }) })
      save()
    },

    setBotType(botName, type, on) {
      const current = { ...(get().perBot[botName] ?? {}) }

      if (on === null) {
        delete current[type]
      } else {
        current[type] = on
      }

      const perBot = { ...get().perBot }

      if (Object.keys(current).length) {
        perBot[botName] = current
      } else {
        delete perBot[botName]
      }

      set({ perBot })
    },

    resetBotTypes(botName) {
      if (!get().perBot[botName]) {
        return
      }

      const perBot = { ...get().perBot }

      delete perBot[botName]
      set({ perBot })
    },

    setType(type, on) {
      set({ types: { ...get().types, [type]: on } })
      save()
    },

    setPreview(preview) {
      set({ preview })
      save()
    },

    setAddress(address, stamp) {
      set({ address, updatedAt: address ? stamp : 0, ...(address ? { addressFailure: null } : {}) })
    },

    setAddressFailure(failure) {
      set({ addressFailure: failure })
    },

    touch(stamp) {
      if (get().address) {
        set({ updatedAt: stamp })
      }
    },

    beat(bot, stamp) {
      const installationId = get().installationId

      if (installationId) {
        set({ seen: { ...get().seen, [installationId]: { bot, at: stamp } } })
      }
    },

    applyRemote(patch) {
      const installationId = get().installationId
      const seen = { ...patch.seen }
      const ours = get().seen[installationId]

      // Our own stamp is ours: a remote copy of it is always the older one,
      // because this device is the only thing that ever writes it. It is also
      // the only copy that knows WHICH chat, on a gateway whose plugin still
      // stores a bare number.
      if (installationId && ours && ours.at > (seen[installationId]?.at ?? 0)) {
        seen[installationId] = ours
      }

      // Theirs is taken and ours is replaced, the same rule the rows follow.
      // The overrides belong to the PERSON rather than to a device, so the
      // gateway's copy simply wins: there is no local half to merge.
      set({ others: patch.others, seen, ...(patch.perBot ? { perBot: patch.perBot } : {}) })
    },

    retire() {
      /*
        OURS goes; theirs stays.

        The id survives — a sign-out is not a new installation, and keeping it
        means signing back in re-registers the same row rather than adding one.
        So do the other devices' rows and stamps: this store is what the next
        write of the section is built from, and emptying `others` here would
        make that write a section with nobody in it, which removes the key and
        unregisters every phone on the gateway. The removal this is for is one
        row, and that row is the one `ownRegistration` stops producing the
        moment `enabled` is false.
      */
      const installationId = get().installationId
      const seen = { ...get().seen }

      delete seen[installationId]

      set({ enabled: false, address: null, updatedAt: 0, seen, addressFailure: null })
      save()
    },

    reset() {
      set({
        enabled: false,
        types: noPushTypes(),
        preview: false,
        address: null,
        updatedAt: 0,
        others: {},
        perBot: {},
        seen: {},
        loaded: false,
        addressFailure: null
      })
    }
  }
})

/** This device's registration as ADR-0017 wants it, or `null` when it is off. */
export function ownRegistration(state: PushState, platform: string): PushRegistrationInput | null {
  if (!state.loaded || !state.enabled || !state.installationId || !state.address) {
    return null
  }

  return {
    installationId: state.installationId,
    address: state.address,
    platform,
    types: state.types,
    preview: state.preview,
    updatedAt: state.updatedAt
  }
}
