import { BotsController } from '../src/features/bots/bots-controller'
import { ChatController } from '../src/features/chats/chat-controller'
import { MemoryChatCache } from '../src/platform/chat-cache'
import { botFromProfileRow, useBotsStore } from '../src/store/bots'
import { useChatsStore } from '../src/store/chats'
import { FakeChatGateway } from './support/fake-chat-gateway'

const RESEARCHER = botFromProfileRow({
  name: 'researcher',
  path: '/root/.hermes/profiles/researcher',
  display_name: 'Researcher',
  canonical_session: {
    id: 'stored-researcher',
    resolved_id: 'tip-researcher',
    title: 'Bot Chat',
    last_active: 1_700_000_100,
    message_count: 2
  }
})

const HISTORY = [
  { role: 'user', text: 'Introduce yourself.', row_id: 1, timestamp: 1_700_000_000 },
  { role: 'assistant', text: 'I am researcher.', row_id: 2, timestamp: 1_700_000_001 }
]

const started: ChatController[] = []

function setup(options: { cache?: MemoryChatCache | null } = {}) {
  const gateway = new FakeChatGateway()
  const cache = options.cache === undefined ? new MemoryChatCache() : options.cache
  const botsController = new BotsController({ gateway, store: useBotsStore, cache })
  const controller = new ChatController({
    gateway,
    chats: useChatsStore,
    bots: useBotsStore,
    botsController,
    cache
  })

  gateway
    .reply('session.resume', {
      session_id: 'runtime-1',
      stored_session_id: 'tip-researcher',
      message_count: 2,
      messages: [],
      messages_omitted: true,
      info: { desktop_contract: 7 },
      open_requests: []
    })
    .reply('session.history', { count: HISTORY.length, messages: HISTORY })
    .reply('session.events.since', {
      events: [],
      latest_seq: 7,
      truncated: false,
      count: 0,
      epoch: 'e1',
      open_requests: []
    })
    .reply('profiles.list', { profiles: [] })
    .reply('approval.received', { acknowledged: true })
    .reply('approval.pending', { approvals: [] })

  useBotsStore.getState().setBots([RESEARCHER])
  gateway.restMessages = null
  started.push(controller)

  return { gateway, cache, controller, botsController }
}

beforeEach(() => {
  useChatsStore.getState().reset()
  useBotsStore.getState().reset()
})

afterEach(() => {
  // The controller owns two timers (the sessions.changed debounce and the
  // approval poll); a test that leaves one running holds the whole run open.
  for (const controller of started.splice(0)) {
    controller.stop()
  }
})

const chatOf = (name = 'researcher') => useChatsStore.getState().chats[name]!

describe('opening a chat', () => {
  it('resumes, reads history, folds in the snapshot and only then replays', async () => {
    const { gateway, controller } = setup()

    await controller.openChat(RESEARCHER)

    // The roster read comes last on purpose: a chat opened halfway through a
    // delegation has to learn about children the event stream never replayed.
    expect(gateway.methodOrder()).toEqual([
      'session.resume',
      'session.history',
      'session.events.since',
      'subagent.list'
    ])
    expect(gateway.lastCall('session.resume')).toMatchObject({
      session_id: 'stored-researcher',
      profile: 'researcher',
      omit_messages: true,
      source: 'hermie'
    })
    expect(chatOf().hydration).toBe('live')
    expect(chatOf().order).toHaveLength(2)
  })

  it('resumes on the durable id and binds the runtime id events arrive under', async () => {
    const { controller } = setup()

    await controller.openChat(RESEARCHER)

    expect(chatOf().storedSessionId).toBe('stored-researcher')
    expect(chatOf().runtimeSessionId).toBe('runtime-1')
    expect(useChatsStore.getState().runtimeToBot).toEqual({ 'runtime-1': 'researcher' })
  })

  it('refuses a gateway whose desktop contract is too old', async () => {
    const { gateway, controller } = setup()

    gateway.reply('session.resume', {
      session_id: 'runtime-1',
      message_count: 0,
      messages: [],
      info: { desktop_contract: 5 }
    })

    await expect(controller.openChat(RESEARCHER)).rejects.toThrow(/desktop contract 5/)
  })

  it('reads the REST transcript instead of a full history when the chat is long', async () => {
    const { gateway, controller } = setup()

    gateway.restMessages = HISTORY
    gateway.reply('session.resume', {
      session_id: 'runtime-1',
      stored_session_id: 'tip-researcher',
      message_count: 900,
      messages: [],
      info: { desktop_contract: 7 }
    })

    await controller.openChat(RESEARCHER)

    expect(gateway.restCalls[0]).toEqual({ sessionId: 'tip-researcher', limit: 200, order: 'latest' })
    expect(gateway.methodOrder()).not.toContain('session.history')
  })

  it('paints the cached transcript before the gateway answers', async () => {
    const cache = new MemoryChatCache()

    await cache.write({
      bot: 'researcher',
      itemsJson: JSON.stringify({
        format: 1,
        items: [{ id: 'c1', kind: 'user', text: 'from the cache', seq: 0, version: 0, origin: 'history', rowId: 1 }],
        subagents: [],
        lastSeq: 0,
        updatedAt: 1
      }),
      lastRowId: 1,
      lastSeq: 0,
      epoch: null,
      updatedAt: 1
    })

    const { gateway, controller } = setup({ cache })
    const paints: string[] = []

    gateway.reply('session.history', () => {
      paints.push(chatOf().hydration)

      return { count: 0, messages: [] }
    })

    await controller.openChat(RESEARCHER)

    // The cached item was on screen while the gateway was still being asked,
    // and reconciliation kept its id rather than remounting the thread.
    expect(paints).toEqual(['hydrating'])
    expect(chatOf().items.c1).toBeDefined()
  })

  it('opens once when two taps land together', async () => {
    const { gateway, controller } = setup()

    await Promise.all([controller.openChat(RESEARCHER), controller.openChat(RESEARCHER)])

    expect(gateway.calls.filter(call => call.method === 'session.resume')).toHaveLength(1)
  })

  it('adopts the replay watermark on a cold open without re-applying the events', async () => {
    const { gateway, controller } = setup()

    gateway.reply('session.events.since', {
      events: [{ type: 'message.delta', session_id: 'runtime-1', seq: 6, payload: { text: 'replayed' } }],
      latest_seq: 7,
      truncated: false,
      count: 1,
      epoch: 'e1',
      open_requests: []
    })

    await controller.openChat(RESEARCHER)

    expect(chatOf().lastSeq).toBe(7)
    expect(JSON.stringify(chatOf().items)).not.toContain('replayed')
  })
})

