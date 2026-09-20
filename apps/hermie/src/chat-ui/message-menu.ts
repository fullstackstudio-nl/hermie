/**
 * What a message in the transcript can do, as data.
 *
 * Same shape as the chat list's row menu and for the same reason: one list of
 * intentions, drawn by the platform where the platform can draw it. The difference
 * is that a transcript row is not one kind of thing — a reply, a human turn, an
 * inbound bot message, a tool card, a delegation, a cron delivery — so the list is
 * assembled per kind rather than being a fixed table.
 *
 * Three decisions worth stating:
 *
 *  - **Copy text and Copy as Markdown are both offered, always, and they differ.**
 *    A model's reply IS markdown. Copying it into a terminal wants the words;
 *    copying it into a document wants the syntax. Offering only one means guessing,
 *    and the guess is wrong half the time.
 *  - **Links are enumerated, not collapsed into one "Copy link".** A reply with
 *    three links has three things a reader might want, and a submenu of them is
 *    what every mail client does. Capped, because a menu taller than the window is
 *    not a menu.
 *  - **Nothing here reaches the gateway.** Every action is local: a copy, a
 *    disclosure, or opening a chat this app already has. A context menu that could
 *    send something would need a confirmation, and ADR-0010 says a question is
 *    answered by an explicit tap rather than by a menu line.
 */
import type { TranscriptItem } from '@hermie/transcript'

import { plainTextBlock } from '../markdown/plain-text'
import { menuItems, type MenuItem } from '../ui/menu'
import { chatStrings } from './strings'

/** How many links one message's submenu will list. */
export const MAX_LINK_ITEMS = 8

export type MessageMenuAction =
  | { kind: 'copyText'; text: string }
  | { kind: 'copyMarkdown'; text: string }
  | { kind: 'copyLink'; href: string }
  | { kind: 'openBot'; handle: string }
  | { kind: 'selectText'; text: string }
  | { kind: 'toggleDetails' }

