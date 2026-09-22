import { describe, expect, it } from 'vitest'

import { reconcile } from './reconcile'
import { applyEvent, applyServerRequest } from './reducer'
import { rowsToItems } from './rows-to-items'
import {
  isBusy,
  itemsVersion,
  latestStatus,
  openRequests,
  runningSubagents,
  subagentTree,
  lastMessageAt,
  unreadBadgeLabel,
  unreadCountSince,
  type VisibilityOptions,
  visibleItems
} from './selectors'
import { approvalRequest, delegationEvents, dmDispatchTurn, streamedTurn } from './__fixtures__/events'
import { kanbanNotificationText, plainProcessText, priorContextText, rpcHistoryRows } from './__fixtures__/rows'
import { type AssistantItem, type ChatState, createChatState } from './types'

const NOW = 1_700_000_000_000

const fresh = () => createChatState('researcher', 'stored-1', 'resolved-1')
const run = (events: readonly { type: string; seq?: number; payload?: unknown }[], start: ChatState = fresh()) =>
  events.reduce((state, event) => applyEvent(state, event, NOW), start)

const options = (over: Partial<VisibilityOptions> = {}): VisibilityOptions => ({
  level: 'normal',
  showBotToBot: true,
  showThinking: false,
  ...over
})

const shown = (state: ChatState, over: Partial<VisibilityOptions> = {}) =>
  visibleItems(state, options(over)).map(entry => [entry.item.kind, entry.presentation])

const kindsOf = (state: ChatState) => state.order.map(id => state.items[id]?.kind)

/** The wire's own shape for an inbound teammate message — see ADR-0009. */
const dmInbound = (text: string) => `Message from 🤖 Writer (@writer): ${text}`

/** `[noticeKind, presentation]` for the notices a level lets through. */
const notices = (state: ChatState, over: Partial<VisibilityOptions> = {}) =>
  visibleItems(state, options(over))
    .filter(entry => entry.item.kind === 'notice')
    .map(entry => [entry.item.kind === 'notice' ? entry.item.noticeKind : '', entry.presentation])