describe('routing live traffic', () => {
  it('sends an event to the chat that owns its runtime session and nowhere else', async () => {
    const { gateway, controller } = setup()

    controller.start()
    await controller.openChat(RESEARCHER)

    gateway.emit({ type: 'message.delta', session_id: 'runtime-1', seq: 8, payload: { text: 'streamed' } })
    gateway.emit({ type: 'message.delta', session_id: 'runtime-unknown', seq: 9, payload: { text: 'nobody' } })

    expect(JSON.stringify(chatOf().items)).toContain('streamed')
    expect(JSON.stringify(chatOf().items)).not.toContain('nobody')
  })

  it('drops the runtime id and marks the chat stale when the session is reclaimed', async () => {
    const { gateway, controller } = setup()

    controller.start()
    await controller.openChat(RESEARCHER)

    gateway.emit({ type: 'session.reclaimed', session_id: 'runtime-1', seq: 9, payload: { reason: 'taken over' } })

    expect(chatOf().runtimeSessionId).toBeUndefined()
    expect(chatOf().hydration).toBe('stale')
    expect(useChatsStore.getState().runtimeToBot).toEqual({})
  })
})

describe('a foreign turn', () => {
  it('stands a placeholder in and fills it from a tail fetch', async () => {
    const { gateway, controller } = setup()

    controller.start()
    await controller.openChat(RESEARCHER)

    gateway.restMessages = [
      ...HISTORY,
      { role: 'user', text: 'Message from 🤖 Writer (@writer): the draft is ready.', row_id: 3 },
      { role: 'assistant', text: 'Noted.', row_id: 4 }
    ]

    // Nobody submitted locally, so this turn belongs to somebody else.
    gateway.emit({ type: 'message.start', session_id: 'runtime-1', seq: 10, payload: {} })

    const placeholder = chatOf()
      .order.map(id => chatOf().items[id])
      .find(item => item?.kind === 'user' && item.unknownAuthor)

    expect(placeholder).toBeDefined()
    expect(chatOf().turn.foreignReconcilePending).toBe(true)

    gateway.emit({ type: 'message.complete', session_id: 'runtime-1', seq: 11, payload: { text: 'Noted.' } })
    await flush()

    const kinds = chatOf().order.map(id => chatOf().items[id]?.kind)

    expect(kinds).toContain('bot_dm_in')
    expect(
      chatOf()
        .order.map(id => chatOf().items[id])
        .some(item => item?.kind === 'user' && item.unknownAuthor)
    ).toBe(false)
  })

  /**
   * The owner's report: a message he sent on his phone was not in the chat on
   * his Mac.
   *
   * `message.start` carries no author, so the second device stands an empty
   * `unknownAuthor` bubble in and waits to be told who spoke — and nothing on
   * the socket ever tells it, because the deltas that follow are the REPLY. The
   * only frame that used to fill the placeholder was `message.complete`, and the
   * sweep that could have filled it earlier skipped every chat that was mid-turn.
   * So for the whole of a turn the other device's message was not in the
   * transcript, and an empty placeholder draws nothing (`selectors.ts`), so there
   * was not even a gap to explain it.
   */
  it('a turn started on another device shows its user message here', async () => {
    jest.useFakeTimers()

    try {
      const { gateway, controller } = setup()

      controller.start()
      await controller.openChat(RESEARCHER)

      // Mid-turn the gateway has written the PROMPT and nothing else: the reply
      // is still arriving on the socket.
      gateway.restMessages = [...HISTORY, { role: 'user', text: 'Sent from the phone.', row_id: 3 }]

      gateway.emit({ type: 'message.start', session_id: 'runtime-1', seq: 10, payload: {} })
      gateway.emit({ type: 'message.delta', session_id: 'runtime-1', seq: 11, payload: { text: 'Looking…' } })
      gateway.emit({ type: 'sessions.changed', payload: {} })

      jest.advanceTimersByTime(600)
      await flushFakeTimers()

      const items = chatOf().order.map(id => chatOf().items[id])

      // The prompt is there, above the reply that is still streaming, and the
      // placeholder it filled is gone rather than left standing beside it.
      expect(items.map(item => `${item?.kind}:${(item as { text?: string } | undefined)?.text ?? ''}`)).toEqual([
        'user:Introduce yourself.',
        'assistant:I am researcher.',
        'user:Sent from the phone.',
        'assistant:Looking…'
      ])
      expect(items.some(item => item?.kind === 'user' && item.unknownAuthor)).toBe(false)
      expect(chatOf().turn.active).toBe(true)
    } finally {
      jest.useRealTimers()
    }
  })

  it('reconciles every live chat on a debounced sessions.changed, but not one mid-turn', async () => {
    jest.useFakeTimers()

    try {
      const { gateway, controller } = setup()

      controller.start()
      await controller.openChat(RESEARCHER)

      gateway.restMessages = HISTORY
      gateway.emit({ type: 'sessions.changed', payload: {} })
      gateway.emit({ type: 'sessions.changed', payload: {} })
      gateway.emit({ type: 'sessions.changed', payload: {} })

      expect(gateway.restCalls).toHaveLength(0)

      jest.advanceTimersByTime(600)
      await flushFakeTimers()

      // Three broadcasts, one sweep.
      expect(gateway.restCalls).toHaveLength(1)
    } finally {
      jest.useRealTimers()
    }
  })
})

