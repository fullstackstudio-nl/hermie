import { describe, expect, it } from 'vitest'

import {
  answerRequest,
  applyEvent,
  applyProcessCompletion,
  applyResumeSnapshot,
  applyServerRequest,
  applySubagentSnapshot,
  beginLocalTurn,
  confirmSubmit,
  markInterrupted,
  type SubagentSnapshotRow,
  type TranscriptEvent
} from './reducer'
import { latestStatus } from './selectors'
import {
  approvalRequest,
  clarifyRequest,
  delegationEvents,
  dmDispatchTurn,
  erroredTurn,
  streamedTurn
} from './__fixtures__/events'
import { dmReplyProcessText } from './__fixtures__/rows'
import {
  type ApprovalItem,
  type AssistantItem,
  type BotDmOutItem,
  type ChatState,
  type ClarifyItem,
  createChatState,
  type SubagentGroupItem,
  type ToolItem,
  type UserItem
} from './types'

const NOW = 1_700_000_000_000

const fresh = () => createChatState('researcher', 'stored-1', 'resolved-1')

const run = (events: readonly TranscriptEvent[], start: ChatState = fresh(), now = NOW) =>
  events.reduce((state, event) => applyEvent(state, event, now), start)

const list = (state: ChatState) => state.order.map(id => state.items[id]!)

describe('a streamed turn', () => {
  // Nothing was submitted locally, so this stream reads as a foreign turn and
  // opens with the placeholder that `reconcileTail` later fills in.
  const state = run(streamedTurn)
  const items = list(state)
  const assistants = items.filter(item => item.kind === 'assistant') as AssistantItem[]

  it('builds the turn out of the events alone', () => {
    expect(items.map(item => item.kind)).toEqual(['user', 'assistant', 'tool', 'status', 'assistant', 'assistant'])
  })

  it('seals the pre-tool text as mid-turn commentary', () => {
    const interim = assistants[0]!

    expect(interim.text).toBe('Let me look that up.')
    expect(interim.interim).toBe(true)
    expect(interim.streaming).toBe(false)
  })

  it('seals the commentary the gateway previewed between tool and reply', () => {
    expect(assistants[1]).toMatchObject({ text: 'Found it.', interim: true, streaming: false })
  })

  it('keeps reasoning on the bubble that produced it', () => {
    expect(assistants[0]?.reasoning).toBe('Check the changelog first.')
  })

  it('completes the tool with everything the verbose gateway sent', () => {
    const tool = items[2] as ToolItem

    expect(tool).toMatchObject({
      status: 'complete',
      resultKnown: true,
      name: 'read_file',
      argsText: '{"path":"CHANGELOG.md"}',
      resultText: '# 1.2.0',
      summary: 'read 1 file',
      durationS: 0.42
    })
    expect(state.byToolId.call_1).toBe(tool.id)
  })

  it('does not keep an empty inline diff', () => {
    expect((items[2] as ToolItem).inlineDiff).toBeUndefined()
  })

  it('settles the final bubble and the turn', () => {
    const final = assistants.at(-1)!

    expect(final).toMatchObject({ text: 'Version 1.2.0 ships three fixes.', streaming: false, status: 'complete' })
    expect(state.turn.active).toBe(false)
    expect(state.usage).toMatchObject({ total: 168 })
  })

  it('clears the drafting-tool label once the call really starts', () => {
    expect(state.turn.draftingTool).toBeUndefined()
  })

  it('tracks the highest applied seq', () => {
    expect(state.lastSeq).toBe(12)
  })
})

describe('replay', () => {
  it('ignores an event at or below the last applied seq', () => {
    const state = run(streamedTurn)
    const replayed = applyEvent(state, { type: 'message.delta', seq: 4, payload: { text: 'again' } }, NOW)

    expect(replayed).toBe(state)
  })

  it('applies the whole stream twice to the same result', () => {
    const once = run(streamedTurn)
    const twice = run(streamedTurn, once)

    expect(list(twice).map(item => item.kind)).toEqual(list(once).map(item => item.kind))
    expect((list(twice).at(-1) as AssistantItem).text).toBe('Version 1.2.0 ships three fixes.')
  })

  it('still applies events that carry no seq at all', () => {
    const state = applyEvent(fresh(), { type: 'message.delta', payload: { text: 'hi' } }, NOW)

    expect((list(state)[0] as AssistantItem).text).toBe('hi')
  })
})

