/**
 * The whole Bot Chat sequence against the fake gateway, in plain TypeScript.
 *
 * The app drives this through a zustand store and a React screen; neither is
 * needed to prove the protocol works. What runs here is exactly what the chat
 * controller runs — resume, history, replay, submit, stream, approve — with the
 * same transcript reducer the app uses, so a break in either half shows up
 * without a simulator.
 */
import { startFakeGateway, type FakeGateway } from '@hermie/fake-gateway'
import {
  applyEvent,
  applyResumeSnapshot,
  applyServerRequest,
  answerRequest,
  beginLocalTurn,
  type ChatState,
  confirmSubmit,
  createChatState,
  reconcile,
  reconcileTail,
  rowsToItems,
  type TranscriptEvent,
  type TranscriptItem,
  type TranscriptRow,
  visibleItems
} from '@hermie/transcript'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket as NodeWebSocket } from 'ws'

import { assertDesktopContract, GatewayConnection } from './connection'
import { SessionTokenCredentials } from './credentials'
import { DialPlanSocketFactory, type WebSocketConstructorLike } from './socket-factory'

const SocketImpl = NodeWebSocket as unknown as WebSocketConstructorLike

const live: { gateway: FakeGateway; connection: GatewayConnection }[] = []

afterEach(async () => {
  for (const entry of live.splice(0)) {
    entry.connection.stop()
    await entry.gateway.close()
  }
})

interface ChatHarness {
  gateway: FakeGateway
  connection: GatewayConnection
  /** The live transcript, as the store would hold it. */
  state: () => ChatState
  runtimeSessionId: string
  /** `approval` / `clarify` requests the gateway asked, with their reply handle. */
  answered: string[]
  respondApproval: (requestId: string, choice: string) => void
  restRows: (limit: number) => Promise<TranscriptRow[]>
  waitFor: (predicate: (state: ChatState) => boolean, label: string) => Promise<void>
}

async function openBotChat(profile: string): Promise<ChatHarness> {
  const gateway = await startFakeGateway({ auth: 'token', token: 'demo', streamDelayMs: 1 })
  const connection = new GatewayConnection({
    config: { baseUrl: gateway.url, authMode: 'session_token' },
    credentials: new SessionTokenCredentials({ token: 'demo' }),
    socketFactory: new DialPlanSocketFactory(SocketImpl),
    backoffDelayMs: () => 10,
    readyTimeoutMs: 2000,
    connectTimeoutMs: 2000,
    heartbeatIntervalMs: 0,
    heartbeatDeadlineMs: 0
  })

  live.push({ gateway, connection })
  connection.start()
  await waitForStatus(connection, 'ready')

  // ── the roster and the canonical chat ─────────────────────────────────────
  const roster = await connection.request('profiles.list', { include_sessions: true })
  const row = (roster.profiles ?? []).find(entry => entry.name === profile)

  if (!row?.canonical_session) {
    throw new Error(`${profile} has no canonical Bot Chat`)
  }

  const storedId = row.canonical_session.id
  const resolvedId = row.canonical_session.resolved_id || storedId

  let state = createChatState(profile, storedId, resolvedId)
  const apply = (next: ChatState) => {
    state = next
  }

  // ── resume on the DURABLE id; events arrive under the runtime one ─────────
  const resume = await connection.request('session.resume', {
    session_id: storedId,
    profile,
    omit_messages: true,
    source: 'hermie',
    cols: 96
  })

  assertDesktopContract(resume.info)

  const runtimeSessionId = resume.session_id

  expect(runtimeSessionId).not.toBe(storedId)

  // Events land before anything else touches the state, exactly as the store's
  // subscription does; the reducer's seq guard makes replay idempotent.
  connection.onAny(event => {
    const frame = event as unknown as TranscriptEvent

    if (frame.session_id !== runtimeSessionId) {
      return
    }

    apply(applyEvent(state, frame))
  })

  const answered: string[] = []
  const replies = new Map<string, (result: Record<string, unknown>) => void>()

  connection.onRequest(request => {
    if (request.method !== 'approval' && request.method !== 'clarify') {
      return false
    }

    if (request.params.session_id !== runtimeSessionId) {
      return false
    }

    replies.set(request.id, request.respond)
    apply(applyServerRequest(state, { id: request.id, method: request.method, params: request.params }))
    void connection.request('approval.received', {
      session_id: runtimeSessionId,
      request_id: String(request.params.request_id ?? request.id)
    })

    return true
  })

  // ── history → items → reconcile, then the in-flight tail, then the replay ──
  const history = await connection.request('session.history', { session_id: runtimeSessionId, profile })

  apply(reconcile(state, rowsToItems((history.messages ?? []) as TranscriptRow[], 'rpc')))
  // The generated contract models these as closed interfaces; the reducer reads
  // them as open bags, which is the same widening the app's controller does.
  apply(
    applyResumeSnapshot(state, {
      inflight: resume.inflight ? { ...resume.inflight } : null,
      running: resume.running ?? null,
      queued: resume.queued ? { ...resume.queued } : null,
      pending_approval: resume.pending_approval ? { ...resume.pending_approval } : null,
      todo_state: resume.todo_state ? { ...resume.todo_state } : null,
      open_requests: resume.open_requests ?? null
    })
  )

  const since = await connection.request('session.events.since', {
    session_id: runtimeSessionId,
    last_seen: state.lastSeq
  })

  apply({ ...state, lastSeq: Math.max(state.lastSeq, since.latest_seq), epoch: since.epoch })

  const restRows = async (limit: number): Promise<TranscriptRow[]> => {
    const response = await fetch(`${gateway.url}/api/sessions/${resolvedId}/messages?limit=${limit}&order=latest`, {
      headers: { 'X-Hermes-Session-Token': 'demo' }
    })
    const body = (await response.json()) as { messages?: TranscriptRow[] }

    return body.messages ?? []
  }

  const waitFor = async (predicate: (value: ChatState) => boolean, label: string) => {
    const deadline = Date.now() + 5000

    while (Date.now() < deadline) {
      if (predicate(state)) {
        return
      }

      await new Promise(resolve => setTimeout(resolve, 10))
    }

    throw new Error(`Timed out waiting for ${label}`)
  }

  return {
    gateway,
    connection,
    state: () => state,
    runtimeSessionId,
    answered,
    respondApproval(requestId, choice) {
      apply(answerRequest(state, requestId, choice))
      answered.push(choice)
      replies.get(requestId)?.({ choice })
      replies.delete(requestId)
    },
    restRows,
    waitFor
  }
}

