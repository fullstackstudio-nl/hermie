/**
 * The whole Bot Chat sequence against the fake gateway, in plain TypeScript.
 *
 * The app drives this through a zustand store and a React screen; neither is
 * needed to prove the protocol works. What runs here is exactly what the chat
 * controller runs — resume, history, replay, submit, stream, approve — with the
 * same transcript reducer the app uses, so a break in either half shows up
 * without a simulator.
 */
import { type FakeGateway, type FakeGatewayOptions, startFakeGateway } from '@hermie/fake-gateway'
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
  type UserItem,
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
  /** Every server request the channel delivered, tagged with what was in flight. */
  deliveries: { id: string; method: string; replayed: boolean; during: string }[]
  /** What `deliveries` records as "in flight" from here on. */
  mark: (label: string) => void
  storedSessionId: string
  respondApproval: (requestId: string, choice: string) => void
  restRows: (limit: number) => Promise<TranscriptRow[]>
  waitFor: (predicate: (state: ChatState) => boolean, label: string) => Promise<void>
  /** The session's working directory — the only place an upload can legally land. */
  cwd?: string
  /** Paint, submit and settle a turn, in the order the controller's `send` does. */
  submit: (text: string, attachments?: string[]) => Promise<void>
  /** The `sessions.changed` sweep: fold the REST tail into the live transcript. */
  sweepTail: (limit?: number) => Promise<void>
  /** Reopening the chat: throw the transcript away and project it from the rows. */
  rehydrate: (limit?: number) => Promise<void>
}

