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

    expect(user).toMatchObject({ text: 'have a look', pending: false, attachments: ['shot.png'] })
  })

  it('keeps a queued prompt pending behind the running turn', async () => {
    const { gateway, controller } = setup()

    gateway.reply('prompt.submit', { status: 'queued' })
    await controller.openChat(RESEARCHER)
    await controller.send('researcher', 'and then this')

    expect(chatOf().queued).toEqual({ text: 'and then this' })
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

  it('answers a card rebuilt from a snapshot through approval.respond instead', async () => {
    const { gateway, controller } = setup()

    gateway.reply('session.resume', {
      session_id: 'runtime-1',
      stored_session_id: 'tip-researcher',
      message_count: 2,
      messages: [],
      info: { desktop_contract: 7 },
      open_requests: [
        {
          id: 'srq-replayed',
          method: 'approval',
          params: { session_id: 'runtime-1', request_id: 'appr-7', command: 'rm -rf build', choices: ['once', 'deny'] }
        }
      ]
    })
    gateway.reply('approval.respond', { resolved: 1 })

    controller.start()
    await controller.openChat(RESEARCHER)

    expect(chatOf().byRequestId['srq-replayed']).toBeDefined()

    await controller.respondApproval('researcher', 'srq-replayed', 'deny')

    expect(gateway.lastCall('approval.respond')).toMatchObject({
      session_id: 'runtime-1',
      choice: 'deny',
      request_id: 'appr-7'
    })
  })

  it('declines a request for a session it does not hold, so the agent is not parked', async () => {
    const { gateway, controller } = setup()

    controller.start()
    await controller.openChat(RESEARCHER)

    expect(gateway.serverRequest('srq-x', 'approval', { session_id: 'runtime-elsewhere' }).accepted).toBe(false)
    expect(gateway.serverRequest('srq-y', 'sudo', { session_id: 'runtime-1' }).accepted).toBe(false)
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