describe('a failed turn', () => {
  const state = run(erroredTurn)
  const assistant = list(state).find(item => item.kind === 'assistant') as AssistantItem

  it('keeps the partial text and records the failure', () => {
    expect(assistant.text).toBe('Starting…')
    expect(assistant.status).toBe('error')
    expect(assistant.error).toMatchObject({
      message: 'Provider returned 429 after 3 retries',
      partial: true,
      recoverable: true
    })
  })

  it('names the failing layer when the gateway classified it', () => {
    expect(assistant.error?.surface).toMatchObject({ layer: 'provider', code: 'rate_limited' })
  })

  it('ends the turn', () => {
    expect(state.turn.active).toBe(false)
  })
})

describe('the standalone error event', () => {
  it('fails the open bubble and cancels the open request', () => {
    let state = run([
      { type: 'message.start', seq: 1 },
      { type: 'message.delta', seq: 2, payload: { text: 'hm' } }
    ])

    state = applyServerRequest(state, approvalRequest, NOW)
    state = applyEvent(state, { type: 'error', seq: 3, payload: { message: 'agent init failed' } }, NOW)

    const assistant = list(state).find(item => item.kind === 'assistant') as AssistantItem
    const approval = list(state).find(item => item.kind === 'approval') as ApprovalItem

    expect(assistant.error?.message).toBe('agent init failed')
    expect(approval.state).toBe('cancelled')
    expect(approval.cancelReason).toBe('turn_failed')
  })
})

describe('interruption', () => {
  it('stops the turn and keeps what was already said', () => {
    let state = run([
      { type: 'message.start', seq: 1 },
      { type: 'message.delta', seq: 2, payload: { text: 'half a ' } }
    ])

    state = markInterrupted(state, NOW + 2000)

    const assistant = list(state).find(item => item.kind === 'assistant') as AssistantItem

    expect(assistant).toMatchObject({ text: 'half a ', status: 'interrupted', streaming: false })
    expect(assistant.durationS).toBe(2)
    expect(state.turn.active).toBe(false)
  })

  it('reports the interrupted verdict even when the gateway says complete', () => {
    let state = run([
      { type: 'message.start', seq: 1 },
      { type: 'message.delta', seq: 2, payload: { text: 'x' } }
    ])

    state = markInterrupted(state, NOW)
    state = applyEvent(state, { type: 'message.complete', seq: 3, payload: { text: 'x', status: 'complete' } }, NOW)

    expect((list(state).find(item => item.kind === 'assistant') as AssistantItem).status).toBe('interrupted')
  })
})

describe('response_previewed', () => {
  it('does not duplicate a reply that already streamed as interim', () => {
    const state = run([
      { type: 'message.start', seq: 1 },
      { type: 'message.delta', seq: 2, payload: { text: 'the answer' } },
      { type: 'message.interim', seq: 3, payload: { text: 'the answer' } },
      { type: 'message.complete', seq: 4, payload: { text: 'the answer', response_previewed: true } }
    ])

    const assistants = list(state).filter(item => item.kind === 'assistant') as AssistantItem[]

    expect(assistants).toHaveLength(1)
    expect(assistants[0]).toMatchObject({ text: 'the answer', interim: false, status: 'complete' })
  })
})

