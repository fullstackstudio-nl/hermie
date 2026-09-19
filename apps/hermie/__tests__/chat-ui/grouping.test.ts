/**
 * Grouping, tails and date stamps — the three whole-list facts a row cannot work
 * out for itself.
 *
 * The one that matters most: the tail is drawn ONLY on the last bubble of a run.
 * The previous build drew it on every bubble, which is what put a protruding
 * square on the corner of each one.
 */
import { dateStampFor, GROUP_WINDOW_SECONDS, layoutRows, speakerKey } from '../../src/chat-ui'
import type { TranscriptItem, VisibleItem } from '../../src/chat-ui/types'

const AT = 1_767_000_000

function user(id: string, ts: number, extra: Partial<TranscriptItem> = {}): VisibleItem {
  return {
    item: { id, kind: 'user', origin: 'history', seq: ts, text: id, ts, version: 0, ...extra } as TranscriptItem,
    presentation: 'full'
  }
}

function assistant(id: string, ts: number): VisibleItem {
  return {
    item: {
      id,
      interim: false,
      kind: 'assistant',
      origin: 'history',
      seq: ts,
      status: 'complete',
      streaming: false,
      text: id,
      ts,
      version: 0
    } as TranscriptItem,
    presentation: 'full'
  }
}

function tool(id: string, ts: number): VisibleItem {
  return {
    item: {
      id,
      kind: 'tool',
      name: 'terminal',
      origin: 'history',
      resultKnown: false,
      seq: ts,
      status: 'complete',
      toolId: id,
      ts,
      version: 0
    } as TranscriptItem,
    presentation: 'collapsed'
  }
}

describe('speakerKey', () => {
  it('keeps a turn of unknown authorship out of the owner’s own run', () => {
    expect(speakerKey(user('a', AT).item)).toBe('own')
    expect(speakerKey(user('b', AT, { unknownAuthor: true }).item)).toBe('foreign')
  })

  it('separates an interim note from the answer', () => {
    const answer = assistant('a', AT).item
    const note = { ...answer, id: 'b', interim: true } as TranscriptItem

    expect(speakerKey(answer)).not.toBe(speakerKey(note))
  })

  it('gives anything that is not speech no key at all', () => {
    expect(speakerKey(tool('t', AT).item)).toBeNull()
  })
})

describe('layoutRows', () => {
  it('tails only the LAST bubble of a run', () => {
    const layout = layoutRows([user('a', AT), user('b', AT + 5), user('c', AT + 10)])

    expect(layout.a?.tail).toBe(false)
    expect(layout.b?.tail).toBe(false)
    expect(layout.c?.tail).toBe(true)
  })

  it('groups every bubble after the first of a run', () => {
    const layout = layoutRows([user('a', AT), user('b', AT + 5), user('c', AT + 10)])

    expect(layout.a?.grouped).toBe(false)
    expect(layout.b?.grouped).toBe(true)
    expect(layout.c?.grouped).toBe(true)
  })

  it('tails a lone bubble', () => {
    const layout = layoutRows([user('a', AT)])

    expect(layout.a).toMatchObject({ grouped: false, tail: true })
  })

  it('ends a run when the speaker changes', () => {
    const layout = layoutRows([user('a', AT), assistant('b', AT + 2), user('c', AT + 4)])

    expect(layout.a?.tail).toBe(true)
    expect(layout.b?.tail).toBe(true)
    expect(layout.c?.tail).toBe(true)
    expect(layout.c?.grouped).toBe(false)
  })

  // A tool row between two replies is visible, so the replies are not adjacent on
  // screen and drawing the second as a continuation of the first would misreport
  // the order things happened in.
  it('ends a run at anything that is not speech', () => {
    const layout = layoutRows([assistant('a', AT), tool('t', AT + 1), assistant('b', AT + 2)])

    expect(layout.a?.tail).toBe(true)
    expect(layout.b?.grouped).toBe(false)
  })

  it('ends a run when the two turns are far apart in time', () => {
    const layout = layoutRows([user('a', AT), user('b', AT + GROUP_WINDOW_SECONDS + 1)])

    expect(layout.a?.tail).toBe(true)
    expect(layout.b?.grouped).toBe(false)
  })

  // Turning Quiet on must not visibly re-group the conversation: a hidden row is
  // not on screen, so it cannot separate two bubbles.
  it('looks through a hidden row', () => {
    const hidden = { ...tool('t', AT + 1), presentation: 'hidden-placeholder' as const }
    const layout = layoutRows([user('a', AT), hidden, user('b', AT + 2)])

    expect(layout.b?.grouped).toBe(true)
    expect(layout.a?.tail).toBe(false)
  })

  it('groups rows with no timestamps at all rather than never grouping them', () => {
    const noStamp = (id: string): VisibleItem => ({
      item: { id, kind: 'user', origin: 'history', seq: 0, text: id, version: 0 } as TranscriptItem,
      presentation: 'full'
    })
    const layout = layoutRows([noStamp('a'), noStamp('b')])

    expect(layout.b?.grouped).toBe(true)
  })

  it('stamps the first row of each day and no other', () => {
    const day = 86_400
    const layout = layoutRows([user('a', AT - day), user('b', AT - day + 5), user('c', AT)], AT)

    expect(layout.a?.dateStamp).toBeTruthy()
    expect(layout.b?.dateStamp).toBeUndefined()
    expect(layout.c?.dateStamp).toBeTruthy()
    expect(layout.a?.dateStamp).not.toBe(layout.c?.dateStamp)
  })
})

describe('dateStampFor', () => {
  it('names today and yesterday rather than dating them', () => {
    expect(dateStampFor(AT, AT)).toBe('Today')
    expect(dateStampFor(AT - 86_400, AT)).toBe('Yesterday')
  })

  it('uses a weekday inside the last week and a date beyond it', () => {
    expect(dateStampFor(AT - 3 * 86_400, AT)).toMatch(/^[A-Z][a-z]{2} \d+ \w+$/)
    expect(dateStampFor(AT - 30 * 86_400, AT)).not.toMatch(/^[A-Z][a-z]{2} /)
  })

  it('adds the year once the date is in another one', () => {
    expect(dateStampFor(AT - 400 * 86_400, AT)).toMatch(/\d{4}$/)
  })
})
