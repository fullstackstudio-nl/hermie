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
import { applyEvent, applyResumeSnapshot, beginLocalTurn, beginSteer, confirmSubmit, markInterrupted } from './reducer'
import { rowsToItems, type TranscriptRow } from './rows-to-items'
import { type ChatState, createChatState, type TranscriptItem, type UserItem } from './types'
import { steerWrapperBody, steerWrapperText } from './__fixtures__/rows'

const NOW = 1_700_000_000_000
/** A minute later, which is how far apart the two bubbles in the report were. */
const LATER = NOW + 60_000

const fresh = () => createChatState('researcher', 'stored-1', 'resolved-1')
const list = (state: ChatState) => state.order.map(id => state.items[id]!)
const users = (state: ChatState) => list(state).filter((item): item is UserItem => item.kind === 'user')
const assistants = (state: ChatState) => list(state).filter(item => item.kind === 'assistant')
const texts = (state: ChatState) => list(state).map(item => `${item.kind}:${'text' in item ? item.text : ''}`)
/** What a bubble carries, appended to its text so one assertion covers both. */
const chips = (item: TranscriptItem) =>
  item.kind === 'user' && item.attachments?.length ? ` +${item.attachments.join(' ')}` : ''

/** The message from the report: paragraphs, a blank line, an address, a URL. */
const LONG = [
  'Can you have a look at the box again.',
  '',
  'It answers on 192.168.1.44 but the panel at https://example.test/admin is empty.',
  '',
  'Tell me what you find.'
].join('\n')

/**
 * The file half of the report that opened this file's 2026-09-20 section: an
 * upload lands under the session's cwd with a collision token in front of its
 * name, and the prompt is nothing BUT the reference to it.
 */
