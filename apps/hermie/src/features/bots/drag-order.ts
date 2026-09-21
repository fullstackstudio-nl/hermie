/**
 * Where a dragged row lands, as arithmetic.
 *
 * The chat list is a FLAT array of positions in which dividers and chats are the
 * same kind of thing (`store/chat-layout.ts`), and it is rendered as a FILTERED,
 * derived list — sections, empty-section rows, an archive drawer. A drag happens in
 * the second space and has to commit in the first, and that translation is the only
 * hard part of dragging a row. It is pure, so it is tested rather than watched.
 *
 * Three ideas:
 *
 *  - an **anchor** is a visible row that stands for a position in the entry list;
 *  - a **slot** is the gap between two anchors, which is what a drop line draws;
 *  - the **entry index** of slot `n` is anchor `n`'s own index, because dropping
 *    into a gap means "immediately before the row below the line".
 *
 * The empty-section row is an anchor too, and that is the one non-obvious entry in
 * the table: without it a named section with no chats left in it would have no gap
 * of its own, and there would be nowhere to drag a chat back INTO.
 */
import type { LayoutEntry } from '../../store/chat-layout'

/** One row's box, as the list measured it, in content coordinates. */
export interface RowBox {
  y: number
  height: number
}

/** A visible row and the entry-list position it stands for. */
export interface DragAnchor {
  key: string
  entryIndex: number
}

/** The minimal shape of a rendered row that this module needs. */
export interface AnchorCandidate {
  key: string
  kind: string
  archived?: boolean
}

/**
 * The entry index every row key stands for.
 *
 * Keys are the list's own (`bot:name`, `archived:name`, `divider:id`,
 * `empty:id`) so the caller does not have to build a parallel identity scheme.
 */
export function entryIndexByKey(entries: readonly LayoutEntry[]): Record<string, number> {
  const byKey: Record<string, number> = {}

  entries.forEach((entry, index) => {
    if (entry.kind === 'divider') {
      byKey[`divider:${entry.id}`] = index
      // A chat dropped into an empty section goes immediately AFTER its heading,
      // which is the position the heading's own index plus one.
      byKey[`empty:${entry.id}`] = index + 1

      return
    }

    byKey[`bot:${entry.name}`] = index
    byKey[`archived:${entry.name}`] = index
  })

  return byKey
}

/**
 * The rows a drop line may sit above, in visual order.
 *
 * Archived rows and the archive header are excluded: archiving is what takes a
 * chat out of the arrangement's reading order, so dropping one back in by dragging
 * would say two contradictory things at once. The drawer keeps its explicit
 * Unarchive instead.
 */
export function dragAnchors(
  items: readonly AnchorCandidate[],
  entryIndexes: Readonly<Record<string, number>>
): DragAnchor[] {
  const anchors: DragAnchor[] = []

  for (const item of items) {
    if (item.archived === true) {
      continue
    }

    if (item.kind !== 'bot' && item.kind !== 'divider' && item.kind !== 'sectionEmpty') {
      continue
    }

    const entryIndex = entryIndexes[item.key]

    if (entryIndex !== undefined) {
      anchors.push({ key: item.key, entryIndex })
    }
  }

  return anchors
}

/**
 * Which slot the pointer is over: the index into `anchors` the line draws above.
 *
 * The comparison is against each row's MIDPOINT rather than its top edge, so the
 * line flips when the dragged row is more than halfway past its neighbour — which
 * is the point at which a reader would say the two have swapped.
 *
 * An unmeasured row is skipped rather than treated as zero-height: a row that has
 * not laid out yet is one FlatList has not rendered, and guessing its position
 * would put the line somewhere nothing is drawn.
 */
export function dropSlot(
  anchors: readonly DragAnchor[],
  boxes: Readonly<Record<string, RowBox>>,
  pointerY: number
): number {
  for (let index = 0; index < anchors.length; index += 1) {
    const anchor = anchors[index]
    const box = anchor ? boxes[anchor.key] : undefined

    if (!box) {
      continue
    }

    if (pointerY < box.y + box.height / 2) {
      return index
    }
  }

  return anchors.length
}

/**
 * The entry index a drop in `slot` commits to.
 *
 * Past the last anchor is the end of the arrangement, which is `entryCount`. An
 * archived chat keeps its position in the entry list while being drawn in the
 * drawer, so a row dropped at the very bottom can land after one of those — which
 * is invisible and harmless: unarchiving it later puts it where it has always been,
 * and the alternative is a special case for rows nobody can see.
 */
export function dropEntryIndex(anchors: readonly DragAnchor[], slot: number, entryCount: number): number {
  return anchors[slot]?.entryIndex ?? entryCount
}

/**
 * How far a row that is NOT being dragged has to move out of the way.
 *
 * `-1` is one row's height up, `1` is one down, `0` is stay put. It is the whole
 * of "the other rows animate aside", and it is arithmetic rather than animation:
 * a row between where the lifted row came FROM and the gap it is over has to
 * close up behind it or open up in front of it, and everything outside that span
 * is untouched.
 *
 * `from` is the lifted row's own anchor index; `slot` is the gap the drop line
 * would sit at, which is an index BETWEEN anchors — so a slot equal to `from` or
 * to `from + 1` both mean "back where it started" and shift nothing.
 *
 * Pure, because the alternative is discovering at 60 frames a second that a row
 * moved the wrong way.
 */
export function rowShift(anchor: number, from: number, slot: number): -1 | 0 | 1 {
  if (anchor === from) {
    return 0
  }

  // Dragging DOWN: everything it has passed comes up one.
  if (slot > from + 1 && anchor > from && anchor < slot) {
    return -1
  }

  // Dragging UP: everything it has passed goes down one.
  if (slot <= from - 1 && anchor >= slot && anchor < from) {
    return 1
  }

  return 0
}

/**
 * How far every visible row has moved aside, in points, by anchor key.
 *
 * `rowShift` says which way a row goes; this says how far, and the two are separate
 * because the distance is not a row's own height — it is the LIFTED row's. What is
 * opening or closing is the hole that row came out of, so a divider closing up
 * behind a chat travels the chat's height and not its own. Shifting by each row's
 * own height would leave a gap of the wrong size under the finger, which is exactly
 * the gap a reader is aiming at.
 *
 * `slot === null` is the end of a gesture: every row goes home.
 */
export function neighbourOffsets(
  anchors: readonly DragAnchor[],
  boxes: Readonly<Record<string, RowBox>>,
  from: number,
  slot: number | null
): Record<string, number> {
  const height = boxes[anchors[from]?.key ?? '']?.height ?? 0
  const offsets: Record<string, number> = {}

  anchors.forEach((anchor, index) => {
    const offset = (slot === null ? 0 : rowShift(index, from, slot)) * height

    // `-1 * 0` is negative zero, which an animation cannot tell from zero and a
    // test can. Nothing here has a signed nothing to express.
    offsets[anchor.key] = offset === 0 ? 0 : offset
  })

  return offsets
}
