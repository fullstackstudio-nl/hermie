/**
 * A session that is NOT the canonical Bot Chat, as a type rather than a check.
 *
 * ADR-0007 gives a bot exactly one forever-chat: the hidden session on its
 * profile titled exactly `Bot Chat`. Round four's handover named the reason this
 * module exists before it existed — the chat list "must never offer to delete or
 * hide the canonical one, so the model has to make that a type distinction
 * rather than a check somebody can forget". So every row this module produces
 * carries its `kind`, and the only way to reach Delete, Rename or "Make this the
 * Bot Chat" is through `conversationActions`, which answers an EMPTY list for
 * the canonical row. A caller that forgets the guard gets no buttons rather than
 * a destructive one.
 *
 * ## What the gateway does and does not tell us
 *
 * `SessionListRow` is `{id, resolved_id?, title?, preview?, started_at?,
 * message_count?, source?}` and that is the whole of it. There is **no parent
 * field and no kind field**, so nothing on the wire says "this row is a branch
 * of that one". `session.create` does take a `parent_session_id` and upstream
 * keeps it on the row, but the listing never reads it back.
 *
 * Which leaves the TITLE as the only signal, and that is a stated trade rather
 * than an oversight:
 *
 *  - the canonical row is found by its id where the roster knows one, and by
 *    `title === 'Bot Chat'` otherwise — which is not a convention but the
 *    registry key itself (`_canonical_session_row` → `get_session_by_title`),
 *    the same lookup the roster already does;
 *  - a retired conversation is `Bot Chat · <date time>`, which is the string
 *    `ChatController.startNewConversation` writes when it puts one away;
 *  - a branch is `Branch · <first words>`, which is the string `branchTitle`
 *    below writes.
 *
 * The consequence is worth stating plainly because a reader will hit it: a
 * conversation somebody RENAMES out of its prefix stops being grouped as a
 * branch and becomes an ordinary past conversation. Nothing is lost — it is
 * still listed, still openable, still named what they called it — and the
 * alternative is a parallel parentage table in `ui_meta` that would go stale
 * against a gateway anybody else also talks to. A grouping that can be wrong in
 * a way the reader can see and fix beats a shadow index that is wrong silently.
 *
 * Pure, so all of it is testable without a gateway.
 */
import type { SessionListRow } from '@hermes/shared/gateway-contract'

import { CANONICAL_CHAT_TITLE } from '../bots/bots-controller'

/**
 * What a branch's title starts with.
 *
 * The separator is the same ` · ` the retired conversations use, so the two
 * groups read as one family of generated names rather than two conventions.
 */
export const BRANCH_TITLE_PREFIX = 'Branch'

/** `Bot Chat · ` — what a conversation put away by `/new` is called. */
export const RETIRED_TITLE_PREFIX = `${CANONICAL_CHAT_TITLE} · `

/** How many words of the branched row survive into the branch's name. */
export const BRANCH_TITLE_WORDS = 6

/** And how long the whole generated title may get, before the words are cut. */
export const BRANCH_TITLE_MAX = 48

export type ConversationKind = 'canonical' | 'branch' | 'past'

/**
 * One of a profile's conversations, as the app models it.
 *
 * `id` is the STORED id throughout — the durable registry row. It is what
 * `session.resume` and `session.delete` take, and it is the only id a listing
 * hands out; a runtime id belongs to a live session and this list is mostly of
 * sessions nothing is running.
 */
export interface Conversation {
  id: string
  /** The compression-lineage tip, for reading REST transcript rows. */
  resolvedId: string
  title: string
  preview: string
  messageCount: number
  /** Unix seconds, or 0 where the gateway did not say. */
  lastActive: number
  kind: ConversationKind
}

/** The three groups the Conversations page draws, in the order it draws them. */
export interface ConversationGroups {
  /** Exactly one row, or none where the gateway listed no canonical chat. */
  canonical: Conversation | null
  branches: Conversation[]
  past: Conversation[]
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '')
const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

