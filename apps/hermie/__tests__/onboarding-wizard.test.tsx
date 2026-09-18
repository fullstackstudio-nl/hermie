import { GatewayError, type ProbeResult, type TokenSet } from '@hermie/gateway-client'
import { fireEvent, screen, waitFor } from '@testing-library/react-native'

import { connectionPayloadKey, emptyDraft, type OnboardingDraft, OnboardingNavigator } from '../src/features/onboarding'
import { CONFIG_KEY, SECRET_KEYS } from '../src/gateway'
import { keyValueStore } from '../src/platform/key-value-store'
import { secretStore } from '../src/platform/secret-store'
import { renderScreen } from './support/render'

jest.mock('../src/features/onboarding/test-connection', () => ({
  CONNECTION_TEST_TIMEOUT_MS: 30_000,
  runConnectionTest: jest.fn()
}))

jest.mock('../src/platform/secret-store', () => ({
  secretStore: {
    get: jest.fn(async () => null),
    set: jest.fn(async () => undefined),
    delete: jest.fn(async () => undefined)
  }
}))

jest.mock('../src/platform/key-value-store', () => ({
  keyValueStore: {
    get: jest.fn(async () => null),
    set: jest.fn(async () => undefined),
    delete: jest.fn(async () => undefined),
    getJson: jest.fn(async () => null),
    setJson: jest.fn(async () => undefined)
  }
}))

const { runConnectionTest } = require('../src/features/onboarding/test-connection') as {
  runConnectionTest: jest.Mock
}

const GATED: ProbeResult = {
  version: '2026.9.14',
  authRequired: true,
  authFlows: ['cookie', 'native_pkce'],
  providers: [{ name: 'self-hosted', displayName: 'Self-Hosted OIDC', supportsPassword: false }],
  supportsNativePkce: true
}

const TOKENS: TokenSet = {
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  expiresAt: 4102444800,
  provider: 'self-hosted',
  userId: 'tester@example.invalid'
}

function signedInDraft(): OnboardingDraft {
  return {
    ...emptyDraft(),
    rawAddress: 'hermes.example.com',
    baseUrl: 'https://hermes.example.com',
    probe: GATED,
    provider: GATED.providers[0] ?? null,
    tokens: TOKENS
  }
}

const primaryButton = (name: string) => screen.getByRole('button', { name })
const isDisabled = (name: string) => primaryButton(name).props.accessibilityState?.disabled === true

beforeEach(() => {
  jest.clearAllMocks()
})

