import { describe, expect, it } from 'vitest'

import { reconcile, reconcileTail } from './reconcile'
import { applyEvent, applyResumeSnapshot, applyServerRequest, beginLocalTurn, confirmSubmit } from './reducer'
import { rowsToItems, type TranscriptRow } from './rows-to-items'
import { approvalRequest, dmDispatchTurn, streamedTurn } from './__fixtures__/events'
import { cronBotChatText, dmReplyProcessText, rpcHistoryRows } from './__fixtures__/rows'
import {
  type ApprovalItem,
  type BotDmOutItem,
  type ChatState,
  createChatState,
  type CronDeliveryItem,
  SEQ_STEP,
  type ToolItem,
  type UserItem
} from './types'

const NOW = 1_700_000_000_000

const fresh = () => createChatState('researcher', 'stored-1', 'resolved-1')
const list = (state: ChatState) => state.order.map(id => state.items[id]!)
const run = (events: readonly { type: string; seq?: number; payload?: unknown }[], start: ChatState = fresh()) =>
  events.reduce((state, event) => applyEvent(state, event, NOW), start)

describe('reconcile', () => {
  it('keeps ids stable across a second hydration of the same rows', () => {
    const first = reconcile(fresh(), rowsToItems(rpcHistoryRows, 'rpc'))
    const second = reconcile(first, rowsToItems(rpcHistoryRows, 'rpc'))

    expect(second.order).toEqual(first.order)
  })

  it('keeps ids stable when the same rows arrive over the other transport', () => {
    const rpc = reconcile(fresh(), rowsToItems(rpcHistoryRows, 'rpc'))
    const asRest: TranscriptRow[] = rpcHistoryRows.map(({ text, row_id, ...rest }) => ({
      ...rest,
      ...(text !== undefined ? { content: text } : {}),
      ...(row_id !== undefined ? { id: row_id } : {})
    }))
    const rest = reconcile(rpc, rowsToItems(asRest, 'rest'))

    expect(rest.order).toEqual(rpc.order)
  })

  it('renumbers items densely so a later live item still sorts last', () => {
    const state = reconcile(fresh(), rowsToItems(rpcHistoryRows, 'rpc'))

    expect(list(state).map(item => item.seq)).toEqual(list(state).map((_item, index) => index * 1000))
    expect(state.turn.nextSeq).toBe(state.order.length * 1000)
  })

  it('carries live tool results onto the history row that has none', () => {
    const live = run(streamedTurn)
    const historyRows: TranscriptRow[] = [
      { role: 'user', row_id: 1, text: 'read the changelog' },
      { role: 'tool', tool_id: 'call_1', name: 'read_file', context: 'read_file(CHANGELOG.md)' },
      { role: 'assistant', row_id: 2, text: 'Version 1.2.0 ships three fixes.' }
    ]
    const state = reconcile(live, rowsToItems(historyRows, 'rpc'))
    const tool = list(state).find(item => item.kind === 'tool') as ToolItem

    expect(tool.resultKnown).toBe(true)
    expect(tool.resultText).toBe('# 1.2.0')
    expect(tool.durationS).toBe(0.42)
  })

  it('carries a live dispatch outcome onto the history row', () => {
    const live = run(dmDispatchTurn)
    const state = reconcile(
      live,
      rowsToItems(
        [
          {
            role: 'tool',
            tool_id: 'call_dm_1',
            name: 'message_agent',
            args: { target: '@writer', message: 'Can you draft the announcement?' }
          }
        ],
        'rpc'
      )
    )
    const dispatch = list(state).find(item => item.kind === 'bot_dm_out') as BotDmOutItem

    expect(dispatch.dispatch).toMatchObject({ status: 'queued', processId: 'proc-2f9c' })
    expect(state.byProcessId['proc-2f9c']).toBe(dispatch.id)
  })

  it('keeps an optimistic tail the backend has not persisted yet', () => {
    const local = beginLocalTurn(
      reconcile(fresh(), rowsToItems(rpcHistoryRows, 'rpc')),
      'one more thing',
      undefined,
      NOW
    )
    const state = reconcile(local, rowsToItems(rpcHistoryRows, 'rpc'))
    const tail = list(state).at(-1) as UserItem

    expect(tail.text).toBe('one more thing')
    expect(tail.origin).toBe('optimistic')
  })

  it('keeps an open approval, which history can never re-supply', () => {
    const withRequest = applyServerRequest(reconcile(fresh(), rowsToItems(rpcHistoryRows, 'rpc')), approvalRequest, NOW)
    const state = reconcile(withRequest, rowsToItems(rpcHistoryRows, 'rpc'))
    const approval = list(state).find(item => item.kind === 'approval') as ApprovalItem

    expect(approval.state).toBe('open')
    expect(state.byRequestId['srq-7']).toBe(approval.id)
  })

  it('drops a live bubble once the persisted row replaces it', () => {
    const live = run([
      { type: 'message.start', seq: 1 },
      { type: 'message.delta', seq: 2, payload: { text: 'hello there' } },
      { type: 'message.complete', seq: 3, payload: { text: 'hello there', status: 'complete' } }
    ])
    const state = reconcile(live, rowsToItems([{ role: 'assistant', row_id: 9, text: 'hello there' }], 'rpc'))

    expect(list(state).filter(item => item.kind === 'assistant')).toHaveLength(1)
    expect(list(state).find(item => item.kind === 'assistant')?.rowId).toBe(9)
  })

  it('marks the transcript live', () => {
    expect(reconcile(fresh(), rowsToItems(rpcHistoryRows, 'rpc')).hydration).toBe('live')
  })
})

