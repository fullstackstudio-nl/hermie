/**
 * A scheduled job's delivery, shown twice by a resume.
 *
 * `duplicate-turns.test.ts` pins the same behaviour for the owner's own
 * prompts. A cron delivery is the harder half of it, for one reason: the
 * transcript does not show the delivery's raw text at all. It shows a CARD, and
 * that card keeps the job's name and body as separate fields — so the obvious
 * comparison, "is `inflight.user` the text of the newest authored item", is
 * false for every cron turn and would stand a second card beside the first on
 * every resume. `resumeOverlap` compares `${jobName}\n${body}` through
 * `parseCronDelivery` instead, and `shownTurn` accepts a `cron_delivery` as the
 * shown prompt. Both halves are load-bearing and neither had a test.
 *
 * Both delivery shapes are exercised, because they parse differently — the Bot
 * Chat header carries an instruction and a blank line, the mirror carries one
 * newline and nothing else — and a comparison that only worked for one would
 * look correct in half the fixtures.
 */
import { describe, expect, it } from 'vitest'

import { cronBotChatBody, cronBotChatHeader, cronBotChatText, cronMirrorText } from './__fixtures__/rows'
import { reconcile } from './reconcile'
import { applyEvent, applyResumeSnapshot } from './reducer'
import { rowsToItems } from './rows-to-items'
import { createChatState, type ChatState, type CronDeliveryItem } from './types'

const NOW = 1_700_000_000_000
const LATER = NOW + 60_000

const fresh = () => createChatState('researcher', 'stored-1', 'resolved-1')
const list = (state: ChatState) => state.order.map(id => state.items[id]!)
const cards = (state: ChatState) =>
  list(state).filter((item): item is CronDeliveryItem => item.kind === 'cron_delivery')
const assistants = (state: ChatState) => list(state).filter(item => item.kind === 'assistant')
const kinds = (state: ChatState) => list(state).map(item => item.kind)

const runningSnapshot = (user: string, assistant: string) => ({
  inflight: { user, assistant, streaming: true },
  running: true
})

/** The delivery already in history, as `session.history` projects it. */
const historyWith = (text: string, rowId: number) =>
  reconcile(fresh(), rowsToItems([{ role: 'user', row_id: rowId, text, timestamp: 1_700_000_050 }], 'rest'))

describe('a resume during a running cron turn', () => {
  it('does not add a second card beside the delivery row history already carries', () => {
    const loaded = historyWith(cronBotChatText, 20)

    expect(cards(loaded)).toHaveLength(1)

    const resumed = applyResumeSnapshot(loaded, runningSnapshot(cronBotChatText, 'Reading the inbox'), LATER)

    expect(cards(resumed)).toHaveLength(1)
    expect(kinds(resumed)).toEqual(['cron_delivery', 'assistant'])
    expect(cards(resumed)[0]).toMatchObject({ jobName: 'Inbox scan', body: cronBotChatBody })
  })

  it('does not add a second card for the mirror shape either', () => {
    const resumed = applyResumeSnapshot(
      historyWith(cronMirrorText, 21),
      runningSnapshot(cronMirrorText, 'Both green, nothing to do'),
      LATER
    )

    expect(cards(resumed)).toHaveLength(1)
    expect(cards(resumed)[0]).toMatchObject({ jobName: 'Morning Brief', shape: 'mirror' })
  })

  it('keeps streaming onto the bubble the previous resume opened', () => {
    // Two reconnects inside one cron turn, which is the case a flaky link
    // actually produces. The first resume opens the assistant bubble; the
    // second has to settle onto both the card and that bubble.
    let state = applyResumeSnapshot(
      historyWith(cronBotChatText, 22),
      runningSnapshot(cronBotChatText, 'Reading'),
      LATER
    )

    expect(cards(state)).toHaveLength(1)

    state = applyResumeSnapshot(state, runningSnapshot(cronBotChatText, 'Reading the inbox'), LATER + 1_000)

    expect(cards(state)).toHaveLength(1)
    expect(assistants(state)).toHaveLength(1)
    expect(assistants(state)[0]).toMatchObject({ text: 'Reading the inbox' })
  })

  /**
   * The gap this file found, now closed.
   *
   * `message.start` for a turn this client did not author inserts an EMPTY
   * placeholder user item — the row standing in for an author a tail fetch has
   * not named yet. A scheduler's turn is exactly that case, so the placeholder
   * lands between the cron card history already carries and the reply being
   * streamed. `shownTurn` used to read that blank text AS the shown prompt: the
   * comparison against `inflight.user` missed and the resume stood a second card
   * beside the first. A placeholder is a promise of a prompt, not a prompt, so it
   * is now walked past — it neither counts as one nor hides the card that is one.
   */
  it('sees past a foreign-author placeholder to the card behind it', () => {
    let state = historyWith(cronBotChatText, 23)

    state = applyEvent(state, { type: 'message.start', seq: 1 }, NOW)
    state = applyEvent(state, { type: 'message.delta', seq: 2, payload: { text: 'Reading' } }, NOW)

    const resumed = applyResumeSnapshot(state, runningSnapshot(cronBotChatText, 'Reading the inbox'), LATER)

    expect(cards(resumed)).toHaveLength(1)
    // And the blank bubble the placeholder was is gone with it, rather than
    // sitting between the card and its reply for the reader to wonder about.
    expect(kinds(resumed)).toEqual(['cron_delivery', 'assistant'])
  })

  it('fills the placeholder with the card, in place, on a chat that never saw the delivery', () => {
    // The cold-open variant: no history at all, a foreign `message.start`, then
    // the resume that is the only thing which knows the scheduler ran. The card
    // has to land WHERE the placeholder stood — appended, it would sit under the
    // reply it started.
    let state = applyEvent(fresh(), { type: 'message.start', seq: 1 }, NOW)

    expect(kinds(state)).toEqual(['user'])

    state = applyEvent(state, { type: 'message.delta', seq: 2, payload: { text: 'Reading' } }, NOW)
    state = applyResumeSnapshot(state, runningSnapshot(cronBotChatText, 'Reading the inbox'), LATER)

    expect(kinds(state)).toEqual(['cron_delivery', 'assistant'])
    expect(cards(state)[0]).toMatchObject({ jobName: 'Inbox scan', body: cronBotChatBody })
  })
})