describe('sending', () => {
  it('paints the message, attaches images first and settles on the submit status', async () => {
    const { gateway, controller } = setup()

    gateway.reply('image.attach_bytes', { attached: true }).reply('prompt.submit', { status: 'streaming' })

    controller.start()
    await controller.openChat(RESEARCHER)
    await controller.send('researcher', 'have a look', [{ filename: 'shot.png', base64: 'AAA' }])

    const order = gateway.methodOrder()

    expect(order.indexOf('image.attach_bytes')).toBeLessThan(order.indexOf('prompt.submit'))
    expect(gateway.lastCall('prompt.submit')).toMatchObject({ session_id: 'runtime-1', text: 'have a look' })

    const user = chatOf()
      .order.map(id => chatOf().items[id])
      .find(item => item?.kind === 'user' && item.origin === 'optimistic')

    // A reference, not a display name: `attachments` is the same contract on
    // both sides of the wire, and the gateway appends `@image:<its own path>` to
    // the row it persists. The name is all the client can put in the path
    // position, and the name is what the two sides are compared on.
    expect(user).toMatchObject({ text: 'have a look', pending: false, attachments: ['@image:shot.png'] })
  })

  it('keeps a queued prompt pending behind the running turn', async () => {
    const { gateway, controller } = setup()

    gateway.reply('prompt.submit', { status: 'queued' })
    await controller.openChat(RESEARCHER)
    await controller.send('researcher', 'and then this')

    expect(chatOf().queued).toEqual({ text: 'and then this', local: true })
  })

  it('stops the turn without throwing away the partial reply', async () => {
    const { gateway, controller } = setup()

    gateway.reply('prompt.submit', { status: 'streaming' }).reply('session.interrupt', { status: 'interrupted' })

    controller.start()
    await controller.openChat(RESEARCHER)
    await controller.send('researcher', 'go')
    gateway.emit({ type: 'message.delta', session_id: 'runtime-1', seq: 12, payload: { text: 'half a th' } })
    await controller.stopTurn('researcher')

    const assistants = chatOf()
      .order.map(id => chatOf().items[id])
      .filter(item => item?.kind === 'assistant')

    expect(assistants[assistants.length - 1]).toMatchObject({
      text: 'half a th',
      status: 'interrupted',
      streaming: false
    })
    expect(chatOf().turn.active).toBe(false)
  })
})

/**
 * The queue behind a running turn.
 *
 * `prompt.submit` will park a prompt on the gateway — it answers `queued` — and
 * that is exactly what the client cannot use: the gateway's queue is one opaque
 * prompt with no method to read it back, edit it or take it out. So a message
 * sent mid-turn is held HERE, drawn in the transcript as the reader's own
 * bubble, and submitted when the turn that was running finishes.
 */