describe('reconcileTail', () => {
  it('fills the placeholder a foreign turn left behind', () => {
    const live = run(streamedTurn)
    const placeholder = list(live)[0] as UserItem

    expect(placeholder.unknownAuthor).toBe(true)

    const tail = rowsToItems(
      [{ role: 'user', row_id: 21, text: 'Message from 🤖 Writer (@writer): can you check the changelog?' }],
      'rest'
    )
    const state = reconcileTail(live, tail)
    const filled = state.items[placeholder.id]

    expect(filled).toMatchObject({ kind: 'bot_dm_in', senderHandle: 'writer', rowId: 21 })
    expect(state.turn.foreignReconcilePending).toBeUndefined()
  })

  it('drops a placeholder the tail turned out not to need', () => {
    // A turn that started without us, whose row the tail then turns out to
    // describe as ours: the optimistic bubble is already there, so the row
    // pairs with it by text and never reaches the placeholder. Nothing will
    // ever fill that bubble, so it must not stay on screen.
    let live = beginLocalTurn(fresh(), 'and then deploy', undefined, NOW)

    live = confirmSubmit(live, { status: 'streaming' }, NOW)
    live = applyEvent(live, { type: 'message.start', seq: 1 }, NOW)
    live = { ...live, turn: { ...live.turn, local: false } }
    live = applyEvent(live, { type: 'message.start', seq: 2 }, NOW)

    expect(list(live).filter(item => item.kind === 'user' && item.unknownAuthor)).toHaveLength(1)

    const state = reconcileTail(live, rowsToItems([{ role: 'user', row_id: 31, text: 'and then deploy' }], 'rest'))

    expect(list(state).filter(item => item.kind === 'user' && item.unknownAuthor)).toHaveLength(0)
    expect(list(state).filter(item => item.kind === 'user')).toHaveLength(1)
    expect(state.turn.foreignReconcilePending).toBeUndefined()
  })

  it('keeps a placeholder the tail has not caught up with yet', () => {
    const live = run([{ type: 'message.start', seq: 1 }])
    const state = reconcileTail(live, rowsToItems([{ role: 'assistant', row_id: 41, text: 'unrelated' }], 'rest'))

    expect(list(state).filter(item => item.kind === 'user' && item.unknownAuthor)).toHaveLength(1)
  })

  it('never drops the bubbles of the turn it is describing', () => {
    const live = run([
      { type: 'message.start', seq: 1 },
      { type: 'message.delta', seq: 2, payload: { text: 'still typing' } }
    ])
    const state = reconcileTail(live, rowsToItems([{ role: 'user', row_id: 30, text: 'ping' }], 'rest'))

    expect(list(state).some(item => item.kind === 'assistant')).toBe(true)
    expect(state.turn.assistantId).toBeDefined()
  })

  it('joins a delivery reply onto the dispatch it belongs to', () => {
    const live = run(dmDispatchTurn)
    const tail = rowsToItems(
      [{ role: 'user', row_id: 31, display_kind: 'process_complete', text: dmReplyProcessText }],
      'rest'
    )
    const state = reconcileTail(live, tail)
    const dispatch = list(state).find(item => item.kind === 'bot_dm_out') as BotDmOutItem

    expect(dispatch.reply?.text).toBe('Draft is ready, I pushed it to the shared folder.')
    // The completion was consumed by the join, so it adds no notice of its own.
    expect(list(state).some(item => item.kind === 'notice')).toBe(false)
  })

  it('appends rows it has never seen', () => {
    const live = reconcile(fresh(), rowsToItems(rpcHistoryRows, 'rpc'))
    const state = reconcileTail(live, rowsToItems([{ role: 'user', row_id: 99, text: 'and one more' }], 'rest'))

    expect((list(state).at(-1) as UserItem).text).toBe('and one more')
    expect(state.byRowId['99']).toBeDefined()
  })

  it('fills a foreign placeholder with the cron card, not with an empty bubble', () => {
    // A cron delivery starts a turn nobody local submitted, so the reducer stands
    // a placeholder in first and the tail has to recognise the row as the author.
    const live = run([{ type: 'message.start', seq: 1 }])
    const placeholder = list(live)[0] as UserItem

    expect(placeholder.unknownAuthor).toBe(true)

    const state = reconcileTail(live, rowsToItems([{ role: 'user', row_id: 51, text: cronBotChatText }], 'rest'))

    expect(state.items[placeholder.id]).toMatchObject({ kind: 'cron_delivery', jobName: 'Inbox scan', rowId: 51 })
    expect(list(state).filter(item => item.kind === 'user' && item.unknownAuthor)).toHaveLength(0)
    expect(state.turn.foreignReconcilePending).toBeUndefined()
  })

  it('merges a row it already shows instead of duplicating it', () => {
    const live = reconcile(fresh(), rowsToItems(rpcHistoryRows, 'rpc'))
    const before = live.order.length
    const state = reconcileTail(live, rowsToItems(rpcHistoryRows.slice(-2), 'rpc'))

    expect(state.order.length).toBe(before)
  })
})

