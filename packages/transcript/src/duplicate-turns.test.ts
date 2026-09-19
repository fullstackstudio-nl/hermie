/**
 * The ways one message can end up on screen twice, or in the wrong place.
 *
 * Reported from a real gateway: the owner sent one long multi-paragraph message
 * and the transcript showed it twice, a minute apart, with the turn still
 * running. There is no id linking a locally sent turn to the row the gateway
 * writes for it, so every path that can re-describe that turn — the tail sweep,
 * a resume after a reconnect, a cold open mid-turn, an event replay — is a
 * chance to paint it a second time. Each one gets a case here.
 *
 * Kept in its own file rather than spread over `reducer.test.ts` and
 * `reconcile.test.ts`, because what is being pinned is one behaviour that cuts
 * across the reducer, the projection and both reconcilers.
 */
import { describe, expect, it } from 'vitest'

import { reconcile, reconcileTail } from './reconcile'
import { applyEvent, applyResumeSnapshot, beginLocalTurn, confirmSubmit, markInterrupted } from './reducer'
import { rowsToItems, type TranscriptRow } from './rows-to-items'
import { type ChatState, createChatState, type UserItem } from './types'

const NOW = 1_700_000_000_000
/** A minute later, which is how far apart the two bubbles in the report were. */
const LATER = NOW + 60_000

const fresh = () => createChatState('researcher', 'stored-1', 'resolved-1')
const list = (state: ChatState) => state.order.map(id => state.items[id]!)
const users = (state: ChatState) => list(state).filter((item): item is UserItem => item.kind === 'user')
const assistants = (state: ChatState) => list(state).filter(item => item.kind === 'assistant')
const texts = (state: ChatState) => list(state).map(item => `${item.kind}:${'text' in item ? item.text : ''}`)

/** The message from the report: paragraphs, a blank line, an address, a URL. */
const LONG = [
  'Can you have a look at the box again.',
  '',
  'It answers on 192.168.1.44 but the panel at https://example.test/admin is empty.',
  '',
  'Tell me what you find.'
].join('\n')

/** Painted, submitted, and the gateway took it straight away. */
function sentTurn(text = LONG, attachments?: string[]): ChatState {
  return confirmSubmit(beginLocalTurn(fresh(), text, attachments, NOW), { status: 'streaming' }, NOW)
}