/**
 * The same hole, for the other kind of turn nobody here authored.
 *
 * A teammate's message opens a turn in this chat (ADR-0009) and arrives as a
 * `role: user` row whose text is `Message from 🤖 <name> (@<handle>): <body>`.
 * The transcript draws only the BODY, in a tinted bubble — so a resume comparing
 * `inflight.user` raw against that bubble missed for the same reason the cron
 * card did, and projected the signature line as a plain user bubble on top of it.
 */
describe('a resume during a running teammate turn', () => {
  const dmText = 'Message from 🤖 Writer (@writer): can you check the changelog?'

  const historyWithDm = (rowId: number) =>
    reconcile(fresh(), rowsToItems([{ role: 'user', row_id: rowId, text: dmText, timestamp: 1_700_000_050 }], 'rest'))

  it('does not add a second bubble beside the inbound row history carries', () => {
    const loaded = historyWithDm(40)

    expect(kinds(loaded)).toEqual(['bot_dm_in'])

    const resumed = applyResumeSnapshot(loaded, runningSnapshot(dmText, 'Looking'), LATER)

    expect(kinds(resumed)).toEqual(['bot_dm_in', 'assistant'])
  })

  it('sees past the foreign-author placeholder to that bubble', () => {
    let state = historyWithDm(41)

    state = applyEvent(state, { type: 'message.start', seq: 1 }, NOW)
    state = applyEvent(state, { type: 'message.delta', seq: 2, payload: { text: 'Look' } }, NOW)

    const resumed = applyResumeSnapshot(state, runningSnapshot(dmText, 'Looking'), LATER)

    expect(kinds(resumed)).toEqual(['bot_dm_in', 'assistant'])
  })

  it('projects the message as a DM bubble, not as the signature line in a user bubble', () => {
    let state = applyEvent(fresh(), { type: 'message.start', seq: 1 }, NOW)

    state = applyResumeSnapshot(state, runningSnapshot(dmText, ''), LATER)

    expect(kinds(state)).toEqual(['bot_dm_in'])
    expect(list(state)[0]).toMatchObject({
      kind: 'bot_dm_in',
      senderName: 'Writer',
      senderHandle: 'writer',
      text: 'can you check the changelog?'
    })
  })

  it('still adds the card when the chat has never seen that delivery', () => {
    // The other side of the same rule: a resume that lands on a cold chat mid
    // cron turn is the ONLY thing that knows the job ran, so suppressing it
    // would lose the delivery rather than de-duplicate it.
    const resumed = applyResumeSnapshot(fresh(), runningSnapshot(cronBotChatText, 'Reading'), LATER)

    expect(cards(resumed)).toHaveLength(1)
    expect(cards(resumed)[0]).toMatchObject({ jobName: 'Inbox scan' })
  })
})

describe('a NEW delivery of a job that has already run', () => {
  /** Yesterday's run: the delivery, and the persisted reply that finished it. */
  const finishedRun = (text: string) =>
    reconcile(
      fresh(),
      rowsToItems(
        [
          { role: 'user', row_id: 30, text, timestamp: 1_700_000_050 },
          { role: 'assistant', row_id: 31, text: 'Nothing needed you.', timestamp: 1_700_000_060 }
        ],
        'rest'
      )
    )

  it('gets its own card when an identical delivery is in flight again', () => {
    // A cron delivers the same job name and, when nothing changed, the same
    // body. The settled reply between them is what says the first run is over,
    // so this one is a new turn and not a re-description of the old one.
    const loaded = finishedRun(cronBotChatText)

    expect(cards(loaded)).toHaveLength(1)

    const resumed = applyResumeSnapshot(loaded, runningSnapshot(cronBotChatText, ''), LATER)

    expect(cards(resumed)).toHaveLength(2)
    expect(kinds(resumed)).toEqual(['cron_delivery', 'assistant', 'cron_delivery'])
  })

  it('adds exactly one card, not one per resume, while that new turn runs', () => {
    let state = applyResumeSnapshot(finishedRun(cronMirrorText), runningSnapshot(cronMirrorText, ''), LATER)

    expect(cards(state)).toHaveLength(2)

    // A second reconnect describes the same in-flight turn again. By now the
    // new card IS the newest authored item, so it has to settle onto it.
    state = applyResumeSnapshot(state, runningSnapshot(cronMirrorText, 'Checking'), LATER + 1_000)

    expect(cards(state)).toHaveLength(2)
    expect(assistants(state)).toHaveLength(2)
  })

  it('separates two runs of the same job whose bodies differ', () => {
    const second = `${cronBotChatHeader('Inbox scan')}\n\n## Inbox scan\n\n- 1 thread waiting on a reply`
    const resumed = applyResumeSnapshot(finishedRun(cronBotChatText), runningSnapshot(second, ''), LATER)

    expect(cards(resumed)).toHaveLength(2)
    expect(cards(resumed)[1]).toMatchObject({ body: '## Inbox scan\n\n- 1 thread waiting on a reply' })
  })
})