describe('a cron delivery that was live before it was persisted', () => {
  /** The chat was open and resuming when the scheduled turn was already running. */
  const midDelivery = () => applyResumeSnapshot(fresh(), { inflight: { user: cronBotChatText }, running: true }, NOW)

  const persisted = rowsToItems([{ role: 'user', row_id: 61, text: cronBotChatText, timestamp: 1_700_000_050 }], 'rest')

  it('reconciles the live card and the persisted row onto ONE item', () => {
    const state = reconcile(midDelivery(), persisted)
    const cards = list(state).filter(item => item.kind === 'cron_delivery')

    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({ rowId: 61, jobName: 'Inbox scan' })
  })

  it('does the same through a tail fetch, and a second sweep is a no-op', () => {
    const once = reconcileTail(midDelivery(), persisted)

    expect(once.order).toHaveLength(1)
    expect(list(once)[0]).toMatchObject({ kind: 'cron_delivery', rowId: 61 })

    const twice = reconcileTail(once, persisted)

    expect(twice.order).toHaveLength(1)
  })

  it('needs no merge rule of its own: the persisted row carries the whole card', () => {
    // `mergeWithLive` has no `cron_delivery` case on purpose. Proof: the live item
    // and the reconciled one differ in nothing but the ids and bookkeeping the
    // merge is there to preserve.
    const live = list(midDelivery())[0] as CronDeliveryItem
    const merged = list(reconcile(midDelivery(), persisted))[0] as CronDeliveryItem

    expect(merged.id).toBe(live.id)
    expect({ jobName: merged.jobName, body: merged.body, shape: merged.shape }).toEqual({
      jobName: live.jobName,
      body: live.body,
      shape: live.shape
    })
  })
})

