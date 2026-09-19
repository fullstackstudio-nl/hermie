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
  unreadBadgeLabel,
  unreadCountSince,
  type VisibilityOptions,
  visibleItems
} from './selectors'
import { approvalRequest, delegationEvents, dmDispatchTurn, streamedTurn } from './__fixtures__/events'
import { rpcHistoryRows } from './__fixtures__/rows'
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

describe('visibleItems levels', () => {
  const state = reconcile(fresh(), rowsToItems(rpcHistoryRows, 'rpc'))

  it('hides tool cards and notices at quiet, but never the conversation', () => {
    const kinds = shown(state, { level: 'quiet' }).map(entry => entry[0])

    expect(kinds).not.toContain('tool')
    expect(kinds).not.toContain('notice')
    expect(kinds).toContain('user')
    expect(kinds).toContain('assistant')
    expect(kinds).toContain('bot_dm_in')
  })

  it('collapses tool cards and notices at normal', () => {
    expect(shown(state)).toContainEqual(['tool', 'collapsed'])
    expect(shown(state)).toContainEqual(['notice', 'collapsed'])
  })

  it('expands everything at verbose', () => {
    const entries = shown(state, { level: 'verbose' })

    expect(entries).toContainEqual(['tool', 'full'])
    expect(entries).toContainEqual(['notice', 'full'])
    expect(entries).toContainEqual(['bot_dm_out', 'full'])
    expect(entries).toContainEqual(['subagent_group', 'full'])
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

  it('caps the badge label rather than widening it', () => {
    expect(unreadBadgeLabel(0)).toBe('')
    expect(unreadBadgeLabel(3)).toBe('3')
    expect(unreadBadgeLabel(99)).toBe('99')
    expect(unreadBadgeLabel(1200)).toBe('99+')
  })
})