const FILE_DIRECTIVE = '@file:"/srv/work/uploads/hermie/2026-09-19/ab-notes.txt"'
const FILE_ONLY_BODY = FILE_DIRECTIVE

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
      sentTurn(body, [FILE_DIRECTIVE]),
      rowsToItems([{ role: 'user', row_id: 8, text: body }], 'rest')
    )

    expect(users(state)).toHaveLength(1)
    expect(users(state)[0]).toMatchObject({ rowId: 8, text: 'have a look at this' })
  })

  it('pairs a send that carried an image, whose directive the gateway appends', () => {
    const state = reconcileTail(
      sentTurn('what is this', ['@image:shot.png']),
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

/**
 * Reported from an Android run on 2026-09-20: attaching a file and sending it
 * with NO words painted two bubbles, the optimistic one naming `ui.xml` and the
 * row naming `8setj4h3-ui.xml`.
 *
 * It is the same "nothing links the two sides" problem as above with the one
 * thing that solved it taken away. A turn whose whole body is a `@file:`
 * reference projects to EMPTY text — the directive is plumbing and the
 * projection lifts it out — so text cannot pair anything, and what the two sides
 * do have in common is the attachment. That only works if both sides describe an
 * attachment the same way, which is what `UserItem.attachments` being one
 * contract (the directive strings) is for.
 */
describe('a send that carries an attachment and no words', () => {
  it('pairs a file-only send with its row instead of standing a second bubble beside it', () => {
    const state = reconcileTail(
      sentTurn(FILE_ONLY_BODY, [FILE_DIRECTIVE]),
      rowsToItems([{ role: 'user', row_id: 12, text: FILE_ONLY_BODY, timestamp: 1 }], 'rest')
    )

    expect(users(state)).toHaveLength(1)
    expect(users(state)[0]).toMatchObject({ rowId: 12, text: '', attachments: [FILE_DIRECTIVE] })
  })

  it('pairs a file-only send through a full re-hydration too', () => {
    const state = reconcile(
      sentTurn(FILE_ONLY_BODY, [FILE_DIRECTIVE]),
      rowsToItems([{ role: 'user', row_id: 12, text: FILE_ONLY_BODY, timestamp: 1 }], 'rest')
    )

    expect(users(state)).toHaveLength(1)
    expect(users(state)[0]?.rowId).toBe(12)
  })

  it('pairs an image-only send, whose path only the gateway knows', () => {
    // An image goes over `image.attach_bytes`, so it is never in the body and
    // the client never learns where it landed; the gateway appends the directive
    // it chose at persist time. The base name is what both sides can say.
    const state = reconcileTail(
      sentTurn('', ['@image:shot.png']),
      rowsToItems([{ role: 'user', row_id: 13, text: '@image:/srv/work/.hermes/images/shot.png' }], 'rest')
    )

    expect(users(state)).toHaveLength(1)
    expect(users(state)[0]).toMatchObject({ rowId: 13, attachments: ['@image:/srv/work/.hermes/images/shot.png'] })
  })

  it('keeps two bubbles when the two sends carried different files', () => {
    const other = '@file:"/srv/work/uploads/hermie/2026-09-19/cd-budget.csv"'
    let state = sentTurn(FILE_ONLY_BODY, [FILE_DIRECTIVE])

    state = applyEvent(state, { type: 'message.start', seq: 1 }, NOW)
    state = applyEvent(state, { type: 'message.complete', seq: 2, payload: { text: 'read it', status: 'ok' } }, NOW)
    state = confirmSubmit(beginLocalTurn(state, other, [other], LATER), { status: 'streaming' }, LATER)

    const tail = reconcileTail(
      state,
      rowsToItems(
        [
          { role: 'user', row_id: 12, text: FILE_ONLY_BODY, timestamp: 1 },
          { role: 'assistant', row_id: 13, text: 'read it', timestamp: 2 },
          { role: 'user', row_id: 14, text: other, timestamp: 3 }
        ],
        'rest'
      )
    )

    expect(users(tail)).toHaveLength(2)
    expect(users(tail).map(item => item.attachments)).toEqual([[FILE_DIRECTIVE], [other]])
  })

  it('does not pair an image with a file of the same name', () => {
    // Same base name, different directive: a picture of a diagram and the
    // diagram's source are two attachments, so they are two turns.
    const state = reconcileTail(
      sentTurn('', ['@image:diagram.png']),
      rowsToItems([{ role: 'user', row_id: 15, text: '@file:/srv/work/diagram.png' }], 'rest')
    )

    expect(users(state)).toHaveLength(2)
  })

  it('does not fold a file-only send into a resume that describes a different one', () => {
    const other = '@file:"/srv/work/uploads/hermie/2026-09-19/cd-budget.csv"'
    const resumed = applyResumeSnapshot(
      sentTurn(FILE_ONLY_BODY, [FILE_DIRECTIVE]),
      { inflight: { user: other, assistant: '', streaming: true }, running: true },
      LATER
    )

    expect(users(resumed)).toHaveLength(2)
  })

  it('folds a resume that describes the file-only turn already on screen', () => {
    const resumed = applyResumeSnapshot(
      sentTurn(FILE_ONLY_BODY, [FILE_DIRECTIVE]),
      { inflight: { user: FILE_ONLY_BODY, assistant: 'Reading it.', streaming: true }, running: true },
      LATER
    )

    expect(users(resumed)).toHaveLength(1)
    expect(assistants(resumed)).toHaveLength(1)
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

/**
 * The report of 2026-09-21: a pasted `stat` run, twice, after a refresh.
 *
 * The chat had interim assistant messages on, so the turn had already sealed a
 * note and had it PERSISTED while it went on working. The tail therefore read
 * prompt, reply — which the resume rule took for a finished turn, so it stood
 * the running turn's `inflight.user` up again under the note. The rows below are
 * that chat's, stamped the way the gateway stamps them: the prompt at 20:54:42,
 * the interim note at 20:55:07, and a turn that started with the prompt and had
 * not stopped when the page was reloaded.
 */
describe('a resume while the running turn has already persisted a note', () => {
  /** The shell the owner pasted, which is also what he saw struck through. */
  const PASTED = "root@hermes:~# stat -c '%u:%g %n' /usr/bin/sudo\n0:0 /usr/bin/sudo\nroot@hermes:~#"
  const INTERIM = 'Dat bevestigt dat sudo van root is en niet te schrijven.'

  /** Unix seconds, off the gateway's clock, as the rows and the turn carry them. */
  const SUBMITTED_AT = 1_758_484_482
  const NOTE_AT = 1_758_484_507

  const midTurn = (rows: TranscriptRow[]) => reconcile(fresh(), rowsToItems(rows, 'rest'))

  const promptRow: TranscriptRow = { role: 'user', row_id: 41, text: PASTED, timestamp: SUBMITTED_AT }
  const noteRow: TranscriptRow = { role: 'assistant', row_id: 42, text: INTERIM, timestamp: NOTE_AT }

  /** What `session.resume` answers while that turn is still working. */
  const stillRunning = (assistant = '') => ({
    inflight: { user: PASTED, assistant, streaming: assistant !== '' },
    running: true,
    turn_started_at: SUBMITTED_AT
  })

  it('leaves one bubble for the prompt the note was written under', () => {
    const resumed = applyResumeSnapshot(midTurn([promptRow, noteRow]), stillRunning(), LATER)

    expect(users(resumed)).toHaveLength(1)
    expect(users(resumed)[0]).toMatchObject({ rowId: 41, text: PASTED })
  })

  it('keeps the note where it is and gives the next words their own bubble', () => {
    const resumed = applyResumeSnapshot(midTurn([promptRow, noteRow]), stillRunning('Nu de service zelf.'), LATER)

    expect(texts(resumed)).toEqual([`user:${PASTED}`, `assistant:${INTERIM}`, 'assistant:Nu de service zelf.'])
    expect(resumed.turn.active).toBe(true)
  })

  it('holds through a second reconnect inside the same turn', () => {
    let state = applyResumeSnapshot(midTurn([promptRow, noteRow]), stillRunning('Nu de service zelf.'), LATER)

    state = applyResumeSnapshot(state, stillRunning('Nu de service zelf, en de config.'), LATER + 1_000)

    expect(users(state)).toHaveLength(1)
    expect(assistants(state)).toHaveLength(2)
  })

  /**
   * The same shape with the note stamped BEFORE the turn began is the case the
   * old rule was written for: a finished turn above, and a genuinely new send of
   * the same words below it.
   */
  it('still gives a new send of the same words its own bubble', () => {
    const resumed = applyResumeSnapshot(midTurn([promptRow, noteRow]), {
      inflight: { user: PASTED, assistant: '', streaming: true },
      running: true,
      turn_started_at: NOTE_AT + 30
    })

    expect(users(resumed)).toHaveLength(2)
  })

  /** A re-send the gateway already persisted: two rows, and no third bubble. */
  it('paints two when the gateway holds two rows for it', () => {
    const resumed = applyResumeSnapshot(
      midTurn([promptRow, noteRow, { role: 'user', row_id: 43, text: PASTED, timestamp: NOTE_AT + 30 }]),
      { inflight: { user: PASTED, assistant: '', streaming: true }, running: true, turn_started_at: NOTE_AT + 30 },
      LATER
    )

    expect(users(resumed)).toHaveLength(2)
    expect(users(resumed).map(item => item.rowId)).toEqual([41, 43])
  })

  it('reads the start out of the session info when the snapshot omits it', () => {
    const loaded = applyEvent(
      midTurn([promptRow, noteRow]),
      { type: 'session.info', seq: 1, payload: { running: true, turn_started_at: SUBMITTED_AT } },
      LATER
    )
    const resumed = applyResumeSnapshot(loaded, { inflight: { user: PASTED, assistant: '' }, running: true }, LATER)

    expect(users(resumed)).toHaveLength(1)
  })

  /**
   * A gateway that names no start at all leaves the old rule in place, rather
   * than guessing. The cron suite depends on that: an hourly job whose body has
   * not changed is delivered again under exactly this shape.
   */
  it('falls back to the reply-ends-the-turn rule when no start is reported', () => {
    const resumed = applyResumeSnapshot(midTurn([promptRow, noteRow]), {
      inflight: { user: PASTED, assistant: '', streaming: true },
      running: true
    })

    expect(users(resumed)).toHaveLength(2)
  })

  it('does not fold a matching prompt into a turn that is not running', () => {
    const resumed = applyResumeSnapshot(midTurn([promptRow, noteRow]), {
      inflight: { user: PASTED, assistant: '' },
      running: false,
      turn_started_at: SUBMITTED_AT
    })

    expect(users(resumed)).toHaveLength(2)
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

/** One conversation, described the two ways a client can learn about it. */
interface Conversation {
  rows: TranscriptRow[]
  /** The prompt as `session.resume` reports it: the submitted body, verbatim. */
  prompt: string
  /** The same turn as it arrives on the socket, sent from here. */
  streamed: () => ChatState
}

/** A turn with a tool in the middle, whose prompt is words. */
const withWords: Conversation = {
  rows: [
    { role: 'user', row_id: 1, text: 'read the changelog', timestamp: 1 },
    { role: 'assistant', row_id: 2, text: 'Let me look.', timestamp: 2 },
    { role: 'tool', row_id: 3, tool_id: 'call_1', name: 'read_file', context: 'read_file(CHANGELOG.md)', timestamp: 3 },
    { role: 'assistant', row_id: 4, text: 'It ships three fixes.', timestamp: 4 }
  ],
  prompt: 'read the changelog',
  streamed: () => {
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
}

/**
 * The same turn with no words in it at all — the whole prompt is the file.
 *
 * Every route below has to converge on the single bubble, and the one that
 * reported the bug (the tail sweep after a send) is only one of them.
 */
const fileOnly: Conversation = {
  rows: [
    { role: 'user', row_id: 1, text: FILE_ONLY_BODY, timestamp: 1 },
    { role: 'assistant', row_id: 2, text: 'Six hundred lines of XML.', timestamp: 2 }
  ],
  prompt: FILE_ONLY_BODY,
  streamed: () => {
    let state = sentTurn(FILE_ONLY_BODY, [FILE_DIRECTIVE])

    state = applyEvent(state, { type: 'message.start', seq: 1 }, NOW)
    state = applyEvent(state, { type: 'message.delta', seq: 2, payload: { text: 'Six hundred lines of XML.' } }, NOW)

    return applyEvent(
      state,
      { type: 'message.complete', seq: 3, payload: { text: 'Six hundred lines of XML.', status: 'ok' } },
      NOW
    )
  }
}

/**
 * Every way one conversation can reach a client. Whichever order they arrive in,
 * the transcript has to end up as the clean load of it — one item per row, in the
 * gateway's order.
 */
function routesFor({ rows, prompt }: Conversation): Record<string, (state: ChatState) => ChatState> {
  const reply = rows.filter(row => row.role === 'assistant').pop()?.text ?? ''

  return {
    tail: state => reconcileTail(state, rowsToItems(rows, 'rest')),
    'tail, front half first': state =>
      reconcileTail(reconcileTail(state, rowsToItems(rows.slice(0, 2), 'rest')), rowsToItems(rows, 'rest')),
    rehydrate: state => reconcile(state, rowsToItems(rows, 'rest')),
    'resume, then tail': state =>
      reconcileTail(
        applyResumeSnapshot(state, { inflight: { user: prompt, assistant: reply } }, NOW),
        rowsToItems(rows, 'rest')
      ),
    'tail, then rehydrate': state =>
      reconcile(reconcileTail(state, rowsToItems(rows, 'rest')), rowsToItems(rows, 'rest')),
    'rehydrate, then tail': state =>
      reconcileTail(reconcile(state, rowsToItems(rows, 'rest')), rowsToItems(rows, 'rest'))
  }
}

describe.each([
  ['a conversation of words', withWords],
  ['a conversation whose prompt is only a file', fileOnly]
])('every route to %s', (_name, conversation) => {
  const routes = routesFor(conversation)
  // Attachments are part of the shape here: a bubble that converges on the right
  // COUNT while losing the chip off the file it was sent with is still wrong.
  const shape = (state: ChatState) =>
    list(state).map(item => `${item.kind}:${'text' in item ? item.text : ''}${chips(item)}`)
  const clean = () => shape(reconcile(fresh(), rowsToItems(conversation.rows, 'rest')))

  for (const [name, route] of Object.entries(routes)) {
    it(`converges on the clean load: ${name}`, () => {
      expect(shape(route(conversation.streamed()))).toEqual(clean())
    })
  }

  it('converges from a cold start too, whichever route runs', () => {
    for (const route of Object.values(routes)) {
      expect(shape(route(fresh()))).toEqual(clean())
    }
  })

  it('converges when the routes are applied twice in every pairing', () => {
    const names = Object.keys(routes)

    for (const first of names) {
      for (const second of names) {
        expect(shape(routes[second]!(routes[first]!(conversation.streamed())))).toEqual(clean())
      }
    }
  })
})

/**
 * The prompt that came back a second time because a steer stood in front of it.
 *
 * Reported from the device: the prompt at 21:21, a steer at 21:24, and the same
 * prompt again at 21:24 — with exactly one row for it in the gateway's database,
 * so nothing was sent twice and nothing was persisted twice. Only the screen was
 * wrong.
 *
 * `session.steer` folds words into the turn already running. It starts no turn,
 * and the gateway's `inflight.user` for that turn goes on naming the ORIGINAL
 * prompt. But the steer's bubble was the newest authored item, so every resume
 * compared the original prompt against the steer's words, found no match, and
 * projected the prompt again. A steer belongs to the turn it steered; it is
 * never that turn's prompt.
 */
describe('a resume after a steer', () => {
  const PROMPT = 'Summarise the release notes.'
  const STEER = 'lees over shared memory skill'

  /** Prompt sent, turn running, and a steer folded into it. */
  const steeredTurn = () => {
    let state = confirmSubmit(beginLocalTurn(fresh(), PROMPT, undefined, NOW), { status: 'streaming' }, NOW)

    state = applyEvent(state, { type: 'message.start', seq: 1 }, NOW)

    return confirmSubmit(beginLocalTurn(state, STEER, undefined, LATER), { status: 'steered' }, LATER)
  }

  it('does not paint the prompt again behind the steer', () => {
    const state = applyResumeSnapshot(
      steeredTurn(),
      { inflight: { user: PROMPT, assistant: 'Reading them', streaming: true }, running: true },
      LATER
    )

    expect(texts(state)).toEqual([`user:${PROMPT}`, `user:${STEER}`, 'assistant:Reading them'])
    expect(users(state)).toHaveLength(2)
  })

  it('holds through a second resume inside the same turn', () => {
    let state = applyResumeSnapshot(
      steeredTurn(),
      { inflight: { user: PROMPT, assistant: 'Reading', streaming: true }, running: true },
      LATER
    )

    state = applyResumeSnapshot(
      state,
      { inflight: { user: PROMPT, assistant: 'Reading them now', streaming: true }, running: true },
      LATER + 1_000
    )

    expect(users(state)).toHaveLength(2)
    expect(assistants(state)).toHaveLength(1)
  })

  it('still gives a genuinely new turn its own bubble after a steer', () => {
    // The guard must not swallow a real second send of the same words: a durable
    // reply between the two says the first turn is over.
    let state = steeredTurn()

    state = reconcileTail(
      state,
      rowsToItems(
        [
          { role: 'user', row_id: 1, text: PROMPT },
          { role: 'user', row_id: 2, text: steerWrapperText, display_kind: 'steer' },
          { role: 'assistant', row_id: 3, text: 'Three fixes and one feature.' }
        ],
        'rest'
      )
    )

    state = applyResumeSnapshot(
      state,
      { inflight: { user: PROMPT, assistant: '', streaming: true }, running: true },
      LATER + 2_000
    )

    expect(users(state)).toHaveLength(3)
  })

  it('pairs the persisted steer row with the bubble, wrapper and all', () => {
    // The gateway persists a steer inside a marker addressed to the model. The
    // bubble on screen never saw it, so only stripping it makes the two one row.
    const state = reconcileTail(
      steeredTurn(),
      rowsToItems(
        [
          { role: 'user', row_id: 1, text: PROMPT },
          { role: 'user', row_id: 2, text: steerWrapperText, display_kind: 'steer' }
        ],
        'rest'
      )
    )

    expect(users(state)).toHaveLength(2)
    expect(users(state)[1]).toMatchObject({ rowId: 2, text: steerWrapperBody, displayKind: 'steer' })
  })

  it('does not let a persisted steer stand in for another author’s prompt', () => {
    // A foreign `message.start` is waiting to be told who spoke. A steer is not
    // an answer to that question: it opened no turn.
    let state = applyEvent(beginSteer(fresh(), STEER, undefined, NOW), { type: 'message.start', seq: 1 }, LATER)

    state = reconcileTail(
      state,
      rowsToItems([{ role: 'user', row_id: 2, text: steerWrapperText, display_kind: 'steer' }], 'rest')
    )

    expect(users(state).filter(item => item.unknownAuthor)).toHaveLength(1)
    expect(state.turn.foreignReconcilePending).toBe(true)
  })
})
