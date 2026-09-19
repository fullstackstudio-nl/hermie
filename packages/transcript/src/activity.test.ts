import { describe, expect, it } from 'vitest'

import { activityEntries, findDmCounterpart } from './activity'
import { applyEvent, applyProcessCompletion } from './reducer'
import { delegationEvents, dmDispatchTurn } from './__fixtures__/events'
import { type ChatState, createChatState } from './types'

const NOW = 1_700_000_000_000

const run = (events: readonly { type: string; seq?: number; payload?: unknown }[], state: ChatState) =>
  events.reduce((current, event) => applyEvent(current, event, NOW), state)

/** Researcher, having dispatched a DM to writer. */
const researcher = () => run(dmDispatchTurn, createChatState('researcher', 'stored-r', 'resolved-r'))

/** Writer's own chat, holding the inbound view of that same message. */
function writer(at = NOW / 1000 + 20): ChatState {
  const base = createChatState('writer', 'stored-w', 'resolved-w')

  return run(
    [
      { type: 'message.start', seq: 1, payload: {} },
      { type: 'message.complete', seq: 2, payload: { text: 'On it.', status: 'complete' } }
    ],
    {
      ...base,
      items: {
        'i:1': {
          id: 'i:1',
          kind: 'bot_dm_in',
          seq: 1000,
          version: 0,
          origin: 'history',
          ts: at,
          senderName: 'Researcher',
          senderHandle: 'researcher',
          text: 'Can you draft the announcement?'
        }
      },
      order: ['i:1'],
      turn: { ...base.turn, nextSeq: 2000 }
    }
  )
}

describe('activityEntries', () => {
  it('renders a dispatch as a sender-side row', () => {
    const entries = activityEntries({ researcher: researcher() })
    const dispatch = entries.find(entry => entry.kind === 'dm_out')

    expect(dispatch).toMatchObject({
      botName: 'researcher',
      fromHandle: 'researcher',
      toHandle: 'writer',
      text: 'Can you draft the announcement?',
      status: 'Queued',
      pending: true
    })
  })

  it('does not report the same delivery twice when both chats are loaded', () => {
    const entries = activityEntries({ researcher: researcher(), writer: writer() })
    const deliveries = entries.filter(entry => entry.text === 'Can you draft the announcement?')

    expect(deliveries).toHaveLength(1)
    // The sender side wins, because it is the one that knows the status.
    expect(deliveries[0]?.kind).toBe('dm_out')
  })

  it('keeps an inbound row whose sender chat is not loaded', () => {
    const entries = activityEntries({ writer: writer() })

    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ kind: 'dm_in', fromHandle: 'researcher', toHandle: 'writer' })
  })

  it('adds a reply row once the delivery reports back', () => {
    const replied = applyProcessCompletion(
      researcher(),
      [
        '[IMPORTANT: Background process proc-2f9c completed (exit code 0).',
        'Command: python3 /opt/hermes/tools/bot_mode_dm.py --run-delivery hermes -p writer chat',
        'Output:',
        'Message from 🤖 Writer (@writer): Draft is ready.]'
      ].join('\n'),
      NOW
    )

    const entries = activityEntries({ researcher: replied })

    expect(entries.map(entry => entry.kind)).toEqual(['dm_out', 'dm_reply'])
    expect(entries[1]).toMatchObject({ fromHandle: 'writer', toHandle: 'researcher', text: 'Draft is ready.' })
    expect(entries[0]?.status).toBe('Replied')
    expect(entries[0]?.pending).toBeUndefined()
  })

  it('renders a fan-out as one delegation row that counts its children', () => {
    const entries = activityEntries({ researcher: run(delegationEvents, createChatState('researcher', 's', 'r')) })
    const delegation = entries.find(entry => entry.kind === 'delegation')

    expect(delegation).toMatchObject({ botName: 'researcher', fromHandle: 'researcher' })
    expect(delegation?.agentCount).toBeGreaterThan(0)
  })

  it('sorts by time and stays stable for rows stamped in the same second', () => {
    const entries = activityEntries({ researcher: researcher(), writer: writer(NOW / 1000 + 600) })
    const stamps = entries.map(entry => entry.at)

    expect([...stamps].sort((a, b) => a - b)).toEqual(stamps)
    expect(activityEntries({ researcher: researcher(), writer: writer(NOW / 1000 + 600) }).map(e => e.id)).toEqual(
      entries.map(e => e.id)
    )
  })
})

describe('findDmCounterpart', () => {
  it('finds the inbound row that matches a dispatch', () => {
    const target = writer()
    const id = findDmCounterpart(target, {
      kind: 'bot_dm_in',
      handle: 'researcher',
      at: NOW / 1000,
      text: 'Can you draft the announcement?'
    })

    expect(id).toBe('i:1')
  })

  it('refuses a match from a different handle rather than opening the wrong message', () => {
    expect(findDmCounterpart(writer(), { kind: 'bot_dm_in', handle: 'scribe', at: NOW / 1000 })).toBeUndefined()
  })

  it('refuses a stamp-only match that is hours away', () => {
    const far = writer(NOW / 1000 + 20_000)

    expect(findDmCounterpart(far, { kind: 'bot_dm_in', handle: 'researcher', at: NOW / 1000 })).toBeUndefined()
  })

  it('takes an exact body match even when the stamps disagree', () => {
    const far = writer(NOW / 1000 + 20_000)
    const id = findDmCounterpart(far, {
      kind: 'bot_dm_in',
      handle: 'researcher',
      at: NOW / 1000,
      text: 'Can you draft the announcement?'
    })

    expect(id).toBe('i:1')
  })

  it('answers nothing for a chat that is not loaded', () => {
    expect(findDmCounterpart(undefined, { kind: 'bot_dm_in', handle: 'researcher' })).toBeUndefined()
  })
})
