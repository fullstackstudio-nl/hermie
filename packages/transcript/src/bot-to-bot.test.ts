/**
 * The invariant: bot-to-bot traffic is never speech.
 *
 * Two agents working a delivery out between themselves is not the conversation
 * the reader is in, so no row that carries it may reach the screen as the owner's
 * bubble or as the bot's reply — on any path, in either direction, whatever the
 * gateway did or did not label.
 *
 * It is written as a table on purpose. Every way a row can enter the transcript
 * is one entry in `PATHS`, and every shape the wire has for this traffic is one
 * entry in `TRAFFIC`; the suite runs the product of the two. A new entry path
 * that does not go through `classifyUserRow` has to be added here to be
 * considered covered, and the moment it is, the leak this file was written for
 * shows up as a failure rather than as a screenshot from a tester.
 *
 * What the leak was: the answer to a dispatch does not arrive as a message but as
 * `[IMPORTANT: Background process <sid> completed …]` on the `user` role, with
 * the delivery command and the teammate's reply in its output. `parseInjectedRow`
 * refuses that text rather than guessing at its body, and refusing, handed it to
 * the speech branch — so on the two paths that see the text alone (a persisted
 * row whose `display_kind` never arrived, and a resume's `inflight.user`) the
 * teammate's reply was painted as a bubble the owner had supposedly typed.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { isBotToBotItem } from './bot-dm'
import { DM_DELIVERY_COMMAND, dmReplyProcessText, LEGACY_DELIVERY_COMMAND } from './__fixtures__/rows'
import { reconcileTail } from './reconcile'
import { applyEvent, applyResumeSnapshot } from './reducer'
import { classifyUserRow, rowsToItems, type TranscriptRow } from './rows-to-items'
import { visibleItems } from './selectors'
import { type ChatState, createChatState, type TranscriptItem, type Verbosity } from './types'

const NOW = 1_700_000_000_000
const LATER = NOW + 60_000

/** Every shape the wire has for traffic between two agents. */
const TRAFFIC: { name: string; text: string }[] = [
  { name: 'an inbound delivery', text: 'Message from 🤖 Writer (@writer): The draft is in docs/announce.md.' },
  { name: 'an inbound delivery with no handle', text: 'Message from Writer: The draft is in docs/announce.md.' },
  { name: 'the legacy inbound signature', text: "[Message from agent 'Writer'] The draft is in docs/announce.md." },
  { name: 'the reply the delivery runner reports back', text: dmReplyProcessText },
  {
    name: 'the reply the legacy delivery command reports back',
    text: [
      '[IMPORTANT: Background process proc-4b1a completed (exit code 0).',
      `Command: ${LEGACY_DELIVERY_COMMAND}`,
      'Output:',
      'Message from 🤖 Writer (@writer): Done — it is in the shared folder.]'
    ].join('\n')
  },
  {
    name: 'a batch report carrying a delivery beside an unrelated process',
    text: [
      '[IMPORTANT: Background process proc-aa01 exited (exit code 1).',
      'Command: npm run build',
      'Output:',
      'error TS2345: Argument of type string is not assignable.]',
      '',
      '[IMPORTANT: Background process proc-2f9c completed (exit code 0).',
      `Command: ${DM_DELIVERY_COMMAND}`,
      'Output:',
      'Message from 🤖 Writer (@writer): Draft is ready.]'
    ].join('\n')
  }
]

/**
 * The fragments that only ever appear in traffic between two agents: a delivery
 * signature, a process report's scaffolding, and the runner's own command line.
 * A speech item carrying any of them is the bug.
 */
const TRAFFIC_MARKERS = ['Message from', 'Background process', 'bot_mode_dm.py', 'hermes -p', 'Message from agent']

const fresh = () => createChatState('researcher', 'stored-1', 'resolved-1')
const list = (state: ChatState): TranscriptItem[] => state.order.map(id => state.items[id]!).filter(Boolean)

/** A foreign `message.start`: nothing local was submitted, so a placeholder goes up. */
const foreignTurn = () => applyEvent(fresh(), { type: 'message.start', seq: 1 }, NOW)

const row = (text: string, extra: Partial<TranscriptRow> = {}): TranscriptRow => ({
  role: 'user',
  row_id: 12,
  text,
  timestamp: 1_700_000_020,
  ...extra
})

