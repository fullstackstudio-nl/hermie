/**
 * What a home-screen widget is allowed to know, as one pure function.
 *
 * A widget process is not the app. It has no gateway, no socket, no keychain and
 * no store — it wakes up, reads one file, draws, and goes away again. So the
 * whole of what it can show has to be written down first, by the app, while the
 * app still knows it. This module is that writing-down step and nothing else:
 * stores in, one plain object out, no clock and no I/O, which is what makes the
 * thing the widgets actually render testable as a table.
 *
 * Three rules shaped the shape:
 *
 *  - **Everything is derived here, exactly once.** `presenceOf` is the same
 *    function the chat list and the chat header already share, and it is called
 *    here for the same reason they call it: a widget that says "Online" over a
 *    row that says "Needs input" is two bugs that look like one. `unreadCountSince`
 *    and `formatPreview` come from the same places for the same reason.
 *  - **No colour is decided in Swift or Kotlin.** `colour` is a hex string off
 *    the app's own accent table, so the two native widget implementations have no
 *    palette of their own to drift from. It is deliberately `ACCENTS[…].bubble`
 *    and not `.fill`: `bubble` is the value `npm run contrast:check` measures
 *    white against, and an avatar circle with initials on it is the same
 *    question an outgoing bubble asks. `fill` is the ring colour — Lime's is
 *    `#C7FF4A`, which white measures about 1.3 : 1 against, so initials drawn on
 *    it would be initials nobody can read.
 *  - **The file is versioned and the version is checked on the way in.** An old
 *    widget binary against a new snapshot, or the reverse, is the normal state of
 *    affairs for a few minutes after every app update: iOS keeps running the
 *    installed extension until it reloads. A widget that finds a version it does
 *    not know draws its empty state rather than half a row.
 */
import { gatewayKeyOf } from '@hermie/gateway-client'

import { formatPreview, initialFor } from '../../chat-ui'
import { hasOpenRequest, unreadCountSince } from '@hermie/transcript'
import type { ChatState } from '@hermie/transcript'
import { botLabel, type NameOrder } from '../../store/bot-names'
import type { Bot } from '../../store/bots'
import { isMuted, type Mutes } from '../../store/mute'
import { ACCENTS, type AccentName } from '../../ui/tokens'
import { presenceOf, type PresenceState } from '../bots/presence'

/**
 * Bumped whenever a field changes meaning or disappears. Adding an OPTIONAL
 * field does not need a bump — both native readers decode with a default — and
 * anything else does.
 */
export const WIDGET_SNAPSHOT_VERSION = 1

/** The file the widgets read, inside the shared container. */
export const WIDGET_SNAPSHOT_FILE = 'widget-snapshot.json'

/** Where a written avatar lands, relative to the same container. */
export function widgetAvatarPath(botName: string): string {
  return `avatars/${encodeURIComponent(botName)}.png`
}

export interface WidgetBot {
  /** The profile name. This is what `hermie://chat/<bot>` carries. */
  name: string
  displayName: string
  /**
   * The bot's own picture, relative to the shared container, or absent when the
   * profile has none or its asset has not been fetched yet. A widget that finds
   * no file at this path falls back to the initials, so a stale path costs a
   * circle rather than a crash.
   */
  avatarPath?: string
  /** The fallback the app's own `Avatar` draws: one uppercase letter. */
  initials: string
  /** Hex, white-on-this is AA. See the note above about `bubble` and `fill`. */
  colour: string
  presence: PresenceState
  /** One clipped, markdown-stripped line — the same text the chat row shows. */
  lastLine: string
  /** Unix SECONDS, as the gateway reports `last_active`. Zero when unknown. */
  lastAt: number
  unread: number
  needsInput: boolean
}

export interface WidgetSnapshot {
  version: number
  /** Unix MILLISECONDS, as `Date.now()`. The widget shows it as a staleness hint. */
  generatedAt: number
  /**
   * Which gateway these bots belong to, as `gatewayKeyOf` its address.
   *
   * A widget shows the ACTIVE gateway's bots, because the app has one live
   * connection and a widget cannot dial. What the key adds is that a tap can
   * say which gateway the row it drew belonged to — a reader who switched
   * between the last write and the tap would otherwise open a chat by name on
   * whichever machine happened to be live.
   *
   * Optional, so a widget binary built before this decodes the file with a
   * default rather than drawing its empty state; see `WIDGET_SNAPSHOT_VERSION`.
   */
  gatewayKey?: string
  /** Most recently active first, archived bots excluded. */
  bots: WidgetBot[]
}

export interface WidgetSnapshotInput {
  bots: readonly Bot[]
  /**
   * Which of a bot's two names the widget's one line carries.
   *
   * A widget row has room for exactly one name, so it gets the PRIMARY one —
   * the same one the chat list leads with — and a reader who switched the order
   * in Settings sees the switch on their home screen as well. The native
   * renderers read `displayName` and know nothing about the choice; this is the
   * only place it is made.
   */
  nameOrder: NameOrder
  chats: Record<string, ChatState>
  /** Bots the last `session.active_list` poll could place a busy session on. */
  running: Record<string, true>
  /** name → the `last_active` the reader has already looked at. */
  lastSeen: Record<string, number>
  /** The owner's per-chat colours; a bot with no entry is `default`. */
  accents: Record<string, AccentName>
  /** Bots the owner has archived. Archiving is how you stop a bot counting. */
  archived: Record<string, true>
  /**
   * Bot name → the second its silence lapses, `0` for never.
   *
   * A muted bot is still HERE — it keeps its row, its colour and its last line,
   * because a reader who silenced a chat did not ask to stop seeing it. What it
   * loses is its numbers. A widget is the loudest place a count appears and a
   * lock screen is where it appears loudest of all, so a chat the reader told
   * the app to be quiet about contributes nothing to either. That is a weaker
   * treatment than archiving, which removes the row outright, and a stronger
   * one than the chat list, which still shows the count on the row itself.
   *
   * Required, deliberately. It was optional for one commit so that fixtures
   * about colours did not have to mention it, and an optional field on a
   * projection input is a caller that silently loses the feature by forgetting
   * a line. There is one production caller; the compiler is a better reminder
   * than a code review.
   */
  mutes: Mutes
  /** Whether the gateway socket is up and usable (`status === 'ready'`). */
  gatewayReady: boolean
  /** name → true for every avatar PNG the writer has actually put in the container. */
  avatars: Record<string, true>
  /** `Date.now()`, passed in so this function has no clock of its own. */
  now: number
  /** The active gateway's address; `''` before one is configured. */
  gatewayAddress?: string
}

