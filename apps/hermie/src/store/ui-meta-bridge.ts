/**
 * The app's half of ADR-0016: the stores, projected onto `ui_meta` and back.
 *
 * `@hermie/gateway-client`'s `UiMetaSync` owns the protocol — the revision table,
 * the compare-and-swap, the retry, the local-only fallback — and knows nothing
 * about zustand. This is the adapter, and it does three things:
 *
 *  1. **Projects.** `snapshotFromStores` reads the arrangement and the app-wide
 *     settings out of the two stores; `applySnapshot` puts a gateway's copy back
 *     into them.
 *  2. **Notices.** Rather than marking every setter in two stores dirty by hand —
 *     eleven call sites today and one forgotten one tomorrow — it SUBSCRIBES and
 *     diffs. A section whose projection changed is a section to send, whoever
 *     changed it and however.
 *  3. **Waits.** A drag across a list of forty is dozens of store writes in a
 *     second, so the send is debounced. What goes out is the arrangement the
 *     reader stopped on, not every frame of the gesture.
 *
 * The one thing it deliberately does NOT sync is `sidebarCollapsed`. That is
 * about the window in front of the reader — a phone has no sidebar — so it stays
 * where ADR-0012 put it.
 */
import {
  contextDefaultOf,
  contextSectionFor,
  foreignContextUsers,
  type ContextSectionShape
} from '@hermie/gateway-client/context'
import {
  foreignPushRows,
  pushSectionFor,
  pushSeenOf,
  pushStampOf,
  type PushSectionShape
} from '@hermie/gateway-client/push'
import {
  HERMIE_APP_SECTION_VERSION,
  HERMIE_SECTION_VERSION,
  UiMetaSync,
  type HermieAppSection,
  type HermieBotSection,
  type UiMetaGateway,
  type UiMetaSnapshot
} from '@hermie/gateway-client/ui-meta'
import { Platform } from 'react-native'

import { ACCENTS, type AccentName } from '../ui/tokens'
import { useChatLayoutStore, type LayoutEntry } from './chat-layout'
import { ownContextRow, useDeviceContextStore } from './device-context'
import { usePluginStore } from './plugin'
import { ownRegistration, usePushStore } from './push'
import { asThemeChoice, asUserThemes, DEFAULT_CHAT_VIEW, useSettingsStore, type ChatViewSettings } from './settings'

/** How long the reader has to stop moving before their arrangement goes out. */
export const UI_META_DEBOUNCE_MS = 600

/** The app-wide section, as this build writes it. */
export interface HermieAppShape extends HermieAppSection {
  v: number
  /** Order AND dividers: one list, because that is what the store holds. */
  entries?: LayoutEntry[]
  defaults?: ChatViewSettings
  themeChoice?: unknown
  themes?: unknown
  /** ADR-0017: every device that asked to be told, and who was last looking. */
  push?: PushSectionShape
  /** What the gateway plugin renders into a bot's system prompt, per person. */
  context?: ContextSectionShape
}

/**
 * What the daemon calls this device.
 *
 * `ios`, `android` or `web`, and `macos` for the Designed-for-iPad build, which
 * reports itself honestly rather than as an iPhone. The daemon does not route on
 * it — the transport does — so it is a label for whoever reads the section.
 */
export const pushPlatformName = (): string => Platform.OS

/** Everything ADR-0016 syncs, read out of the two stores as they are now. */
export function snapshotFromStores(): UiMetaSnapshot {
  const layout = useChatLayoutStore.getState()
  const settings = useSettingsStore.getState()
  const bots: Record<string, HermieBotSection> = {}

  for (const name of Object.keys(layout.archived)) {
    bots[name] = { v: HERMIE_SECTION_VERSION, archived: true }
  }

  for (const [name, accent] of Object.entries(layout.accents)) {
    bots[name] = { ...(bots[name] ?? { v: HERMIE_SECTION_VERSION }), colour: accent }
  }

  const push = usePushStore.getState()
  /*
    The whole section, not this device's row: ADR-0016 replaces a key WHOLE, so a
    snapshot that named only our own registration would unregister every other
    device on this gateway the moment anything here changed.
  */
  const pushSection = pushSectionFor({
    others: push.others,
    own: ownRegistration(push, pushPlatformName()),
    seen: push.seen,
    now: pushStampOf(Date.now())
  })

  /*
    The same whole-section rule as the push registrations, and the same
    consequence: the rows belonging to other PEOPLE travel through every write
    this device makes. `ownContextRow` answers `null` until the reader has been
    told who can read this, so on a shared gateway nothing is written before
    they say yes.
  */
  const context = useDeviceContextStore.getState()
  const contextSection = contextSectionFor({
    others: context.others,
    own: ownContextRow(context),
    fallbackDefault: context.remoteDefault
  })

  const app: HermieAppShape = {
    v: HERMIE_APP_SECTION_VERSION,
    entries: layout.entries,
    defaults: settings.defaults,
    themeChoice: settings.themeChoice,
    themes: settings.userThemes,
    // Omitted rather than empty while nobody has ever registered; see
    // `pushSectionFor`.
    ...(pushSection ? { push: pushSection } : {}),
    ...(contextSection ? { context: contextSection } : {})
  }

  return { app, bots }
}