/**
 * Every way a row reaches the transcript.
 *
 * `rowsToItems` twice over, because the two transports prefer different aliases
 * of the same field and a projection that reads one and not the other is a path
 * of its own.
 */
const PATHS: { name: string; run: (text: string) => TranscriptItem[] }[] = [
  { name: 'RPC history', run: text => rowsToItems([row(text)], 'rpc') },
  { name: 'REST history', run: text => rowsToItems([{ role: 'user', id: 12, display_content: text }], 'rest') },
  {
    name: 'a persisted row the gateway labelled',
    run: text => rowsToItems([row(text, { display_kind: 'process_complete' })], 'rpc')
  },
  {
    name: 'a REST tail onto an empty chat',
    run: text => list(reconcileTail(fresh(), rowsToItems([row(text)], 'rest')))
  },
  {
    name: 'a REST tail filling a foreign placeholder',
    run: text => list(reconcileTail(foreignTurn(), rowsToItems([row(text)], 'rest')))
  },
  {
    name: 'a resume snapshot during the turn',
    run: text =>
      list(
        applyResumeSnapshot(
          foreignTurn(),
          { inflight: { user: text, assistant: 'Noted — I will fold that in.', streaming: true }, running: true },
          LATER
        )
      )
  },
  {
    name: 'a resume snapshot followed by the tail that persisted it',
    run: text => {
      const resumed = applyResumeSnapshot(
        foreignTurn(),
        { inflight: { user: text, assistant: 'Noted — I will fold that in.', streaming: true }, running: true },
        LATER
      )

      return list(reconcileTail(resumed, rowsToItems([row(text)], 'rest')))
    }
  },
  {
    name: 'a live dispatch, then the tail that answered it',
    run: text => {
      const args = { target: '@writer', message: 'Can you draft the announcement?' }
      let state = applyEvent(
        fresh(),
        { type: 'tool.start', seq: 1, payload: { tool_id: 'c1', name: 'message_agent', args } },
        NOW
      )

      state = applyEvent(
        state,
        {
          type: 'tool.complete',
          seq: 2,
          payload: { tool_id: 'c1', name: 'message_agent', args, result: { status: 'queued', process_id: 'proc-2f9c' } }
        },
        NOW + 100
      )

      return list(reconcileTail(state, rowsToItems([row(text)], 'rest')))
    }
  }
]

const speech = (items: readonly TranscriptItem[]): string[] =>
  items.filter(item => item.kind === 'user' || item.kind === 'assistant').map(item => item.text)

describe('no path draws bot-to-bot traffic as speech', () => {
  for (const path of PATHS) {
    for (const traffic of TRAFFIC) {
      it(`${path.name}: ${traffic.name}`, () => {
        const items = path.run(traffic.text)

        for (const text of speech(items)) {
          for (const marker of TRAFFIC_MARKERS) {
            expect(text).not.toContain(marker)
          }
        }
      })
    }
  }
})

describe('the classifier is the one place it is decided', () => {
  for (const traffic of TRAFFIC) {
    it(`${traffic.name} is never classified as the owner speaking`, () => {
      expect(classifyUserRow(traffic.text).kind).not.toBe('user')
    })
  }

  it('reads a labelled row for the delivery signature but not for the rest', () => {
    // A label is a stronger signal than any header heuristic, so a labelled row
    // skips them — except the inbound signature, which rides inside the text of a
    // steer or a skill invocation as much as anywhere else.
    expect(classifyUserRow(TRAFFIC[0]!.text, { labelled: true }).kind).toBe('bot_dm_in')
    expect(classifyUserRow(dmReplyProcessText, { labelled: true }).kind).toBe('user')
  })

  it('leaves an ordinary message alone', () => {
    const classified = classifyUserRow('Ask Writer for the draft when you get a chance.')

    expect(classified).toMatchObject({ kind: 'user', steered: false })
  })

  /*
    The structural half of the invariant, and the only half that can fail on code
    nobody thought to test: a THIRD projection path.

    Both halves of the leak were one shape read by two chains that had drifted
    apart, so the guard is that there are only two modules allowed to build a
    speech item at all. A new one has to name itself here, and naming itself is
    the moment its author has to answer whether it goes through
    `classifyUserRow`.
  */
  it('has no third module building a user item', () => {
    const dir = join(import.meta.dirname, '.')
    // `types.ts` DECLARES the kind rather than building one.
    const allowed = new Set(['reducer.ts', 'rows-to-items.ts', 'types.ts'])
    const offenders = readdirSync(dir)
      .filter(name => name.endsWith('.ts') && !name.endsWith('.test.ts') && !allowed.has(name))
      .filter(name => /kind:\s*'user'/u.test(readFileSync(join(dir, name), 'utf8')))

    expect(offenders).toEqual([])
  })
})