describe('a turn we sent ourselves coming back persisted', () => {
  /** An optimistic user bubble plus the reply the stream built, neither persisted. */
  const liveTurn = (): ChatState => {
    const submitted = beginLocalTurn(fresh(), 'delegate the dependency audit', undefined, NOW)

    return applyEvent(
      applyEvent(submitted, { type: 'message.start', seq: 1, payload: {} }, NOW),
      { type: 'message.complete', seq: 2, payload: { text: 'Looking that up for you.', status: 'ok' } },
      NOW
    )
  }

  const persistedRows: TranscriptRow[] = [
    { role: 'user', text: 'delegate the dependency audit', row_id: 7, timestamp: 1_700_000_100 },
    { role: 'assistant', text: 'Looking that up for you.', row_id: 8, timestamp: 1_700_000_101 }
  ]

  it('adopts the persisted rows onto the live bubbles instead of appending copies', () => {
    const state = liveTurn()
    const before = state.order.length

    const next = reconcileTail(state, rowsToItems(persistedRows, 'rest'))

    expect(next.order).toHaveLength(before)
    expect(
      list(next).filter(item => item.kind === 'user' && item.text === 'delegate the dependency audit')
    ).toHaveLength(1)
    expect(list(next).filter(item => item.kind === 'assistant')).toHaveLength(1)
  })

  it('gives them their durable row ids, so a second sweep is a no-op', () => {
    const once = reconcileTail(liveTurn(), rowsToItems(persistedRows, 'rest'))

    expect(list(once).map(item => item.rowId)).toEqual([7, 8])

    const twice = reconcileTail(once, rowsToItems(persistedRows, 'rest'))

    expect(twice.order).toHaveLength(once.order.length)
  })

  /**
   * The list renders one cell per id, so an id is a KEY: change it and React
   * unmounts the row and mounts a new one, which throws away every height the
   * list had measured and re-measures it a frame later. That is indistinguishable
   * on screen from the transcript jumping, and it was the fourth suspect for it.
   *
   * Adoption is where it would happen if it happened anywhere: the persisted row
   * arrives with a durable `row_id` and the live bubble has an id of its own, and
   * only one of the two may survive. It has to be the live one.
   */
  it('leaves every rendered key exactly where it was, twice over', () => {
    const live = liveTurn()
    const keys = live.order
    const once = reconcileTail(live, rowsToItems(persistedRows, 'rest'))

    expect(once.order).toEqual(keys)
    expect(reconcileTail(once, rowsToItems(persistedRows, 'rest')).order).toEqual(keys)
    // And through the other door, which takes the whole list rather than its tail.
    expect(reconcile(once, rowsToItems(persistedRows, 'rest')).order).toEqual(keys)
  })

  it('still appends a row that is genuinely new', () => {
    const state = reconcileTail(liveTurn(), rowsToItems(persistedRows, 'rest'))
    const next = reconcileTail(
      state,
      rowsToItems([...persistedRows, { role: 'assistant', text: 'One more thing.', row_id: 9 }], 'rest')
    )

    expect(next.order).toHaveLength(state.order.length + 1)
  })
})

