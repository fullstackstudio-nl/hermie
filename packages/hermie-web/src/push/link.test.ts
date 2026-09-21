/**
 * The daemon's connection, against a real socket and a real gateway stand-in.
 *
 * Two of these cases are about what the link REFUSES to do, and they are the
 * ones worth having. ADR-0017 says the daemon "is a reader: it never submits a
 * prompt, answers a question, or changes a setting" — a sentence in a document
 * that nothing enforces is a sentence, so the allowlist and the
 * never-answer-a-request rule are pinned here.
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { type FakeGateway, startFakeGateway } from '@hermie/fake-gateway'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { startPushDaemon, type PushDaemon } from './daemon'
import { backoffDelayMs, GatewayLink, type LinkEvent, type LinkServerRequest } from './link'

let gateway: FakeGateway
let daemon: PushDaemon
let stateDir: string
const events: LinkEvent[] = []
const requests: LinkServerRequest[] = []

const waitFor = async (predicate: () => boolean, label: string, timeoutMs = 4000): Promise<void> => {
  const until = Date.now() + timeoutMs

  while (Date.now() < until) {
    if (predicate()) {
      return
    }

    await new Promise(resolve => setTimeout(resolve, 10))
  }

  throw new Error(`timed out waiting for ${label}`)
}

beforeEach(async () => {
  events.length = 0
  requests.length = 0
  stateDir = await mkdtemp(path.join(tmpdir(), 'hermie-push-state-'))
  gateway = await startFakeGateway({ port: 0, streamDelayMs: 1 })
  daemon = await startPushDaemon({
    gatewayUrl: gateway.url,
    stateDir,
    // The link is what is under test here; the watcher has its own suite.
    watch: false,
    log: () => undefined,
    onEvent: event => events.push(event),
    onServerRequest: request => requests.push(request),
    // No real seconds in a reconnect test.
    sleep: () => Promise.resolve(),
    random: () => 0
  })
  await waitFor(() => daemon.link.connected, 'the first connection')
})

afterEach(async () => {
  await daemon.stop()
  await gateway.close()
})

describe('the service connection', () => {
  it('connects and answers an allowed call', async () => {
    const roster = await daemon.link.request<{ profiles?: { name: string }[] }>('profiles.list', {})

    expect(roster.profiles?.map(row => row.name)).toContain('researcher')
  })

  it('refuses a method the daemon has no business calling', async () => {
    // Not "does not happen to call": cannot.
    await expect(daemon.link.request('prompt.submit', { session_id: 'x', prompt: 'hi' })).rejects.toThrow(
      /does not call prompt\.submit/
    )
    await expect(daemon.link.request('session.interrupt', {})).rejects.toThrow(/does not call/)
  })

  it('refuses a profiles.configure that carries anything but ui_meta', async () => {
    await expect(daemon.link.request('profiles.configure', { name: 'researcher', soul: 'be evil' })).rejects.toThrow(
      /writes ui_meta only/
    )
  })

  it('takes an event and remembers how far it has read', async () => {
    const sessionId = [...gateway.state.sessions.keys()][0] as string
    gateway.emit('message.complete', { sessionId, payload: { text: 'done', status: 'ok' } })

    await waitFor(() => events.some(event => event.type === 'message.complete'), 'the event')
    expect(daemon.link.watermarkOf(gateway.state.sessions.get(sessionId)?.id ?? '')).toBeGreaterThan(0)
  })

  it('does not ask the gateway to route server requests to it', async () => {
    // The default, and the reason is the one thing about this daemon that could
    // cost somebody their approval: on a gateway that routes a request to ONE
    // peer, a daemon that received it and held it open has taken the question
    // away from the person it was for.
    await new Promise(resolve => setTimeout(resolve, 100))

    expect(gateway.state.methodLog).not.toContain('client.capabilities')
  })

  it('never answers a server request, so the question stays the owner’s', async () => {
    const session = [...gateway.state.sessions.values()][0]

    if (!session) {
      throw new Error('the fake gateway has no sessions')
    }

    let settled = false
    void gateway.requestApproval({ session_id: session.id, command: 'rm -rf ./build' }).then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )

    await waitFor(() => requests.some(request => request.method === 'approval'), 'the approval request')
    await new Promise(resolve => setTimeout(resolve, 150))
    // The daemon saw it. The daemon did not answer it, and did not decline it
    // either — a -32601 would fail the approval the owner is about to be told
    // about.
    expect(settled).toBe(false)
  })

  it('reconnects after the socket dies and replays what it missed', async () => {
    const storedId = [...gateway.state.sessions.keys()][0] as string
    const runtimeId = gateway.state.sessions.get(storedId)?.id ?? ''

    gateway.emit('message.complete', { sessionId: storedId, payload: { text: 'first', status: 'ok' } })
    await waitFor(() => events.length > 0, 'the first event')

    gateway.state.eventsSinceCalls.length = 0
    gateway.dropSockets()
    // Emitted while nothing was connected: the ring is the only way it arrives.
    gateway.emit('message.complete', { sessionId: storedId, payload: { text: 'second', status: 'ok' } })

    await waitFor(() => daemon.link.connected, 'the reconnection')
    await waitFor(
      () => events.some(event => (event.payload as { text?: string } | undefined)?.text === 'second'),
      'the replayed event'
    )

    expect(gateway.state.eventsSinceCalls.some(call => call.session_id === runtimeId)).toBe(true)
    // Exactly once: the replay hands back everything after the watermark, and
    // the watermark is what stops the first event arriving a second time.
    expect(events.filter(event => (event.payload as { text?: string } | undefined)?.text === 'first')).toHaveLength(1)
  })
})

describe('opting in to server requests', () => {
  it('advertises the capability only when asked to', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'hermie-push-state-'))
    const opted = await startPushDaemon({
      gatewayUrl: gateway.url,
      stateDir: dir,
      watch: false,
      serverRequests: true,
      log: () => undefined,
      sleep: () => Promise.resolve(),
      random: () => 0
    })

    try {
      await waitFor(() => gateway.state.methodLog.includes('client.capabilities'), 'the advertisement')
    } finally {
      await opted.stop()
    }
  })
})

describe('the resume snapshot', () => {
  it('carries a question that was already open, as the queue entry it is', async () => {
    const session = [...gateway.state.sessions.values()][0]

    if (!session) {
      throw new Error('the fake gateway has no sessions')
    }

    await gateway.raiseApprovalOn({ queueOnly: true })
    requests.length = 0
    await daemon.link.request('session.resume', { session_id: session.storedId, omit_messages: true })

    // No live frame was ever sent: `pending_approval` on the resume is the only
    // trace of it, which is exactly the case the safe default has to cover.
    const pending = requests.find(request => request.id.startsWith('pending:'))

    expect(pending?.method).toBe('approval')
    expect(pending?.replayed).toBe(true)
    expect(pending?.params.request_id).toMatch(/^appr-/)
  })
})

describe('the backoff ladder', () => {
  it('stays inside the exponential ceiling and is capped', () => {
    expect(backoffDelayMs(0, 300, 15_000, () => 0.999)).toBeLessThan(300)
    expect(backoffDelayMs(3, 300, 15_000, () => 0.999)).toBeLessThan(2400)
    expect(backoffDelayMs(50, 300, 15_000, () => 0.999)).toBeLessThan(15_000)
  })

  it('is full jitter, so a fleet that dropped together does not redial together', () => {
    expect(backoffDelayMs(8, 300, 15_000, () => 0)).toBe(0)
  })
})

describe('the link on its own', () => {
  it('keeps retrying a dial that fails, and waits longer each time', async () => {
    const delays: number[] = []
    let attempts = 0
    const link = new GatewayLink({
      dial: () => {
        attempts += 1

        return Promise.reject(new Error('the gateway is not there'))
      },
      onEvent: () => undefined,
      // No jitter and no real waiting, so the ladder is the thing under test.
      random: () => 1,
      sleep: async ms => {
        delays.push(ms)
        // Recorded, not slept: what is under test is the ladder, not the clock.
        // A real macrotask, so the retry loop cannot starve the assertion below.
        await new Promise(resolve => setTimeout(resolve, 1))
      },
      log: () => undefined
    })

    link.start()
    await waitFor(() => delays.length >= 4, 'four failed dials')

    expect(attempts).toBeGreaterThanOrEqual(4)
    expect(delays.slice(0, 4)).toEqual([300, 600, 1200, 2400])
    await link.stop()
  })
})
