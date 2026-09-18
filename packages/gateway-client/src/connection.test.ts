import { startFakeGateway, type FakeGateway } from '@hermie/fake-gateway'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket as NodeWebSocket } from 'ws'

import {
  assertDesktopContract,
  FIRST_SESSION_TIMEOUT_MS,
  GatewayConnection,
  PROMPT_SUBMIT_TIMEOUT_MS,
  DEFAULT_RPC_TIMEOUT_MS,
  rpcTimeoutMs
} from './connection'
import { NativePkceCredentials, SessionTokenCredentials } from './credentials'
import { exchangeCode, TokenCoordinator, type TokenSet, type TokenStore } from './native-auth'
import { buildAuthorizeUrl, createPkce, parseLoopbackRedirect, REDIRECT_URI } from './pkce'
import { DialPlanSocketFactory, type WebSocketConstructorLike } from './socket-factory'
import type { ConnectionStatus } from './types'

const SocketImpl = NodeWebSocket as unknown as WebSocketConstructorLike

const live: { gateway: FakeGateway; connection?: GatewayConnection }[] = []

afterEach(async () => {
  for (const entry of live.splice(0)) {
    entry.connection?.stop()
    await entry.gateway.close()
  }
})

function memoryStore(initial: TokenSet | null = null): TokenStore {
  let stored = initial

  return {
    async load() {
      return stored
    },
    async save(tokens) {
      stored = tokens
    },
    async clear() {
      stored = null
    }
  }
}

/** Walk the real native PKCE round trip against the fake gateway. */
async function signIn(gateway: FakeGateway): Promise<TokenSet> {
  const pkce = createPkce()
  const authorize = new URL(
    buildAuthorizeUrl(gateway.url, {
      provider: 'self-hosted',
      challenge: pkce.challenge,
      state: pkce.state,
      redirectUri: REDIRECT_URI
    })
  )
  authorize.searchParams.set('auto', '1')

  const response = await fetch(authorize, { redirect: 'manual' })
  const location = response.headers.get('location')

  if (!location) {
    throw new Error(`The authorize endpoint did not redirect (HTTP ${response.status}).`)
  }

  const redirect = parseLoopbackRedirect(location)

  if ('error' in redirect) {
    throw new Error(`Sign-in failed: ${redirect.error}`)
  }

  expect(redirect.state).toBe(pkce.state)

  return exchangeCode(gateway.url, { code: redirect.code, verifier: pkce.verifier })
}

interface Harness {
  gateway: FakeGateway
  connection: GatewayConnection
  statuses: ConnectionStatus[]
  waitFor: (status: ConnectionStatus, timeoutMs?: number) => Promise<void>
}

async function harness(options: {
  auth?: 'none' | 'token' | 'native'
  closeCode?: number
  heartbeatIntervalMs?: number
  streamDelayMs?: number
}): Promise<Harness> {
  const auth = options.auth ?? 'none'
  const gateway = await startFakeGateway({
    auth,
    ...(options.closeCode === undefined ? {} : { closeCode: options.closeCode }),
    ...(options.streamDelayMs === undefined ? {} : { streamDelayMs: options.streamDelayMs })
  })
  const entry: { gateway: FakeGateway; connection?: GatewayConnection } = { gateway }
  live.push(entry)

  let credentials
  let coordinator: TokenCoordinator | undefined

  if (auth === 'native') {
    const store = memoryStore(await signIn(gateway))
    coordinator = new TokenCoordinator({
      store,
      refresh: async tokens => {
        const { refreshTokens } = await import('./native-auth')

        return refreshTokens(gateway.url, tokens)
      }
    })
    credentials = new NativePkceCredentials({ baseUrl: gateway.url, coordinator })
  } else {
    credentials = new SessionTokenCredentials({ token: gateway.state.token })
  }

  const factory = new DialPlanSocketFactory(SocketImpl)
  const connection = new GatewayConnection({
    config: { baseUrl: gateway.url, authMode: auth === 'native' ? 'native_pkce' : 'session_token' },
    credentials,
    socketFactory: factory,
    backoffDelayMs: () => 10,
    readyTimeoutMs: 2000,
    connectTimeoutMs: 2000,
    heartbeatIntervalMs: options.heartbeatIntervalMs ?? 0,
    heartbeatDeadlineMs: options.heartbeatIntervalMs ? 5000 : 0
  })
  entry.connection = connection

  const statuses: ConnectionStatus[] = []
  connection.onStatus(status => statuses.push(status))

  const waitFor = async (status: ConnectionStatus, timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs

    while (Date.now() < deadline) {
      if (connection.status === status) {
        return
      }

      await new Promise(resolve => setTimeout(resolve, 5))
    }

    throw new Error(
      `Timed out waiting for "${status}"; the connection is "${connection.status}" ` +
        `(seen: ${statuses.join(' → ')}; last error: ${connection.lastError?.message ?? 'none'})`
    )
  }

  return { gateway, connection, statuses, waitFor }
}

