/**
 * What a bot is CALLED, resolved into the two lines every surface draws.
 *
 * A Hermes profile carries two names and the app used to show one of them. The
 * handle (`profiles.list`'s `name` — `lance-vance`) is the bot's identity: it
 * is what `@`-addressing uses, what a cron names, what a DM line says, what the
 * gateway's own logs say, and the only one of the two that is unique. The
 * display name (`display_name` — "Netwerkbeheerder") is a label somebody typed,
 * and it is optional, mutable and free to collide.
 *
 * The app showed the display name everywhere and the handle almost nowhere, so
 * a reader looking at a chat list could not tell which bot an `@mention`
 * elsewhere in the app referred to. Both names are now drawn, as a primary line
 * and a secondary one under it, and **which of them is primary is one global
 * setting** rather than a decision each surface makes for itself.
 *
 * ## Why a module and not a hook
 *
 * `botNames` is pure, which is what lets the same rule answer for a React row,
 * for the widget snapshot's projection, and for a test — three callers that do
 * not share a render tree. `useBotNames` is the thin hook over it for the ones
 * that do.
 *
 * ## The one-line case is not a special case
 *
 * A profile with no display name, or one whose display name IS its handle in
 * different case, has one name and not two. Drawing "lance-vance" over
 * "Lance-Vance" would be a second line that adds nothing and invites the reader
 * to look for a difference that is not there, so `secondary` is empty and every
 * surface already has to handle that: a bot that has never been given a display
 * name is the common case on a fresh gateway.
 */
import { useBotsStore } from './bots'
import { useSettingsStore } from './settings'

/**
 * Which of the two names is the large one.
 *
 * `display` is the default, and that is the owner's call — the second one they
 * have made about it. The handle led at first because it is the name the rest of
 * the app addresses a bot by, and using the app said the opposite: somebody who
 * has given their bots names thinks of them by those names, and a list of
 * handles reads like a directory of processes rather than a list of people to
 * talk to. Nothing is hidden by the swap — the handle is still on the row, one
 * line down, which is where a reader looks when they have to match a chat
 * against an `@mention`, a cron or a line in a log.
 *
 * `profile` puts it back, for a reader who wants the identity first.
 */
export type NameOrder = 'profile' | 'display'

export const NAME_ORDERS: readonly NameOrder[] = ['profile', 'display']

export const DEFAULT_NAME_ORDER: NameOrder = 'display'

/** Read a stored order defensively: it arrives from disk AND from a gateway. */
export const asNameOrder = (value: unknown): NameOrder | undefined =>
  typeof value === 'string' && (NAME_ORDERS as readonly string[]).includes(value) ? (value as NameOrder) : undefined

/** The two lines, already in the order this reader asked for. */
export interface BotNames {
  primary: string
  /** Empty when the bot has only one name worth showing. */
  secondary: string
}

/**
 * Just enough of a bot to name it.
 *
 * Deliberately structural rather than `Bot`: the widget snapshot's projection
 * and a test fixture both have these two fields and neither is a roster row.
 */
export interface NameableBot {
  name: string
  displayName: string
}

/**
 * The two lines for one bot.
 *
 * `bots.ts` already falls back — `displayName: str(row.display_name) || name` —
 * so an absent display name arrives here as a copy of the handle rather than as
 * an empty string. Both shapes are treated the same, because a store is not the
 * only thing that builds one of these.
 *
 * The comparison is case-insensitive and trimmed. `researcher` and `Researcher`
 * are the same name differently capitalised, and that pair is the single most
 * common thing on a real gateway — see the note `useBotDisplayName` has carried
 * since the roster was written.
 */
export function botNames(bot: NameableBot, order: NameOrder): BotNames {
  const handle = bot.name
  const display = bot.displayName.trim()
  const same = display === '' || display.toLowerCase() === handle.trim().toLowerCase()

  if (same) {
    return { primary: handle, secondary: '' }
  }

  return order === 'display' ? { primary: display, secondary: handle } : { primary: handle, secondary: display }
}

/** The order this reader chose, for a surface that resolves its own names. */
export function useNameOrder(): NameOrder {
  return useSettingsStore(state => state.botNameOrder)
}

/**
 * The two lines for one bot, by handle.
 *
 * Selecting the resolved strings rather than the whole roster map keeps a
 * caller from re-rendering when an unrelated bot's presence moves — the same
 * reason `useBotDisplayName` selects a string.
 */
export function useBotNames(name: string | undefined): BotNames {
  const order = useNameOrder()
  const displayName = useBotsStore(state => (name === undefined ? '' : (state.byName[name]?.displayName ?? name)))

  return botNames({ name: name ?? '', displayName }, order)
}

/**
 * One line, for somewhere that has room for exactly one.
 *
 * A browser tab title, a menu-bar item, a live region announcing a drag. The
 * secondary name is dropped rather than appended: these are places where the
 * text is already competing with something else for a few characters.
 */
export function botLabel(bot: NameableBot, order: NameOrder): string {
  return botNames(bot, order).primary
}
