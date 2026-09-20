/**
 * Which bubbles belong together, and where a date stamp goes.
 *
 * A pure pass over the visible items, done once per render of the list rather
 * than guessed at by each row. That matters for one reason above the others: the
 * tail is drawn only on the LAST bubble of a group (§6.1), and "last" is a fact
 * about the item's neighbours, which a row cannot see.
 *
 * Only speech groups. A tool row, a cron card or a bot-to-bot line between two
 * replies ends the run — the reply after it is a new thought, and drawing it as a
 * continuation of the one before the machinery would be a lie about the order
 * things happened in.
 */
import type { TranscriptItem, VisibleItem } from './types'

/** How far apart two turns from one sender may be and still read as one run. */
export const GROUP_WINDOW_SECONDS = 300

export interface RowLayout {
  /** Continues the run above it: tighter gap, squarer top corner. */
  grouped: boolean
  /** Last of its run, so it carries the tail. */
  tail: boolean
  /**
   * Follows another outgoing bot-to-bot line.
   *
   * Not `grouped`: a dispatch is a ledger line, not speech (§6.4), so it has no
   * tail and no corner to tuck. It does have a rhythm of its own — §6.6's nine
   * points between consecutive lines — and that is the only thing this says.
   */
  ledgerRun: boolean
  /** A date stamp belongs directly ABOVE this row. */
  dateStamp?: string
}

/**
 * The speaker a bubble belongs to, or `null` for anything that is not speech.
 *
 * A human turn whose author is not yet known (`unknownAuthor`, a turn somebody
 * else started in this session) is deliberately its own key: grouping it with
 * the owner's own bubbles would claim it was theirs.
 */
export function speakerKey(item: TranscriptItem): string | null {
  switch (item.kind) {
    case 'user':
      return item.unknownAuthor ? 'foreign' : 'own'
    case 'assistant':
      // An interim note and the answer are the same bot, but the note is muted
      // and the answer is not, so a run that mixes them reads as a rendering
      // bug. They stay apart.
      if (item.interim) {
        return 'bot-interim'
      }

      // A reply addressed at a teammate bot is its own turn, not a continuation
      // of the one before it: it carries the "REPLY TO @handle" eyebrow, and an
      // eyebrow is a heading. Grouped, it was drawn 3pt under the previous
      // bubble's bottom edge with nothing between them, which is what the owner
      // read as jammed. Keyed by the HANDLE so two consecutive replies to the
      // same teammate still group — and then only the first of that run carries
      // the eyebrow, which is the point of having one.
      return item.replyToBotHandle ? `bot-reply:${item.replyToBotHandle}` : 'bot'
    case 'bot_dm_in':
      return `dm:${item.senderHandle ?? item.senderName.toLowerCase()}`
    default:
      return null
  }
}

/** `Today`, `Yesterday`, `Tue 16 September`, `16 September 2025`. */
export function dateStampFor(unixSeconds: number, now = Date.now() / 1000): string {
  const date = new Date(unixSeconds * 1000)
  const today = new Date(now * 1000)
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  const daysApart = Math.round((startOfToday - startOfDate) / 86_400_000)

  if (daysApart === 0) {
    return 'Today'
  }

  if (daysApart === 1) {
    return 'Yesterday'
  }

  const weekday = date.toLocaleDateString('en-GB', { weekday: 'short' })
  const dayMonth = date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })

  return daysApart < 7
    ? `${weekday} ${dayMonth}`
    : date.getFullYear() === today.getFullYear()
      ? dayMonth
      : `${dayMonth} ${date.getFullYear()}`
}

/**
 * Lay out the whole visible list.
 *
 * Indexed by item id rather than by position, so the caller can reverse the
 * array for an inverted `FlatList` without the layout going with it.
 */
export function layoutRows(entries: readonly VisibleItem[], now = Date.now() / 1000): Record<string, RowLayout> {
  const layout: Record<string, RowLayout> = {}
  let lastStamp: string | undefined

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]

    if (!entry) {
      continue
    }

    const item = entry.item
    const key = speakerKey(item)

    // A hidden row is not on the screen, so it must not break a run either —
    // otherwise turning Quiet on would visibly re-group the conversation.
    const previous = previousVisible(entries, index)
    const next = nextVisible(entries, index)

    const grouped =
      key !== null && previous !== undefined && speakerKey(previous) === key && withinWindow(previous.ts, item.ts)

    const tail = key === null || next === undefined || speakerKey(next) !== key || !withinWindow(item.ts, next.ts)

    const ledgerRun = item.kind === 'bot_dm_out' && previous?.kind === 'bot_dm_out'

    // A hidden row draws nothing, so it must not swallow the day's stamp either:
    // the stamp passes to the first row of that day the reader can actually see.
    const stamp = entry.presentation === 'hidden-placeholder' || !item.ts ? undefined : dateStampFor(item.ts, now)
    const dateStamp = stamp && stamp !== lastStamp ? stamp : undefined

    if (stamp) {
      lastStamp = stamp
    }

    layout[item.id] = { grouped, ledgerRun, tail, ...(dateStamp ? { dateStamp } : {}) }
  }

  return layout
}

function withinWindow(before: number | undefined, after: number | undefined): boolean {
  // No stamp on either side means nothing to disprove the run. History rows from
  // a gateway that persisted no timestamps would otherwise never group at all.
  if (before === undefined || after === undefined) {
    return true
  }

  return Math.abs(after - before) <= GROUP_WINDOW_SECONDS
}

function previousVisible(entries: readonly VisibleItem[], index: number): TranscriptItem | undefined {
  for (let probe = index - 1; probe >= 0; probe -= 1) {
    const entry = entries[probe]

    if (entry && entry.presentation !== 'hidden-placeholder') {
      return entry.item
    }
  }

  return undefined
}

function nextVisible(entries: readonly VisibleItem[], index: number): TranscriptItem | undefined {
  for (let probe = index + 1; probe < entries.length; probe += 1) {
    const entry = entries[probe]

    if (entry && entry.presentation !== 'hidden-placeholder') {
      return entry.item
    }
  }

  return undefined
}
