import { GatewayError, type AuthTimelineSnapshot, type ConnectionStatus } from '@hermie/gateway-client'
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native'

import { GatewayProvider, SignedOutPanel } from '../src/gateway'
import { useConnectionStore } from '../src/gateway/store'
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
  useConnectionStore.getState().setAuthTimeline({ events: [], lastSignOut: null })
})

/**
 * The signed-out state used to be a one-line banner over the chat and a small
 * "Sign in" in a corner, and a real Mac session reported the obvious: what the
 * reader saw was a chat error, and it was not clear at all that the thing to do
 * was sign in. It is a card in the content column now, and these are the same
 * three assertions the banner carried plus the ones the card owes: it names the
 * gateway, and the action is the in-place sign-in rather than the wizard.
 */
describe('the signed-out card', () => {
  /**
   * The card is only ever mounted by a shell that has decided to show it.
   *
   * `recorded` is applied after the provider has settled rather than before: the
   * provider's own startup restores the ring from disk and publishes it, so a
   * store seeded ahead of the render is replaced before anything reads it.
   */
  const renderWhenSignedOut = async (recorded?: AuthTimelineSnapshot) => {
    renderScreen(
      <GatewayProvider>
        <SignedOutPanel />
      </GatewayProvider>
    )

    await waitFor(() => expect(mockStatusHandlers.length).toBeGreaterThan(0))

    if (recorded) {
      act(() => useConnectionStore.getState().setAuthTimeline(recorded))
    }

    pushStatus('needs_signin', new GatewayError('auth', 'expired'))
  }

  it('names the gateway the session expired on', async () => {
    await renderWhenSignedOut()

    expect(screen.getByTestId('signed-out-panel')).toHaveTextContent(/Signed out/)
    expect(screen.getByTestId('signed-out-panel')).toHaveTextContent(/hermes\.example\.com/)
  })

  it('offers signing in and changing gateway, and nothing else', async () => {
    await renderWhenSignedOut()

    expect(screen.getByTestId('signed-out-sign-in')).toBeTruthy()
    expect(screen.getByTestId('signed-out-change-gateway')).toBeTruthy()
  })

  /**
   * The point of the in-place flow: a refresh token can expire while the app is
   * sitting there, and sending the reader back through the whole wizard for
   * that would be rude. The web view opens where they are.
   */
  it('signs in where the reader is rather than restarting setup', async () => {
    await renderWhenSignedOut()

    expect(screen.queryByTestId('sign-in-webview')).toBeNull()

    act(() => {
      fireEvent.press(screen.getByTestId('signed-out-sign-in'))
    })

    expect(screen.getByTestId('sign-in-webview')).toBeTruthy()
  })

  /**
   * A session that ends with no explanation reads as the app's fault. The auth
   * ring knows which of the several paths to `needs_signin` was taken, and one
   * sentence is the difference between "Hermie logged me out" and "the gateway
   * would not renew the session".
   */
  it('names the cause when the auth ring recorded one', async () => {
    await renderWhenSignedOut({
      events: [{ at: 1, event: 'signin.required', reason: 'refresh_rejected' }],
      lastSignOut: { at: 1, reason: 'refresh_rejected' }
    })

    expect(screen.getByTestId('signed-out-reason')).toHaveTextContent(/rejected the saved sign-in/)
  })

  it('tells a failed renewal apart from a rejected one', async () => {
    await renderWhenSignedOut({ events: [], lastSignOut: { at: 1, reason: 'refresh_failed' } })

    expect(screen.getByTestId('signed-out-reason')).toHaveTextContent(/did not complete/)
  })

  /**
   * Silence beats a guess. A sign-out from before this build, or down a path that
   * recorded nothing, gets no sentence rather than a plausible invention.
   */
  it('says nothing at all when there is no recorded cause', async () => {
    await renderWhenSignedOut()

    expect(screen.queryByTestId('signed-out-reason')).toBeNull()
  })
})
