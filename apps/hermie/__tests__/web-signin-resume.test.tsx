/**
 * Signing in again, after signing out.
 *
 * `draftFromConfig` synthesises a probe from the stored gateway so the wizard
 * can open straight on the sign-in step. A preference file knows the auth MODE;
 * it cannot know whether the provider takes a password, and the entry it makes
 * says `false`. The step read `draft.probe ?? (await probeGateway(baseUrl))`,
 * so on every resume it believed that fabricated answer, never asked the
 * gateway, and offered the redirect and nothing else — the in-app form, the one
 * the password manager fills, was unreachable for exactly the visitor who had
 * used it before.
 *
 * The `.web` half by its real name, as every seam test here does: the native
 * sibling has no password form to look for.
 */
import { screen, waitFor } from '@testing-library/react-native'
import { probeGateway } from '@hermie/gateway-client'

import { draftFromConfig } from '../src/features/onboarding/draft'
import { SignInStep } from '../src/features/onboarding/steps/SignInStep.web'
import { renderScreen } from './support/render'

jest.mock('@hermie/gateway-client', () => ({
  ...jest.requireActual('@hermie/gateway-client'),
  probeGateway: jest.fn(),
  // No session yet, which is the ordinary state one screen after a sign-out.
  // Left real, this reaches `fetch` and the test hangs rather than fails.
  GatewayHttp: class {
    authMe() {
      return Promise.reject(new Error('no session'))
    }
  }
}))

// `authModeOf` only answers `cookie` in a browser, and Jest runs the native
// platform — so the whole branch this file is about would render nothing.
jest.mock('../src/platform/runs-in-browser', () => ({ RUNS_IN_BROWSER: true }))

jest.mock('../src/gateway/web-config', () => ({
  loadHermieWebConfig: jest.fn().mockResolvedValue({
    gatewayHost: '127.0.0.1:9119',
    loginReturn: '/',
    version: '0.1.0'
  })
}))

const probe = jest.mocked(probeGateway)

const LIVE_PROBE = {
  version: '0.21.3-fake',
  authRequired: true,
  authFlows: ['cookie'],
  providers: [{ name: 'self-hosted', displayName: 'Self-Hosted OIDC', supportsPassword: true }],
  supportsNativePkce: false
}

beforeEach(() => {
  probe.mockReset()
  probe.mockResolvedValue(LIVE_PROBE)
})

describe('resuming the wizard after a sign-out', () => {
  it('asks the gateway rather than believing the stored config', async () => {
    // Exactly what a sign-out leaves behind, including the `supportsPassword`
    // nobody could have known.
    const resumed = draftFromConfig({
      baseUrl: 'http://127.0.0.1:9120',
      authMode: 'cookie',
      provider: 'self-hosted',
      providerDisplayName: 'Self-Hosted OIDC',
      version: '0.21.3-fake'
    })

    expect(resumed.probe?.providers[0]?.supportsPassword).toBe(false)

    renderScreen(<SignInStep draft={resumed} update={jest.fn()} />)

    await waitFor(() => expect(probe).toHaveBeenCalledWith('http://127.0.0.1:9120'))
  })

  it('offers the in-app form once the gateway says the provider takes a password', async () => {
    renderScreen(
      <SignInStep
        draft={{ ...draftFromConfig({ baseUrl: 'http://127.0.0.1:9120', authMode: 'cookie' }), probe: LIVE_PROBE }}
        update={jest.fn()}
      />
    )

    await waitFor(() => expect(screen.getByTestId('cookie-username')).toBeTruthy())
    expect(screen.getByTestId('cookie-password')).toBeTruthy()
    expect(screen.getByTestId('cookie-password-submit')).toBeTruthy()
  })
})
