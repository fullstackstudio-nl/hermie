/**
 * The list's arrangement: order, dividers, archive, colour.
 *
 * All of it is local to this device and none of it is sent to the gateway
 * (ADR-0012), so the whole contract is testable without a connection — which is
 * the point of keeping it in a plain store rather than in the controllers.
 *
 * The cases that earn their place here are the ones where the roster and the
 * arrangement disagree: a bot that appears, a bot that vanishes, and a gateway
 * that is swapped underneath both.
 */
import { CHAT_LAYOUT_KEY, archivedOf, dividersOf, sectionsOf, useChatLayoutStore } from '../src/store/chat-layout'

const mockDisk = new Map<string, string>()

jest.mock('../src/platform/key-value-store', () => ({
  keyValueStore: {
    get: jest.fn(async (key: string) => mockDisk.get(key) ?? null),
    set: jest.fn(async (key: string, value: string) => {
      mockDisk.set(key, value)
    }),
    delete: jest.fn(async (key: string) => {
      mockDisk.delete(key)
    }),
    getJson: jest.fn(async (key: string) => {
      const raw = mockDisk.get(key)

      return raw === undefined ? null : JSON.parse(raw)
    }),
    setJson: jest.fn(async (key: string, value: unknown) => {
      mockDisk.set(key, JSON.stringify(value))
    })
  }
}))

const store = () => useChatLayoutStore.getState()
const order = () => store().entries.map(entry => (entry.kind === 'chat' ? entry.name : `#${entry.name}`))

/** Writes are queued, so a test that reads the disk has to let the queue drain. */
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0))

beforeEach(() => {
  mockDisk.clear()
  store().reset()
})

describe('reconciling the arrangement with the roster', () => {
  it('builds the first arrangement from the roster order', () => {
    store().reconcile(['researcher', 'writer', 'bookkeeper'])

    expect(order()).toEqual(['researcher', 'writer', 'bookkeeper'])
  })

  it('lands a new bot at the end of the unsectioned top group, not at the very end', () => {
    store().reconcile(['researcher', 'writer'])
    store().addDivider('Finance')
    store().moveToSection('writer', dividersOf(store().entries)[0]!.id)

    store().reconcile(['researcher', 'writer', 'postman'])

    // Under the heading would bury it in a section it was never put in; the top
    // would push it in front of whatever is being read.
    expect(order()).toEqual(['researcher', 'postman', '#Finance', 'writer'])
  })

  it('drops a bot the gateway no longer has, and keeps everything around it', () => {
    store().reconcile(['researcher', 'writer', 'postman'])
    store().addDivider('Work')
    store().moveToSection('postman', dividersOf(store().entries)[0]!.id)

    store().reconcile(['researcher', 'postman'])

    expect(order()).toEqual(['researcher', '#Work', 'postman'])
  })

  it('does not rewrite the arrangement when nothing changed', () => {
    store().reconcile(['researcher', 'writer'])
    const before = store().entries

    store().reconcile(['researcher', 'writer'])

    // Same identity, so a list re-rendering on every roster poll is impossible.
    expect(store().entries).toBe(before)
  })
})

describe('moving rows', () => {
  beforeEach(() => store().reconcile(['researcher', 'writer', 'bookkeeper']))

  it('moves one position at a time', () => {
    store().moveBy('bookkeeper', -1)

    expect(order()).toEqual(['researcher', 'bookkeeper', 'writer'])
  })

  it('stops at the ends rather than wrapping', () => {
    store().moveBy('researcher', -5)
    expect(order()).toEqual(['researcher', 'writer', 'bookkeeper'])

    store().moveBy('bookkeeper', 9)
    expect(order()).toEqual(['researcher', 'writer', 'bookkeeper'])
  })

  /**
   * The reason dividers and chats share one array: stepping past a heading is
   * how a bot changes section, and it is the same gesture as stepping past
   * another bot.
   */
  it('crosses a divider by stepping over it', () => {
    store().addDivider('Finance')
    expect(order()).toEqual(['researcher', 'writer', 'bookkeeper', '#Finance'])

    store().moveBy('bookkeeper', 1)

    expect(order()).toEqual(['researcher', 'writer', '#Finance', 'bookkeeper'])
    expect(sectionsOf(store().entries, {})).toEqual([
      { divider: null, bots: ['researcher', 'writer'] },
      { divider: { id: expect.any(String), name: 'Finance' }, bots: ['bookkeeper'] }
    ])
  })

  it('moves to the end of a named section in one step', () => {
    const id = store().addDivider('Finance')

    store().moveToSection('researcher', id)
    store().moveToSection('writer', id)

    expect(order()).toEqual(['bookkeeper', '#Finance', 'researcher', 'writer'])
  })

  it('moves back out into the unsectioned top group', () => {
    const id = store().addDivider('Finance')
    store().moveToSection('researcher', id)

    store().moveToSection('researcher', null)

    expect(order()).toEqual(['writer', 'bookkeeper', 'researcher', '#Finance'])
  })

  it('ignores a move for a bot that is not in the arrangement', () => {
    const before = store().entries

    store().moveBy('nobody', 1)
    store().moveToSection('nobody', null)

    expect(store().entries).toBe(before)
  })
})