describe('a completion that follows a tool call', () => {
  // The tool boundary seals the streaming bubble, so the completion arrives
  // with nothing live to settle onto. Painting it fresh renders the reply
  // twice while the gateway stored one row (upstream #63679).
  const toolTurn = (final: string) =>
    [
      { type: 'message.start', seq: 1 },
      { type: 'message.delta', seq: 2, payload: { text: 'Looking that up for you.' } },
      { type: 'tool.start', seq: 3, payload: { tool_id: 't1', name: 'read_file', args: { path: 'README.md' } } },
      {
        type: 'tool.complete',
        seq: 4,
        payload: { tool_id: 't1', name: 'read_file', args: {}, duration_s: 0.2, result: '# Hermie' }
      },
      { type: 'message.complete', seq: 5, payload: { text: final, status: 'ok' } }
    ] as TranscriptEvent[]

  it('settles an identical final onto the sealed bubble instead of repeating it', () => {
    const state = run(toolTurn('Looking that up for you.'))
    const assistants = list(state).filter(item => item.kind === 'assistant') as AssistantItem[]

    expect(assistants).toHaveLength(1)
    expect(assistants[0]).toMatchObject({
      text: 'Looking that up for you.',
      interim: false,
      streaming: false,
      status: 'complete'
    })
  })

  it('settles a final that extends what was streamed', () => {
    const state = run(toolTurn('Looking that up for you. It is in the README.'))
    const assistants = list(state).filter(item => item.kind === 'assistant') as AssistantItem[]

    expect(assistants).toHaveLength(1)
    expect(assistants[0]?.text).toBe('Looking that up for you. It is in the README.')
  })

  it('still opens a new bubble for a final that is a different reply', () => {
    const state = run(toolTurn('The README says Hermie is a client for Hermes Agent.'))
    const assistants = list(state).filter(item => item.kind === 'assistant') as AssistantItem[]

    expect(assistants).toHaveLength(2)
    expect(assistants[0]).toMatchObject({ text: 'Looking that up for you.', interim: true })
    expect(assistants[1]?.text).toBe('The README says Hermie is a client for Hermes Agent.')
  })
})

describe('a foreign turn', () => {
  it('stands a placeholder in for the author we have not seen yet', () => {
    const state = applyEvent(fresh(), { type: 'message.start', seq: 1 }, NOW)
    const placeholder = list(state)[0] as UserItem

    expect(placeholder).toMatchObject({ kind: 'user', unknownAuthor: true, origin: 'foreign', text: '' })
    expect(state.turn.foreignReconcilePending).toBe(true)
  })

  it('does not place one for a turn we submitted ourselves', () => {
    let state = beginLocalTurn(fresh(), 'hello', undefined, NOW)

    state = applyEvent(state, { type: 'message.start', seq: 1 }, NOW)

    expect(list(state).filter(item => item.kind === 'user')).toHaveLength(1)
    expect(state.turn.foreignReconcilePending).toBeUndefined()
  })
})

describe('local submits', () => {
  it('paints the message optimistically and settles it on accept', () => {
    let state = beginLocalTurn(fresh(), 'ship it', ['@image:/tmp/a.png'], NOW)

    expect(list(state)[0]).toMatchObject({ kind: 'user', pending: true, origin: 'optimistic' })
    expect(state.draft).toBe('')

    state = confirmSubmit(state, { status: 'streaming' }, NOW)

    expect((list(state)[0] as UserItem).pending).toBe(false)
  })

  it('remembers a prompt the backend parked behind the running turn', () => {
    let state = beginLocalTurn(fresh(), 'and then deploy', undefined, NOW)

    state = confirmSubmit(state, { status: 'queued' }, NOW)

    expect(state.queued).toEqual({ text: 'and then deploy', local: true })
    expect((list(state)[0] as UserItem).pending).toBe(true)
  })

  it('keeps the turn ours while our own queued prompt waits for it', () => {
    let state = beginLocalTurn(fresh(), 'first', undefined, NOW)

    state = confirmSubmit(state, { status: 'streaming' }, NOW)
    state = beginLocalTurn(state, 'and then deploy', undefined, NOW)
    state = confirmSubmit(state, { status: 'queued' }, NOW)
    // The running turn ends and the gateway starts the one it parked.
    state = applyEvent(state, { type: 'message.complete', seq: 1, payload: { text: 'done' } }, NOW)

    expect(state.turn.local).toBe(true)
    expect(state.queued).toBeUndefined()

    state = applyEvent(state, { type: 'message.start', seq: 2 }, NOW)

    expect(list(state).filter(item => item.kind === 'user' && item.unknownAuthor)).toHaveLength(0)
    expect(state.turn.foreignReconcilePending).toBeUndefined()
  })

  it('still calls the next turn foreign when another surface parked the prompt', () => {
    let state = applyResumeSnapshot(fresh(), { queued: { user: 'from another surface' }, running: true }, NOW)

    state = applyEvent(state, { type: 'message.complete', seq: 1, payload: { text: 'done' } }, NOW)

    expect(state.turn.local).toBe(false)

    state = applyEvent(state, { type: 'message.start', seq: 2 }, NOW)

    expect(list(state).filter(item => item.kind === 'user' && item.unknownAuthor)).toHaveLength(1)
  })

  it('marks a steer as one', () => {
    let state = beginLocalTurn(fresh(), 'shorter please', undefined, NOW)

    state = confirmSubmit(state, { status: 'steered' }, NOW)

    expect((list(state)[0] as UserItem).displayKind).toBe('steer')
  })
})