describe('visibleItems levels', () => {
  const state = reconcile(fresh(), rowsToItems(rpcHistoryRows, 'rpc'))

  it('hides tool cards at quiet, but never the conversation', () => {
    const kinds = shown(state, { level: 'quiet' }).map(entry => entry[0])

    expect(kinds).not.toContain('tool')
    expect(kinds).toContain('user')
    expect(kinds).toContain('assistant')
    expect(kinds).toContain('bot_dm_in')
  })

  /**
   * Which notices survive `quiet`, and which do not.
   *
   * The line is not "is it a notice" but "did the owner ask for this". A fan-out
   * they dispatched and a background process they started are results they went
   * away and came back for — the same argument ADR-0013 makes for a cron
   * delivery, and the amendment of 2026-09-21 extends it to these two. Narration
   * — a model switch, a compaction handoff, a kanban event — is not.
   */
  it('keeps work the owner dispatched at quiet, folded', () => {
    expect(notices(state, { level: 'quiet' })).toContainEqual(['async_delegation_complete', 'collapsed'])
  })

  it('keeps a background process at quiet too, folded', () => {
    const completion = reconcile(fresh(), rowsToItems([{ role: 'user', row_id: 1, text: plainProcessText }], 'rpc'))

    expect(notices(completion, { level: 'quiet' })).toEqual([['process_complete', 'collapsed']])
  })

  it.each([
    ['a model switch', { role: 'user', row_id: 1, text: 'gpt-5', display_kind: 'model_switch' }],
    ['a roster refresh', { role: 'user', row_id: 1, text: 'refreshed', display_kind: 'internal_notification' }],
    ['a compaction handoff', { role: 'user', row_id: 1, text: priorContextText }],
    ['a kanban dispatch', { role: 'user', row_id: 1, text: `${kanbanNotificationText}\ndetails` }]
  ])('still drops %s at quiet', (_what, row) => {
    const only = reconcile(fresh(), rowsToItems([row], 'rpc'))

    expect(notices(only)).toHaveLength(1)
    expect(notices(only, { level: 'quiet' })).toEqual([])
  })

  /**
   * A slash command's answer, at every level there is.
   *
   * It is the payload of a line the owner TYPED, which is the same argument the
   * two tests above make for a fan-out and a process — but one step stronger,
   * because those report back minutes later and this one answers a question
   * asked a second ago. `quiet` is the default view, so a folded answer there
   * would already be a command that appeared to do nothing; a dropped one
   * certainly is.
   */
  it.each([['quiet'], ['normal'], ['verbose']] as const)('shows a command answer in full at %s', level => {
    const answered = applyEvent(
      fresh(),
      { type: 'notice', payload: { message: '/help', detail: 'usage: …', noticeKind: 'command' } },
      NOW
    )

    expect(notices(answered, { level })).toEqual([['command', 'full']])
  })

  it('collapses tool cards and notices at normal', () => {
    expect(shown(state)).toContainEqual(['tool', 'collapsed'])
    expect(shown(state)).toContainEqual(['notice', 'collapsed'])
  })

  it('expands everything at verbose, except the bot-to-bot asides', () => {
    const entries = shown(state, { level: 'verbose' })

    expect(entries).toContainEqual(['tool', 'full'])
    expect(entries).toContainEqual(['notice', 'full'])
    expect(entries).toContainEqual(['subagent_group', 'full'])
  })

  /**
   * Bot-to-bot rows are asides, and an aside starts closed at EVERY level.
   *
   * The owner's rule: the reader opens one by tapping it. `verbose` used to hand
   * `bot_dm_out` and `bot_dm_in` `full`, which opened a teammate's whole message
   * for somebody who had turned verbosity up to watch tool calls — and `full` is
   * the one presentation the renderer must never be given for these, because it
   * is what the bubble and the glass card were drawn from.
   */
  it.each([['normal'], ['verbose']] as const)('keeps a bot-to-bot row collapsed at %s', level => {
    const entries = shown(state, { level })

    expect(entries).toContainEqual(['bot_dm_out', 'collapsed'])
    expect(entries).toContainEqual(['bot_dm_in', 'collapsed'])
    expect(entries).not.toContainEqual(['bot_dm_out', 'full'])
    expect(entries).not.toContainEqual(['bot_dm_in', 'full'])
  })

  it('still demotes bot-to-bot to a chip rather than hiding it, with the toggle off', () => {
    // ADR-0009: hiding a DM makes the bot's own reply unexplainable.
    const entries = shown(state, { showBotToBot: false })

    expect(entries).toContainEqual(['bot_dm_out', 'chip'])
    expect(entries).toContainEqual(['bot_dm_in', 'chip'])
  })

  it('keeps a cron delivery at every level, folded at quiet', () => {
    // It is the result the owner scheduled, so it is never dropped and never a
    // chip; `quiet` folds the report rather than losing it.
    expect(shown(state, { level: 'quiet' })).toContainEqual(['cron_delivery', 'collapsed'])
    expect(shown(state)).toContainEqual(['cron_delivery', 'full'])
    expect(shown(state, { level: 'verbose' })).toContainEqual(['cron_delivery', 'full'])
  })

  it('shows the same conversation rows at every level', () => {
    const conversation = (level: VisibilityOptions['level']) =>
      shown(state, { level }).filter(entry => ['user', 'assistant', 'bot_dm_in'].includes(String(entry[0]))).length

    expect(conversation('quiet')).toBe(conversation('normal'))
    expect(conversation('normal')).toBe(conversation('verbose'))
  })
})

describe('the bot-to-bot toggle', () => {
  const state = reconcile(fresh(), rowsToItems(rpcHistoryRows, 'rpc'))

  it('demotes DM traffic to a chip instead of removing it', () => {
    const off = shown(state, { showBotToBot: false })
    const kinds = off.map(entry => entry[0])

    // Removing them would make the bot's own reply unexplainable.
    expect(kinds).toContain('bot_dm_in')
    expect(kinds).toContain('bot_dm_out')
    expect(off).toContainEqual(['bot_dm_in', 'chip'])
    expect(off).toContainEqual(['bot_dm_out', 'chip'])
    expect(off).toContainEqual(['subagent_group', 'chip'])
  })

  it('leaves the count of visible items unchanged', () => {
    expect(shown(state, { showBotToBot: false })).toHaveLength(shown(state).length)
  })

  it('does not touch a cron delivery, which is not bot-to-bot traffic', () => {
    // The scheduler is not a peer bot, so the toggle that quietens agents talking
    // amongst themselves has no business demoting its report.
    expect(shown(state, { showBotToBot: false })).toContainEqual(['cron_delivery', 'full'])
  })
})