describe('the tail sweep after a send', () => {
  it('pairs a multi-paragraph prompt with its row, blank lines and all', () => {
    const state = reconcileTail(
      sentTurn(),
      rowsToItems([{ role: 'user', row_id: 5, text: LONG, timestamp: 1_700_000_060 }], 'rest')
    )

    expect(users(state)).toHaveLength(1)
    expect(users(state)[0]).toMatchObject({ rowId: 5, text: LONG })
  })

  it('pairs through the trims and the line endings the wire changes', () => {
    const composed = '  first line\r\n\r\nsecond line  \n'
    const persisted = 'first line\n\nsecond line'
    const state = reconcileTail(sentTurn(composed), rowsToItems([{ role: 'user', row_id: 6, text: persisted }], 'rest'))

    expect(users(state)).toHaveLength(1)
  })

  it('pairs a prompt whose row comes back in the other Unicode form', () => {
    // A composed e-acute against an e plus a combining acute. The two forms
    // are derived rather than written out: on screen they are the same
    // characters, and a fixture nobody can read is a fixture nobody can fix.
    const composed = `caf${String.fromCodePoint(0xe9)} pl${String.fromCodePoint(0xe4)}ne`
    const decomposed = composed.normalize('NFD')

    // Guards the fixture: a formatter that folded the two into one form would
    // leave this case passing while testing nothing.
    expect(decomposed).not.toBe(composed)

    const state = reconcileTail(
      sentTurn(composed),
      rowsToItems([{ role: 'user', row_id: 7, text: decomposed }], 'rest')
    )

    expect(users(state)).toHaveLength(1)
  })

  it('pairs a send that carried a file, whose row holds no directive line', () => {
    // `withFileReferences` appends the `@file:` token the gateway expands, and
    // the projection lifts that token back out into `attachments` — so the row
    // says less than the body that was submitted.
    const body = 'have a look at this\n\n@file:"/srv/work/uploads/hermie/2026-09-19/ab-notes.txt"'
    const state = reconcileTail(
      sentTurn(body, ['notes.txt']),
      rowsToItems([{ role: 'user', row_id: 8, text: body }], 'rest')
    )

    expect(users(state)).toHaveLength(1)
    expect(users(state)[0]).toMatchObject({ rowId: 8, text: 'have a look at this' })
  })

  it('pairs a send that carried an image, whose directive the gateway appends', () => {
    const state = reconcileTail(
      sentTurn('what is this', ['shot.png']),
      rowsToItems([{ role: 'user', row_id: 9, text: 'what is this\n@image:/srv/work/.hermes/images/shot.png' }], 'rest')
    )

    expect(users(state)).toHaveLength(1)
  })

  it('pairs a prompt the gateway expanded into an attached-context block', () => {
    const body = 'summarise @file:notes.md for me'
    const expanded = `${body}\n\n--- Attached Context ---\n\n@file:notes.md (12 tokens)\n\`\`\`\nhello\n\`\`\``
    const state = reconcileTail(sentTurn(body), rowsToItems([{ role: 'user', row_id: 10, text: expanded }], 'rest'))

    expect(users(state)).toHaveLength(1)
  })

  it('keeps two bubbles when the same message really was sent twice', () => {
    let state = sentTurn('ping')

    state = applyEvent(state, { type: 'message.start', seq: 1 }, NOW)
    state = applyEvent(state, { type: 'message.complete', seq: 2, payload: { text: 'pong', status: 'ok' } }, NOW)
    state = confirmSubmit(beginLocalTurn(state, 'ping', undefined, LATER), { status: 'streaming' }, LATER)

    const rows: TranscriptRow[] = [
      { role: 'user', row_id: 1, text: 'ping', timestamp: 1 },
      { role: 'assistant', row_id: 2, text: 'pong', timestamp: 2 },
      { role: 'user', row_id: 3, text: 'ping', timestamp: 3 }
    ]

    expect(users(reconcileTail(state, rowsToItems(rows, 'rest')))).toHaveLength(2)
  })
})