/** Read one bot section defensively: it came off a wire another build wrote. */
function accentOf(section: HermieBotSection): AccentName | undefined {
  return typeof section.colour === 'string' && section.colour in ACCENTS ? (section.colour as AccentName) : undefined
}

/** Read the entry list defensively, for the same reason. */
function entriesOf(value: unknown): LayoutEntry[] | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }

  const entries: LayoutEntry[] = []
  const seen = new Set<string>()

  for (const raw of value) {
    if (!raw || typeof raw !== 'object') {
      continue
    }

    const entry = raw as Record<string, unknown>

    if (entry.kind === 'divider' && typeof entry.id === 'string' && entry.id) {
      entries.push({ kind: 'divider', id: entry.id, name: typeof entry.name === 'string' ? entry.name : '' })
      continue
    }

    if (entry.kind === 'chat' && typeof entry.name === 'string' && entry.name && !seen.has(entry.name)) {
      seen.add(entry.name)
      entries.push({ kind: 'chat', name: entry.name })
    }
  }

  return entries
}

function chatViewOf(value: unknown): ChatViewSettings | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }

  const raw = value as Record<string, unknown>
  const level = raw.level

  return {
    level: level === 'quiet' || level === 'normal' || level === 'verbose' ? level : DEFAULT_CHAT_VIEW.level,
    showBotToBot: typeof raw.showBotToBot === 'boolean' ? raw.showBotToBot : DEFAULT_CHAT_VIEW.showBotToBot,
    showThinking: typeof raw.showThinking === 'boolean' ? raw.showThinking : DEFAULT_CHAT_VIEW.showThinking
  }
}

/** Put a gateway's copy into the stores. Persisted, never sent back out. */
export function applySnapshot(snapshot: UiMetaSnapshot): void {
  const archived: string[] = []
  const accents: Record<string, AccentName> = {}

  for (const [name, section] of Object.entries(snapshot.bots)) {
    if (section.archived === true) {
      archived.push(name)
    }

    const accent = accentOf(section)

    if (accent && accent !== 'default') {
      accents[name] = accent
    }
  }

  const app = snapshot.app as HermieAppShape | null
  const entries = entriesOf(app?.entries)
  /*
    The per-device and per-person MAPS come from the gateway's own copy, never
    from the merged one. `app` is this device's local section whenever it is
    holding an unsent change — which is exactly the state a device is in while
    it registers itself — and a device that took the neighbours out of its own
    copy found none and then wrote a section with only its own row in it. See
    `UiMetaSnapshot.remote`; on the owner's gateway that lost a Mac's push
    registration the moment a reinstalled iPhone registered.
  */
  const neighbours = (snapshot.remote ?? app) as HermieAppShape | null

  useChatLayoutStore.getState().applyRemote({
    // An absent list is not an empty one. A gateway that has never been written
    // to has no arrangement, and taking that as "no rows anywhere" would empty a
    // list the reader spent an afternoon on.
    ...(entries ? { entries } : {}),
    archived,
    accents
  })

  /*
    Ours is replaced, theirs is taken. A row written by another installation is
    carried forward unread — see `foreignPushRows` — and the stamps come back so
    that a write from this device does not erase somebody else's heartbeat.
  */
  usePushStore.getState().applyRemote({
    others: foreignPushRows(neighbours, usePushStore.getState().installationId),
    seen: pushSeenOf(neighbours)
  })

  /*
    The advert, one-directionally. It is only ever present on a snapshot the
    GATEWAY produced — `snapshotFromStores` leaves it undefined — so an
    `undefined` here is "the app asked itself" and must not be read as "the
    plugin is gone".
  */
  if (snapshot.plugin !== undefined) {
    usePluginStore.getState().apply(snapshot.plugin)
  }

  /* Ours is replaced, theirs is taken — see the push section above. */
  useDeviceContextStore.getState().applyRemote({
    others: foreignContextUsers(neighbours, useDeviceContextStore.getState().userId),
    remoteDefault: contextDefaultOf(neighbours)
  })

  useSettingsStore.getState().applyAppSettings({
    ...(chatViewOf(app?.defaults) ? { defaults: chatViewOf(app?.defaults) as ChatViewSettings } : {}),
    ...(asThemeChoice(app?.themeChoice) ? { themeChoice: asThemeChoice(app?.themeChoice)! } : {}),
    ...(Array.isArray(app?.themes) ? { userThemes: asUserThemes(app?.themes) } : {})
  })
}

