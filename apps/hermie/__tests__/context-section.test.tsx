/**
 * Settings → Context, and the one thing the switch is allowed to mean.
 *
 * On TestFlight, against a real gateway with OIDC, "Use my name" showed OFF
 * while the setting behind it was on. The switch was rendered from the setting
 * AND a display name, and that gateway's `/api/auth/me` answers with a subject
 * and nothing else — so an off switch was saying "this is not being sent" about
 * a name the projection was perfectly willing to send. The switch is the
 * decision; which name travels is a row under it, printed the same way the
 * device facts are.
 */
import { screen } from '@testing-library/react-native'

import { ContextSection } from '../src/features/settings/ContextSection'
import { useBotsStore } from '../src/store/bots'
import { useDeviceContextStore } from '../src/store/device-context'
import { renderScreen } from './support/render'

/** Loaded and identified, on a gateway with no accounts so the notice is past. */
function identified(patch: { userId?: string; displayName?: string; email?: string } = {}): void {
  useDeviceContextStore.setState({
    loaded: true,
    baseUrl: 'https://gateway.example',
    gated: false,
    userId: patch.userId ?? 'oidc:7f3a-ce10',
    displayName: patch.displayName ?? '',
    email: patch.email ?? '',
    acknowledgedFor: ''
  })
}

beforeEach(() => {
  useBotsStore.getState().reset()
  useDeviceContextStore.getState().reset()
})

describe('the name switch', () => {
  it('is on where the gateway supplied no display name at all', () => {
    identified()
    renderScreen(<ContextSection />)

    expect(screen.getByTestId('settings-context-name').props.accessibilityState.checked).toBe(true)
    expect(screen.getByTestId('settings-context-name').props.accessibilityState.disabled).toBeFalsy()
  })

  it('follows the stored setting rather than whether a name is known', () => {
    identified({ displayName: 'Sebas' })
    useDeviceContextStore.setState({ shareDisplayName: false })
    renderScreen(<ContextSection />)

    expect(screen.getByTestId('settings-context-name').props.accessibilityState.checked).toBe(false)
  })
})

describe('the name that will be sent', () => {
  it('prints the gateway’s own display name, and says where it came from', () => {
    identified({ displayName: 'Sebas', email: 'sebas@example.invalid' })
    renderScreen(<ContextSection />)

    expect(screen.getByText('Sebas')).toBeTruthy()
    expect(screen.getByText('From your gateway sign-in')).toBeTruthy()
  })

  it('prints the fallback the projection will actually send', () => {
    identified({ email: 'sebas@example.invalid' })
    renderScreen(<ContextSection />)

    expect(screen.getByText('sebas')).toBeTruthy()
  })

  it('prints the subject without its provider prefix when that is all there is', () => {
    identified()
    renderScreen(<ContextSection />)

    expect(screen.getByText('7f3a-ce10')).toBeTruthy()
  })

  it('says so when the gateway has named nobody, and leaves the switch on', () => {
    identified({ userId: '' })
    renderScreen(<ContextSection />)

    expect(screen.getByText('No name known yet')).toBeTruthy()
    expect(screen.queryByText('From your gateway sign-in')).toBeNull()
    expect(screen.getByTestId('settings-context-name').props.accessibilityState.checked).toBe(true)
  })
})
