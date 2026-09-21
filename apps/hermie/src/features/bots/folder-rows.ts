/**
 * The arrangement, as the rows a list actually draws — and where a drop lands.
 *
 * `store/folders.ts` holds the arrangement as two lists that mean one thing: a
 * top level of folders and loose chats, and each folder's contents. This turns
 * that into the FLAT sequence a `FlatList` renders, which is a different space:
 * a collapsed folder's children are not in it, an archived chat is drawn in the
 * drawer rather than where it sits, and an empty expanded folder gets a row of
 * its own that stands for nothing in the arrangement at all.
 *
 * A drag happens in this second space and has to commit in the first. That
 * translation was the only hard part of dragging a row when the groups were
 * headings, and folders make it harder in exactly one way: a position is no
 * longer a single index. It is a CONTAINER and an index inside it, because
 * "third from the top" and "third inside Finance" are different places that the
 * same number would name.
 *
 * Three ideas, the same three as before:
 *
 *  - an **anchor** is a visible row that stands for a position;
 *  - a **slot** is the gap between two anchors, which is what a drop line draws;
 *  - the **target** of slot `n` is anchor `n`'s own position, because dropping
 *    into a gap means "immediately before the row below the line".
 *
 * Two anchors are not rows anybody drags. `folderIn:<id>` is the bottom half of
 * a folder's own header and means "inside this folder, first" — it is what makes
 * "drop onto the folder" a real gesture, and it works for a collapsed folder as
 * well as an open one, which is the case a drop line between children cannot
 * reach. `folderEmpty:<id>` is the placeholder row an open, empty folder draws,
 * so a folder somebody has just emptied still has somewhere to drop a chat back
 * into.
 *
 * Pure. The alternative is finding out at sixty frames a second that a row went
 * into the wrong folder.
 */
import type { Arrangement, Folder } from '../../store/folders'
import { isMuted, type Mutes } from '../../store/mute'
import type { RowBox } from './drag-order'

/** One rendered row. `folderId` is which container a bot row is drawn in. */
export type FolderRow =
  | { kind: 'folder'; key: string; folder: Folder; open: boolean; counts: FolderCounts }
  | { kind: 'folderEmpty'; key: string; folderId: string }
  | { kind: 'bot'; key: string; name: string; folderId: string | null; archived?: false }
  | { kind: 'archivedHeader'; key: string; count: number }
  | { kind: 'bot'; key: string; name: string; folderId: null; archived: true }

/** What a closed folder says about what is inside it. */
export interface FolderCounts {
  /**
   * Unread messages across its bots, MUTED ONES INCLUDED.
   *
   * A mute silences the buzzing, not the counting. An unread badge is the
   * reader looking at the list on purpose and asking what arrived while they
   * were not watching — and a muted chat's four messages are exactly the thing
   * they came to find out about. The same rule the individual row already
   * follows: `BotRow` draws the bell AND the pill, because "this chat is quiet"
   * and "four things arrived in it" are two different facts.
   */
  unread: number
  /** True when any bot inside has a question waiting, muted ones excluded. */
  needsInput: boolean
  /** How many bots are inside, muted or not. Used for the empty case only. */
  size: number
}

/**
 * A row's key, which is also its identity everywhere else.
 *
 * The keys were spelled out as template literals in five files. They are one
 * vocabulary — `bot:<name>` and `folder:<id>` — and the drag now speaks it end
 * to end rather than speaking bot names and building keys at the edges, so it
 * is stated once and read back once.
 */
export const botRowKey = (name: string): string => `bot:${name}`
export const folderRowKey = (id: string): string => `folder:${id}`

export type ParsedRowKey = { kind: 'bot'; name: string } | { kind: 'folder'; id: string }

/**
 * What a row key means, or nothing.
 *
 * `folderIn:` and `folderEmpty:` are deliberately NOT parsed: they are anchors
 * — positions — and never rows anybody drags, so a key that names one is not a
 * row and saying so is the point.
 */
export function parseRowKey(key: string): ParsedRowKey | null {
  if (key.startsWith('bot:')) {
    return { kind: 'bot', name: key.slice('bot:'.length) }
  }

  if (key.startsWith('folder:')) {
    return { kind: 'folder', id: key.slice('folder:'.length) }
  }

  return null
}

/** Where a drop commits: a container, and an index inside it. */
export interface DropTarget {
  folderId: string | null
  index: number
}

export interface DragAnchor {
  key: string
  target: DropTarget
}

export interface RowsInput {
  arrangement: Arrangement
  archived: Record<string, true>
  /** Folder ids the reader has closed. Local to this device; never synced. */
  collapsed: Record<string, true>
  mutes: Mutes
  /** Unix seconds, for the mutes. */
  now: number
  /** Per-bot unread count and whether a question is waiting. */
  countsFor: (botName: string) => { unread: number; needsInput: boolean }
}