describe('bot-to-bot dispatch', () => {
  const state = run(dmDispatchTurn)
  const dispatch = list(state).find(item => item.kind === 'bot_dm_out') as BotDmOutItem

  it('reads the fire-and-forget ack', () => {
    expect(dispatch).toMatchObject({
      targetHandle: 'writer',
      message: 'Can you draft the announcement?',
      dispatch: { status: 'queued', deliveryId: 'dm-2f9c', processId: 'proc-2f9c', to: '@writer' }
    })
  })

  it('indexes the delivery process so the reply can find it later', () => {
    expect(state.byProcessId['proc-2f9c']).toBe(dispatch.id)
  })

  it('joins the reply that arrives as a background completion', () => {
    const joined = applyProcessCompletion(state, dmReplyProcessText, NOW)
    const answered = joined.items[dispatch.id] as BotDmOutItem

    expect(answered.reply?.text).toBe('Draft is ready, I pushed it to the shared folder.')
  })

  it('marks the dispatch failed when the delivery reports one', () => {
    const failure = [
      '[IMPORTANT: Background process proc-2f9c completed (exit code 1).',
      'Command: python3 tools/bot_mode_dm.py --run-delivery query-file /tmp/x.json hermes -p writer chat',
      'Output:',
      '{"error": "Bot Chat is open on another surface", "reason": "target_busy"}]'
    ].join('\n')
    const joined = applyProcessCompletion(state, failure, NOW)
    const answered = joined.items[dispatch.id] as BotDmOutItem

    expect(answered.dispatch.status).toBe('failed')
    expect(answered.reply?.reason).toBe('target_busy')
  })
})

describe('delegation', () => {
  const state = run(delegationEvents)
  const group = list(state).find(item => item.kind === 'subagent_group') as SubagentGroupItem

  it('groups all three children under the delegate_task call', () => {
    expect(group.rootIds).toEqual(['child-0', 'child-1', 'child-2'])
    expect(group.delegationId).toBe('del-9')
    expect(state.byDelegationId['del-9']).toBe(group.id)
  })

  it('creates exactly one group', () => {
    expect(list(state).filter(item => item.kind === 'subagent_group')).toHaveLength(1)
  })

  it('closes the group when every child is done', () => {
    expect(group.status).toBe('done')
    expect(group.completion).toBe('3 tasks completed')
  })

  it('projects each child with its observability rollup', () => {
    expect(state.subagents['child-1']).toMatchObject({
      goal: 'Write tests',
      status: 'completed',
      childSessionId: 'sub-1',
      model: 'example-small-model',
      taskIndex: 1,
      taskCount: 3,
      durationSeconds: 12.5,
      toolCount: 4,
      summary: 'task 1 done',
      filesRead: ['package.json']
    })
  })

  it('keeps a readable activity stream per child', () => {
    expect(state.subagents['child-0']?.stream.map(entry => entry.kind)).toEqual(['progress', 'tool', 'summary'])
    expect(state.subagents['child-0']?.stream[1]?.text).toBe('Read File("package.json")')
  })

  it('will not resurrect a child that already finished', () => {
    const late = applyEvent(
      state,
      {
        type: 'subagent.progress',
        seq: 99,
        payload: { subagent_id: 'child-0', goal: 'Audit deps', task_index: 0, task_count: 3, text: 'late' }
      },
      NOW
    )

    expect(late.subagents['child-0']?.status).toBe('completed')
  })

  it('fails closed when a complete frame carries no usable status', () => {
    const state2 = run([
      { type: 'subagent.start', seq: 1, payload: { subagent_id: 'c', goal: 'g', task_index: 0, task_count: 1 } },
      { type: 'subagent.complete', seq: 2, payload: { subagent_id: 'c', goal: 'g', task_index: 0, task_count: 1 } }
    ])

    expect(state2.subagents.c?.status).toBe('failed')
    expect((list(state2)[0] as SubagentGroupItem).status).toBe('failed')
  })

  it('opens a group for a child that arrives without a delegation id', () => {
    const state2 = run([
      {
        type: 'subagent.start',
        seq: 1,
        payload: { subagent_id: 'solo', goal: 'Do a thing', task_index: 0, task_count: 1 }
      }
    ])

    expect((list(state2)[0] as SubagentGroupItem).goals).toEqual(['Do a thing'])
  })
})