describe('the queue behind a running turn', () => {
  const queueOf = (name = 'researcher') => useChatsStore.getState().queues[name] ?? []

  /** Open a chat and leave a turn running in it. */
  async function busy() {
    const kit = setup()

    kit.gateway.reply('prompt.submit', { status: 'streaming' })
    kit.controller.start()
    await kit.controller.openChat(RESEARCHER)
    await kit.controller.send('researcher', 'go')

    expect(chatOf().turn.active).toBe(true)

    return kit
  }

  const complete = (gateway: FakeChatGateway, seq: number) =>
    gateway.emit({ type: 'message.complete', session_id: 'runtime-1', seq, payload: {} })

  it('parks a message rather than submitting it, and submits it when the turn ends', async () => {
    const { gateway, controller } = await busy()
    const before = gateway.methodOrder().filter(method => method === 'prompt.submit').length

    await controller.send('researcher', 'and one more thing')

    // Nothing went to the gateway…
    expect(gateway.methodOrder().filter(method => method === 'prompt.submit')).toHaveLength(before)
    expect(queueOf()).toEqual([expect.objectContaining({ text: 'and one more thing' })])

    // …until the running turn finished.
    complete(gateway, 20)
    await Promise.resolve()
    await Promise.resolve()

    expect(gateway.lastCall('prompt.submit')).toMatchObject({ text: 'and one more thing' })
    expect(queueOf()).toEqual([])
  })

  it('sends several in the order they were written, one turn at a time', async () => {
    const { gateway, controller } = await busy()

    await controller.send('researcher', 'first')
    await controller.send('researcher', 'second')

    expect(queueOf().map(entry => entry.text)).toEqual(['first', 'second'])

    complete(gateway, 21)
    await Promise.resolve()
    await Promise.resolve()

    expect(gateway.lastCall('prompt.submit')).toMatchObject({ text: 'first' })
    // The second is still parked: it goes out after the reply to the first.
    expect(queueOf().map(entry => entry.text)).toEqual(['second'])

    complete(gateway, 22)
    await Promise.resolve()
    await Promise.resolve()

    expect(gateway.lastCall('prompt.submit')).toMatchObject({ text: 'second' })
    expect(queueOf()).toEqual([])
  })

  it('hands a parked message back for editing, and takes it out of the queue', async () => {
    const { controller } = await busy()

    await controller.send('researcher', 'wait, I meant')

    const id = queueOf()[0]!.id

    expect(controller.editQueued('researcher', id)).toBe('wait, I meant')
    expect(queueOf()).toEqual([])
    // A second attempt has nothing to hand back.
    expect(controller.editQueued('researcher', id)).toBeUndefined()
  })

  it('deletes one without sending anything', async () => {
    const { gateway, controller } = await busy()
    const before = gateway.methodOrder().filter(method => method === 'prompt.submit').length

    await controller.send('researcher', 'never mind')
    controller.deleteQueued('researcher', queueOf()[0]!.id)

    expect(queueOf()).toEqual([])

    // And the turn ending finds nothing to submit.
    complete(gateway, 23)
    await Promise.resolve()
    await Promise.resolve()

    expect(gateway.methodOrder().filter(method => method === 'prompt.submit')).toHaveLength(before)
  })

  it('steers one into the turn that is running, through session.steer', async () => {
    const { gateway, controller } = await busy()

    gateway.reply('session.steer', { status: 'queued', text: 'use the cached copy' })

    await controller.send('researcher', 'use the cached copy')
    const status = await controller.steerQueued('researcher', queueOf()[0]!.id)

    expect(status).toBe('queued')
    expect(gateway.lastCall('session.steer')).toMatchObject({
      session_id: 'runtime-1',
      text: 'use the cached copy'
    })
    expect(queueOf()).toEqual([])
  })

  it('puts a rejected steer back in the queue rather than losing it', async () => {
    // `session.steer` answers `rejected` when the turn is past its final tool
    // batch: there is nothing left to hand the text to. The message has not been
    // sent anywhere, so it goes back to where it was.
    const { gateway, controller } = await busy()

    gateway.reply('session.steer', { status: 'rejected', text: 'too late' })

    await controller.send('researcher', 'too late')

    expect(await controller.steerQueued('researcher', queueOf()[0]!.id)).toBe('rejected')
    expect(queueOf()).toEqual([expect.objectContaining({ text: 'too late' })])
  })
})