/**
 * The most rows any widget can use, and therefore the most worth writing.
 *
 * systemMedium draws three, and the configuration list on systemSmall offers
 * every bot it can find. Twelve is the cap because the snapshot is read by a
 * process with a strict memory budget — a widget extension is killed rather than
 * paged — and a roster longer than a dozen has nothing left to say to a 155pt
 * square. The cut is by recency, so the twelve kept are the twelve a reader
 * would have scrolled to anyway.
 */
export const WIDGET_BOT_LIMIT = 12

/**
 * Project the app's live state onto the file the widgets read.
 *
 * Sorted most-recently-active first rather than in the owner's list order, and
 * that is a deliberate difference from the sidebar. The list is an arrangement
 * the owner made and scrolls; a widget is four square centimetres that get one
 * glance, so the only ordering worth spending them on is "what happened last".
 * The one thing that DOES follow the arrangement is which bots are here at all:
 * an archived bot is absent, because archiving is the app's existing way of
 * saying "stop counting this one" and a widget is the loudest place a count
 * appears.
 */
export function projectWidgetSnapshot(input: WidgetSnapshotInput): WidgetSnapshot {
  const bots = input.bots
    .filter(bot => !input.archived[bot.name])
    .map(bot => projectBot(bot, input))
    .sort((left, right) => right.lastAt - left.lastAt || left.name.localeCompare(right.name))
    .slice(0, WIDGET_BOT_LIMIT)

  const gatewayKey = gatewayKeyOf(input.gatewayAddress ?? '')

  return {
    version: WIDGET_SNAPSHOT_VERSION,
    generatedAt: input.now,
    ...(gatewayKey ? { gatewayKey } : {}),
    bots
  }
}

function projectBot(bot: Bot, input: WidgetSnapshotInput): WidgetBot {
  const chat = input.chats[bot.name]
  const needsInput = chat ? hasOpenRequest(chat) : false

  const presence = presenceOf({
    gatewayReady: input.gatewayReady,
    needsInput,
    sessionAttached: Boolean(bot.canonical?.id),
    working: Boolean(input.running[bot.name]) || (chat?.turn.active ?? false),
    ...(bot.canonical?.lastActive ? { lastActive: bot.canonical.lastActive } : {})
  })

  const accent = input.accents[bot.name] ?? 'default'
  // Seconds here, because that is what a mute deadline is; `input.now` is
  // `Date.now()` because that is what the snapshot stamps itself with.
  const muted = isMuted(input.mutes, bot.name, Math.floor(input.now / 1000))

  // The line the widget draws, which is the app's primary name for this bot.
  // `name` beside it stays the HANDLE whatever the order says: it is the deep
  // link's key (`hermie://chat/<bot>`) and the avatar file's key, not a label.
  const label = botLabel(bot, input.nameOrder)

  return {
    name: bot.name,
    displayName: label,
    ...(input.avatars[bot.name] ? { avatarPath: widgetAvatarPath(bot.name) } : {}),
    initials: initialFor(label),
    colour: (ACCENTS[accent] ?? ACCENTS.default).bubble,
    presence: presence.state,
    lastLine: bot.canonical?.preview ? formatPreview(bot.canonical.preview) : '',
    lastAt: bot.canonical?.lastActive ?? 0,
    unread: muted || !chat ? 0 : unreadCountSince(chat, input.lastSeen[bot.name] ?? 0),
    // The presence BEAD above still says `needsInput`, which is the row's own
    // state and is not a count. This is the number.
    needsInput: needsInput && !muted
  }
}

/**
 * How many bots are waiting on a person, which is the whole content of the two
 * accessory widgets. Exported so the lock-screen number and the medium widget's
 * badges cannot be counted two different ways.
 */
export function needsInputCount(snapshot: WidgetSnapshot): number {
  return snapshot.bots.filter(bot => bot.needsInput).length
}

/**
 * Whether two snapshots would draw the same widget.
 *
 * `generatedAt` is excluded on purpose, and it is the only field that is: it
 * changes on every store notification, and asking WidgetKit to reload for a
 * timestamp nobody renders is how an app spends its widget refresh budget on
 * nothing. Everything else is compared by value, which for an object this small
 * is one `JSON.stringify` and no hand-written field list to forget to update.
 */
export function sameWidgetContent(left: WidgetSnapshot | null, right: WidgetSnapshot): boolean {
  // The gateway key joins the comparison, because a switch between two gateways
  // with identical rosters would otherwise leave the home screen holding the
  // previous gateway's key and send every tap to the wrong machine.
  return (
    left !== null && left.gatewayKey === right.gatewayKey && JSON.stringify(left.bots) === JSON.stringify(right.bots)
  )
}

export type { PresenceState }
