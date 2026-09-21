/**
 * A turn the gateway started for itself, and the two ways it reaches the screen.
 *
 * When a `delegate_task` fan-out finishes, the gateway writes a `role: "user"`
 * row and runs a turn on it. Persisted, that row carries
 * `display_kind: "async_delegation_complete"` and has always been drawn as a
 * card. LIVE it carries nothing: the foreign `message.start` stands up a blank
 * placeholder, and the resume that follows knows the turn only as
 * `inflight.user` — a string. So on the device the report arrived as a blue
 * bubble opening `[ASYNC DELEGATION BATCH COMPLETE — deleg_1bd47ada]`, signed by
 * an owner who typed none of it.
 *
 * Both halves are pinned here, in one file, because they are one behaviour: the
 * live projection has to produce the item the persisted row produces, or the
 * tail that brings the row in stands a second card beside the first.
 */
import { describe, expect, it } from 'vitest'

import { delegationBatchText, kanbanNotificationText, plainProcessText } from './__fixtures__/rows'
import { reconcileTail } from './reconcile'
import { applyEvent, applyResumeSnapshot } from './reducer'
import { rowsToItems } from './rows-to-items'
import { type ChatState, createChatState, type NoticeItem } from './types'

const NOW = 1_700_000_000_000
const LATER = NOW + 60_000

const fresh = () => createChatState('researcher', 'stored-1', 'resolved-1')
const list = (state: ChatState) => state.order.map(id => state.items[id]!)
const kinds = (state: ChatState) => list(state).map(item => item.kind)
const notices = (state: ChatState) => list(state).filter((item): item is NoticeItem => item.kind === 'notice')

/** A foreign `message.start`: nothing local was submitted, so a placeholder goes up. */
const foreignTurn = () => applyEvent(fresh(), { type: 'message.start', seq: 1 }, NOW)

const runningSnapshot = (user: string, assistant: string) => ({
  inflight: { user, assistant, streaming: true },
  running: true
})

/** The row the gateway wrote for that turn, as a tail fetch brings it back. */
const persistedRow = (text: string, rowId: number, displayKind?: string) =>
  rowsToItems(
    [
      {
        role: 'user',
        row_id: rowId,
        text,
        timestamp: 1_700_000_060,
        ...(displayKind ? { display_kind: displayKind } : {})
      }
    ],
    'rest'
  )

describe('a resume during a turn the gateway started for itself', () => {
  it('fills the placeholder with a notice, never with the owner speaking', () => {
    const state = applyResumeSnapshot(foreignTurn(), runningSnapshot(delegationBatchText, 'Reading it now'), LATER)

    expect(kinds(state)).toEqual(['notice', 'assistant'])
    expect(notices(state)[0]).toMatchObject({
      noticeKind: 'async_delegation_complete',
      title: 'ASYNC DELEGATION BATCH COMPLETE — deleg_1bd47ada',
      body: delegationBatchText
    })
  })

  it('does the same for a background process and a kanban dispatch', () => {
    const process = applyResumeSnapshot(foreignTurn(), runningSnapshot(plainProcessText, ''), LATER)
    const kanban = applyResumeSnapshot(foreignTurn(), runningSnapshot(`${kanbanNotificationText}\ndetails`, ''), LATER)

    expect(notices(process)[0]?.noticeKind).toBe('process_complete')
    expect(notices(kanban)[0]?.noticeKind).toBe('internal_notification')
  })

  it('keeps one card when the persisted row arrives behind it', () => {
    let state = applyResumeSnapshot(foreignTurn(), runningSnapshot(delegationBatchText, 'Reading it now'), LATER)

    state = reconcileTail(state, persistedRow(delegationBatchText, 30, 'async_delegation_complete'))

    expect(kinds(state)).toEqual(['notice', 'assistant'])
    // The row won the pairing, so the card now wears the gateway's own title and
    // its row id — and there is still exactly one of it.
    expect(notices(state)[0]).toMatchObject({ rowId: 30, title: 'Background agent work finished' })
    expect(state.turn.foreignReconcilePending).toBeUndefined()
  })

  it('keeps one card across a second resume', () => {
    // A flaky link resumes twice inside one turn. The second resume has to
    // recognise the card the first one projected as the turn's opening row.
    let state = applyResumeSnapshot(foreignTurn(), runningSnapshot(delegationBatchText, 'Reading'), LATER)

    state = applyResumeSnapshot(state, runningSnapshot(delegationBatchText, 'Reading it now'), LATER + 1_000)

    expect(kinds(state)).toEqual(['notice', 'assistant'])
  })
})

describe('a tail fetch with no resume in front of it', () => {
  it('turns the placeholder into the card rather than leaving an empty bubble beside it', () => {
    const state = reconcileTail(foreignTurn(), persistedRow(delegationBatchText, 31, 'async_delegation_complete'))

    expect(kinds(state)).toEqual(['notice'])
    expect(notices(state)[0]).toMatchObject({ rowId: 31, body: delegationBatchText })
    expect(state.turn.foreignReconcilePending).toBeUndefined()
  })
})