describe('approvals', () => {
  it('acknowledges the card, then answers the request the agent is waiting on', async () => {
    const { gateway, controller } = setup()

    controller.start()
    await controller.openChat(RESEARCHER)

    const delivered = gateway.serverRequest('srq-9', 'approval', {
      session_id: 'runtime-1',
      request_id: 'appr-1',
      command: 'rm -rf build',
      choices: ['once', 'deny']
    })

    expect(delivered.accepted).toBe(true)
    await flush()
    expect(gateway.lastCall('approval.received')).toEqual({ session_id: 'runtime-1', request_id: 'appr-1' })

    await controller.respondApproval('researcher', 'srq-9', 'once')

    expect(delivered.answer()).toEqual({ choice: 'once' })
    // Answering the request IS the answer; no second RPC goes out.
    expect(gateway.methodOrder()).not.toContain('approval.respond')

    const item = chatOf().items[chatOf().byRequestId['srq-9'] ?? '']

    expect(item).toMatchObject({ state: 'answered', answer: 'once' })
  })

  it('answers a queue entry with no request behind it through approval.respond', async () => {
    const { gateway, controller } = setup()

    // `pending_approval` is a queue entry the resume reports, not a request the
    // socket carried: there is no reply frame anywhere to answer it on.
    gateway.reply('session.resume', {
      session_id: 'runtime-1',
      stored_session_id: 'tip-researcher',
      message_count: 2,
      messages: [],
      info: { desktop_contract: 7 },
      pending_approval: { request_id: 'appr-7', command: 'rm -rf build', choices: ['once', 'deny'] },
      open_requests: []
    })
    gateway.reply('approval.respond', { resolved: 1 })

    controller.start()
    await controller.openChat(RESEARCHER)

    expect(chatOf().byRequestId['pending:appr-7']).toBeDefined()

    await controller.respondApproval('researcher', 'pending:appr-7', 'deny')

    expect(gateway.lastCall('approval.respond')).toMatchObject({
      session_id: 'runtime-1',
      choice: 'deny',
      request_id: 'appr-7'
    })
  })

  it('declines a method it has no surface for, so the agent is not parked', async () => {
    const { gateway, controller } = setup()

    controller.start()
    await controller.openChat(RESEARCHER)

    // Sudo, secret, vault, preview, terminal — nothing here can answer them,
    // and -32601 is the honest reply.
    expect(gateway.serverRequest('srq-y', 'sudo', { session_id: 'runtime-1' }).accepted).toBe(false)
    expect(gateway.declined.map(entry => entry.method)).toEqual(['sudo'])
  })

  it('holds an approval for a session it has not bound yet instead of declining it', async () => {
    const { gateway, controller } = setup()

    controller.start()
    await controller.openChat(RESEARCHER)

    // Declining would not read as "not mine": the gateway takes -32601 to mean
    // the client cannot answer approvals at all and WITHDRAWS the question.
    expect(gateway.serverRequest('srq-x', 'approval', { session_id: 'runtime-later' }).accepted).toBe(true)
    expect(gateway.declined).toHaveLength(0)

    // The first ready of the process is not a reconnect.
    gateway.status('ready')
    await flush()

    gateway.reply('session.resume', {
      session_id: 'runtime-later',
      stored_session_id: 'tip-researcher',
      message_count: 2,
      messages: [],
      info: { desktop_contract: 7 },
      open_requests: []
    })
    gateway.status('reconnecting')
    gateway.status('ready')
    await flush()

    expect(chatOf().byRequestId['srq-x']).toBeDefined()
  })

  it('takes the open requests a resume replays before it resolves', async () => {
    const { gateway, controller } = setup()

    // Exactly what the channel does: the requests reach the handlers a tick
    // before anything can know which bot owns the session they name.
    gateway.reply('session.resume', {
      session_id: 'runtime-1',
      stored_session_id: 'tip-researcher',
      message_count: 2,
      messages: [],
      info: { desktop_contract: 7 },
      open_requests: [
        {
          id: 'srq-inherited',
          method: 'approval',
          params: { session_id: 'runtime-1', request_id: 'appr-2', command: 'rm -rf build', choices: ['once', 'deny'] }
        }
      ]
    })

    controller.start()
    await controller.openChat(RESEARCHER)

    expect(gateway.declined).toHaveLength(0)

    const item = chatOf().items[chatOf().byRequestId['srq-inherited'] ?? '']

    expect(item).toMatchObject({ kind: 'approval', approvalId: 'appr-2', state: 'open' })

    // And the reply handle survived the parking, so the card answers the
    // request itself rather than going out as a second RPC.
    await controller.respondApproval('researcher', 'srq-inherited', 'deny')

    expect(gateway.answerFor('srq-inherited')).toEqual({ choice: 'deny' })
    expect(gateway.methodOrder()).not.toContain('approval.respond')
  })

  it('shows one card when the pending poll reports an approval already on screen', async () => {
    const { gateway, controller } = setup()

    controller.start()
    await controller.openChat(RESEARCHER)
    gateway.serverRequest('srq-9', 'approval', {
      session_id: 'runtime-1',
      request_id: 'appr-1',
      command: 'rm -rf build'
    })

    gateway.reply('approval.pending', {
      approvals: [{ request_id: 'appr-1', command: 'rm -rf build', choices: ['once', 'deny'] }]
    })

    await controller.onForeground()

    const approvals = chatOf()
      .order.map(id => chatOf().items[id])
      .filter(item => item?.kind === 'approval')

    expect(approvals).toHaveLength(1)
    expect(approvals[0]).toMatchObject({ requestId: 'srq-9', approvalId: 'appr-1' })
  })

  it('forgets the handles behind a card the gateway withdraws', async () => {
    const { gateway, controller } = setup()

    controller.start()
    await controller.openChat(RESEARCHER)
    gateway.serverRequest('srq-9', 'approval', {
      session_id: 'runtime-1',
      request_id: 'appr-1',
      command: 'rm -rf build'
    })
    await flush()

    gateway.emit({
      type: 'request.cancel',
      session_id: 'runtime-1',
      seq: 30,
      payload: { id: 'srq-9', method: 'approval', reason: 'timeout' }
    })

    expect(chatOf().items[chatOf().byRequestId['srq-9'] ?? '']).toMatchObject({ state: 'cancelled' })

    // The handle is gone, so answering the dead card cannot resolve a request
    // that no longer exists; it falls through to the queue instead.
    gateway.reply('approval.respond', { resolved: 0 })
    await controller.respondApproval('researcher', 'srq-9', 'once')

    expect(gateway.lastCall('approval.respond')).toMatchObject({ request_id: 'appr-1' })
  })
})