/** A section's projection, as one string, so a diff is one comparison. */
const fingerprint = (value: unknown): string => JSON.stringify(value ?? null)

export interface UiMetaBridgeOptions {
  gateway: UiMetaGateway
  /** Overridable so a test does not have to wait two thirds of a second. */
  debounceMs?: number
}

export class UiMetaBridge {
  readonly sync: UiMetaSync
  private readonly debounceMs: number
  private readonly seen = new Map<string, string>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private applying = false
  private unsubscribe: (() => void)[] = []

  constructor(options: UiMetaBridgeOptions) {
    this.debounceMs = options.debounceMs ?? UI_META_DEBOUNCE_MS
    this.sync = new UiMetaSync({
      gateway: options.gateway,
      read: snapshotFromStores,
      apply: snapshot => {
        // The watcher is deaf while the gateway's copy goes in, and the
        // fingerprints are retaken afterwards. Otherwise zustand's synchronous
        // notification would read the arriving value back as a local change and
        // send it straight home again — a loop with nothing to break it.
        this.applying = true

        try {
          applySnapshot(snapshot)
        } finally {
          this.applying = false
          this.remember(snapshotFromStores())
        }
      }
    })
  }

  /** Start watching both stores. The returned function stops and cancels. */
  start(): () => void {
    this.remember(snapshotFromStores())

    const watch = (): void => this.onStoreChanged()

    this.unsubscribe = [
      useChatLayoutStore.subscribe(watch),
      useSettingsStore.subscribe(watch),
      usePushStore.subscribe(watch),
      useDeviceContextStore.subscribe(watch)
    ]

    return () => this.stop()
  }

  stop(): void {
    for (const off of this.unsubscribe) {
      off()
    }

    this.unsubscribe = []
    clearTimeout(this.timer)
    this.timer = undefined
  }

  /** Read the gateway's copy and send whatever this device is still holding. */
  reconcile(): Promise<unknown> {
    return this.sync.reconcile()
  }

  private onStoreChanged(): void {
    if (this.applying) {
      return
    }

    const snapshot = snapshotFromStores()
    let dirty = false

    for (const [name, section] of Object.entries(snapshot.bots)) {
      if (this.seen.get(`bot:${name}`) !== fingerprint(section)) {
        this.sync.markBot(name)
        dirty = true
      }
    }

    // A bot whose section went away — unarchived, colour back to Default — is a
    // change too, and the one a diff over the new snapshot alone would miss.
    for (const key of this.seen.keys()) {
      const name = key.startsWith('bot:') ? key.slice(4) : null

      if (name && !snapshot.bots[name]) {
        this.sync.markBot(name)
        dirty = true
      }
    }

    if (this.seen.get('app') !== fingerprint(snapshot.app)) {
      this.sync.markApp()
      dirty = true
    }

    if (!dirty) {
      return
    }

    this.remember(snapshot)
    clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.sync.flush(), this.debounceMs)
  }

  private remember(snapshot: UiMetaSnapshot): void {
    this.seen.clear()
    this.seen.set('app', fingerprint(snapshot.app))

    for (const [name, section] of Object.entries(snapshot.bots)) {
      this.seen.set(`bot:${name}`, fingerprint(section))
    }
  }
}