/**
 * The title a branch is born with.
 *
 * `Branch · <first words>` of the row it was taken from, so six branches off one
 * conversation read as six different thoughts rather than six copies of one
 * name. Whitespace is collapsed first — a branch taken from a fenced code block
 * would otherwise carry a newline into a title — and the cut is on a WORD
 * boundary, because a name ending mid-word reads as a truncation bug rather than
 * as a summary.
 *
 * A row with no words at all (a tool card, an empty turn) falls back to the bare
 * prefix, which is still a legal, findable title.
 */
export function branchTitle(text: string): string {
  const words = str(text).replace(/\s+/gu, ' ').trim().split(' ').filter(Boolean)

  if (!words.length) {
    return BRANCH_TITLE_PREFIX
  }

  let out = ''

  for (const word of words.slice(0, BRANCH_TITLE_WORDS)) {
    const next = out ? `${out} ${word}` : word

    if (next.length > BRANCH_TITLE_MAX) {
      break
    }

    out = next
  }

  // One word longer than the whole budget: take the budget rather than the bare
  // prefix, because `Branch · Reticulatingsplines…` says more than `Branch`.
  if (!out) {
    out = words[0]!.slice(0, BRANCH_TITLE_MAX)
  }

  return `${BRANCH_TITLE_PREFIX} · ${out}`
}

/**
 * How many of the parent's messages a branch taken at this row should keep.
 *
 * This is the app's half of the one assumption in this feature, and it is worth
 * reading slowly because there are two steps and each can be wrong on its own.
 *
 * **Step one: `count` counts messages from the start.** `SessionBranchParams` is
 * `{session_id, profile?, name?, count?}` — no row index, no row id — so `count`
 * is the only parameter that can express a position at all, and the reading this
 * app is built on is "how many of the parent's messages the child starts with".
 * Unverified against a real gateway; `docs/platform-notes.md` says so.
 *
 * **Step two: a transcript ITEM is not a gateway MESSAGE.** `rowsToItems`
 * projects one persisted row onto several items — a reply and its reasoning, a
 * DM and the card that announces it — and a live item has no row at all. So
 * counting items would count the wrong things. What is counted instead is
 * `rowId`, which the transcript carries straight off the gateway's own
 * `row_id`: the answer is the number of DISTINCT row ids at or before this item.
 *
 * That makes no assumption about row ids being 1-based, contiguous, or starting
 * anywhere in particular — only that they ascend in transcript order, which is
 * what makes them the ordering key the reducer already treats them as.
 *
 * An item with no row id of its own (one that arrived live, in this session)
 * counts everything persisted before it and then itself, which is the only
 * answer available and the one a reader would predict: "everything up to here".
 */
export function branchCountFor(items: readonly { id: string; rowId?: number }[], itemId: string): number {
  const seen = new Set<number>()
  let count = 0

  for (const item of items) {
    if (item.rowId === undefined) {
      // A live row the gateway has not persisted under an id yet. It is still a
      // message in the conversation, so it still moves the count along.
      count += 1
    } else if (!seen.has(item.rowId)) {
      seen.add(item.rowId)
      count += 1
    }

    if (item.id === itemId) {
      return count
    }
  }

  // An id that is not in the list at all: branch the whole conversation rather
  // than branching nothing, which is the safer of the two wrong answers.
  return count
}

/** Is this the title of a conversation `/new` put away? */
export function isRetiredTitle(title: string): boolean {
  return str(title).startsWith(RETIRED_TITLE_PREFIX)
}

/** Is this the title `branchTitle` writes? */
export function isBranchTitle(title: string): boolean {
  return str(title) === BRANCH_TITLE_PREFIX || str(title).startsWith(`${BRANCH_TITLE_PREFIX} · `)
}

export interface ClassifyInput {
  rows: readonly SessionListRow[]
  /**
   * The stored id the roster resolved as this bot's canonical chat.
   *
   * Preferred over the title when it is known, because an id cannot be typed by
   * hand into the wrong row: a reader who names a past conversation `Bot Chat`
   * while it is visible would otherwise make it look canonical, and the one row
   * that may never be deleted would move.
   */
  canonicalId?: string
  /** The lineage tip of the same row, which a listing may report instead. */
  canonicalResolvedId?: string
}