describe('status rows and todos', () => {
  it('keeps one status row at the tail rather than a stack of them', () => {
    const state = run([
      { type: 'status.update', seq: 1, payload: { kind: 'status', text: 'Thinking' } },
      { type: 'status.update', seq: 2, payload: { kind: 'status', text: 'Reading files' } }
    ])

    expect(list(state)).toHaveLength(1)
    expect(latestStatus(state)?.text).toBe('Reading files')
  })

  it('tracks the compaction flag', () => {
    let state = applyEvent(fresh(), { type: 'status.update', seq: 1, payload: { kind: 'compacting', text: 'x' } }, NOW)

    expect(state.compacting).toBe(true)

    state = applyEvent(state, { type: 'status.update', seq: 2, payload: { kind: 'compacted', text: 'y' } }, NOW)

    expect(state.compacting).toBe(false)
  })

  it('stores the authoritative todo snapshot', () => {
    const state = applyEvent(
      fresh(),
      { type: 'todo.updated', seq: 1, payload: { todos: [{ content: 'ship', status: 'pending' }], revision: 4 } },
      NOW
    )

    expect(state.todo).toEqual({ todos: [{ content: 'ship', status: 'pending' }], revision: 4 })
  })

  it('flags risky tool output on the call it belongs to', () => {
    const state = run([
      { type: 'tool.start', seq: 1, payload: { tool_id: 'c1', name: 'fetch_url' } },
      {
        type: 'tool.output_risk',
        seq: 2,
        payload: {
          tool_id: 'c1',
          name: 'fetch_url',
          risk: 'prompt_injection',
          findings: ['ignore previous'],
          redacted: true
        }
      }
    ])

    expect((list(state)[0] as ToolItem).outputRisk).toEqual({
      risk: 'prompt_injection',
      findings: ['ignore previous'],
      redacted: true
    })
  })

  it('materialises a tool whose start was missed rather than dropping its result', () => {
    const state = applyEvent(
      fresh(),
      { type: 'tool.complete', seq: 1, payload: { tool_id: 'lost', name: 'grep', summary: 'no matches' } },
      NOW
    )

    expect(list(state)[0]).toMatchObject({ kind: 'tool', toolId: 'lost', status: 'complete', summary: 'no matches' })
  })
})