/**
 * HERM-83: the fresh row's author wins, and pairing a bubble with its own row
 * never leaves the reader with two authors — or two bubbles — for one turn.
 */
describe('author reconciliation', () => {
  const author = { id: 'oidc:user-a', name: 'Robin' }

  it('gives the optimistic bubble the row author once the row lands, without duplicating it', () => {
    const submitted = beginLocalTurn(fresh(), 'delegate the dependency audit', undefined, NOW, author)
    const persistedRows: TranscriptRow[] = [
      {
        role: 'user',
        text: 'delegate the dependency audit',
        row_id: 7,
        timestamp: 1_700_000_100,
        display_metadata: { author }
      }
    ]

    const next = reconcileTail(submitted, rowsToItems(persistedRows, 'rest'))
    const userItems = list(next).filter((item): item is UserItem => item.kind === 'user')

    expect(userItems).toHaveLength(1)
    expect(userItems[0]?.author).toEqual(author)
    expect(userItems[0]?.rowId).toBe(7)
  })

  it("keeps the row's own author when the pair agrees on the id and differs only in the name", () => {
    const submitted = beginLocalTurn(fresh(), 'ping', undefined, NOW, { id: author.id, name: 'Old name' })
    const persistedRows: TranscriptRow[] = [
      { role: 'user', text: 'ping', row_id: 9, timestamp: 1_700_000_100, display_metadata: { author } }
    ]

    const next = reconcileTail(submitted, rowsToItems(persistedRows, 'rest'))
    const userItems = list(next).filter((item): item is UserItem => item.kind === 'user')

    expect(userItems).toHaveLength(1)
    expect(userItems[0]?.author).toEqual(author)
  })

  /*
    Two people in one group chat can both say "ok". The reader's optimistic
    "ok" is theirs; a colleague's persisted "ok" is the colleague's. Pairing
    them on the words alone gave the reader's bubble the colleague's row — and
    the colleague's author — and lost the reader's own turn.
  */
  const colleague = { id: 'oidc:user-b', name: 'Sam' }
  const colleaguesOk: TranscriptRow[] = [
    { role: 'user', text: 'ok', row_id: 12, timestamp: 1_700_000_050, display_metadata: { author: colleague } }
  ]

  it('never pairs the reader’s optimistic bubble with a colleague’s row that says the same thing (tail)', () => {
    const submitted = beginLocalTurn(fresh(), 'ok', undefined, NOW, author)
    const optimisticId = list(submitted)[0]?.id

    const next = reconcileTail(submitted, rowsToItems(colleaguesOk, 'rest'))
    const userItems = list(next).filter((item): item is UserItem => item.kind === 'user')

    expect(userItems).toHaveLength(2)
    expect(next.items[optimisticId ?? '']).toMatchObject({ author })
    expect(next.items[optimisticId ?? '']?.rowId).toBeUndefined()
    expect(userItems.find(item => item.rowId === 12)?.author).toEqual(colleague)
  })

  it('never pairs the reader’s optimistic bubble with a colleague’s row that says the same thing (hydration)', () => {
    const submitted = beginLocalTurn(fresh(), 'ok', undefined, NOW, author)
    const optimisticId = list(submitted)[0]?.id

    const next = reconcile(submitted, rowsToItems(colleaguesOk, 'rest'))
    const userItems = list(next).filter((item): item is UserItem => item.kind === 'user')

    expect(userItems).toHaveLength(2)
    expect(next.items[optimisticId ?? '']).toMatchObject({ author })
    expect(next.items[optimisticId ?? '']?.rowId).toBeUndefined()
    expect(userItems.find(item => item.rowId === 12)?.author).toEqual(colleague)
  })

  it('still pairs an attributed bubble with an unattributed row: a gateway that stamps nobody', () => {
    // The reader's identity is known, so the bubble carries an author; the
    // gateway does not stamp, so the row carries none. They are one turn, and
    // refusing to pair them would draw every message this reader sends twice.
    const submitted = beginLocalTurn(fresh(), 'ok', undefined, NOW, author)

    const tail = reconcileTail(submitted, rowsToItems([{ role: 'user', text: 'ok', row_id: 3 }], 'rest'))
    const hydrated = reconcile(submitted, rowsToItems([{ role: 'user', text: 'ok', row_id: 3 }], 'rest'))

    expect(list(tail).filter(item => item.kind === 'user')).toHaveLength(1)
    expect(list(hydrated).filter(item => item.kind === 'user')).toHaveLength(1)
  })

  it('names a foreign placeholder from the row that fills it', () => {
    const live = run([{ type: 'message.start', seq: 1 }])
    const placeholder = list(live)[0] as UserItem

    expect(placeholder.unknownAuthor).toBe(true)

    const tail = rowsToItems([{ role: 'user', text: 'good morning', row_id: 71, display_metadata: { author } }], 'rest')
    const state = reconcileTail(live, tail)
    const filled = state.items[placeholder.id] as UserItem

    expect(filled.author).toEqual(author)
  })
})