describe('a resume while our own turn is still running', () => {
  /** What `session.resume` reports for a turn it is in the middle of. */
  const runningSnapshot = (user: string, assistant: string) => ({
    inflight: { user, assistant, streaming: true },
    running: true
  })

  it('does not paint the reported second bubble a minute after the first', () => {
    let state = sentTurn()

    state = applyEvent(state, { type: 'message.start', seq: 1 }, NOW)
    state = applyEvent(state, { type: 'message.delta', seq: 2, payload: { text: 'Looking' } }, NOW)

    const resumed = applyResumeSnapshot(state, runningSnapshot(LONG, 'Looking'), LATER)

    expect(users(resumed)).toHaveLength(1)
    expect(assistants(resumed)).toHaveLength(1)
    expect(resumed.turn.active).toBe(true)
  })

  it('does not paint it beside the row a cold open already read', () => {
    // Reopening the chat mid-turn: the gateway wrote the user row at submit
    // time, so history carries it AND the resume still calls it in flight.
    const loaded = reconcile(fresh(), rowsToItems([{ role: 'user', row_id: 3, text: LONG, timestamp: 1 }], 'rest'))
    const resumed = applyResumeSnapshot(loaded, runningSnapshot(LONG, 'Looking that up'), LATER)

    expect(users(resumed)).toHaveLength(1)
    expect(texts(resumed)).toEqual([`user:${LONG}`, 'assistant:Looking that up'])
  })

  it('keeps streaming onto the bubble the stream was already filling', () => {
    let state = sentTurn()

    state = applyEvent(state, { type: 'message.start', seq: 1 }, NOW)
    state = applyEvent(state, { type: 'message.delta', seq: 2, payload: { text: 'Looking' } }, NOW)

    const resumed = applyResumeSnapshot(state, runningSnapshot(LONG, 'Looking at the box'), LATER)
    const reply = assistants(resumed)[0]!

    expect(reply.id).toBe(state.turn.assistantId)
    expect(reply).toMatchObject({ text: 'Looking at the box', streaming: true })
    expect(resumed.turn.assistantId).toBe(reply.id)
  })

  it('leaves a bubble a tool call sealed alone rather than repainting it whole', () => {
    let state = sentTurn('read the changelog')

    state = applyEvent(state, { type: 'message.start', seq: 1 }, NOW)
    state = applyEvent(state, { type: 'message.delta', seq: 2, payload: { text: 'Let me look.' } }, NOW)
    state = applyEvent(state, { type: 'tool.start', seq: 3, payload: { tool_id: 'call_1', name: 'read_file' } }, NOW)

    const resumed = applyResumeSnapshot(
      state,
      runningSnapshot('read the changelog', 'Let me look. It ships three fixes.'),
      LATER
    )

    // One bubble, still holding only what it said before the tool ran: the flat
    // snapshot repeats that sentence, so pasting it in would show it twice.
    expect(assistants(resumed)).toHaveLength(1)
    expect(assistants(resumed)[0]).toMatchObject({ text: 'Let me look.', interim: true })
  })

  it('surfaces a retained failure on the bubble instead of a second one', () => {
    let state = sentTurn('go')

    state = applyEvent(state, { type: 'message.start', seq: 1 }, NOW)
    state = applyEvent(state, { type: 'message.delta', seq: 2, payload: { text: 'Half a th' } }, NOW)

    const resumed = applyResumeSnapshot(
      state,
      { inflight: { user: 'go', assistant: 'Half a th', error: 'the provider hung up', recoverable: true } },
      LATER
    )

    expect(assistants(resumed)).toHaveLength(1)
    expect(assistants(resumed)[0]).toMatchObject({
      status: 'error',
      error: { message: 'the provider hung up', recoverable: true }
    })
  })

  it('still projects a turn nobody here started', () => {
    const loaded = reconcile(
      fresh(),
      rowsToItems(
        [
          { role: 'user', row_id: 1, text: 'ping', timestamp: 1 },
          { role: 'assistant', row_id: 2, text: 'pong', timestamp: 2 }
        ],
        'rest'
      )
    )
    const resumed = applyResumeSnapshot(loaded, { inflight: { user: 'ping', streaming: true }, running: true }, LATER)

    // The same word, but the answered turn above ended before this one began —
    // dropping it would leave the bot replying to a message nobody can see.
    expect(users(resumed)).toHaveLength(2)
  })

  it('folds the row in without a duplicate once it lands', () => {
    let state = sentTurn()

    state = applyEvent(state, { type: 'message.start', seq: 1 }, NOW)
    state = applyResumeSnapshot(state, runningSnapshot(LONG, ''), LATER)

    const settled = reconcileTail(state, rowsToItems([{ role: 'user', row_id: 4, text: LONG }], 'rest'))

    expect(users(settled)).toHaveLength(1)
    expect(users(settled)[0]?.rowId).toBe(4)
  })
})