describe('session-level events', () => {
  it('stores session info and lets running=false end the turn', () => {
    let state = applyEvent(fresh(), { type: 'message.start', seq: 1 }, NOW)

    state = applyEvent(
      state,
      {
        type: 'session.info',
        seq: 2,
        payload: { model: 'example-large-model', running: false, stored_session_id: 'stored-9' }
      },
      NOW
    )

    expect(state.info?.model).toBe('example-large-model')
    expect(state.storedSessionId).toBe('stored-9')
    expect(state.turn.active).toBe(false)
  })

  it('treats a title other than Bot Chat as drift', () => {
    const state = applyEvent(fresh(), { type: 'session.title', seq: 1, payload: { title: 'Release chores' } }, NOW)

    expect(state.hydration).toBe('stale')
  })

  it('leaves the canonical title alone', () => {
    const state = applyEvent(fresh(), { type: 'session.title', seq: 1, payload: { title: 'Bot Chat' } }, NOW)

    expect(state.hydration).toBe('cold')
  })

  it('keeps the transcript when the gateway reclaims the session', () => {
    let state = run(streamedTurn)

    state = { ...state, runtimeSessionId: 'run-1' }
    state = applyEvent(
      state,
      { type: 'session.reclaimed', seq: 13, payload: { reason: 'another client attached' } },
      NOW
    )

    expect(state.runtimeSessionId).toBeUndefined()
    expect(list(state).at(-1)).toMatchObject({ kind: 'notice', noticeKind: 'reclaimed' })
    expect(list(state).length).toBeGreaterThan(1)
  })

  it('records a mid-turn usage tick', () => {
    const state = applyEvent(fresh(), { type: 'session.usage', seq: 1, payload: { usage: { total: 42 } } }, NOW)

    expect(state.usage).toEqual({ total: 42 })
  })

  it('surfaces a gateway notice', () => {
    const state = applyEvent(fresh(), { type: 'notice', seq: 1, payload: { message: 'capabilities refreshed' } }, NOW)

    expect(list(state)[0]).toMatchObject({ kind: 'notice', noticeKind: 'notice', title: 'capabilities refreshed' })
  })

  it('surfaces a side-question answer', () => {
    const state = applyEvent(
      fresh(),
      {
        type: 'btw.complete',
        seq: 1,
        payload: { task_id: 't1', question: 'who owns this?', text: 'the platform team' }
      },
      NOW
    )

    expect(list(state)[0]).toMatchObject({
      kind: 'notice',
      title: 'Side question: who owns this?',
      body: 'the platform team'
    })
  })

  it('paints a reaction on the row it addresses', () => {
    let state = run(streamedTurn)
    const assistantId = state.order[1]!

    state = {
      ...state,
      items: { ...state.items, [assistantId]: { ...state.items[assistantId]!, rowId: 55 } },
      byRowId: { '55': assistantId }
    }
    state = applyEvent(
      state,
      { type: 'message.reaction', seq: 13, payload: { row_id: 55, reactions: [{ emoji: '🎉' }], role: 'assistant' } },
      NOW
    )

    expect(state.items[assistantId]?.reactions).toEqual([{ emoji: '🎉' }])
  })

  it('ignores an event type it does not model', () => {
    const state = applyEvent(fresh(), { type: 'pet.changed', seq: 1, payload: {} }, NOW)

    expect(state.order).toEqual([])
    expect(state.lastSeq).toBe(1)
  })
})