const settle = (ms = 60) => new Promise(resolve => setTimeout(resolve, ms))

describe('GatewayConnection against the fake gateway', () => {
  it('dials, waits for gateway.ready and answers the heartbeat', async () => {
    const { connection, gateway, statuses, waitFor } = await harness({ auth: 'token', heartbeatIntervalMs: 25 })

    connection.start()
    await waitFor('ready')

    expect(statuses).toEqual(['disconnected', 'authenticating', 'connecting', 'ready'])
    expect(connection.replayEpoch).toBe(gateway.state.replayEpoch)
    expect(connection.lastReadyAt).toBeGreaterThan(0)

    await settle(120)
    // The vendored channel announces itself once per connection generation, and
    // then keeps the socket honest with `gateway.ping`.
    expect(gateway.state.methodLog).toContain('client.capabilities')
    expect(gateway.state.methodLog).toContain('gateway.ping')
    expect(connection.status).toBe('ready')

    const profiles = await connection.request('profiles.list', { include_sessions: true })
    expect(profiles.profiles?.map(profile => profile.name)).toEqual(['researcher', 'writer'])
  })

  it('mints one ticket per dial and never reuses one', async () => {
    const { connection, gateway, waitFor } = await harness({ auth: 'native' })

    connection.start()
    await waitFor('ready')
    expect(gateway.state.ticketsMinted).toBe(1)
    expect(gateway.state.ticketsConsumed).toBe(1)

    connection.pause()
    await waitFor('paused')
    connection.resume()
    await waitFor('ready')

    expect(gateway.state.ticketsMinted).toBe(2)
    expect(gateway.state.ticketsConsumed).toBe(2)
    expect(gateway.state.connections).toBe(2)
  })

  it('recovers from a 4401 by refreshing once and redialling', async () => {
    const { connection, gateway, statuses, waitFor } = await harness({ auth: 'native' })

    gateway.state.rejectNextUpgrades = 1

    connection.start()
    await waitFor('ready')

    expect(gateway.state.rejectedUpgrades).toBe(1)
    expect(gateway.state.refreshCalls).toBe(1)
    expect(statuses).not.toContain('needs_signin')
    expect(gateway.state.ticketsMinted).toBe(2)
  })

  it('stops at needs_signin after a second 4401 in a row', async () => {
    const { connection, gateway, waitFor } = await harness({ auth: 'native' })

    gateway.state.rejectNextUpgrades = 2

    connection.start()
    await waitFor('needs_signin')

    expect(connection.lastError?.kind).toBe('auth')
    expect(gateway.state.rejectedUpgrades).toBe(2)

    // Terminal: no further dials.
    await settle(150)
    expect(gateway.state.rejectedUpgrades).toBe(2)
    expect(connection.status).toBe('needs_signin')
  })

  it('treats a 4403 as a configuration problem and does not loop', async () => {
    const { connection, gateway, waitFor } = await harness({ auth: 'token' })

    connection.start()
    await waitFor('ready')
    expect(gateway.state.connections).toBe(1)

    gateway.closeSockets(4403, 'host not allowed')
    await waitFor('disconnected')

    expect(connection.lastError?.kind).toBe('config')
    expect(connection.lastError?.closeCode).toBe(4403)
    expect(connection.lastError?.message).toMatch(/dashboard\.public_url/)

    await settle(200)
    expect(gateway.state.connections).toBe(1)
    expect(connection.status).toBe('disconnected')
  })

  it('reconnects after an abrupt drop and replays the events it missed', async () => {
    const { connection, gateway, statuses, waitFor } = await harness({ auth: 'token', streamDelayMs: 1 })

    connection.start()
    await waitFor('ready')

    const profiles = await connection.request('profiles.list', { include_sessions: true })
    const sessionId = profiles.profiles?.[0]?.canonical_session?.id as string
    expect(sessionId).toBeTruthy()

    await connection.request('session.resume', { session_id: sessionId, omit_messages: true })

    const complete = new Promise<void>(resolve => {
      const off = connection.on('message.complete', () => {
        off()
        resolve()
      })
    })
    await connection.request('prompt.submit', { session_id: sessionId, text: 'hello' })
    await complete

    // The gateway goes away without a close frame; the client sees 1006.
    gateway.dropSockets()
    await waitFor('reconnecting')
    await waitFor('ready')

    expect(statuses.filter(status => status === 'ready')).toHaveLength(2)
    expect(gateway.state.connections).toBe(2)

    await settle(120)
    expect(gateway.state.eventsSinceCalls.length).toBeGreaterThanOrEqual(1)
    expect(gateway.state.eventsSinceCalls[0]?.last_seen).toBeGreaterThan(0)
  })

  it('runs a single refresh for two concurrent 401s', async () => {
    const { connection, gateway, waitFor } = await harness({ auth: 'native' })

    connection.start()
    await waitFor('ready')

    // Every stored access token stops working, but the refresh token still does.
    gateway.state.accessTokens.clear()

    const [first, second] = await Promise.all([connection.http.authMe(), connection.http.authMe()])

    expect(first.userId).toBe('tester@example.invalid')
    expect(second.userId).toBe('tester@example.invalid')
    expect(gateway.state.refreshCalls).toBe(1)
  })

  it('pauses without reconnecting and resumes immediately', async () => {
    const { connection, gateway, statuses, waitFor } = await harness({ auth: 'token' })

    connection.start()
    await waitFor('ready')

    connection.pause()
    await waitFor('paused')
    await settle(150)

    expect(gateway.state.connections).toBe(1)
    expect(statuses).not.toContain('reconnecting')

    connection.resume()
    await waitFor('ready')
    expect(gateway.state.connections).toBe(2)
  })

  it('goes offline without dialling and comes back when the network does', async () => {
    const { connection, gateway, waitFor } = await harness({ auth: 'token' })

    connection.start()
    await waitFor('ready')

    connection.setOnline(false)
    await waitFor('offline')
    await settle(150)
    expect(gateway.state.connections).toBe(1)

    connection.setOnline(true)
    await waitFor('ready')
    expect(gateway.state.connections).toBe(2)
  })

  it('answers a server-to-client approval request', async () => {
    const { connection, gateway, waitFor } = await harness({ auth: 'token' })

    connection.start()
    await waitFor('ready')

    const seen: string[] = []
    connection.onRequest(request => {
      seen.push(request.method)
      request.respond({ choice: 'once' })

      return true
    })

    const answer = await gateway.requestApproval({
      session_id: 'stored-researcher',
      request_id: 'ap-1',
      command: 'rm -rf build',
      description: 'Remove the build directory',
      choices: ['once', 'session', 'always', 'deny']
    })

    expect(seen).toEqual(['approval'])
    expect(answer).toEqual({ choice: 'once' })
  })

  it('declines a server request nobody handles, so the backend is not left waiting', async () => {
    const { connection, gateway, waitFor } = await harness({ auth: 'token' })

    connection.start()
    await waitFor('ready')

    await expect(gateway.requestApproval({ session_id: 's', request_id: 'ap-2' })).rejects.toThrow(/-32601/)
  })

  it('delivers a pushed gateway event to a typed subscriber', async () => {
    const { connection, gateway, waitFor } = await harness({ auth: 'token' })

    connection.start()
    await waitFor('ready')

    const changed = new Promise<void>(resolve => {
      const off = connection.on('sessions.changed', () => {
        off()
        resolve()
      })
    })

    gateway.emit('sessions.changed', { payload: {} })
    await changed
  })

  it('lets a caller shorten the prompt.submit timeout', async () => {
    const { connection, gateway, waitFor } = await harness({ auth: 'token' })

    connection.start()
    await waitFor('ready')

    const profiles = await connection.request('profiles.list', { include_sessions: true })
    const sessionId = profiles.profiles?.[0]?.canonical_session?.id as string

    gateway.state.hangMethods.add('prompt.submit')

    const started = Date.now()
    await expect(
      connection.request('prompt.submit', { session_id: sessionId, text: 'hello' }, { timeoutMs: 80 })
    ).rejects.toThrow(/timed out/)

    // The default for this method is half an hour; the override has to win.
    expect(Date.now() - started).toBeLessThan(2000)
  })
})