describe('the wizard as a whole', () => {
  it('walks Welcome → Gateway address → Sign in → Test connection → Done', () => {
    renderScreen(<OnboardingNavigator onComplete={jest.fn()} initialDraft={signedInDraft()} />)

    expect(screen.getByText('Welcome to Hermie')).toBeTruthy()
    expect(screen.queryByTestId('step-counter')).toBeNull()

    fireEvent.press(primaryButton('Set up a gateway'))
    expect(screen.getByTestId('step-counter')).toHaveTextContent('Step 1 of 4')
    expect(screen.getByText('Gateway address')).toBeTruthy()

    fireEvent.press(primaryButton('Continue'))
    expect(screen.getByTestId('step-counter')).toHaveTextContent('Step 2 of 4')
    expect(screen.getByText('Sign in')).toBeTruthy()

    fireEvent.press(primaryButton('Continue'))
    expect(screen.getByTestId('step-counter')).toHaveTextContent('Step 3 of 4')
    // The heading and the button share a label, so the gate line identifies the step.
    expect(screen.getByTestId('test-required')).toBeTruthy()
  })

  it('opens on the sign-in step when a sign-out left the address behind', () => {
    renderScreen(
      <OnboardingNavigator
        onComplete={jest.fn()}
        resumeConfig={{
          baseUrl: 'https://hermes.example.com',
          authMode: 'native_pkce',
          provider: 'self-hosted',
          providerDisplayName: 'Self-Hosted OIDC',
          version: '2026.9.14'
        }}
      />
    )

    expect(screen.getByText('Sign in')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Sign in with Self-Hosted OIDC' })).toBeTruthy()
  })
})

describe('the test-connection gate', () => {
  it('refuses to move on until the test has run', async () => {
    const draft = signedInDraft()
    runConnectionTest.mockResolvedValue({
      key: connectionPayloadKey(draft),
      userDisplayName: 'Fake Tester',
      botCount: 2
    })

    renderScreen(<OnboardingNavigator onComplete={jest.fn()} initialStep="test" initialDraft={draft} />)

    expect(isDisabled('Continue')).toBe(true)
    expect(screen.getByTestId('test-required')).toHaveTextContent('Run the test before finishing setup.')

    fireEvent.press(primaryButton('Test connection'))

    await waitFor(() =>
      expect(screen.getByTestId('test-result')).toHaveTextContent('Connected as Fake Tester · 2 bots')
    )
    expect(isDisabled('Continue')).toBe(false)
  })

  it('reports a rejected credential and stays shut', async () => {
    runConnectionTest.mockRejectedValue(new GatewayError('auth', 'raw', { closeCode: 4401 }))

    renderScreen(<OnboardingNavigator onComplete={jest.fn()} initialStep="test" initialDraft={signedInDraft()} />)
    fireEvent.press(primaryButton('Test connection'))

    await waitFor(() => expect(screen.getByTestId('test-error')).toHaveTextContent(/rejected the credentials/))
    expect(isDisabled('Continue')).toBe(true)
  })

  it('names the gateway address as the fix behind a 4403 close', async () => {
    runConnectionTest.mockRejectedValue(new GatewayError('config', 'raw', { closeCode: 4403 }))

    renderScreen(<OnboardingNavigator onComplete={jest.fn()} initialStep="test" initialDraft={signedInDraft()} />)
    fireEvent.press(primaryButton('Test connection'))

    await waitFor(() => expect(screen.getByTestId('test-error')).toHaveTextContent(/dashboard\.public_url/))
  })

  it('treats a result from a different payload as no result at all', () => {
    const draft = signedInDraft()
    const stale: OnboardingDraft = {
      ...draft,
      test: { key: 'a key from an earlier address', userDisplayName: 'Fake Tester', botCount: 2 }
    }

    renderScreen(<OnboardingNavigator onComplete={jest.fn()} initialStep="test" initialDraft={stale} />)

    expect(isDisabled('Continue')).toBe(true)
    expect(screen.getByTestId('test-required')).toHaveTextContent(
      'Something changed since the last test. Run it again.'
    )
    expect(screen.queryByTestId('test-result')).toBeNull()
  })
})

describe('the Done step', () => {
  it('writes the config to the key-value store and the tokens to the secret store', async () => {
    const draft = signedInDraft()
    const tested: OnboardingDraft = {
      ...draft,
      headers: [{ id: 'h1', name: 'CF-Access-Client-Id', value: 'client-id' }],
      test: { key: '', userDisplayName: 'Fake Tester', botCount: 2 }
    }
    const onComplete = jest.fn()

    renderScreen(<OnboardingNavigator onComplete={onComplete} initialStep="done" initialDraft={tested} />)
    fireEvent.press(primaryButton('Start chatting'))

    await waitFor(() => expect(onComplete).toHaveBeenCalled())

    expect(keyValueStore.setJson).toHaveBeenCalledWith(CONFIG_KEY, {
      baseUrl: 'https://hermes.example.com',
      authMode: 'native_pkce',
      provider: 'self-hosted',
      providerDisplayName: 'Self-Hosted OIDC',
      version: '2026.9.14',
      userDisplayName: 'Fake Tester'
    })
    expect(secretStore.set).toHaveBeenCalledWith(SECRET_KEYS.accessToken, 'access-1')
    expect(secretStore.set).toHaveBeenCalledWith(SECRET_KEYS.refreshToken, 'refresh-1')
    expect(secretStore.set).toHaveBeenCalledWith(
      SECRET_KEYS.tokenMeta,
      JSON.stringify({ expiresAt: 4102444800, provider: 'self-hosted', userId: 'tester@example.invalid' })
    )
    expect(secretStore.set).toHaveBeenCalledWith(
      SECRET_KEYS.extraHeaders,
      JSON.stringify({ 'CF-Access-Client-Id': 'client-id' })
    )
    expect(secretStore.set).not.toHaveBeenCalledWith(SECRET_KEYS.sessionToken, expect.anything())
  })

  it('stores the session token, and no bearer tokens, for an ungated gateway', async () => {
    const tested: OnboardingDraft = {
      ...emptyDraft(),
      rawAddress: 'localhost:9119',
      baseUrl: 'http://localhost:9119',
      probe: { ...GATED, authRequired: false, providers: [] },
      sessionToken: '  session-token-value  ',
      test: { key: '', userDisplayName: '', botCount: 2 }
    }
    const onComplete = jest.fn()

    renderScreen(<OnboardingNavigator onComplete={onComplete} initialStep="done" initialDraft={tested} />)
    fireEvent.press(primaryButton('Start chatting'))

    await waitFor(() => expect(onComplete).toHaveBeenCalled())

    expect(keyValueStore.setJson).toHaveBeenCalledWith(CONFIG_KEY, {
      baseUrl: 'http://localhost:9119',
      authMode: 'session_token',
      version: '2026.9.14'
    })
    expect(secretStore.set).toHaveBeenCalledWith(SECRET_KEYS.sessionToken, 'session-token-value')
    expect(secretStore.set).not.toHaveBeenCalledWith(SECRET_KEYS.accessToken, expect.anything())
    // No extra headers means the key is removed rather than left holding an old set.
    expect(secretStore.delete).toHaveBeenCalledWith(SECRET_KEYS.extraHeaders)
  })

  it('keeps the wizard open and explains itself when the write fails', async () => {
    ;(secretStore.set as jest.Mock).mockRejectedValueOnce(new Error('keychain is locked'))
    const onComplete = jest.fn()

    renderScreen(
      <OnboardingNavigator
        onComplete={onComplete}
        initialStep="done"
        initialDraft={{ ...signedInDraft(), test: { key: '', userDisplayName: 'Fake Tester', botCount: 2 } }}
      />
    )
    fireEvent.press(primaryButton('Start chatting'))

    await waitFor(() => expect(screen.getByTestId('done-error')).toHaveTextContent(/keychain is locked/))
    expect(onComplete).not.toHaveBeenCalled()
  })
})