async function openBotChat(profile: string, options: FakeGatewayOptions = {}): Promise<ChatHarness> {
  const gateway = await startFakeGateway({ auth: 'token', token: 'demo', streamDelayMs: 1, ...options })
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
  const deliveries: ChatHarness['deliveries'] = []
  let during = 'idle'
  const replies = new Map<string, (result: Record<string, unknown>) => void>()

  connection.onRequest(request => {
    if (request.method !== 'approval' && request.method !== 'clarify') {
      return false
    }

    if (request.params.session_id !== runtimeSessionId) {
      return false
    }

    deliveries.push({ id: request.id, method: request.method, replayed: request.replayed === true, during })
    replies.set(request.id, request.respond)
    apply(
      applyServerRequest(state, {
        id: request.id,
        method: request.method,
        params: request.params,
        ...(request.replayed ? { replayed: true } : {})
      })
    )
    // Fire and forget, exactly as the controller sends it: the ack is a
    // courtesy to the queue's timeout, and one still in flight when the test
    // tears the socket down must not surface as an unhandled rejection.
    void connection
      .request('approval.received', {
        session_id: runtimeSessionId,
        request_id: String(request.params.request_id ?? request.id)
      })
      .catch(() => undefined)

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
    deliveries,
    storedSessionId: storedId,
    mark(label) {
      during = label
    },
    respondApproval(requestId, choice) {
      apply(answerRequest(state, requestId, choice))
      answered.push(choice)
      replies.get(requestId)?.({ choice })
      replies.delete(requestId)
    },
    restRows,
    waitFor,
    ...(typeof resume.info?.cwd === 'string' ? { cwd: resume.info.cwd } : {}),
    async submit(text, attachments) {
      apply(beginLocalTurn(state, text, attachments))

      const result = await connection.request('prompt.submit', {
        session_id: runtimeSessionId,
        profile,
        text
      })

      apply(confirmSubmit(state, { status: result?.status ?? null }))
    },
    async sweepTail(limit = 30) {
      apply(reconcileTail(state, rowsToItems(await restRows(limit), 'rest')))
    },
    async rehydrate(limit = 30) {
      apply(reconcile(state, rowsToItems(await restRows(limit), 'rest')))
    }
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

/** The human's own bubbles — what a duplicated send shows up as two of. */
const outgoing = (state: ChatState): UserItem[] =>
  itemsOf(state).filter((item): item is UserItem => item.kind === 'user')

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

  it('shows a delegation as subagent activity, one failed child included', async () => {
    // The fan-out is deliberately slow in normal use (a delegation nobody can
    // look at cannot be steered); a test only cares about the end state.
    const chat = await openBotChat('researcher', { subagentStepMs: 1 })

    await chat.connection.request('prompt.submit', {
      session_id: chat.runtimeSessionId,
      text: 'delegate the dependency audit'
    })

    await chat.waitFor(
      state => Object.values(state.subagents).filter(child => child.status !== 'running').length === 3,
      'three finished subagents'
    )

    const children = Object.values(chat.state().subagents).sort((a, b) => a.taskIndex - b.taskIndex)

    expect(children.map(child => child.goal)).toEqual([
      'Audit the dependencies',
      'Summarize the changelog',
      'Check the licence headers'
    ])
    expect(children.map(child => child.status)).toEqual(['completed', 'completed', 'failed'])
    expect(children[0]?.stream.length).toBeGreaterThan(0)
    // Every child carries its own session id, which is what makes the full
    // read-only transcript offer real rather than a dead button.
    expect(children.every(child => Boolean(child.childSessionId))).toBe(true)

    await chat.waitFor(
      state => Object.values(state.items).some(item => item.kind === 'subagent_group' && Boolean(item.completion)),
      'the group card to carry a completion summary'
    )

    const group = Object.values(chat.state().items).find(item => item.kind === 'subagent_group')

    expect(group).toMatchObject({ status: 'failed' })
    expect(group?.kind === 'subagent_group' ? group.completion : '').toContain('licence check failed')
  }, 20_000)

  it('answers subagent.list with the children that are still live', async () => {
    const chat = await openBotChat('researcher', { subagentStepMs: 40 })

    await chat.connection.request('prompt.submit', {
      session_id: chat.runtimeSessionId,
      text: 'delegate the dependency audit'
    })

    await chat.waitFor(
      state => Object.values(state.subagents).some(child => child.status === 'running'),
      'a running subagent'
    )

    const listed = await chat.connection.request('subagent.list', { session_id: chat.runtimeSessionId })
    const status = await chat.connection.request('delegation.status', { profile: 'researcher' })

    expect(listed.subagents?.length).toBeGreaterThan(0)
    expect(status.active.length).toBe(listed.subagents?.length)
    expect(listed.subagents?.[0]).toMatchObject({ status: expect.stringMatching(/queued|running/) })
  }, 20_000)

  it('hands a queued message_agent to a delivery process and joins the reply back onto it', async () => {
    const chat = await openBotChat('researcher', { subagentStepMs: 300 })

    await chat.connection.request('prompt.submit', {
      session_id: chat.runtimeSessionId,
      text: 'dm the release notes are merged'
    })

    await chat.waitFor(
      // The seeded history already holds one dispatch; the LIVE one is the one
      // carrying a background delivery process.
      state => Object.values(state.items).some(item => item.kind === 'bot_dm_out' && Boolean(item.dispatch.processId)),
      'a queued dispatch with a delivery process'
    )

    // While the delivery is out, it is a background process — the only place a
    // client can count deliveries that have not landed.
    const inFlight = await chat.connection.request('agents.list', { profile: 'researcher' })

    expect(inFlight.processes?.some(row => row.command.includes('bot_mode_dm.py --run-delivery'))).toBe(true)

    // The reply is not pushed: it lands as a persisted row, which is why a
    // client has to tail-reconcile on `sessions.changed` to see it at all.
    await new Promise(resolve => setTimeout(resolve, 900))

    const reconciled = reconcileTail(chat.state(), rowsToItems(await chat.restRows(30), 'rest'))
    const dispatch = Object.values(reconciled.items).find(item => item.kind === 'bot_dm_out' && item.dispatch.processId)

    expect(dispatch?.kind === 'bot_dm_out' ? dispatch.reply?.text : '').toContain('is in hand')
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

  it('re-delivers an unanswered request before the resume that carries it resolves', async () => {
    const chat = await openBotChat('researcher')
    const pending = chat.gateway.requestApproval({
      session_id: chat.runtimeSessionId,
      request_id: 'ap-open',
      command: 'rm -rf ./build',
      choices: ['once', 'deny']
    })

    await chat.waitFor(
      state => itemsOf(state).some(item => item.kind === 'approval' && item.state === 'open'),
      'the approval card'
    )

    chat.mark('resuming')

    const resume = await chat.connection.request('session.resume', {
      session_id: chat.storedSessionId,
      profile: 'researcher',
      omit_messages: true,
      source: 'hermie',
      cols: 96
    })

    chat.mark('idle')

    expect(resume.open_requests?.map(entry => entry.method)).toEqual(['approval'])

    // This ordering is the whole reason a client has to park a request whose
    // session it has not bound yet: the request handler runs while the resume
    // that would do the binding is still in flight.
    const replayed = chat.deliveries.filter(entry => entry.replayed)

    expect(replayed).toHaveLength(1)
    expect(replayed[0]).toMatchObject({ method: 'approval', during: 'resuming' })

    const approval = itemsOf(chat.state()).find(item => item.kind === 'approval')

    expect(itemsOf(chat.state()).filter(item => item.kind === 'approval')).toHaveLength(1)

    chat.respondApproval(approval?.kind === 'approval' ? approval.requestId : '', 'deny')

    await expect(pending).resolves.toEqual({ choice: 'deny' })
  }, 20_000)

  it('settles an open request through request.answer when there is no frame to answer on', async () => {
    const chat = await openBotChat('researcher')
    const pending = chat.gateway.requestApproval({
      session_id: chat.runtimeSessionId,
      request_id: 'ap-proxy',
      command: 'rm -rf ./build',
      choices: ['once', 'deny']
    })

    await chat.waitFor(
      state => itemsOf(state).some(item => item.kind === 'approval' && item.state === 'open'),
      'the approval card'
    )

    const approval = itemsOf(chat.state()).find(item => item.kind === 'approval')
    const acknowledged = await chat.connection.request('request.answer', {
      id: approval?.kind === 'approval' ? approval.requestId : '',
      result: { choice: 'deny' },
      profile: 'researcher'
    })

    expect(acknowledged.status).toBe('ok')
    await expect(pending).resolves.toEqual({ choice: 'deny' })

    // A second attempt has nothing left to settle.
    const again = await chat.connection.request('request.answer', {
      id: approval?.kind === 'approval' ? approval.requestId : '',
      result: { choice: 'deny' }
    })

    expect(again.status).toBe('expired')
  }, 20_000)

  it('refuses to lock a single-question clarify, which is why request.answer exists', async () => {
    const chat = await openBotChat('researcher')
    const pending = chat.gateway.requestServerSide('clarify', {
      session_id: chat.runtimeSessionId,
      question: 'Which branch?',
      choices: ['main', 'next']
    })

    await chat.waitFor(
      state => itemsOf(state).some(item => item.kind === 'clarify' && item.state === 'open'),
      'the clarify card'
    )

    const clarify = itemsOf(chat.state()).find(item => item.kind === 'clarify')
    const requestId = clarify?.kind === 'clarify' ? clarify.requestId : ''

    // `lock_answer` has no qid set to lock against for a bare question, so the
    // gateway reports it expired and the agent keeps waiting.
    const locked = await chat.connection.request('clarify.lock', {
      request_id: requestId,
      question_id: clarify?.kind === 'clarify' ? (clarify.questions[0]?.qid ?? '') : '',
      answer: 'main'
    })

    expect(locked.status).toBe('expired')

    const answered = await chat.connection.request('request.answer', {
      id: requestId,
      result: { answer: 'main' }
    })

    expect(answered.status).toBe('ok')
    await expect(pending).resolves.toEqual({ answer: 'main' })
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

  it('paints one bubble for a file sent with no words, at every stage', async () => {
    const chat = await openBotChat('researcher')

    // The upload has to land under the session's own cwd or the `@file:`
    // reference is refused as outside the allowed workspace.
    expect(chat.cwd, 'the session reported no working directory').toBeTruthy()

    const path = `${chat.cwd}/uploads/hermie/2026-09-20/8setj4h3-ui.xml`
    const form = new FormData()

    form.append('path', path)
    form.append('overwrite', 'true')
    form.append('file', new Blob(['<ui/>']), 'ui.xml')

    const upload = await fetch(`${chat.gateway.url}/api/files/upload-stream`, {
      method: 'POST',
      headers: { 'X-Hermes-Session-Token': 'demo' },
      body: form
    })

    expect(upload.status).toBe(200)

    // No words at all: the reference IS the prompt. That is the send that came
    // back as two bubbles, because the projection of it holds no text to pair on.
    const reference = `@file:${path}`

    // Only the bubbles carrying this file: the canonical chat opens with fixture
    // history, and counting every outgoing bubble would count those too.
    const carryingTheFile = (state: ChatState): UserItem[] =>
      outgoing(state).filter(item => item.attachments?.some(ref => ref.endsWith('8setj4h3-ui.xml')))

    await chat.submit(reference, [reference])

    expect(carryingTheFile(chat.state())).toHaveLength(1)

    await chat.waitFor(state => !state.turn.active, 'the reply to finish')
    await chat.sweepTail()

    expect(carryingTheFile(chat.state())).toHaveLength(1)
    expect(carryingTheFile(chat.state())[0]?.rowId).toBeGreaterThan(0)
    // The chip survives the pairing: the row's directive is the durable one.
    expect(carryingTheFile(chat.state())[0]?.attachments).toEqual([reference])

    await chat.rehydrate()

    expect(carryingTheFile(chat.state())).toHaveLength(1)
    // And the file really did reach the agent, which is the other half of the
    // claim: one bubble showing an upload nothing read would be no better.
    expect(itemsOf(chat.state()).some(item => item.kind === 'assistant' && item.text.includes('ui.xml'))).toBe(true)
  }, 20_000)
})