describe('server requests', () => {
  it('turns an approval request into an answerable item', () => {
    let state = applyServerRequest(fresh(), approvalRequest, NOW)
    const approval = list(state)[0] as ApprovalItem

    expect(approval).toMatchObject({
      kind: 'approval',
      requestId: 'srq-7',
      approvalId: 'apr-3',
      command: 'rm -rf build',
      toolName: 'terminal',
      choices: ['once', 'session', 'always', 'deny'],
      state: 'open'
    })

    state = answerRequest(state, 'srq-7', 'deny')

    expect(list(state)[0] as ApprovalItem).toMatchObject({ state: 'answered', answer: 'deny' })
  })

  it('ignores a redelivered request it already shows', () => {
    const once = applyServerRequest(fresh(), approvalRequest, NOW)

    expect(applyServerRequest(once, { ...approvalRequest, replayed: true }, NOW)).toBe(once)
  })

  it('withdraws a request the backend cancels', () => {
    let state = applyServerRequest(fresh(), approvalRequest, NOW)

    state = applyEvent(
      state,
      { type: 'request.cancel', seq: 1, payload: { id: 'srq-7', method: 'approval', reason: 'resolved' } },
      NOW
    )

    expect(list(state)[0]).toMatchObject({ state: 'cancelled', cancelReason: 'resolved' })
  })

  it('shows one card for a queue entry that arrives under a second transport id', () => {
    const live = applyServerRequest(fresh(), approvalRequest, NOW)
    // What `approval.pending` and a resume snapshot synthesize for the same
    // queue entry: a different request id, the same `request_id`.
    const polled = applyServerRequest(
      live,
      {
        id: 'pending:apr-3',
        method: 'approval',
        params: { request_id: 'apr-3', command: 'rm -rf build' },
        replayed: true
      },
      NOW
    )

    expect(polled).toBe(live)
    expect(list(polled).filter(item => item.kind === 'approval')).toHaveLength(1)
  })

  it('lets a new question reuse the queue id of one already answered', () => {
    let state = applyServerRequest(fresh(), approvalRequest, NOW)

    state = answerRequest(state, 'srq-7', 'once')
    state = applyServerRequest(
      state,
      { id: 'srq-77', method: 'approval', params: { request_id: 'apr-3', command: 'rm -rf dist' } },
      NOW
    )

    expect(list(state).filter(item => item.kind === 'approval')).toHaveLength(2)
  })

  it('withdraws a cancel addressed to the approval queue id rather than the request id', () => {
    let state = applyServerRequest(fresh(), approvalRequest, NOW)

    state = applyEvent(
      state,
      { type: 'request.cancel', seq: 1, payload: { id: 'apr-3', method: 'approval', reason: 'timeout' } },
      NOW
    )

    expect(list(state)[0]).toMatchObject({ state: 'cancelled', cancelReason: 'timeout' })
  })

  it('marks a clarify built from a questions array as a batch', () => {
    const batch = applyServerRequest(fresh(), clarifyRequest, NOW)
    const single = applyServerRequest(
      fresh(),
      { id: 'srq-9', method: 'clarify', params: { request_id: 'c1', question: 'Which branch?' } },
      NOW
    )

    expect((list(batch)[0] as ClarifyItem).batch).toBe(true)
    expect((list(single)[0] as ClarifyItem).batch).toBeUndefined()
  })

  it('builds a batch clarify and locks each answer as it lands', () => {
    let state = applyServerRequest(fresh(), clarifyRequest, NOW)

    expect((list(state)[0] as ClarifyItem).questions).toHaveLength(2)

    state = answerRequest(state, 'srq-8', { q1: 'staging' })

    expect(list(state)[0]).toMatchObject({ state: 'open', answers: { q1: 'staging' }, locked: ['q1'] })

    state = answerRequest(state, 'srq-8', { q2: 'yes' })

    expect((list(state)[0] as ClarifyItem).state).toBe('answered')
  })

  it('builds a single-question clarify from the flat params', () => {
    const state = applyServerRequest(
      fresh(),
      { id: 'srq-9', method: 'clarify', params: { request_id: 'c1', question: 'Which branch?', choices: ['main'] } },
      NOW
    )

    expect((list(state)[0] as ClarifyItem).questions[0]).toEqual({
      qid: 'c1',
      question: 'Which branch?',
      choices: ['main'],
      multiSelect: false
    })
  })

  it('cancels whatever is still open when the turn ends', () => {
    let state = applyServerRequest(run([{ type: 'message.start', seq: 1 }]), clarifyRequest, NOW)

    state = applyEvent(state, { type: 'message.complete', seq: 2, payload: { text: 'done', status: 'complete' } }, NOW)

    expect(list(state).find(item => item.kind === 'clarify')).toMatchObject({ state: 'cancelled' })
  })
})