describe('clarify', () => {
  it('answers a replayed single-question clarify through request.answer', async () => {
    const { gateway, controller } = setup()

    gateway.reply('request.answer', { status: 'ok' })
    controller.start()
    await controller.openChat(RESEARCHER)

    // No live reply frame behind it, and `clarify.lock` is batch-only upstream:
    // it reports `expired` for a single question and the agent keeps waiting.
    useChatsStore.getState().dispatchServerRequest('researcher', {
      id: 'srq-clar',
      method: 'clarify',
      params: { session_id: 'runtime-1', request_id: 'c1', question: 'Which branch?' },
      replayed: true
    })

    await controller.respondClarify('researcher', 'srq-clar', { c1: 'main' })

    expect(gateway.methodOrder()).not.toContain('clarify.lock')
    expect(gateway.lastCall('request.answer')).toEqual({
      id: 'srq-clar',
      result: { answer: 'main' },
      profile: 'researcher'
    })
  })

  it('locks a batch clarify question by question while it is incomplete', async () => {
    const { gateway, controller } = setup()

    gateway.reply('clarify.lock', { status: 'ok', remaining: ['q2'] })
    controller.start()
    await controller.openChat(RESEARCHER)
    gateway.serverRequest('srq-batch', 'clarify', {
      session_id: 'runtime-1',
      questions: [
        { qid: 'q1', question: 'Which cluster?' },
        { qid: 'q2', question: 'Which branch?' }
      ]
    })

    await controller.respondClarify('researcher', 'srq-batch', { q1: 'staging' })

    expect(gateway.lastCall('clarify.lock')).toMatchObject({ request_id: 'srq-batch', question_id: 'q1' })
  })

  it('answers a live batch clarify on its own reply frame', async () => {
    const { gateway, controller } = setup()

    controller.start()
    await controller.openChat(RESEARCHER)

    const delivered = gateway.serverRequest('srq-batch', 'clarify', {
      session_id: 'runtime-1',
      questions: [{ qid: 'q1', question: 'Which cluster?' }]
    })

    await controller.respondClarify('researcher', 'srq-batch', { q1: 'staging' })

    expect(delivered.answer()).toEqual({ answers: { q1: 'staging' } })
  })
})

describe('reconnecting', () => {
  it('ignores the first ready and re-applies snapshots on the next one', async () => {
    const { gateway, controller } = setup()

    controller.start()
    await controller.openChat(RESEARCHER)

    gateway.status('ready')
    await flush()

    const afterFirst = gateway.calls.filter(call => call.method === 'session.resume').length

    expect(afterFirst).toBe(1)

    gateway.reply('session.resume', {
      session_id: 'runtime-2',
      stored_session_id: 'tip-researcher',
      message_count: 2,
      messages: [],
      info: { desktop_contract: 7 },
      open_requests: []
    })
    gateway.status('reconnecting')
    gateway.status('ready')
    await flush()

    expect(gateway.calls.filter(call => call.method === 'session.resume')).toHaveLength(2)
    expect(chatOf().runtimeSessionId).toBe('runtime-2')
    expect(useChatsStore.getState().runtimeToBot).toEqual({ 'runtime-2': 'researcher' })
  })

  it('refetches the tail only when the roster says rows were written while we were away', async () => {
    const { gateway, controller } = setup()

    controller.start()
    await controller.openChat(RESEARCHER)
    gateway.status('ready')
    await flush()

    gateway.restMessages = HISTORY
    gateway.reply('profiles.list', {
      profiles: [
        {
          name: 'researcher',
          path: '/p',
          canonical_session: { id: 'stored-researcher', resolved_id: 'tip-researcher', message_count: 40 }
        }
      ]
    })

    gateway.status('reconnecting')
    gateway.status('ready')
    await flush()

    expect(gateway.restCalls.some(call => call.limit === 30)).toBe(true)
  })
})

