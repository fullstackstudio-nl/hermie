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
  neighbourOffsets,
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

/**
 * The list as it really stacks: a divider is shorter than a chat row, and a chat row
 * on the iPad is taller than one on the phone. A uniform stack cannot tell an error
 * in the arithmetic from an error in the assumption.
 */
const ragged: Record<string, RowBox> = (() => {
  const heights: Record<string, number> = {
    archive: 44,
    'archived:delta': 72,
    'bot:alpha': 72,
    'bot:beta': 72,
    'bot:gamma': 72,
    'divider:d1': 32,
    'divider:d2': 32,
    'empty:d2': 56
  }
  const boxes: Record<string, RowBox> = {}
  let y = 0

  for (const item of items) {
    boxes[item.key] = { height: heights[item.key] ?? 72, y }
    y += heights[item.key] ?? 72
  }

  return boxes
})()

describe('which slot the finger is over, with dividers in the way', () => {
  // alpha 0…72, beta 72…144, d1 144…176, gamma 176…248, d2 248…280, empty 280…336.
  it.each([
    [0, 0, 'above the first chat'],
    [35, 0, 'the top half of the first chat'],
    [37, 1, 'the bottom half of the first chat'],
    [150, 2, 'the top half of a divider, which is only thirty-two points tall'],
    [161, 3, 'the bottom half of that divider'],
    [200, 3, 'the top half of the chat under it'],
    [220, 4, 'the bottom half of that chat'],
    [300, 5, 'the empty section under the second divider'],
    [335, 6, 'past everything'],
    [900, 6, 'well past everything']
  ])('reads %i as slot %i (%s)', (pointerY, slot) => {
    expect(dropSlot(anchors, ragged, pointerY)).toBe(slot)
  })

  it('does not assume a uniform row, which is what a divider in the list disproves', () => {
    // 160 is past the divider's midpoint (144 + 16) and short of the midpoint a
    // stack of equal rows would have put there.
    expect(dropSlot(anchors, ragged, 160)).toBe(3)
    expect(
      dropSlot(anchors, Object.fromEntries(items.map((item, index) => [item.key, { height: 72, y: index * 72 }])), 160)
    ).toBe(2)
  })
})

describe('how far the other rows move aside', () => {
  it('opens the gap with the LIFTED row’s height, not with each row’s own', () => {
    // gamma, seventy-two tall, dragged up to the top of the list.
    expect(neighbourOffsets(anchors, ragged, 3, 0)).toEqual({
      'bot:alpha': 72,
      'bot:beta': 72,
      'bot:gamma': 0,
      'divider:d1': 72,
      'divider:d2': 0,
      'empty:d2': 0
    })
  })

  it('moves the rows a chat has passed on its way down, and nothing else', () => {
    // alpha dragged down past beta and the divider, to the slot above gamma.
    expect(neighbourOffsets(anchors, ragged, 0, 3)).toEqual({
      'bot:alpha': 0,
      'bot:beta': -72,
      'bot:gamma': 0,
      'divider:d1': -72,
      'divider:d2': 0,
      'empty:d2': 0
    })
  })

  it('moves nothing while the row is over its own place', () => {
    expect(Object.values(neighbourOffsets(anchors, ragged, 1, 1))).toEqual([0, 0, 0, 0, 0, 0])
    expect(Object.values(neighbourOffsets(anchors, ragged, 1, 2))).toEqual([0, 0, 0, 0, 0, 0])
  })

  it('sends every row home when the gesture ends', () => {
    expect(Object.values(neighbourOffsets(anchors, ragged, 3, null))).toEqual([0, 0, 0, 0, 0, 0])
  })

  it('shifts nothing at all when the lifted row has not been measured', () => {
    expect(Object.values(neighbourOffsets(anchors, {}, 0, 3))).toEqual([0, 0, 0, 0, 0, 0])
  })
})