describe('thinking', () => {
  const state = run(streamedTurn)

  it('strips reasoning from the items it hands back when thinking is off', () => {
    const assistants = visibleItems(state, options({ showThinking: false }))
      .map(entry => entry.item)
      .filter((item): item is AssistantItem => item.kind === 'assistant')

    expect(assistants.every(item => item.reasoning === undefined)).toBe(true)
  })

  it('keeps reasoning when thinking is on', () => {
    const assistants = visibleItems(state, options({ showThinking: true }))
      .map(entry => entry.item)
      .filter((item): item is AssistantItem => item.kind === 'assistant')

    expect(assistants.some(item => item.reasoning)).toBe(true)
  })

  it('hides a bubble that is nothing but reasoning when thinking is off', () => {
    const thinkingOnly = run([
      { type: 'message.start', seq: 1 },
      { type: 'reasoning.delta', seq: 2, payload: { text: 'weighing options' } }
    ])

    expect(shown(thinkingOnly, { showThinking: false }).map(entry => entry[0])).not.toContain('assistant')
    expect(shown(thinkingOnly, { showThinking: true })).toContainEqual(['assistant', 'collapsed'])
  })
})

describe('always-visible rows', () => {
  it('shows an open approval at every level', () => {
    const state = applyServerRequest(fresh(), approvalRequest, NOW)

    for (const level of ['quiet', 'normal', 'verbose'] as const) {
      expect(shown(state, { level })).toContainEqual(['approval', 'full'])
    }
  })

  it('shows an error card at every level', () => {
    const state = run([
      { type: 'message.start', seq: 1 },
      { type: 'message.delta', seq: 2, payload: { text: 'oh no' } },
      { type: 'message.complete', seq: 3, payload: { status: 'error', error: 'provider down' } }
    ])

    for (const level of ['quiet', 'normal', 'verbose'] as const) {
      expect(shown(state, { level })).toContainEqual(['assistant', 'full'])
    }
  })
})

describe('status and activity', () => {
  it('shows only the latest status row outside verbose', () => {
    const state = run([
      { type: 'message.start', seq: 1 },
      { type: 'status.update', seq: 2, payload: { kind: 'status', text: 'one' } },
      { type: 'tool.start', seq: 3, payload: { tool_id: 'c1', name: 'grep' } },
      { type: 'status.update', seq: 4, payload: { kind: 'status', text: 'two' } }
    ])

    expect(shown(state).filter(entry => entry[0] === 'status')).toEqual([['status', 'chip']])
    expect(latestStatus(state)?.text).toBe('two')
  })

  it('stands one working row in for the whole tool stream at quiet', () => {
    const state = run([
      { type: 'message.start', seq: 1 },
      { type: 'tool.start', seq: 2, payload: { tool_id: 'c1', name: 'grep' } },
      { type: 'tool.complete', seq: 3, payload: { tool_id: 'c1', name: 'grep' } },
      { type: 'tool.start', seq: 4, payload: { tool_id: 'c2', name: 'read_file' } }
    ])

    expect(shown(state, { level: 'quiet' }).filter(entry => entry[0] === 'tool')).toEqual([
      ['tool', 'hidden-placeholder']
    ])
  })

  it('reports busy while a turn, a tool or a child is running', () => {
    expect(isBusy(fresh())).toBe(false)
    expect(isBusy(run([{ type: 'message.start', seq: 1 }]))).toBe(true)
    expect(isBusy(run(streamedTurn))).toBe(false)
  })
})

describe('subagent views', () => {
  const state = run(delegationEvents)

  it('reports nothing running once the fan-out finished', () => {
    expect(runningSubagents(state)).toHaveLength(0)
  })

  it('reports the children that are still working', () => {
    const midway = run(delegationEvents.slice(0, 14))

    expect(runningSubagents(midway).map(child => child.goal)).toContain('Audit deps')
  })

  it('nests children under the parent that spawned them', () => {
    const nested = run([
      { type: 'subagent.start', seq: 1, payload: { subagent_id: 'p', goal: 'Plan', task_index: 0, task_count: 1 } },
      {
        type: 'subagent.start',
        seq: 2,
        payload: { subagent_id: 'c', parent_id: 'p', goal: 'Do', task_index: 0, task_count: 1 }
      }
    ])
    const tree = subagentTree(nested)

    expect(tree).toHaveLength(1)
    expect(tree[0]?.children.map(child => child.id)).toEqual(['c'])
  })
})