describe('resume snapshots', () => {
  const state = applyResumeSnapshot(
    fresh(),
    {
      running: true,
      inflight: { user: 'deploy staging', assistant: 'Deploying…', streaming: true },
      queued: { user: 'then run the smoke tests' },
      todo_state: { todos: [{ content: 'deploy' }], revision: 2 },
      pending_approval: {
        request_id: 'apr-9',
        command: 'kubectl apply -f .',
        description: 'Apply the manifests',
        choices: ['once', 'deny'],
        allow_permanent: false
      },
      open_requests: [{ id: 'srq-4', method: 'clarify', params: { question: 'Which cluster?' } }]
    },
    NOW
  )

  it('rebuilds the in-flight bubbles', () => {
    expect(
      list(state)
        .slice(0, 2)
        .map(item => item.kind)
    ).toEqual(['user', 'assistant'])
    expect(list(state)[0]?.origin).toBe('inflight')
    expect(state.turn.assistantId).toBe(list(state)[1]?.id)
    expect(state.turn.active).toBe(true)
  })

  it('rebuilds the parked prompt and the todo list', () => {
    expect(state.queued).toEqual({ text: 'then run the smoke tests' })
    expect(state.queued?.local).toBeUndefined()
    expect(state.todo?.revision).toBe(2)
  })

  it('synthesizes the approval card the queue is still holding', () => {
    const approval = list(state).find(item => item.kind === 'approval') as ApprovalItem

    expect(approval).toMatchObject({
      requestId: 'pending:apr-9',
      command: 'kubectl apply -f .',
      choices: ['once', 'deny'],
      allowPermanent: false,
      state: 'open'
    })
  })

  it('re-delivers the open requests', () => {
    expect(state.byRequestId['srq-4']).toBeDefined()
  })

  it('rebuilds a retained failed turn as a failure', () => {
    const failed = applyResumeSnapshot(
      fresh(),
      { inflight: { user: 'do it', assistant: 'partial', error: 'provider down', recoverable: true } },
      NOW
    )
    const assistant = list(failed).find(item => item.kind === 'assistant') as AssistantItem

    expect(assistant.error).toMatchObject({ message: 'provider down', partial: true, recoverable: true })
  })
})

describe('applySubagentSnapshot', () => {
  const row = (over: Partial<SubagentSnapshotRow> = {}): SubagentSnapshotRow => ({
    subagent_id: 'child-9',
    parent_id: null,
    depth: 1,
    goal: 'Audit deps',
    delegation_id: 'del-9',
    model: 'p/m',
    started_at: 1_699_999_000,
    status: 'running',
    tool_count: 2,
    last_tool: 'read_file',
    accepting_steer: true,
    child_session_id: 'child-session-9',
    ...over
  })

  it('creates a child the event stream never announced', () => {
    // The case this exists for: a chat opened halfway through a delegation.
    // There is no replay for `subagent.*`, so the roster is all there is.
    const state = applySubagentSnapshot(fresh(), [row()], NOW)
    const child = state.subagents['child-9']

    expect(child).toMatchObject({
      goal: 'Audit deps',
      status: 'running',
      delegationId: 'del-9',
      childSessionId: 'child-session-9',
      acceptingSteer: true
    })
    expect(Object.values(state.items).some(item => item.kind === 'subagent_group')).toBe(true)
  })

  it('refreshes a child the stream already created without resetting its clock', () => {
    const streamed = run(delegationEvents.filter(event => event.type !== 'subagent.complete'))
    const before = streamed.subagents['child-0']
    const after = applySubagentSnapshot(streamed, [row({ subagent_id: 'child-0', last_tool: 'grep' })], NOW + 60_000)

    expect(after.subagents['child-0']?.startedAt).toBe(before?.startedAt)
    expect(after.subagents['child-0']?.currentTool).toBe('grep')
  })

  it('never resurrects a child the stream saw finish', () => {
    const streamed = run(delegationEvents)
    const finished = Object.values(streamed.subagents).find(child => child.status === 'completed')

    expect(finished).toBeDefined()

    const after = applySubagentSnapshot(streamed, [row({ subagent_id: finished!.id, status: 'running' })], NOW)

    expect(after.subagents[finished!.id]?.status).toBe('completed')
  })

  it('is a no-op for an empty roster, so a poll does not churn the state', () => {
    const state = run(delegationEvents)

    expect(applySubagentSnapshot(state, [], NOW)).toBe(state)
  })
})