/**
 * Pairing on the attachments when there is no text to pair on.
 *
 * `reconcile` and `reconcileTail` both key the live side by what an item says, so
 * an item that says nothing was never a candidate at all. A turn carrying only a
 * file is exactly that — the directive is lifted out of the text — so the
 * attachments have to count towards the key, and count in a way both sides can
 * produce: the reference's base name, because the gateway alone decides the path
 * an attached image lands on.
 */
describe('pairing a turn that says nothing but carries something', () => {
  const REF = '@file:"/srv/work/uploads/hermie/2026-09-20/8setj4h3-ui.xml"'
  const row = (text: string, rowId: number): TranscriptRow[] => [{ role: 'user', text, row_id: rowId, timestamp: 1 }]
  const sent = (text: string, attachments: string[]) =>
    confirmSubmit(beginLocalTurn(fresh(), text, attachments, NOW), { status: 'streaming' }, NOW)
  const userItems = (state: ChatState) => list(state).filter((item): item is UserItem => item.kind === 'user')

  it('adopts the row onto the bubble in a tail sweep', () => {
    const next = reconcileTail(sent(REF, [REF]), rowsToItems(row(REF, 4), 'rest'))

    expect(userItems(next)).toHaveLength(1)
    expect(userItems(next)[0]?.rowId).toBe(4)
  })

  it('adopts it in a full re-hydration, keeping the bubble its id', () => {
    const state = sent(REF, [REF])
    const id = userItems(state)[0]?.id
    const next = reconcile(state, rowsToItems(row(REF, 4), 'rest'))

    expect(userItems(next)).toHaveLength(1)
    expect(userItems(next)[0]?.id).toBe(id)
  })

  it('refuses to pair a different file, however similar the turn looks', () => {
    const other = '@file:"/srv/work/uploads/hermie/2026-09-20/99xyzabc-ui.xml"'
    const next = reconcileTail(sent(REF, [REF]), rowsToItems(row(other, 4), 'rest'))

    expect(userItems(next)).toHaveLength(2)
  })

  it('pairs an attached image on its name, which is all the client was told', () => {
    const next = reconcileTail(
      sent('', ['@image:shot.png']),
      rowsToItems(row('@image:/srv/work/.hermes/images/shot.png', 4), 'rest')
    )

    expect(userItems(next)).toHaveLength(1)
    // The row's own directive wins: it is the durable one, and the path in it is
    // where the file really is.
    expect(userItems(next)[0]?.attachments).toEqual(['@image:/srv/work/.hermes/images/shot.png'])
  })

  it('pairs regardless of the order the two sides list two attachments in', () => {
    const image = '@image:shot.png'
    const next = reconcileTail(sent(REF, [REF, image]), rowsToItems(row(`${image}\n${REF}`, 4), 'rest'))

    expect(userItems(next)).toHaveLength(1)
  })

  it('still pairs a turn that has words, whatever it carries', () => {
    // The attachment must not become a second thing that has to match: an
    // ordinary message's row carries no attachments at all.
    const next = reconcileTail(sent('just words', []), rowsToItems(row('just words', 4), 'rest'))

    expect(userItems(next)).toHaveLength(1)
  })
})