/**
 * What a folder is holding, for the badge it wears while it is closed.
 *
 * **The two numbers follow different rules about mute, and that is the point.**
 *
 * `unread` counts a muted bot like any other. A closed folder hides rows the
 * reader would otherwise see carrying their own badges, so a count that skipped
 * the muted ones would make collapsing a folder DELETE information — four
 * messages visible while it is open and nothing at all while it is shut. Mute
 * is about not being interrupted; a badge on a list somebody opened on purpose
 * is not an interruption.
 *
 * `needsInput` does skip them. That dot is a summons — it says a bot is blocked
 * and will stay blocked until this reader answers — and summoning somebody to a
 * conversation they silenced is exactly what mute is for.
 *
 * Archived bots are excluded from both, for the reason they always were:
 * archiving already takes a chat out of every count.
 */
export function folderCounts(folder: Folder, input: RowsInput): FolderCounts {
  let unread = 0
  let needsInput = false
  let size = 0

  for (const name of folder.bots) {
    if (input.archived[name]) {
      continue
    }

    size += 1

    const counts = input.countsFor(name)
    const muted = isMuted(input.mutes, name, input.now)

    unread += counts.unread
    needsInput = needsInput || (counts.needsInput && !muted)
  }

  return { unread, needsInput, size }
}

/**
 * Every row the list draws, in order.
 *
 * The archived drawer is deliberately NOT here: it is one group with its own
 * header and its own rules, the caller already draws it separately, and folding
 * it in would put rows into the anchor table that must never be drop targets.
 */
export function folderRows(input: RowsInput): FolderRow[] {
  const rows: FolderRow[] = []

  for (const entry of input.arrangement.entries) {
    if (entry.kind === 'chat') {
      if (!input.archived[entry.name]) {
        rows.push({ kind: 'bot', key: botRowKey(entry.name), name: entry.name, folderId: null })
      }

      continue
    }

    const folder = input.arrangement.folders.find(candidate => candidate.id === entry.id)

    if (!folder) {
      continue
    }

    const open = !input.collapsed[folder.id]

    rows.push({
      kind: 'folder',
      key: folderRowKey(folder.id),
      folder,
      open,
      counts: folderCounts(folder, input)
    })

    if (!open) {
      continue
    }

    const visible = folder.bots.filter(name => !input.archived[name])

    if (!visible.length) {
      // Somewhere to drop a chat back INTO a folder that has just been emptied.
      rows.push({ kind: 'folderEmpty', key: `folderEmpty:${folder.id}`, folderId: folder.id })
      continue
    }

    for (const name of visible) {
      rows.push({ kind: 'bot', key: botRowKey(name), name, folderId: folder.id })
    }
  }

  return rows
}

/**
 * The position every anchor stands for.
 *
 * Indices are into the ARRANGEMENT, not into the rendered rows, and they count
 * every member of the container including archived ones — an archived chat keeps
 * its place in the arrangement while being drawn in the drawer, so counting only
 * the visible rows would slide a drop one position for every archived chat above
 * it. That was a real off-by-N, not a hypothetical one.
 */
export function dragAnchors(input: RowsInput): DragAnchor[] {
  const anchors: DragAnchor[] = []
  const { entries, folders } = input.arrangement

  entries.forEach((entry, index) => {
    if (entry.kind === 'chat') {
      if (!input.archived[entry.name]) {
        anchors.push({ key: botRowKey(entry.name), target: { folderId: null, index } })
      }

      return
    }

    const folder = folders.find(candidate => candidate.id === entry.id)

    if (!folder) {
      return
    }

    // The folder's own row, twice: above it is the top level, and its bottom
    // half is inside it. See the note at the top about why the second one is
    // what makes a collapsed folder reachable at all.
    anchors.push({ key: folderRowKey(folder.id), target: { folderId: null, index } })
    anchors.push({ key: `folderIn:${folder.id}`, target: { folderId: folder.id, index: 0 } })

    if (input.collapsed[folder.id]) {
      return
    }

    if (!folder.bots.some(name => !input.archived[name])) {
      anchors.push({ key: `folderEmpty:${folder.id}`, target: { folderId: folder.id, index: 0 } })

      return
    }

    folder.bots.forEach((name, inside) => {
      if (!input.archived[name]) {
        anchors.push({ key: botRowKey(name), target: { folderId: folder.id, index: inside } })
      }
    })
  })

  return anchors
}

/**
 * The boxes `dropSlot` measures against, including the two synthetic ones.
 *
 * `folderIn:<id>` is the BOTTOM HALF of the folder's header. A drop line is
 * placed by comparing the pointer against each row's midpoint, so giving this
 * anchor the header's own box would make it unreachable — the anchor above it
 * shares that midpoint and is scanned first. Half a row, starting halfway down,
 * gives it a midpoint of its own three quarters of the way through the header,
 * which reads exactly as "onto the folder" rather than "above" or "below" it.
 */
export function anchorBoxes(
  anchors: readonly DragAnchor[],
  measured: Readonly<Record<string, RowBox>>
): Record<string, RowBox> {
  const boxes: Record<string, RowBox> = { ...measured }

  for (const anchor of anchors) {
    if (!anchor.key.startsWith('folderIn:')) {
      continue
    }

    const header = measured[`folder:${anchor.key.slice('folderIn:'.length)}`]

    if (header) {
      boxes[anchor.key] = { y: header.y + header.height / 2, height: header.height / 2 }
    }
  }

  return boxes
}