describe('the reply the delivery runner reports back', () => {
  const dispatch = (): ChatState => {
    const args = { target: '@writer', message: 'Can you draft the announcement?' }
    let state = applyEvent(
      fresh(),
      { type: 'tool.start', seq: 1, payload: { tool_id: 'c1', name: 'message_agent', args } },
      NOW
    )

    state = applyEvent(
      state,
      {
        type: 'tool.complete',
        seq: 2,
        payload: { tool_id: 'c1', name: 'message_agent', args, result: { status: 'queued', process_id: 'proc-2f9c' } }
      },
      NOW + 100
    )

    return state
  }

  it('lands on the dispatch whether the gateway labelled the row or not', () => {
    for (const displayKind of [undefined, 'process_complete']) {
      const tail = rowsToItems([row(dmReplyProcessText, displayKind ? { display_kind: displayKind } : {})], 'rest')
      const items = list(reconcileTail(dispatch(), tail))

      expect(items.map(item => item.kind)).toEqual(['bot_dm_out'])
      expect(items[0]).toMatchObject({
        kind: 'bot_dm_out',
        reply: { text: 'Draft is ready, I pushed it to the shared folder.' }
      })
    }
  })

  it('projects nothing at all from a resume, leaving the join to the tail', () => {
    // The dispatch is a tool row the snapshot says nothing about, and it may not
    // even be on screen, so this side cannot make the join. Staying quiet is the
    // honest answer; a bubble was not.
    const resumed = applyResumeSnapshot(
      foreignTurn(),
      { inflight: { user: dmReplyProcessText, assistant: 'Thanks — folding it in.', streaming: true }, running: true },
      LATER
    )

    expect(list(resumed).map(item => item.kind)).toEqual(['assistant'])
  })

  it('still becomes a notice when there is no dispatch to answer', () => {
    // Not silence: a reply with nothing to attach to is the one case where the
    // reader would otherwise see a turn run for no visible reason.
    const items = rowsToItems([row(dmReplyProcessText)], 'rest')

    expect(items.map(item => item.kind)).toEqual(['notice'])
    expect(items[0]).toMatchObject({ kind: 'notice', noticeKind: 'process_complete' })
  })
})

describe('a bot-to-bot row is an aside at every verbosity', () => {
  const levels: Verbosity[] = ['quiet', 'normal', 'verbose']

  const withTraffic = (): ChatState => {
    const items = rowsToItems(
      [
        {
          role: 'tool',
          name: 'message_agent',
          tool_id: 'call_dm_1',
          args: { target: '@writer', message: 'Can you draft the announcement?' }
        },
        { role: 'user', row_id: 14, text: TRAFFIC[0]!.text, timestamp: 1_700_000_040 }
      ],
      'rpc'
    )

    return reconcileTail(fresh(), items)
  }

  for (const level of levels) {
    it(`${level}: both directions are collapsed, never full`, () => {
      const shown = visibleItems(withTraffic(), { level, showBotToBot: true, showThinking: true }).filter(entry =>
        isBotToBotItem(entry.item)
      )

      expect(shown.map(entry => entry.item.kind)).toEqual(['bot_dm_out', 'bot_dm_in'])
      expect(shown.map(entry => entry.presentation)).toEqual(['collapsed', 'collapsed'])
    })

    it(`${level}: the toggle demotes both to a chip rather than hiding either`, () => {
      const shown = visibleItems(withTraffic(), { level, showBotToBot: false, showThinking: true }).filter(entry =>
        isBotToBotItem(entry.item)
      )

      expect(shown.map(entry => entry.presentation)).toEqual(['chip', 'chip'])
    })
  }
})