/**
 * Turn a `session.list` answer into the three groups, sorted.
 *
 * Newest first inside each group, by `started_at`, with the title as the
 * tie-break so that a gateway which reports no timestamps still produces a
 * stable order rather than whatever the map happened to iterate in. Rows with no
 * id are dropped: there is nothing a reader could do with one.
 *
 * The canonical row is taken OUT of the other two groups even when its title
 * also matches a prefix, so it can never be listed twice and can never turn up
 * somewhere Delete is offered.
 */
export function classifyConversations({ canonicalId, canonicalResolvedId, rows }: ClassifyInput): ConversationGroups {
  const canonicalIds = new Set([canonicalId, canonicalResolvedId].filter((id): id is string => Boolean(id)))
  let canonical: Conversation | null = null
  const branches: Conversation[] = []
  const past: Conversation[] = []

  for (const row of rows) {
    const id = str(row.id)

    if (!id) {
      continue
    }

    const title = str(row.title)
    const resolvedId = str(row.resolved_id) || id
    const isCanonical = canonicalIds.size
      ? canonicalIds.has(id) || canonicalIds.has(resolvedId)
      : title === CANONICAL_CHAT_TITLE

    const kind: ConversationKind = isCanonical ? 'canonical' : isBranchTitle(title) ? 'branch' : 'past'

    const conversation: Conversation = {
      id,
      resolvedId,
      // A session upstream never got around to titling lists as an empty
      // string, and a row with no name at all is a row a reader cannot pick out
      // of five others.
      title: title || id,
      preview: str(row.preview),
      messageCount: num(row.message_count),
      lastActive: num(row.started_at),
      kind
    }

    if (kind === 'canonical') {
      // First one wins. Two rows both answering to the canonical id is a gateway
      // in a state this app cannot fix, and picking one beats drawing the chat
      // twice.
      canonical = canonical ?? conversation
      continue
    }

    if (kind === 'branch') {
      branches.push(conversation)
    } else {
      past.push(conversation)
    }
  }

  return { canonical, branches: sortConversations(branches), past: sortConversations(past) }
}

/** Newest first, with the title as a tie-break so the order is total. */
export function sortConversations(rows: readonly Conversation[]): Conversation[] {
  return [...rows].sort((left, right) => right.lastActive - left.lastActive || left.title.localeCompare(right.title))
}

/**
 * What a reader may do with one conversation.
 *
 * The guard ADR-0007 needs, in one place: the canonical row answers an EMPTY
 * list, so a surface that renders whatever this returns cannot draw Delete on
 * the one chat that may never be deleted — not by forgetting a check, because
 * there is no check to forget.
 *
 * `open` is in the list rather than assumed, so a future read-only row can be
 * expressed by leaving it out.
 */
export type ConversationAction = 'open' | 'rename' | 'delete' | 'adopt'

export function conversationActions(conversation: Conversation): ConversationAction[] {
  if (conversation.kind === 'canonical') {
    return []
  }

  return ['open', 'rename', 'delete', 'adopt']
}

/**
 * The key a non-canonical conversation's transcript is held under.
 *
 * `store/chats.ts` is keyed by BOT NAME, because until now a bot had exactly one
 * chat. A branch is a second transcript belonging to the same bot, so it needs a
 * key of its own — and one that cannot collide with any bot name, which is what
 * the `#` does: a profile name is a directory name upstream and never contains
 * one.
 *
 * The canonical chat keeps the bare bot name, so every existing reader — the
 * roster, the cache, the unread counts, `openChat` — goes on meaning what it
 * meant. Nothing had to be migrated for this.
 */
export function conversationKey(botName: string, storedId: string): string {
  return `${botName}#${storedId}`
}

/** The bot a conversation key belongs to, canonical or not. */
export function botOfConversationKey(key: string): string {
  const at = key.indexOf('#')

  return at === -1 ? key : key.slice(0, at)
}

/** The stored id a conversation key names, or null for a canonical chat. */
export function storedIdOfConversationKey(key: string): string | null {
  const at = key.indexOf('#')

  return at === -1 ? null : key.slice(at + 1)
}

/** Whether this key names the bot's one canonical chat. */
export function isCanonicalKey(key: string): boolean {
  return !key.includes('#')
}
