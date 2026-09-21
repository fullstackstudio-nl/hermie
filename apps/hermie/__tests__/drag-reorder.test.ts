/**
 * Where a dragged row lands.
 *
 * The gesture cannot be exercised here — a `PanResponder` needs a touch and the
 * boxes it reads come from a real layout pass — but the ARITHMETIC between the two
 * spaces can, and the arithmetic is the only part that can be wrong in a way the
 * eye would not catch immediately. The visible list is filtered and derived; the
 * arrangement is a flat array in which dividers and chats are the same kind of
 * thing. Every case here is that translation.
 */
import {
  dragAnchors,
  dropEntryIndex,
  dropSlot,
  entryIndexByKey,
  rowShift,
  type DragAnchor,
  type RowBox
} from '../src/features/bots/drag-order'
import { useChatLayoutStore, type LayoutEntry } from '../src/store/chat-layout'

const entries: LayoutEntry[] = [
  { kind: 'chat', name: 'alpha' },
  { kind: 'chat', name: 'beta' },
  { kind: 'divider', id: 'd1', name: 'Finance' },
  { kind: 'chat', name: 'gamma' },
  { kind: 'divider', id: 'd2', name: 'Empty' }
]

const items = [
  { key: 'bot:alpha', kind: 'bot', archived: false },
  { key: 'bot:beta', kind: 'bot', archived: false },
  { key: 'divider:d1', kind: 'divider' },
  { key: 'bot:gamma', kind: 'bot', archived: false },
  { key: 'divider:d2', kind: 'divider' },
  { key: 'empty:d2', kind: 'sectionEmpty' },
  { key: 'archive', kind: 'archiveHeader' },
  { key: 'archived:delta', kind: 'bot', archived: true }
]

/** Forty points each, stacked, which is close enough to a real row. */
const boxes: Record<string, RowBox> = Object.fromEntries(
  items.map((item, index) => [item.key, { height: 40, y: index * 40 }])
)

const anchors: DragAnchor[] = dragAnchors(items, entryIndexByKey(entries))

describe('the anchors a drop line can sit above', () => {
  it('is every chat, every divider and every empty section, in visual order', () => {
    expect(anchors.map(anchor => anchor.key)).toEqual([
      'bot:alpha',
      'bot:beta',
      'divider:d1',
      'bot:gamma',
      'divider:d2',
      'empty:d2'
    ])
  })

  it('excludes the archive drawer, because archiving is what takes a chat out of the order', () => {
    expect(anchors.map(anchor => anchor.key)).not.toContain('archived:delta')
    expect(anchors.map(anchor => anchor.key)).not.toContain('archive')
  })

  it('puts an empty section’s own slot INSIDE that section', () => {
    // The heading is at entry index 4; dropping above the empty row means index 5,
    // which is immediately after the heading — in the section rather than before it.
    expect(anchors.find(anchor => anchor.key === 'divider:d2')?.entryIndex).toBe(4)
    expect(anchors.find(anchor => anchor.key === 'empty:d2')?.entryIndex).toBe(5)
  })
})

describe('which slot the finger is over', () => {
  it('flips at a row’s midpoint, not at its edge', () => {
    expect(dropSlot(anchors, boxes, 19)).toBe(0)
    expect(dropSlot(anchors, boxes, 21)).toBe(1)
    expect(dropSlot(anchors, boxes, 59)).toBe(1)
    expect(dropSlot(anchors, boxes, 61)).toBe(2)
  })

  it('reads past the last row as the end of the arrangement', () => {
    expect(dropSlot(anchors, boxes, 10_000)).toBe(anchors.length)
    expect(dropEntryIndex(anchors, anchors.length, entries.length)).toBe(entries.length)
  })

  it('skips a row the list has not measured rather than guessing where it is', () => {
    const partial = { ...boxes }

    delete partial['bot:alpha']

    // With alpha unmeasured the first answerable row is beta, so a pointer at the
    // very top reads as beta's slot rather than as a position nothing is drawn at.
    expect(dropSlot(anchors, partial, 0)).toBe(1)
  })
})

