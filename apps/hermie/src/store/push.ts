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
  type PushType
} from '@hermie/gateway-client/push'
import { create } from 'zustand'

import type { PushAddressFailure } from '../features/push/platform-contract'
import { keyValueStore } from '../platform/key-value-store'
import { randomBytes } from '../platform/random'

/** Everything this device stores about push, under one key. */
export const PUSH_KEY = 'hermie.push'

/** The types a reader who has just switched notifications on gets. */
export const DEFAULT_PUSH_TYPES: Record<PushType, boolean> = {
  // A messenger that does not tell you about a message is not one.
  message: true,
  // A question with a countdown on it is the one thing worth waking a phone for.
  request: true,
  dm: true,
  cron: true
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
  /** Off by default: ADR-0017's payload says who, not what. */
  preview: boolean
  /** Where the platform says to send. Null until permission and a token. */
  address: PushAddress | null
  /** Epoch SECONDS this device's row was last stamped. */
  updatedAt: number
  /** Rows written by other installations, carried through a write untouched. */
  others: Record<string, unknown>
  /** installation id → last time that device said a chat was on screen. */
  seen: Record<string, number>
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
  setPreview: (preview: boolean) => void
  /** Record the address the platform handed over, and stamp the row. */
  setAddress: (address: PushAddress | null, stamp: number) => void
  /** Record — or clear, with `null` — why the platform would not give one. */
  setAddressFailure: (failure: PushAddressFailure | null) => void
  /** Re-stamp without changing anything else, so a refresh is visible upstream. */
  touch: (stamp: number) => void
  /** Note that a chat is on screen on THIS device, at `stamp` (epoch seconds). */
  beat: (stamp: number) => void
  /** Fold the gateway's copy of the section in. Never written back out by itself. */
  applyRemote: (patch: { others: Record<string, unknown>; seen: Record<string, number> }) => void
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

    beat(stamp) {
      const installationId = get().installationId

      if (installationId) {
        set({ seen: { ...get().seen, [installationId]: stamp } })
      }
    },

    applyRemote(patch) {
      const installationId = get().installationId
      const seen = { ...patch.seen }
      const ours = get().seen[installationId]

      // Our own stamp is ours: a remote copy of it is always the older one,
      // because this device is the only thing that ever writes it.
      if (installationId && ours && ours > (seen[installationId] ?? 0)) {
        seen[installationId] = ours
      }

      set({ others: patch.others, seen })
    },

    retire() {
      // The id survives. A sign-out is not a new installation, and keeping it
      // means signing back in re-registers the same row rather than adding one.
      set({ enabled: false, address: null, updatedAt: 0, others: {}, seen: {}, addressFailure: null })
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