describe('the event watermark', () => {
  it('starts over when the gateway rebuilds the session under a new id', async () => {
    const { gateway, controller } = setup()

    controller.start()
    await controller.openChat(RESEARCHER)
    gateway.emit({ type: 'message.delta', session_id: 'runtime-1', seq: 41, payload: { text: 'a' } })

    expect(chatOf().lastSeq).toBe(41)

    // A rebuilt session numbers its events from 1 again. Carrying 41 over
    // would make the reducer drop the first forty of them as replay.
    gateway.status('ready')
    await flush()
    gateway.reply('session.resume', {
      session_id: 'runtime-2',
      stored_session_id: 'tip-researcher',
      message_count: 2,
      messages: [],
      info: { desktop_contract: 7 },
      open_requests: []
    })
    gateway.reply('session.events.since', {
      events: [],
      latest_seq: 3,
      truncated: false,
      count: 0,
      epoch: 'e1',
      open_requests: []
    })
    gateway.status('reconnecting')
    gateway.status('ready')
    await flush()

    expect(gateway.lastCall('session.events.since')).toMatchObject({ session_id: 'runtime-2', last_seen: 0 })
    expect(chatOf().lastSeqSessionId).toBe('runtime-2')

    gateway.emit({ type: 'message.delta', session_id: 'runtime-2', seq: 4, payload: { text: 'kept' } })

    expect(JSON.stringify(chatOf().items)).toContain('kept')
  })

  it('goes cold when the replay epoch says the gateway restarted', async () => {
    const { gateway, controller } = setup()

    controller.start()
    await controller.openChat(RESEARCHER)

    expect(chatOf().epoch).toBe('e1')

    gateway.emit({ type: 'message.delta', session_id: 'runtime-1', seq: 9, payload: { text: 'before' } })

    expect(chatOf().lastSeq).toBe(9)

    gateway.reply('session.events.since', {
      // A restarted gateway numbers from 1 again, so its `latest_seq` is BELOW
      // the watermark we hold and its events describe a different sequence.
      events: [{ type: 'message.delta', session_id: 'runtime-1', seq: 2, payload: { text: 'replayed' } }],
      latest_seq: 2,
      truncated: false,
      count: 1,
      epoch: 'e2',
      open_requests: []
    })

    // The same runtime id comes back, so nothing else says the numbering moved.
    gateway.status('ready')
    await flush()
    gateway.status('reconnecting')
    gateway.status('ready')
    await flush()

    expect(chatOf().epoch).toBe('e2')
    expect(chatOf().lastSeq).toBe(2)
    expect(JSON.stringify(chatOf().items)).not.toContain('replayed')
  })

  it('refuses a resume that comes back without a session id', async () => {
    const { gateway, controller } = setup()

    gateway.reply('session.resume', {
      session_id: '',
      message_count: 0,
      messages: [],
      info: { desktop_contract: 7 }
    })

    await expect(controller.openChat(RESEARCHER)).rejects.toThrow(/without a session id/)
    expect(chatOf().hydration).toBe('error')
  })
})

describe('chat options', () => {
  it('scopes yolo to this session rather than rewriting the gateway configuration', async () => {
    const { gateway, controller } = setup()

    gateway.reply('config.set', {
      key: 'yolo',
      value: 'on',
      scope: 'session',
      info: { desktop_contract: 7, yolo: true }
    })

    await controller.openChat(RESEARCHER)
    await controller.setOption('researcher', 'yolo', 'on')

    expect(gateway.lastCall('config.set')).toMatchObject({
      key: 'yolo',
      value: 'on',
      session_id: 'runtime-1',
      scope: 'session'
    })
  })

  it('reads the options back without resuming the session', async () => {
    const { gateway, controller } = setup()

    gateway.reply('config.set', { key: 'yolo', value: 'on' }).reply('config.get', params => {
      const key = String(params.key)

      return { value: key === 'model' ? 'example-provider/fast' : key === 'yolo' ? 'on' : '' }
    })

    controller.start()
    await controller.openChat(RESEARCHER)
    gateway.emit({
      type: 'session.info',
      session_id: 'runtime-1',
      seq: 30,
      payload: { desktop_contract: 7, model: 'example-provider/example-model', cwd: '/work' }
    })

    const resumesBefore = gateway.calls.filter(call => call.method === 'session.resume').length

    // `config.set` answered with no `info`, so the sheet re-reads the values.
    await controller.setOption('researcher', 'yolo', 'on')

    // Resuming is a write: it mints a new runtime id and rebuilds the agent.
    expect(gateway.calls.filter(call => call.method === 'session.resume')).toHaveLength(resumesBefore)
    expect(gateway.lastCall('config.get')).toMatchObject({ session_id: 'runtime-1', profile: 'researcher' })
    // The four keys land on top of what the session already reported rather
    // than in place of it: `session.info` replaces the whole record.
    expect(chatOf().info).toMatchObject({
      yolo: true,
      model: 'example-provider/fast',
      desktop_contract: 7,
      cwd: '/work'
    })
  })

  it('forgets the slash catalogue of a session that has been replaced', async () => {
    const { gateway, controller } = setup()

    gateway
      .reply('commands.catalog', { pairs: [['/model', 'Switch the model']] })
      .reply('complete.slash', { items: [] })

    controller.start()
    await controller.openChat(RESEARCHER)
    await controller.querySlash('researcher', '/mo')

    expect(controller.slashCatalog('researcher')).toBeDefined()

    gateway.status('ready')
    await flush()
    gateway.reply('session.resume', {
      session_id: 'runtime-2',
      stored_session_id: 'tip-researcher',
      message_count: 2,
      messages: [],
      info: { desktop_contract: 7 },
      open_requests: []
    })
    gateway.status('reconnecting')
    gateway.status('ready')
    await flush()

    // The catalogue belongs to the session that is gone, not to the bot.
    expect(controller.slashCatalog('researcher')).toBeUndefined()
  })

  it('hands an expensive-model confirmation back instead of confirming it', async () => {
    const { gateway, controller } = setup()

    gateway.reply('config.set', {
      key: 'model',
      value: 'expensive',
      confirm_required: true,
      confirm_message: 'That model is expensive.'
    })

    await controller.openChat(RESEARCHER)

    const result = await controller.setOption('researcher', 'model', 'expensive')

    expect(result).toEqual({ confirmRequired: true, confirmMessage: 'That model is expensive.' })
    expect(gateway.lastCall('config.set')).not.toHaveProperty('confirm_expensive_model')
  })
})