describe('rpcTimeoutMs', () => {
  it('gives a prompt half an hour', () => {
    expect(rpcTimeoutMs('prompt.submit', true)).toBe(PROMPT_SUBMIT_TIMEOUT_MS)
  })

  it('gives the first session call after a connect a minute, and later ones the default', () => {
    expect(rpcTimeoutMs('session.resume', false)).toBe(FIRST_SESSION_TIMEOUT_MS)
    expect(rpcTimeoutMs('session.create', false)).toBe(FIRST_SESSION_TIMEOUT_MS)
    expect(rpcTimeoutMs('session.resume', true)).toBe(DEFAULT_RPC_TIMEOUT_MS)
  })

  it('gives everything else thirty seconds', () => {
    expect(rpcTimeoutMs('profiles.list', false)).toBe(DEFAULT_RPC_TIMEOUT_MS)
  })
})

describe('assertDesktopContract', () => {
  it('accepts contract 7 and above, as a number or a string', () => {
    expect(assertDesktopContract({ desktop_contract: 7 })).toBe(7)
    expect(assertDesktopContract({ desktop_contract: '9' })).toBe(9)
  })

  it('refuses an older contract', () => {
    expect(() => assertDesktopContract({ desktop_contract: 6 })).toThrow(/needs at least 7/)
  })

  it('refuses a gateway that reports no contract at all', () => {
    expect(() => assertDesktopContract({})).toThrow(/does not report a desktop contract/)
    expect(() => assertDesktopContract(null)).toThrow(/does not report a desktop contract/)
  })
})