describe('a prompt the gateway parked', () => {
  /** Two more prompts typed while a turn of ours runs; the gateway queues both. */
  const burst = (): ChatState => {
    let state = sentTurn('one')

    state = applyEvent(state, { type: 'message.start', seq: 1 }, NOW)
    state = confirmSubmit(beginLocalTurn(state, 'two', undefined, NOW), { status: 'queued' }, NOW)
    state = confirmSubmit(beginLocalTurn(state, 'three', undefined, NOW), { status: 'queued' }, NOW)

    return applyEvent(state, { type: 'message.complete', seq: 2, payload: { text: 'a', status: 'ok' } }, NOW)
  }

  it('keeps the second parked prompt ours instead of standing a stranger in', () => {
    let state = applyEvent(burst(), { type: 'message.start', seq: 3 }, NOW)

    state = applyEvent(state, { type: 'message.complete', seq: 4, payload: { text: 'b', status: 'ok' } }, NOW)
    state = applyEvent(state, { type: 'message.start', seq: 5 }, LATER)

    expect(users(state).filter(item => item.unknownAuthor)).toHaveLength(0)
    expect(state.turn.local).toBe(true)
    expect(state.turn.foreignReconcilePending).toBeUndefined()
  })

  it('pairs it with the row the gateway writes when it finally runs', () => {
    let state = applyEvent(burst(), { type: 'message.start', seq: 3 }, NOW)

    state = applyEvent(state, { type: 'message.complete', seq: 4, payload: { text: 'b', status: 'ok' } }, NOW)
    state = applyEvent(state, { type: 'message.start', seq: 5 }, LATER)

    const rows: TranscriptRow[] = [
      { role: 'user', row_id: 1, text: 'one', timestamp: 1 },
      { role: 'assistant', row_id: 2, text: 'a', timestamp: 2 },
      { role: 'user', row_id: 3, text: 'two', timestamp: 3 },
      { role: 'assistant', row_id: 4, text: 'b', timestamp: 4 },
      // Written when the parked prompt STARTED, a minute after it was typed.
      { role: 'user', row_id: 5, text: 'three', timestamp: 60 }
    ]

    expect(texts(reconcileTail(state, rowsToItems(rows, 'rest')))).toEqual([
      'user:one',
      'assistant:a',
      'user:two',
      'assistant:b',
      'user:three'
    ])
  })

  it('stops claiming a stopped queue, so the next stranger gets a placeholder', () => {
    const stopped = markInterrupted(burst(), NOW)
    const started = applyEvent(stopped, { type: 'message.start', seq: 3 }, LATER)

    expect(users(started).filter(item => item.unknownAuthor)).toHaveLength(1)
    expect(started.turn.foreignReconcilePending).toBe(true)
  })
})

describe('an event replay', () => {
  it('ignores the events a re-read of the ring hands back twice', () => {
    const stream = [
      { type: 'message.start', seq: 1 },
      { type: 'message.delta', seq: 2, payload: { text: 'pong' } },
      { type: 'message.complete', seq: 3, payload: { text: 'pong', status: 'ok' } }
    ]
    const once = stream.reduce((state, event) => applyEvent(state, event, NOW), sentTurn('ping'))
    const twice = stream.reduce((state, event) => applyEvent(state, event, NOW), once)

    expect(twice.order).toEqual(once.order)
    expect(assistants(twice)).toHaveLength(1)
  })
})

describe('the order rows are shown in', () => {
  it('puts a row written before ours before ours, however it arrives', () => {
    // A teammate's delivery landed while the user was still typing, so it
    // carries the LOWER row id — and only our own message has a bubble.
    let state = sentTurn('mine')

    state = applyEvent(state, { type: 'message.start', seq: 1 }, NOW)
    state = applyEvent(state, { type: 'message.delta', seq: 2, payload: { text: 'replying' } }, NOW)

    const tail = reconcileTail(
      state,
      rowsToItems(
        [
          { role: 'user', row_id: 10, text: 'Message from 🤖 Writer (@writer): ping', timestamp: 10 },
          { role: 'user', row_id: 11, text: 'mine', timestamp: 11 }
        ],
        'rest'
      )
    )

    expect(texts(tail)).toEqual(['bot_dm_in:ping', 'user:mine', 'assistant:replying'])
  })

  it('keeps a row newer than the whole live tail behind it', () => {
    let state = reconcile(fresh(), rowsToItems([{ role: 'user', row_id: 1, text: 'earlier', timestamp: 1 }], 'rest'))

    state = confirmSubmit(beginLocalTurn(state, 'mine', undefined, NOW), { status: 'streaming' }, NOW)

    const tail = reconcileTail(state, rowsToItems([{ role: 'user', row_id: 1, text: 'earlier', timestamp: 1 }], 'rest'))

    expect(texts(tail)).toEqual(['user:earlier', 'user:mine'])
  })
})

