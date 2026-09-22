/**
 * Where a request card stands after the transcript has been re-hydrated around it.
 *
 * The owner's report: a chat opened the morning after a long session showed
 * `TODAY`, two messages, `YESTERDAY`, an answered "Allowed once" card, and then
 * `TODAY` again above the next message. Two stamps for one day, with a card from
 * the day before wedged between them.
 *
 * The transcript list is not to blame for that — `layoutRows` stamps a date
 * wherever the day changes between NEIGHBOURS, which is the only thing it can
 * honestly do. The order it was handed really did go forwards, backwards and
 * forwards again, and the sequence that produced it is the one written out here.
 */
import { describe, expect, it } from 'vitest'

import { snapshotForCache, stateFromCache } from './cache'
import { reconcile } from './reconcile'
import { answerRequest, applyServerRequest, beginLocalTurn } from './reducer'
import { rowsToItems, type TranscriptRow } from './rows-to-items'
import { approvalRequest } from './__fixtures__/events'
import { type ApprovalItem, type ChatState, createChatState, type TranscriptItem } from './types'

const IDS = { storedSessionId: 'stored-1', resolvedSessionId: 'resolved-1' }

/** Unix seconds. Day 1 is a Monday morning; day 2 is the next day. */
const DAY_1 = 1_758_355_200
const DAY_2 = DAY_1 + 86_400

const fresh = () => createChatState('researcher', IDS.storedSessionId, IDS.resolvedSessionId)
const list = (state: ChatState): TranscriptItem[] => state.order.map(id => state.items[id]!)
const at = (state: ChatState, predicate: (item: TranscriptItem) => boolean) => list(state).findIndex(predicate)
const isApproval = (item: TranscriptItem) => item.kind === 'approval'
const says = (text: string) => (item: TranscriptItem) =>
  (item.kind === 'user' || item.kind === 'assistant') && item.text === text

const day1Rows: TranscriptRow[] = [
  { role: 'user', row_id: 1, text: 'Take the staging stack down', timestamp: DAY_1 + 32_000 },
  { role: 'assistant', row_id: 2, text: 'Running the compose command now.', timestamp: DAY_1 + 32_020 }
]

const day2Rows: TranscriptRow[] = [
  ...day1Rows,
  { role: 'user', row_id: 3, text: 'Set your name to the new one', timestamp: DAY_2 + 34_320 },
  { role: 'assistant', row_id: 4, text: 'Done — it is set.', timestamp: DAY_2 + 34_325 }
]

/**
 * The owner's sequence, in the order it really happened.
 *
 * 1. Day 1: a turn runs, an approval is asked and answered, the chat is cached.
 * 2. Day 2: a cold open paints that cache, so the answered card is on screen
 *    with yesterday's timestamp on it.
 * 3. The resume's history comes back holding day 1 AND a fresh turn from this
 *    morning, and `reconcile` folds it in.
 * 4. The owner types again.
 */
function openedTheNextMorning(): ChatState {
  const day1 = answerRequest(
    applyServerRequest(reconcile(fresh(), rowsToItems(day1Rows, 'rpc')), approvalRequest, (DAY_1 + 32_040) * 1000),
    'srq-7',
    'once'
  )
  const painted = stateFromCache('researcher', IDS, snapshotForCache(day1, (DAY_1 + 32_100) * 1000))
  const hydrated = reconcile(painted, rowsToItems(day2Rows, 'rpc'))

  return beginLocalTurn(hydrated, 'And your handle?', undefined, (DAY_2 + 34_380) * 1000)
}

describe('an answered request keeps the place it was answered in', () => {
  it('survives the cache with the timestamp it was asked at', () => {
    const day1 = answerRequest(
      applyServerRequest(reconcile(fresh(), rowsToItems(day1Rows, 'rpc')), approvalRequest, (DAY_1 + 32_040) * 1000),
      'srq-7',
      'once'
    )
    const painted = stateFromCache('researcher', IDS, snapshotForCache(day1, (DAY_1 + 32_100) * 1000))
    const approval = list(painted).find(isApproval) as ApprovalItem

    expect(approval.state).toBe('answered')
    expect(approval.ts).toBe(DAY_1 + 32_040)
  })

  it('does not drift past the rows a later hydration added', () => {
    const state = openedTheNextMorning()

    expect(at(state, isApproval)).toBeGreaterThan(at(state, says('Running the compose command now.')))
    expect(at(state, isApproval)).toBeLessThan(at(state, says('Set your name to the new one')))
  })

  it('leaves the order running forwards in time, which is what a date stamp reads', () => {
    const stamped = list(openedTheNextMorning())
      .map(item => item.ts)
      .filter((ts): ts is number => ts !== undefined)

    expect(stamped).toEqual([...stamped].sort((a, b) => a - b))
  })

  it('still stands at the tail while it is open, because that is where it is being asked', () => {
    const asked = applyServerRequest(
      reconcile(fresh(), rowsToItems(day1Rows, 'rpc')),
      approvalRequest,
      (DAY_1 + 32_040) * 1000
    )
    const state = reconcile(asked, rowsToItems(day2Rows, 'rpc'))

    expect(list(state).at(-1)!.kind).toBe('approval')
    expect((list(state).at(-1) as ApprovalItem).state).toBe('open')
  })
})