describe('committing a drop', () => {
  beforeEach(() => {
    useChatLayoutStore.setState({ gatewayKey: null, entries: [...entries], archived: {}, accents: {}, loaded: true })
  })

  it('reads the index against the list as it is, including the row being dragged', () => {
    // gamma is at 3. Dropping it before index 1 puts it between alpha and beta —
    // the gap the drop line was drawn in, not one position off it.
    useChatLayoutStore.getState().moveToIndex('gamma', 1)

    expect(useChatLayoutStore.getState().entries.map(describe_)).toEqual([
      'alpha',
      'gamma',
      'beta',
      '#Finance',
      '#Empty'
    ])
  })

  it('moves a chat into a section by crossing its heading', () => {
    useChatLayoutStore.getState().moveToIndex('alpha', 5)

    expect(useChatLayoutStore.getState().entries.map(describe_)).toEqual([
      'beta',
      '#Finance',
      'gamma',
      '#Empty',
      'alpha'
    ])
  })

  it('writes nothing for a drop on either side of where the row already is', () => {
    const before = useChatLayoutStore.getState().entries

    useChatLayoutStore.getState().moveToIndex('beta', 1)
    expect(useChatLayoutStore.getState().entries).toBe(before)

    useChatLayoutStore.getState().moveToIndex('beta', 2)
    expect(useChatLayoutStore.getState().entries).toBe(before)
  })

  it('ignores a chat that is not in the arrangement at all', () => {
    const before = useChatLayoutStore.getState().entries

    useChatLayoutStore.getState().moveToIndex('nobody', 0)
    expect(useChatLayoutStore.getState().entries).toBe(before)
  })
})

describe('a divider added above a row', () => {
  beforeEach(() => {
    useChatLayoutStore.setState({ gatewayKey: null, entries: [...entries], archived: {}, accents: {}, loaded: true })
  })

  it('lands immediately above that row and moves nothing else', () => {
    const id = useChatLayoutStore.getState().addDividerAbove('beta', 'New')

    expect(id).toBeTruthy()
    expect(useChatLayoutStore.getState().entries.map(describe_)).toEqual([
      'alpha',
      '#New',
      'beta',
      '#Finance',
      'gamma',
      '#Empty'
    ])
  })

  it('refuses a bot it cannot find rather than appending a heading to the end', () => {
    expect(useChatLayoutStore.getState().addDividerAbove('nobody', 'New')).toBeNull()
    expect(useChatLayoutStore.getState().entries).toHaveLength(entries.length)
  })
})

function describe_(entry: LayoutEntry): string {
  return entry.kind === 'divider' ? `#${entry.name}` : entry.name
}

/**
 * The rows that are not being dragged.
 *
 * A drop LINE says where a row would land; rows moving aside say it in the shape
 * of the list, which is what every native list does and what the owner means by
 * "it must feel native". The rule is only ever about the span between where the
 * lifted row started and the gap it is over — a list of forty rows must not
 * re-animate thirty-eight of them because one moved.
 */
describe('rowShift', () => {
  it('leaves the lifted row to its own translation', () => {
    expect(rowShift(2, 2, 5)).toBe(0)
  })

  it('shifts nothing while the row is over its own place', () => {
    // Both of these gaps mean "back where it started".
    expect(rowShift(1, 2, 2)).toBe(0)
    expect(rowShift(3, 2, 3)).toBe(0)
    expect(rowShift(4, 2, 3)).toBe(0)
  })

  it('closes the gap behind a row dragged down', () => {
    // Lifted row 1, hovering the gap below row 3: rows 2 and 3 come up one.
    expect(rowShift(2, 1, 4)).toBe(-1)
    expect(rowShift(3, 1, 4)).toBe(-1)
    // Row 4 is below the gap and stays.
    expect(rowShift(4, 1, 4)).toBe(0)
    expect(rowShift(0, 1, 4)).toBe(0)
  })

  it('opens a gap in front of a row dragged up', () => {
    // Lifted row 4, hovering the gap above row 1: rows 1, 2 and 3 go down one.
    expect(rowShift(1, 4, 1)).toBe(1)
    expect(rowShift(3, 4, 1)).toBe(1)
    // Row 0 is above the gap and stays.
    expect(rowShift(0, 4, 1)).toBe(0)
    expect(rowShift(5, 4, 1)).toBe(0)
  })

  it('moves exactly one row for a swap with the neighbour', () => {
    const shifts = [0, 1, 2, 3].map(anchor => rowShift(anchor, 1, 3))

    expect(shifts).toEqual([0, 0, -1, 0])
  })
})
