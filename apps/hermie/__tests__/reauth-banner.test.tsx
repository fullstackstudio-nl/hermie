import { GatewayError, type ConnectionStatus } from '@hermie/gateway-client'
import { act, screen, waitFor } from '@testing-library/react-native'

import { GatewayProvider, ReauthBanner } from '../src/gateway'
import { renderScreen } from './support/render'

const mockStatusHandlers: ((status: ConnectionStatus, error: GatewayError | null) => void)[] = []
const mockResume = jest.fn()
const mockSaveTokens = jest.fn(async () => undefined)

jest.mock('../src/gateway/client', () => ({
  attachLifecycle: () => () => undefined,
  createTokenCoordinator: () => ({ save: (...args: unknown[]) => mockSaveTokens(...(args as [])) }),
  createGatewayConnection: () => ({
    http: {},
    start: jest.fn(),
    stop: jest.fn(),
    resume: () => mockResume(),
    onStatus: (handler: (status: ConnectionStatus, error: GatewayError | null) => void) => {
      mockStatusHandlers.push(handler)
      handler('disconnected', null)

      return () => undefined
    }
  })
}))

jest.mock('../src/platform/key-value-store', () => ({
  keyValueStore: {
    get: jest.fn(async () => null),
    set: jest.fn(async () => undefined),
    delete: jest.fn(async () => undefined),
    getJson: jest.fn(async () => ({
      baseUrl: 'https://hermes.example.com',
      authMode: 'native_pkce',
      provider: 'self-hosted',
      providerDisplayName: 'Self-Hosted OIDC',
      version: '2026.9.14'
    })),
    setJson: jest.fn(async () => undefined)
  }
}))

jest.mock('../src/platform/secret-store', () => ({
  secretStore: {
    get: jest.fn(async (key: string) => (key === 'hermie.auth.access_token' ? 'access-1' : null)),
    set: jest.fn(async () => undefined),
    delete: jest.fn(async () => undefined)
  }
}))

const pushStatus = (status: ConnectionStatus, error: GatewayError | null = null) =>
  act(() => {
    for (const handler of mockStatusHandlers) {
      handler(status, error)
    }
  })

beforeEach(() => {
  mockStatusHandlers.length = 0
  jest.clearAllMocks()
})

describe('the reauthentication banner', () => {
  it('stays out of the way while the connection is healthy', async () => {
    renderScreen(
      <GatewayProvider>
        <ReauthBanner />
      </GatewayProvider>
    )

    await waitFor(() => expect(mockStatusHandlers.length).toBeGreaterThan(0))
    pushStatus('ready')

    expect(screen.queryByTestId('reauth-banner')).toBeNull()
  })

  it('appears with a sign-in action once the gateway says the session is gone', async () => {
    renderScreen(
      <GatewayProvider>
        <ReauthBanner />
      </GatewayProvider>
    )

    await waitFor(() => expect(mockStatusHandlers.length).toBeGreaterThan(0))
    pushStatus('needs_signin', new GatewayError('auth', 'expired'))

    expect(screen.getByTestId('reauth-banner')).toHaveTextContent(/session on this gateway has expired/)
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy()
  })

  it('goes away again when the connection recovers', async () => {
    renderScreen(
      <GatewayProvider>
        <ReauthBanner />
      </GatewayProvider>
    )

    await waitFor(() => expect(mockStatusHandlers.length).toBeGreaterThan(0))
    pushStatus('needs_signin', new GatewayError('auth', 'expired'))
    expect(screen.getByTestId('reauth-banner')).toBeTruthy()

    pushStatus('ready', null)
    expect(screen.queryByTestId('reauth-banner')).toBeNull()
  })
})