describe('dividers', () => {
  beforeEach(() => store().reconcile(['researcher', 'writer']))

  it('renames in place', () => {
    const id = store().addDivider('Finace')

    store().renameDivider(id, 'Finance')

    expect(dividersOf(store().entries)).toEqual([{ id, name: 'Finance' }])
  })

  /**
   * Removing a heading must never take rows with it. The rows stay where they
   * are, which folds them into the section above — the same thing that would
   * happen if the heading were dragged away.
   */
  it('removes the heading and keeps its rows', () => {
    const id = store().addDivider('Finance')
    store().moveToSection('writer', id)

    store().removeDivider(id)

    expect(order()).toEqual(['researcher', 'writer'])
  })

  it('keeps a named section that is empty, so there is something to move into', () => {
    store().addDivider('Finance')

    expect(sectionsOf(store().entries, {})).toEqual([
      { divider: null, bots: ['researcher', 'writer'] },
      { divider: { id: expect.any(String), name: 'Finance' }, bots: [] }
    ])
  })
})

describe('archiving', () => {
  beforeEach(() => store().reconcile(['researcher', 'writer']))

  it('pulls a bot out of the sections without losing its place', () => {
    store().setArchived('writer', true)

    expect(sectionsOf(store().entries, store().archived)).toEqual([{ divider: null, bots: ['researcher'] }])
    expect(archivedOf(store().entries, store().archived)).toEqual(['writer'])

    store().setArchived('writer', false)

    // Back exactly where it was, because archiving never moved the entry.
    expect(sectionsOf(store().entries, store().archived)).toEqual([{ divider: null, bots: ['researcher', 'writer'] }])
  })
})

describe('per-chat colour', () => {
  it('stores a colour and treats Default as the absence of one', () => {
    store().setAccent('writer', 'teal')
    expect(store().accents).toEqual({ writer: 'teal' })

    store().setAccent('writer', 'default')
    expect(store().accents).toEqual({})
  })
})

describe('persistence, keyed by gateway', () => {
  it('starts empty for a gateway it has never seen', async () => {
    await store().load('https://gateway.example.com')

    expect(store().entries).toEqual([])
    expect(store().loaded).toBe(true)
  })

  it('reads back what it wrote', async () => {
    await store().load('https://gateway.example.com')
    store().reconcile(['researcher', 'writer'])
    store().setAccent('writer', 'violet')
    store().setArchived('researcher', true)
    await settle()

    store().reset()
    await store().load('https://gateway.example.com')

    expect(order()).toEqual(['researcher', 'writer'])
    expect(store().accents).toEqual({ writer: 'violet' })
    expect(store().archived).toEqual({ researcher: true })
  })

  /**
   * "Change gateway" and "Sign out" differ by exactly one thing: whether the
   * address survives. Keying on the address is therefore the whole
   * implementation — a different machine's bots are a different list, and
   * signing out of the same machine is not.
   */
  it('gives a different gateway its own arrangement and leaves the first one alone', async () => {
    await store().load('https://one.example.com')
    store().reconcile(['researcher'])
    store().setAccent('researcher', 'red')
    await settle()

    await store().load('https://two.example.com')
    expect(store().entries).toEqual([])
    expect(store().accents).toEqual({})

    store().reconcile(['postman'])
    await settle()

    await store().load('https://one.example.com')
    expect(order()).toEqual(['researcher'])
    expect(store().accents).toEqual({ researcher: 'red' })
  })

  it('survives a blob an older build wrote, rather than throwing on it', async () => {
    mockDisk.set(
      CHAT_LAYOUT_KEY,
      JSON.stringify({
        'https://gateway.example.com': {
          entries: [
            { kind: 'chat', name: 'writer' },
            // Junk an older build might have left: a duplicate, a nameless
            // divider, and something that is neither.
            { kind: 'chat', name: 'writer' },
            { kind: 'divider', name: 'no id' },
            { kind: 'mystery' },
            null
          ],
          archived: ['writer', 7],
          accents: { writer: 'teal', researcher: 'chartreuse' }
        }
      })
    )

    await store().load('https://gateway.example.com')

    expect(order()).toEqual(['writer'])
    expect(store().archived).toEqual({ writer: true })
    // An unknown colour is dropped rather than carried into the theme.
    expect(store().accents).toEqual({ writer: 'teal' })
  })

  it('writes nothing before a gateway is known', () => {
    store().reconcile(['researcher'])

    expect(mockDisk.get(CHAT_LAYOUT_KEY)).toBeUndefined()
  })
})

/**
 * The colour picked in the options sheet is the colour the list shows.
 *
 * There is one store behind both pickers (ADR-0012), which is what makes the
 * retint live: the header ring, the selected row and the outgoing bubble all
 * read `accents[bot]` through `useChatAccent`, so a write here reaches every one
 * of them on the next render without anything being told to refresh.
 */
describe('one accent, read by every surface', () => {
  beforeEach(() => useChatLayoutStore.getState().reset())

  it('is the same value whichever picker wrote it', () => {
    useChatLayoutStore.getState().setAccent('researcher', 'teal')

    expect(useChatLayoutStore.getState().accents.researcher).toBe('teal')

    // The row menu setting it back is the same call on the same key.
    useChatLayoutStore.getState().setAccent('researcher', 'magenta')

    expect(useChatLayoutStore.getState().accents.researcher).toBe('magenta')
  })

  it('stores Default as the absence of a choice rather than as a ninth colour', () => {
    useChatLayoutStore.getState().setAccent('researcher', 'teal')
    useChatLayoutStore.getState().setAccent('researcher', 'default')

    expect(useChatLayoutStore.getState().accents).toEqual({})
  })

  it('does not touch any other chat', () => {
    useChatLayoutStore.getState().setAccent('researcher', 'teal')
    useChatLayoutStore.getState().setAccent('writer', 'orange')

    expect(useChatLayoutStore.getState().accents).toEqual({ researcher: 'teal', writer: 'orange' })
  })
})