describe('every route to the same conversation', () => {
  /** One turn with a tool in the middle, as the gateway persisted it. */
  const rows: TranscriptRow[] = [
    { role: 'user', row_id: 1, text: 'read the changelog', timestamp: 1 },
    { role: 'assistant', row_id: 2, text: 'Let me look.', timestamp: 2 },
    { role: 'tool', row_id: 3, tool_id: 'call_1', name: 'read_file', context: 'read_file(CHANGELOG.md)', timestamp: 3 },
    { role: 'assistant', row_id: 4, text: 'It ships three fixes.', timestamp: 4 }
  ]

  /** The same turn as it arrives on the socket, sent from here. */
  const streamed = (): ChatState => {
    let state = sentTurn('read the changelog')

    state = applyEvent(state, { type: 'message.start', seq: 1 }, NOW)
    state = applyEvent(state, { type: 'message.delta', seq: 2, payload: { text: 'Let me look.' } }, NOW)
    state = applyEvent(
      state,
      {
        type: 'tool.start',
        seq: 3,
        payload: { tool_id: 'call_1', name: 'read_file', context: 'read_file(CHANGELOG.md)' }
      },
      NOW
    )
    state = applyEvent(state, { type: 'tool.complete', seq: 4, payload: { tool_id: 'call_1', result: '# 1.2.0' } }, NOW)
    state = applyEvent(state, { type: 'message.delta', seq: 5, payload: { text: 'It ships three fixes.' } }, NOW)

    return applyEvent(
      state,
      { type: 'message.complete', seq: 6, payload: { text: 'It ships three fixes.', status: 'ok' } },
      NOW
    )
  }

  const clean = () => texts(reconcile(fresh(), rowsToItems(rows, 'rest')))

  /**
   * Every way the same conversation can reach a client. Whichever order they
   * arrive in, the transcript has to end up as the clean load of it — one item
   * per row, in the gateway's order.
   */
  const routes: Record<string, (state: ChatState) => ChatState> = {
    tail: state => reconcileTail(state, rowsToItems(rows, 'rest')),
    'tail, front half first': state =>
      reconcileTail(reconcileTail(state, rowsToItems(rows.slice(0, 2), 'rest')), rowsToItems(rows, 'rest')),
    rehydrate: state => reconcile(state, rowsToItems(rows, 'rest')),
    'resume, then tail': state =>
      reconcileTail(
        applyResumeSnapshot(
          state,
          { inflight: { user: 'read the changelog', assistant: 'It ships three fixes.' } },
          NOW
        ),
        rowsToItems(rows, 'rest')
      ),
    'tail, then rehydrate': state =>
      reconcile(reconcileTail(state, rowsToItems(rows, 'rest')), rowsToItems(rows, 'rest')),
    'rehydrate, then tail': state =>
      reconcileTail(reconcile(state, rowsToItems(rows, 'rest')), rowsToItems(rows, 'rest'))
  }

  for (const [name, route] of Object.entries(routes)) {
    it(`converges on the clean load: ${name}`, () => {
      expect(texts(route(streamed()))).toEqual(clean())
    })
  }

  it('converges from a cold start too, whichever route runs', () => {
    for (const route of Object.values(routes)) {
      expect(texts(route(fresh()))).toEqual(clean())
    }
  })

  it('converges when the routes are applied twice in every pairing', () => {
    const names = Object.keys(routes)

    for (const first of names) {
      for (const second of names) {
        expect(texts(routes[second]!(routes[first]!(streamed())))).toEqual(clean())
      }
    }
  })
})