describe('openRequests', () => {
  it('lists only what is still unanswered', () => {
    let state = applyServerRequest(fresh(), approvalRequest, NOW)

    expect(openRequests(state)).toHaveLength(1)

    state = applyEvent(
      state,
      { type: 'request.cancel', seq: 1, payload: { id: 'srq-7', method: 'approval', reason: 'resolved' } },
      NOW
    )

    expect(openRequests(state)).toHaveLength(0)
  })
})

describe('itemsVersion', () => {
  it('changes when the transcript does and holds still when it does not', () => {
    const state = run(dmDispatchTurn)
    const before = itemsVersion(state)

    expect(itemsVersion(state)).toBe(before)
    expect(itemsVersion(applyEvent(state, { type: 'notice', seq: 6, payload: { message: 'hi' } }, NOW))).not.toBe(
      before
    )
  })
})

describe('unreadCountSince', () => {
  const at = (ts: number, text: string) => ({
    type: 'message.complete',
    seq: ts,
    payload: { text, status: 'complete' }
  })

  it('counts replies that landed after the watermark and nothing else', () => {
    const state = run([
      { type: 'message.start', seq: 1, payload: {} },
      at(2, 'First.'),
      { type: 'message.start', seq: 3, payload: {} },
      at(4, 'Second.')
    ])

    // Both bubbles are stamped with the injected NOW, so a watermark before it
    // counts both and one after it counts none.
    expect(unreadCountSince(state, NOW / 1000 - 1)).toBe(2)
    expect(unreadCountSince(state, NOW / 1000 + 1)).toBe(0)
  })

  it('ignores tool rows, notices and the turns the user typed', () => {
    const state = run(streamedTurn)

    expect(unreadCountSince(state, 0)).toBe(1)
  })

  /**
   * Bot-to-bot traffic does not move a badge.
   *
   * The owner's rule: *bot-to-bot must also not bump the notification badge.* A
   * badge answers "is there something here for ME", and two agents working a
   * delivery out between themselves is not. `bot_dm_in` used to count — it is a
   * message, and it is addressed to this bot — so a chat whose whole tail is
   * teammate chatter shouted for a reader who would find nothing to do in it.
   */
  it('counts nothing for a tail that is only bot-to-bot', () => {
    const head = rowsToItems(rpcHistoryRows, 'rpc')
    const history = reconcile(fresh(), head)
    const watermark = lastMessageAt(history)

    expect(unreadCountSince(history, watermark)).toBe(0)

    // Three more teammate messages land, all of them AFTER the watermark.
    const withDms = reconcile(
      history,
      rowsToItems(
        [
          ...rpcHistoryRows,
          { role: 'user', text: dmInbound('Draft two is up.'), timestamp: watermark + 10, row_id: 90 },
          { role: 'user', text: dmInbound('And a title for it.'), timestamp: watermark + 20, row_id: 91 },
          { role: 'user', text: dmInbound('Ignore the last one.'), timestamp: watermark + 30, row_id: 92 }
        ],
        'rpc'
      )
    )

    expect(kindsOf(withDms).filter(kind => kind === 'bot_dm_in')).toHaveLength(4)
    expect(unreadCountSince(withDms, watermark)).toBe(0)

    // And the reply the owner IS owed still counts, so the rule is about the
    // kind rather than about a badge that stopped working at all.
    const answered = run(
      [
        { type: 'message.start', seq: 900, payload: {} },
        { type: 'message.complete', seq: 901, payload: { text: 'Done.', status: 'complete' } }
      ],
      withDms
    )

    // Counted from the beginning rather than from the watermark: the live
    // bubble is stamped with the injected NOW, which is older than the history
    // this fixture ends on.
    expect(unreadCountSince(answered, 0)).toBe(unreadCountSince(withDms, 0) + 1)
  })

  it('leaves the watermark where a real message left it, not where a DM did', () => {
    // `lastMessageAt` shares the predicate, which is what keeps "read" and
    // "unread" from disagreeing about what a message is.
    const state = reconcile(fresh(), rowsToItems(rpcHistoryRows, 'rpc'))

    expect(unreadCountSince(state, lastMessageAt(state))).toBe(0)
  })

  it('caps the badge label rather than widening it', () => {
    expect(unreadBadgeLabel(0)).toBe('')
    expect(unreadBadgeLabel(3)).toBe('3')
    expect(unreadBadgeLabel(99)).toBe('99')
    expect(unreadBadgeLabel(1200)).toBe('99+')
  })
})