/**
 * Where a drop in `slot` commits.
 *
 * Past the last anchor is the end of the TOP LEVEL, never the end of whichever
 * folder happened to be last: dragging a row to the bottom of the list means
 * "out of everything", which is the only reading that gives a reader a way to
 * take a chat out of the last folder by dragging.
 */
export function dropTarget(anchors: readonly DragAnchor[], slot: number, arrangement: Arrangement): DropTarget {
  return anchors[slot]?.target ?? { folderId: null, index: arrangement.entries.length }
}

/**
 * The TOP-LEVEL position a target stands for.
 *
 * Folders do not nest — an `Arrangement` is a top level and a set of folders
 * holding chat names — so a folder dropped anywhere inside another folder has
 * to mean something at the top level instead of meaning nothing. It means
 * "where that folder is": dropping onto a folder's own body, or between two of
 * its chats, reads as putting the dragged folder NEXT TO it, which is the only
 * answer a reader can predict.
 *
 * A target whose container has since disappeared falls back to the end of the
 * top level, for the same reason a drop past the last row does.
 */
export function topLevelIndexOf(arrangement: Arrangement, target: DropTarget): number {
  if (target.folderId === null) {
    return target.index
  }

  const at = arrangement.entries.findIndex(entry => entry.kind === 'folder' && entry.id === target.folderId)

  return at === -1 ? arrangement.entries.length : at
}

/** Where a row currently sits in whatever container holds it, or `-1`. */
function positionOf(arrangement: Arrangement, key: ParsedRowKey, folderId: string | null): number {
  if (key.kind === 'folder') {
    return arrangement.entries.findIndex(entry => entry.kind === 'folder' && entry.id === key.id)
  }

  if (folderId === null) {
    return arrangement.entries.findIndex(entry => entry.kind === 'chat' && entry.name === key.name)
  }

  return arrangement.folders.find(folder => folder.id === folderId)?.bots.indexOf(key.name) ?? -1
}

/**
 * Is this drop a no-op, for any row?
 *
 * The key generalisation of `isSamePlace`: a folder's own place is an index in
 * the top level and a chat's is an index in whichever container holds it, and
 * both of them are "the same arrangement" when the drop lands immediately
 * before or immediately after the row itself.
 */
export function isSameRowPlace(arrangement: Arrangement, key: string, target: DropTarget): boolean {
  const parsed = parseRowKey(key)

  if (!parsed) {
    return true
  }

  if (parsed.kind === 'folder') {
    const index = topLevelIndexOf(arrangement, target)
    const at = positionOf(arrangement, parsed, null)

    return at !== -1 && (index === at || index === at + 1)
  }

  return isSamePlace(arrangement, parsed.name, target)
}

/**
 * The index a move should use once the row has been taken out, for any row.
 *
 * The same correction `committedIndex` makes and for the same reason — both
 * `moveBotTo` and `moveFolderTo` read their index against the container WITHOUT
 * the moving row, and a drop line is computed against the container WITH it.
 */
export function committedRowIndex(arrangement: Arrangement, key: string, target: DropTarget): number {
  const parsed = parseRowKey(key)

  if (!parsed) {
    return target.index
  }

  if (parsed.kind === 'folder') {
    const index = topLevelIndexOf(arrangement, target)
    const from = positionOf(arrangement, parsed, null)

    return from !== -1 && index > from ? index - 1 : index
  }

  return committedIndex(arrangement, parsed.name, target)
}

/**
 * Is this drop a no-op?
 *
 * Dropping a row immediately before or immediately after ITSELF is the same
 * arrangement, and committing it would churn the disk and the gateway for
 * nothing. The comparison has to be per container: index 2 of the top level and
 * index 2 of a folder are different places, so "same index" alone is not it.
 */
export function isSamePlace(arrangement: Arrangement, botName: string, target: DropTarget): boolean {
  const container =
    target.folderId === null
      ? arrangement.entries
      : (arrangement.folders.find(folder => folder.id === target.folderId)?.bots ?? [])

  const at = container.findIndex(member =>
    typeof member === 'string' ? member === botName : member.kind === 'chat' && member.name === botName
  )

  return at !== -1 && (target.index === at || target.index === at + 1)
}

/**
 * The index a move should use, once the row has been taken out.
 *
 * `moveBotTo` reads its index against the container WITHOUT the moving row, and
 * a drop line is computed against the container WITH it. Everything below the
 * row's old position therefore shifts up by one. Doing the correction here
 * rather than at the call site is what keeps "same container" and "different
 * container" one code path.
 */
export function committedIndex(arrangement: Arrangement, botName: string, target: DropTarget): number {
  const from =
    target.folderId === null
      ? arrangement.entries.findIndex(entry => entry.kind === 'chat' && entry.name === botName)
      : (arrangement.folders.find(folder => folder.id === target.folderId)?.bots.indexOf(botName) ?? -1)

  return from !== -1 && target.index > from ? target.index - 1 : target.index
}