/**
 * The gateway restarting under a live session.
 *
 * Found by pulling the fake gateway out from under the running app and sending
 * twice: React reported `Encountered two children with the same key … .$o=29000`
 * — which is `o:9000` once React's key escaping is undone — and the same user
 * bubble was drawn twice.
 *
 * `o:` ids are minted from `turn.nextSeq`, and `rebuild` used to re-derive that
 * counter from the transcript's LENGTH. A rebuilt session answers with fewer
 * rows than the client holds, so the re-hydration shrank the list and moved the
 * counter back onto a seq that was still in use. `order` is a list, so the next
 * send pushed an id it already held.
 */
describe('a re-hydration that shortens the transcript', () => {
  /** Seven rows is the seeded Bot Chat, which is the shape this was found in. */
  const sevenRows = Array.from({ length: 7 }, (_, index): TranscriptRow => ({
    role: index % 2 ? 'assistant' : 'user',
    text: `row ${index + 1}`,
    row_id: index + 1,
    timestamp: 1_700_000_000 + index
  }))

  /** Three sends the dead gateway never persisted, on top of the seven rows. */
  const afterThreeUnpersistedSends = (): ChatState =>
    ['one', 'two', 'three'].reduce(
      (state, text) => beginLocalTurn(state, text, undefined, NOW),
      reconcile(fresh(), rowsToItems(sevenRows, 'rpc'))
    )

  it('never moves the id counter backwards', () => {
    const live = afterThreeUnpersistedSends()
    // The rebuilt session is a row short of what the client holds.
    const next = reconcile(live, rowsToItems(sevenRows.slice(0, 6), 'rpc'))

    expect(next.turn.nextSeq).toBeGreaterThanOrEqual(live.turn.nextSeq)
  })

  it('leaves no two rows sharing an id when the next message is sent', () => {
    const rehydrated = reconcile(afterThreeUnpersistedSends(), rowsToItems(sevenRows.slice(0, 6), 'rpc'))
    const next = beginLocalTurn(rehydrated, 'after the restart', undefined, NOW)

    expect(new Set(next.order).size).toBe(next.order.length)
  })

  it('draws the message that was sent once, and the ones before it once each', () => {
    const rehydrated = reconcile(afterThreeUnpersistedSends(), rowsToItems(sevenRows.slice(0, 6), 'rpc'))
    const next = beginLocalTurn(rehydrated, 'after the restart', undefined, NOW)
    const texts = next.order.map(id => next.items[id]).map(item => (item?.kind === 'user' ? item.text : ''))

    expect(texts.filter(text => text === 'after the restart')).toEqual(['after the restart'])
    expect(texts.filter(text => text === 'three')).toEqual(['three'])
  })

  /**
   * The seam, on its own: an id that arrives already taken never becomes a
   * second entry in `order`. `nextSeq` is monotonic now, so nothing in the app
   * should reach this — which is exactly why it is worth a case of its own.
   */
  it('keeps both items when something mints an id the transcript already holds', () => {
    const live = afterThreeUnpersistedSends()
    // The seq the FIRST of those three sends was minted at, so the id the next
    // one asks for is one the transcript is already holding.
    const spent = live.turn.nextSeq - 3 * SEQ_STEP

    expect(live.items[`o:${spent}`]).toBeDefined()

    const taken = { ...live, turn: { ...live.turn, nextSeq: spent } }
    const next = beginLocalTurn(taken, 'after the restart', undefined, NOW)

    expect(new Set(next.order).size).toBe(next.order.length)
    expect(next.order).toHaveLength(live.order.length + 1)
  })
})