/** `[text](href)` and `<https://…>`; the two forms a model actually writes. */
const LINK_RE = /\[[^\]]*\]\(([^()\s]+)(?:\s+"[^"]*")?\)|<((?:https?|mailto):[^>\s]+)>/gu

/** A bare URL a model wrote without any syntax around it. */
const BARE_URL_RE = /\bhttps?:\/\/[^\s<>()[\]"']+/gu

/**
 * Anything the stripper could possibly act on.
 *
 * Deliberately over-eager: a false positive costs one strip, a false negative
 * would hide `Copy as Markdown` on a message that has markdown in it.
 */
const MARKUP_RE = /[*_`[\]<>|#>~\\]|^\s*[-+]\s|\d\./mu

/**
 * Every link in a message, in the order it appears, without duplicates.
 *
 * Deliberately a regular expression rather than the markdown parser: this runs when
 * a menu opens, on one message, and the parser's job is to produce something to
 * render. A link the parser would find and this one misses costs a menu line; a
 * parser run per right-click costs the gesture's responsiveness.
 */
export function messageLinks(text: string): string[] {
  if (!text) {
    return []
  }

  const seen = new Set<string>()
  const out: string[] = []

  const add = (href: string | undefined): void => {
    const trimmed = href?.trim()

    if (!trimmed || seen.has(trimmed)) {
      return
    }

    seen.add(trimmed)
    out.push(trimmed)
  }

  for (const match of text.matchAll(LINK_RE)) {
    add(match[1] ?? match[2])
  }

  for (const match of text.matchAll(BARE_URL_RE)) {
    add(match[0])
  }

  return out.slice(0, MAX_LINK_ITEMS)
}

/** The markdown source of whatever this row is, or '' for a row that has no words. */
export function messageText(item: TranscriptItem): string {
  switch (item.kind) {
    case 'assistant':
    case 'user':
    case 'bot_dm_in':
      return item.text

    case 'bot_dm_out':
      return item.message

    case 'cron_delivery':
      return item.body

    default:
      return ''
  }
}

/**
 * The other bot this row is about, if it is about one.
 *
 * An outbound DM names its target; an inbound one names its sender. Either way the
 * useful action is "open that conversation", which is the one thing a bot-to-bot
 * line cannot say for itself in the ledger.
 */
function counterpart(item: TranscriptItem): string | undefined {
  if (item.kind === 'bot_dm_out') {
    return item.targetHandle || undefined
  }

  if (item.kind === 'bot_dm_in') {
    return item.senderHandle || undefined
  }

  return undefined
}

export interface MessageMenuModel {
  item: TranscriptItem
  /** Whether this row has a disclosure at all — a tool card, a roll-up, a cron card. */
  hasDetails: boolean
  /** Whether that disclosure is open, so the line can say Hide rather than Show. */
  detailsOpen: boolean
  /** Whether the host can actually open another chat. */
  canOpenBot: boolean
  /**
   * Whether "Select text" is worth offering, which is a question about the
   * POINTER rather than about the platform.
   *
   * The panel it opens works everywhere — on a phone it is a nested `Text`
   * tree — but there it offers nothing the long press does not already give,
   * so the line would be a second door to the same room. It is opt-in for
   * exactly that reason, and `TranscriptList` passes `RUNS_ON_MAC`.
   */
  canSelectText?: boolean
}

export function messageMenuItems({
  canOpenBot,
  canSelectText = false,
  detailsOpen,
  hasDetails,
  item
}: MessageMenuModel): MenuItem[] {
  const text = messageText(item)
  const links = messageLinks(text)
  const handle = counterpart(item)
  // A message whose markdown and whose words are the same string has nothing to
  // offer twice, and two identical Copy lines read as a bug.
  //
  // Guarded by a character test first. The menu is rebuilt on every version bump,
  // which during a streaming reply is once per delta, and stripping the markdown
  // off a long reply to find out it had none is the one avoidable cost in here.
  const markdownDiffers = MARKUP_RE.test(text) && plainTextBlock(text) !== text

  return menuItems(
    Boolean(text) && { id: 'copyText', title: chatStrings.menu.copyText, systemImage: 'doc.on.doc' },
    Boolean(text) &&
      markdownDiffers && {
        id: 'copyMarkdown',
        title: chatStrings.menu.copyMarkdown,
        systemImage: 'chevron.left.forwardslash.chevron.right'
      },
    // Directly under the two Copy lines, because it belongs to the same
    // intention — "I want these words" — and above the links, which are about
    // something the message merely contains.
    Boolean(text) &&
      canSelectText && {
        id: 'selectText',
        title: chatStrings.menu.selectText,
        systemImage: 'selection.pin.in.out'
      },
    links.length > 0 && {
      id: 'links',
      title: chatStrings.menu.copyLink,
      systemImage: 'link',
      children: links.map((href, index) => ({ id: `copyLink:${index}`, title: href }))
    },
    Boolean(handle) &&
      canOpenBot && {
        id: 'openBot',
        title: chatStrings.menu.openBotChat(handle ?? ''),
        systemImage: 'bubble.left.and.bubble.right'
      },
    hasDetails && {
      id: 'toggleDetails',
      title: detailsOpen ? chatStrings.menu.hideDetails : chatStrings.menu.showDetails,
      systemImage: detailsOpen ? 'chevron.up' : 'chevron.down'
    }
  )
}

/**
 * Read a selection back, against the message it was built from.
 *
 * The item is passed in again rather than captured, so the text a Copy puts on the
 * pasteboard is the text the row holds NOW. A streaming reply's menu can be open
 * while the reply grows, and copying the version the menu was built from would
 * quietly truncate it.
 */
export function parseMessageMenuAction(id: string, item: TranscriptItem): MessageMenuAction | null {
  const text = messageText(item)

  if (id === 'copyText') {
    return { kind: 'copyText', text: plainTextBlock(text) }
  }

  if (id === 'copyMarkdown') {
    return { kind: 'copyMarkdown', text }
  }

  // The markdown source, not the stripped words: the panel renders it, so it
  // needs what the bubble has rather than what a Copy would put on a clipboard.
  if (id === 'selectText') {
    return text ? { kind: 'selectText', text } : null
  }

  if (id === 'toggleDetails') {
    return { kind: 'toggleDetails' }
  }

  if (id === 'openBot') {
    const handle = counterpart(item)

    return handle ? { kind: 'openBot', handle } : null
  }

  if (id.startsWith('copyLink:')) {
    const href = messageLinks(text)[Number(id.slice('copyLink:'.length))]

    return href ? { kind: 'copyLink', href } : null
  }

  return null
}
