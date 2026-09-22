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
import { hasPluginCapability, PLUGIN_CAPABILITIES } from '@hermie/gateway-client/plugin'
import {
  foreignPushRows,
  pushPerBotOf,
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
import { asNameOrder, type NameOrder } from './bot-names'
import { useChatLayoutStore } from './chat-layout'
import { readArrangement, type Folder, type LayoutEntry } from './folders'
import { ownContextRow, useDeviceContextStore } from './device-context'
import { mutesOf, type Mutes } from './mute'
import { usePluginStore } from './plugin'
import { ownRegistration, usePushStore } from './push'
import { asThemeChoice, asUserThemes, DEFAULT_CHAT_VIEW, useSettingsStore, type ChatViewSettings } from './settings'
import { asTextSize, type TextSize } from './text-size'

/** How long the reader has to stop moving before their arrangement goes out. */
export const UI_META_DEBOUNCE_MS = 600

/** The app-wide section, as this build writes it. */
export interface HermieAppShape extends HermieAppSection {
  v: number
  /** The TOP LEVEL in order: folders by id, and loose chats. */
  entries?: LayoutEntry[]
  /**
   * Each folder's name, colour and contents.
   *
   * An ADDITIVE field, and the section version is deliberately not bumped for
   * it. A reader that meets a `v` it does not know treats the whole section as
   * unreadable and then re-seeds it from its own local copy, so bumping would
   * not protect the folders from an older build — it would hand that build the
   * power to delete them. A field it simply does not mention costs it its
   * folders on its own next write, which is the same last-writer-wins trade
   * ADR-0016 already made for the order.
   */
  folders?: Folder[]
  /**
   * Chats the reader holds at the top of their container.
   *
   * **The brief for this round asked for a schema bump with tolerance, and this
   * is deliberately not one.** It is the second time that instruction has been
   * declined for this section and the reason is the same both times, so it is
   * worth stating as a rule rather than as an exception:
   *
   *   `readSection` answers `null` for any section whose `v` is GREATER than the
   *   version the reader knows (`packages/gateway-client/src/ui-meta.ts`). A
   *   build that meets an unknown `v` therefore treats the whole app-wide
   *   section as unreadable and re-seeds it from its own local copy. Bumping to
   *   2 would not protect `pinned` from an older build — it would hand every
   *   older build the power to DELETE the folders, the order and the mutes, for
   *   everyone, the first time one of them wrote.
   *
   * So the field is additive, in exactly the shape `folders`, `botNameOrder` and
   * `textSize` above already use. A build that has not learned it leaves this
   * reader's pins alone until it writes the section itself, at which point they
   * are lost and can be set again — the same last-writer-wins trade ADR-0016
   * made for the order, and a very small loss next to the arrangement.
   *
   * ADR-0016 and ADR-0019 both carry the amendment.
   */
  pinned?: string[]
  /**
   * Which bots this reader opens as a chat of their own (ADR-0007, amended).
   *
   * Here rather than on each bot's own profile for the reason `mutes` gives
   * below, only more so: whose transcript somebody is in is the most personal
   * thing in the section. The key is already `hermie-app:<user_id>`, so this
   * field is per account by construction rather than by care.
   *
   * ADDITIVE, and the section version deliberately stays at 1 — see `pinned`.
   */
  myChats?: string[]
  /**
   * Which chats are silent, and until when.
   *
   * Here rather than on each bot's own profile because a mute is about the
   * READER: two people sharing a gateway do not share a bedtime. The gateway
   * plugin reads it from this same place to decide whether to push.
   */
  mutes?: Mutes
  defaults?: ChatViewSettings
  /**
   * Which of a bot's two names leads. See `store/bot-names.ts`.
   *
   * An ADDITIVE field, and the section version is deliberately not bumped for
   * it, for the reason `folders` gives above: a reader that meets a `v` it does
   * not know treats the whole section as unreadable and re-seeds it from its own
   * local copy, so bumping would hand an older build the power to delete the
   * arrangement rather than protecting this key from it. A build that does not
   * mention the field simply leaves this reader on their own default, which is
   * the smallest possible loss and the same trade ADR-0016 already made.
   */
  botNameOrder?: NameOrder
  /**
   * How big the words in a transcript are (`store/text-size.ts`).
   *
   * An ADDITIVE field, and the section version is deliberately not bumped for
   * it, for the reason `folders` gives above: a reader that meets a `v` it does
   * not know treats the whole section as unreadable and re-seeds it from its
   * own local copy, so bumping would hand an older build the power to delete
   * the arrangement rather than protecting this key. A build that does not
   * mention the field leaves this reader on their own size, which is the
   * smallest possible loss.
   */
  textSize?: TextSize
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
    // Per CHAT and per person, beside the registrations: silencing one bot's
    // cron deliveries is a decision about the reader, not about this device.
    perBot: push.perBot,
    now: pushStampOf(Date.now()),
    /*
      The shape the GATEWAY said it can read, not the one this build prefers.

      A plugin that predates `push.seen.per_chat` reads a bare number and would
      see `{bot, at}` as unreadable — which is a device that appears to be
      looking away for ever, and therefore a notification for every chat it is
      actually reading. Asking first is the difference between saying more and
      saying nothing.
    */
    perChat: hasPluginCapability(usePluginStore.getState().advert, PLUGIN_CAPABILITIES.pushSeenPerChat)
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
    folders: layout.folders,
    // Always sent, empty included, for the reason `mutes` gives below: a reader
    // who unpins their last chat has to be able to say so, and an omitted key
    // reads as "this build knows nothing about pins" rather than as "there are
    // none".
    pinned: Object.keys(layout.pinned),
    // Always sent, empty included, for the same reason: a reader who moves
    // their last chat back to the shared one has to be able to say so.
    myChats: Object.keys(layout.myChats),
    // Always sent, empty included: a reader who unmutes their last chat has to
    // be able to say so, and an omitted key reads as "this device knows
    // nothing about mutes" rather than as "there are none".
    mutes: layout.mutes,
    defaults: settings.defaults,
    botNameOrder: settings.botNameOrder,
    textSize: settings.textSize,
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
  /*
    `readArrangement` reads defensively AND migrates: a section written before
    folders carries `divider` entries inline, and each one becomes a folder
    holding the chats below it up to the next divider. An absent list is not an
    empty one, so the arrangement is applied only when the section actually
    carried entries — a gateway that has never been written to has no
    arrangement, and taking that as "no rows anywhere" would empty a list the
    reader spent an afternoon on.
  */
  const arrangement = Array.isArray(app?.entries) ? readArrangement(app.entries, app.folders) : undefined
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
    ...(arrangement ? { arrangement } : {}),
    // The same distinction, which is why the projection above always sends the
    // key: a section written by a build that knows about mutes says what they
    // are even when there are none, and one written before them says nothing.
    ...(app?.mutes ? { mutes: mutesOf(app.mutes) } : {}),
    // The same distinction again: a build that predates the field says nothing
    // about pins, and taking that as "none" would unpin everything.
    ...(Array.isArray(app?.pinned)
      ? { pinned: app.pinned.filter((name): name is string => typeof name === 'string' && name.length > 0) }
      : {}),
    // And again: a build that predates the field says nothing about which
    // chats are this reader's own, which is not the same as saying none.
    ...(Array.isArray(app?.myChats)
      ? { myChats: app.myChats.filter((name): name is string => typeof name === 'string' && name.length > 0) }
      : {}),
    archived,
    accents
  })

  /*
    Ours is replaced, theirs is taken. A row written by another installation is
    carried forward unread — see `foreignPushRows` — and the stamps come back so
    that a write from this device does not erase somebody else's heartbeat.
  */
  /*
    And the push maps come from wherever the NOTIFIER is looking, which is not
    always the same section: a gateway whose plugin cannot read a per-person key
    keeps the registrations on the bare `hermie-app` while the arrangement moves
    on without them. `pushHome` is the gateway's own copy of that section.
  */
  const pushNeighbours = (snapshot.pushHome ?? neighbours) as HermieAppShape | null

  usePushStore.getState().applyRemote({
    others: foreignPushRows(pushNeighbours, usePushStore.getState().installationId),
    seen: pushSeenOf(pushNeighbours),
    perBot: pushPerBotOf(pushNeighbours)
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
    // Absent is not the same as wrong: a section written by a build that
    // predates this field leaves the reader on their own default rather than
    // being read as "they chose the other one".
    ...(asNameOrder(app?.botNameOrder) ? { botNameOrder: asNameOrder(app?.botNameOrder)! } : {}),
    ...(asTextSize(app?.textSize) ? { textSize: asTextSize(app?.textSize)! } : {}),
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

  /**
   * Say who the gateway named, before the first reconcile.
   *
   * The app-wide key carries that person's name, so this has to be known before
   * anything is read: a reconcile made before it would find no section, hand the
   * stores the app's defaults, and only then discover there was an arrangement
   * to load. `ChatRuntime` therefore awaits the identity and calls this first.
   */
  setUser(userId: string): void {
    this.sync.setUser(userId)
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