async function waitForStatus(connection: GatewayConnection, status: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    if (connection.status === status) {
      return
    }

    await new Promise(resolve => setTimeout(resolve, 10))
  }

  throw new Error(`The connection never reached ${status} (it is ${connection.status}).`)
}

const itemsOf = (state: ChatState): TranscriptItem[] =>
  state.order.map(id => state.items[id]).filter((item): item is TranscriptItem => Boolean(item))

const kindsOf = (state: ChatState): string[] => itemsOf(state).map(item => item.kind)

describe('a Bot Chat end to end', () => {
  it('hydrates the canonical chat with its tool row and its bot-to-bot exchange', async () => {
    const chat = await openBotChat('researcher')
    const state = chat.state()

    expect(state.hydration).toBe('live')
    // The seeded transcript carries a tool call, an outbound DM and the
    // background-process row that brings the teammate's answer back.
    expect(kindsOf(state)).toEqual(expect.arrayContaining(['user', 'assistant', 'tool', 'bot_dm_out']))

    const dispatch = itemsOf(state).find(item => item.kind === 'bot_dm_out')

    expect(dispatch).toMatchObject({ targetHandle: 'writer' })
    expect(dispatch?.kind === 'bot_dm_out' ? dispatch.reply?.text : '').toContain('Draft is ready')
  }, 20_000)

  it('streams a reply with a tool call and settles the turn', async () => {
    const chat = await openBotChat('researcher')
    const before = chat.state().order.length

    const optimistic = beginLocalTurn(chat.state(), 'summarise the notes')

    expect(optimistic.turn.local).toBe(true)

    const result = await chat.connection.request('prompt.submit', {
      session_id: chat.runtimeSessionId,
      text: 'summarise the notes'
    })

    expect(result.status).toBe('streaming')

    confirmSubmit(optimistic, { status: result.status ?? null })
    await chat.waitFor(state => state.order.length > before && !state.turn.active, 'the turn to finish')

    const state = chat.state()
    const tools = itemsOf(state).filter(item => item.kind === 'tool')
    const assistants = itemsOf(state).filter(item => item.kind === 'assistant')

    expect(tools.some(tool => tool.kind === 'tool' && tool.resultKnown)).toBe(true)
    expect(assistants[assistants.length - 1]).toMatchObject({ streaming: false, status: 'complete' })
  }, 20_000)

  it('raises an approval, parks the turn on it, and completes once it is answered', async () => {
    const chat = await openBotChat('researcher')

    await chat.connection.request('prompt.submit', {
      session_id: chat.runtimeSessionId,
      text: 'please approve this cleanup'
    })

    await chat.waitFor(
      state => itemsOf(state).some(item => item.kind === 'approval' && item.state === 'open'),
      'the approval card'
    )

    const pending = await chat.connection.request('approval.pending', { session_id: chat.runtimeSessionId })

    expect(pending.approvals).toHaveLength(1)

    const approval = itemsOf(chat.state()).find(item => item.kind === 'approval')

    expect(approval).toMatchObject({ command: 'rm -rf ./build', choices: ['once', 'session', 'always', 'deny'] })

    if (approval?.kind !== 'approval') {
      throw new Error('no approval card')
    }

    // The turn does not finish until the question is answered.
    expect(chat.state().turn.active).toBe(true)

    chat.respondApproval(approval.requestId, 'once')

    await chat.waitFor(state => !state.turn.active, 'the turn to complete after the approval')

    expect(itemsOf(chat.state()).find(item => item.kind === 'approval')).toMatchObject({
      state: 'answered',
      answer: 'once'
    })
  }, 20_000)

  it('shows a delegation as subagent activity', async () => {
    const chat = await openBotChat('researcher')

    await chat.connection.request('prompt.submit', {
      session_id: chat.runtimeSessionId,
      text: 'delegate the dependency audit'
    })

    await chat.waitFor(
      state => Object.values(state.subagents).some(child => child.status === 'completed'),
      'a subagent'
    )

    const child = Object.values(chat.state().subagents)[0]

    expect(child).toMatchObject({ goal: 'Audit the dependencies', status: 'completed' })
    expect(child?.stream.length).toBeGreaterThan(0)
  }, 20_000)

  it('stands a placeholder in for a foreign turn and fills it from the REST tail', async () => {
    const chat = await openBotChat('researcher')

    const response = await fetch(`${chat.gateway.url}/__fake/inject`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        profile: 'researcher',
        user: 'Message from 🤖 Writer (@writer): the announcement is live.',
        assistant: 'Good — I will link it.'
      })
    })

    expect(response.status).toBe(200)

    await chat.waitFor(
      state => itemsOf(state).some(item => item.kind === 'user' && item.unknownAuthor),
      'a placeholder'
    )
    await chat.waitFor(state => !state.turn.active, 'the foreign turn to finish')

    // The tail reconcile is what learns who spoke.
    const tail = rowsToItems(await chat.restRows(30), 'rest')
    const reconciled = reconcileTail(chat.state(), tail)

    expect(itemsOf(reconciled).some(item => item.kind === 'user' && item.unknownAuthor)).toBe(false)
    expect(itemsOf(reconciled).some(item => item.kind === 'bot_dm_in')).toBe(true)
  }, 20_000)

  it('keeps the chat readable at every verbosity without losing anything', async () => {
    const chat = await openBotChat('researcher')
    const state = chat.state()

    const quiet = visibleItems(state, { level: 'quiet', showBotToBot: true, showThinking: false })
    const verbose = visibleItems(state, { level: 'verbose', showBotToBot: true, showThinking: true })
    const muted = visibleItems(state, { level: 'normal', showBotToBot: false, showThinking: false })

    expect(quiet.length).toBeLessThanOrEqual(verbose.length)
    // Muting bot-to-bot demotes the DM to a chip; it never removes it, or the
    // bot's own answer would have nothing to answer.
    expect(muted.filter(entry => entry.item.kind === 'bot_dm_out')).toHaveLength(1)
    expect(muted.find(entry => entry.item.kind === 'bot_dm_out')?.presentation).toBe('chip')
  }, 20_000)

  it('completes a slash command and reads the catalogue behind it', async () => {
    const chat = await openBotChat('writer')

    const catalog = await chat.connection.request('commands.catalog', { session_id: chat.runtimeSessionId })
    const completions = await chat.connection.request('complete.slash', {
      text: '/mo',
      session_id: chat.runtimeSessionId
    })
    const executed = await chat.connection.request('slash.exec', {
      session_id: chat.runtimeSessionId,
      command: '/status'
    })

    expect(catalog.pairs?.length).toBeGreaterThan(0)
    expect(completions.items?.map(item => item.text)).toEqual(['/model'])
    expect(executed.output).toContain('/status')
  }, 20_000)

  it('scopes a chat option to the session and reports the new session info', async () => {
    const chat = await openBotChat('writer')

    const set = await chat.connection.request('config.set', {
      key: 'yolo',
      value: 'on',
      session_id: chat.runtimeSessionId,
      scope: 'session'
    })

    expect(set).toMatchObject({ key: 'yolo', value: 'on', scope: 'session' })
    expect(set.info?.yolo).toBe(true)

    const expensive = await chat.connection.request('config.set', {
      key: 'model',
      value: 'example-provider/expensive-model',
      session_id: chat.runtimeSessionId
    })

    expect(expensive.confirm_required).toBe(true)
  }, 20_000)

  it('attaches an image before the prompt that uses it', async () => {
    const chat = await openBotChat('writer')

    const attached = await chat.connection.request('image.attach_bytes', {
      session_id: chat.runtimeSessionId,
      content_base64: 'aGVsbG8=',
      filename: 'shot.png'
    })

    expect(attached.attached).toBe(true)
    expect(chat.gateway.state.attachedImages).toHaveLength(1)
  }, 20_000)
})