describe('slash commands', () => {
  it('fetches the catalogue once per session and completes per keystroke', async () => {
    const { gateway, controller } = setup()

    gateway.reply('commands.catalog', { pairs: [['/model', 'Switch the model']] }).reply('complete.slash', {
      items: [{ text: '/model' }]
    })

    await controller.openChat(RESEARCHER)
    await controller.querySlash('researcher', '/mo')
    await controller.querySlash('researcher', '/mod')

    expect(gateway.calls.filter(call => call.method === 'commands.catalog')).toHaveLength(1)
    expect(gateway.calls.filter(call => call.method === 'complete.slash')).toHaveLength(2)
  })

  it('answers from the catalogue which names are commands and which are prose', async () => {
    const { gateway, controller } = setup()

    gateway
      .reply('commands.catalog', {
        pairs: [['/model', 'Switch the model']],
        canon: { compact: 'compact' },
        skills: { work: { usage: 2 } }
      })
      .reply('complete.slash', { items: [] })

    await controller.openChat(RESEARCHER)

    // Nothing has been fetched yet, so nothing is a command yet — which is the
    // safe answer: the line goes out as an ordinary prompt.
    expect(controller.knowsSlashCommand('researcher', 'model')).toBe(false)

    await controller.querySlash('researcher', '/mo')

    // A name, an alias and a skill are all things the gateway will run.
    expect(controller.knowsSlashCommand('researcher', 'model')).toBe(true)
    expect(controller.knowsSlashCommand('researcher', 'Model')).toBe(true)
    expect(controller.knowsSlashCommand('researcher', 'compact')).toBe(true)
    expect(controller.knowsSlashCommand('researcher', 'work')).toBe(true)

    // And a path is not.
    expect(controller.knowsSlashCommand('researcher', 'usr')).toBe(false)
    expect(controller.knowsSlashCommand('researcher', '')).toBe(false)
  })

  it('reports the column an accepted completion replaces from', async () => {
    // One call completes both halves: the command name while there is no
    // argument, and the argument once there is one. `replace_from` is how the
    // gateway says which.
    const { gateway, controller } = setup()

    gateway
      .reply('commands.catalog', {})
      .reply('complete.slash', { items: [{ text: 'example-large' }], replace_from: 7 })

    await controller.openChat(RESEARCHER)

    expect(await controller.querySlash('researcher', '/model exa')).toEqual({
      items: [{ text: 'example-large' }],
      replaceFrom: 7
    })
    expect(gateway.lastCall('complete.slash')).toMatchObject({ text: '/model exa' })
  })

  it('lands a slash result in the transcript as a notice', async () => {
    const { gateway, controller } = setup()

    gateway.reply('slash.exec', { output: 'model is example-model' })

    await controller.openChat(RESEARCHER)
    await controller.runSlash('researcher', '/model')

    const notice = chatOf()
      .order.map(id => chatOf().items[id])
      .find(item => item?.kind === 'notice')

    expect(notice).toMatchObject({ title: '/model — model is example-model' })
  })
})

describe('the cache', () => {
  it('writes the settled transcript when a turn completes', async () => {
    const { gateway, cache, controller } = setup()

    gateway.reply('prompt.submit', { status: 'streaming' })

    controller.start()
    await controller.openChat(RESEARCHER)
    await controller.send('researcher', 'hello')
    gateway.emit({ type: 'message.complete', session_id: 'runtime-1', seq: 20, payload: { text: 'hi' } })
    await flush()

    const row = await cache!.read('researcher')

    // The reply is in. The user's own bubble is still `optimistic` — the cache
    // deliberately stores only settled transcript — and joins the snapshot once
    // the row comes back from the gateway, which is what the sweep below does.
    expect(row?.itemsJson).toContain('hi')
    expect(row?.itemsJson).not.toContain('hello')
  })

  it("caches the user's own message once the gateway has echoed the row", async () => {
    const { gateway, cache, controller } = setup()

    gateway.reply('prompt.submit', { status: 'streaming' })

    controller.start()
    await controller.openChat(RESEARCHER)
    await controller.send('researcher', 'hello')
    gateway.emit({ type: 'message.complete', session_id: 'runtime-1', seq: 20, payload: { text: 'hi' } })
    await flush()

    gateway.restMessages = [
      ...HISTORY,
      { role: 'user', text: 'hello', row_id: 3 },
      { role: 'assistant', text: 'hi', row_id: 4 }
    ]
    await controller.reconcileTailFor('researcher')
    await controller.persist('researcher')

    await expect(cache!.read('researcher').then(entry => entry?.itemsJson)).resolves.toContain('hello')
  })
})

/** Let every already-resolved promise settle. */
function flush(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

/** The fake-timer equivalent: drain the microtask queue without advancing time. */
async function flushFakeTimers(): Promise<void> {
  for (let round = 0; round < 8; round += 1) {
    await Promise.resolve()
  }
}
