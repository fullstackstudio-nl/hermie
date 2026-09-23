/**
 * Where a slash command's answer stands after the transcript has been
 * re-hydrated around it (HERM-46).
 *
 * The owner's report, on a real gateway: `TODAY`, a bot-to-bot notice, a
 * reply, another notice, an answer — and then, BELOW all of that, `YESTERDAY`
 * with a `/model …` row and its result card. The command was run the day
 * before and answered on the spot; the card that answers it is exactly the
 * shape `request-order.test.ts` already pins for an approval — a record of
 * something that already happened, cached across a cold open, then folded
 * back in by a re-hydration that also brings today's rows.
 *
 * It is a different bug from the approval one, not a repeat of it:
 * `NoticeKind`'s own doc comment says a `command` notice is "Live-only —
 * command output is never persisted, so no history row ever projects onto
 * this kind." `reconcile`'s `isEphemeral` / `isSettledRequest` only knew about
 * `approval` and `clarify`, so a command notice fell through to the plain
 * `kept` bucket — never dropped (nothing dropped it, isEphemeral did not
 * gate it away, and its origin/index test happened to keep it because it was
 * the newest thing on screen at the time), but never placed by its own
 * timestamp either. `[...merged, ...kept]` puts `kept` straight after
 * everything a re-hydration brought back, so yesterday's card landed after
 * this morning's messages — the transcript ran forwards and then jumped back
 * a day at the bottom, exactly like the screenshot.
 *
 * `session.reclaimed` is the same shape of problem — a broadcast the gateway
 * never persists either — and is covered here for the same reason.
 */
import { describe, expect, it } from 'vitest'

import { snapshotForCache, stateFromCache } from './cache'
import { reconcile } from './reconcile'
import { applyEvent, beginLocalTurn } from './reducer'
import { rowsToItems, type TranscriptRow } from './rows-to-items'
import { type ChatState, createChatState, type NoticeItem, type TranscriptItem } from './types'

const IDS = { storedSessionId: 'stored-1', resolvedSessionId: 'resolved-1' }

/** Unix seconds. Day 1 is a Monday morning; day 2 is the next day. */
const DAY_1 = 1_758_355_200
const DAY_2 = DAY_1 + 86_400

const fresh = () => createChatState('researcher', IDS.storedSessionId, IDS.resolvedSessionId)
const list = (state: ChatState): TranscriptItem[] => state.order.map(id => state.items[id]!)
const at = (state: ChatState, predicate: (item: TranscriptItem) => boolean) => list(state).findIndex(predicate)
const isCommandNotice = (item: TranscriptItem) => item.kind === 'notice' && item.noticeKind === 'command'
const isReclaimedNotice = (item: TranscriptItem) => item.kind === 'notice' && item.noticeKind === 'reclaimed'
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
 * 1. Day 1: a turn runs, `/model …` is typed and answered, the chat is cached.
 * 2. Day 2: a cold open paints that cache, so the answered card is on screen
 *    with yesterday's timestamp on it.
 * 3. The resume's history comes back holding day 1 AND a fresh turn from this
 *    morning, and `reconcile` folds it in.
 * 4. The owner types again.
 */
function openedTheNextMorning(): ChatState {
  const day1 = applyEvent(
    reconcile(fresh(), rowsToItems(day1Rows, 'rpc')),
    {
      type: 'notice',
      session_id: 'sess-1',
      payload: { message: '/model gpt-5', detail: 'Model set to gpt-5', noticeKind: 'command' }
    },
    (DAY_1 + 32_040) * 1000
  )
  const painted = stateFromCache('researcher', IDS, snapshotForCache(day1, (DAY_1 + 32_100) * 1000))
  const hydrated = reconcile(painted, rowsToItems(day2Rows, 'rpc'))

  return beginLocalTurn(hydrated, 'And your handle?', undefined, (DAY_2 + 34_380) * 1000)
}

describe('a slash command answer keeps the place it was answered in', () => {
  it('survives the cache with the timestamp it was answered at', () => {
    const day1 = applyEvent(
      reconcile(fresh(), rowsToItems(day1Rows, 'rpc')),
      {
        type: 'notice',
        session_id: 'sess-1',
        payload: { message: '/model gpt-5', detail: 'Model set to gpt-5', noticeKind: 'command' }
      },
      (DAY_1 + 32_040) * 1000
    )
    const painted = stateFromCache('researcher', IDS, snapshotForCache(day1, (DAY_1 + 32_100) * 1000))
    const notice = list(painted).find(isCommandNotice) as NoticeItem

    expect(notice.ts).toBe(DAY_1 + 32_040)
  })

  it('does not drift past the rows a later hydration added', () => {
    const state = openedTheNextMorning()

    expect(at(state, isCommandNotice)).toBeGreaterThan(at(state, says('Running the compose command now.')))
    expect(at(state, isCommandNotice)).toBeLessThan(at(state, says('Set your name to the new one')))
  })

  it('leaves the order running forwards in time, which is what a date stamp reads', () => {
    const stamped = list(openedTheNextMorning())
      .map(item => item.ts)
      .filter((ts): ts is number => ts !== undefined)

    expect(stamped).toEqual([...stamped].sort((a, b) => a - b))
  })
})

describe('a reclaimed-session notice keeps the place it happened in', () => {
  function openedTheNextMorningAfterReclaim(): ChatState {
    const day1 = applyEvent(
      reconcile(fresh(), rowsToItems(day1Rows, 'rpc')),
      { type: 'session.reclaimed', session_id: 'sess-1', payload: { reason: 'idle' } },
      (DAY_1 + 32_040) * 1000
    )
    const painted = stateFromCache('researcher', IDS, snapshotForCache(day1, (DAY_1 + 32_100) * 1000))

    return reconcile(painted, rowsToItems(day2Rows, 'rpc'))
  }

  it('does not drift past the rows a later hydration added', () => {
    const state = openedTheNextMorningAfterReclaim()

    expect(at(state, isReclaimedNotice)).toBeGreaterThan(at(state, says('Running the compose command now.')))
    expect(at(state, isReclaimedNotice)).toBeLessThan(at(state, says('Set your name to the new one')))
  })
})

describe('a command notice with no timestamp of its own', () => {
  it('falls back to the tail, the same place any other undated floating item lands', () => {
    // Not a shape a live `notice` event ever produces (`pushNotice` always
    // stamps `now`) but a defensive floor for anything that reaches
    // `reconcile` without one — imported history, a replayed snapshot from an
    // older build, a hand-built fixture. `placeByTimestamp` cannot say WHERE
    // between two rows an undated item belongs, so — like every other kind
    // that reaches it with no `ts` — it goes at the very end rather than
    // guessing a slot a reader would read as meaningful.
    const day1 = reconcile(fresh(), rowsToItems(day1Rows, 'rpc'))
    const withUndatedNotice: ChatState = {
      ...day1,
      items: {
        ...day1.items,
        'n:undated': {
          id: 'n:undated',
          kind: 'notice',
          noticeKind: 'command',
          title: '/help',
          seq: -1,
          version: 0,
          origin: 'live'
        }
      },
      order: ['n:undated', ...day1.order]
    }

    const state = reconcile(withUndatedNotice, rowsToItems(day2Rows, 'rpc'))

    expect(list(state).at(-1)!.id).toBe('n:undated')
  })
})
