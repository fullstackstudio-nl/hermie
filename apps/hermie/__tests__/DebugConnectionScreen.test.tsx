import { screen, userEvent, waitFor } from '@testing-library/react-native'

import { SettingsScreen } from '../src/features/settings'
import { GatewayProvider } from '../src/gateway'
import { useConnectionStore } from '../src/gateway/store'
import { useChatsStore } from '../src/store/chats'
import { renderScreen } from './support/render'

describe('SettingsScreen → Connection test', () => {
  // Before, not after: resetting a store while the screen reading it is still
  // mounted is a state update outside `act`.
  beforeEach(() => {
    useChatsStore.getState().reset()
    useConnectionStore.getState().setAuthTimeline({ events: [], lastSignOut: null })
  })

  it('opens the developer connection screen and starts disconnected', async () => {
    const user = userEvent.setup()

    renderScreen(
      <GatewayProvider>
        <SettingsScreen />
      </GatewayProvider>
    )

    // The provider reads the (empty) configuration off disk before anything
    // renders its values. Waiting on the first group header rather than on a
    // title: Settings has none of its own, because both shells name it above.
    await waitFor(() => expect(screen.getByText('GATEWAY')).toBeTruthy())
    await user.press(screen.getByText('Connection test'))

    expect(screen.getByText('Connection test')).toBeTruthy()
    expect(screen.getByDisplayValue('http://localhost:9119')).toBeTruthy()
    expect(screen.getByTestId('debug-status')).toHaveTextContent('disconnected')
  })

  it('reports what a live transcript holds without showing what it says', async () => {
    const user = userEvent.setup()

    useChatsStore.getState().ensure('researcher', { storedSessionId: 'stored-1', resolvedSessionId: 'tip-1' })
    useChatsStore.getState().beginTurn('researcher', 'the exact words nobody else should read')

    renderScreen(
      <GatewayProvider>
        <SettingsScreen />
      </GatewayProvider>
    )

    await waitFor(() => expect(screen.getByText('GATEWAY')).toBeTruthy())
    await user.press(screen.getByText('Connection test'))

    const lines = screen.getAllByTestId('debug-transcript-line').map(node => node.props.children)

    expect(lines[0]).toBe('researcher: 1 items, 0 persisted, 1 unpaired')
    expect(lines.join('\n')).not.toContain('nobody else should read')
  })

  /**
   * The screen an owner is sent to after a session ends for no visible reason.
   * A Mac session did exactly that — no gateway restart, one process — and there
   * was nothing to read afterwards, so the diagnosis started from "we do not
   * know". These lines are what stops that happening twice.
   */
  it('shows the auth timeline and the last sign-out it recorded', async () => {
    const user = userEvent.setup()

    renderScreen(
      <GatewayProvider>
        <SettingsScreen />
      </GatewayProvider>
    )

    // After the provider has settled, not before: its own startup restores the
    // ring from disk and publishes it, which would replace anything seeded here.
    await waitFor(() => expect(screen.getByText('GATEWAY')).toBeTruthy())

    useConnectionStore.getState().setAuthTimeline({
      events: [
        { at: Date.parse('2026-09-20T11:00:00Z'), event: 'token.served', expiresIn: -12 },
        { at: Date.parse('2026-09-20T11:00:01Z'), event: 'ticket.minted' },
        { at: Date.parse('2026-09-20T11:00:02Z'), event: 'ws.closed', closeCode: 4401 },
        { at: Date.parse('2026-09-20T11:00:03Z'), event: 'refresh.failed', kind: 'auth', status: 401 },
        { at: Date.parse('2026-09-20T11:00:04Z'), event: 'signin.required', reason: 'refresh_rejected' }
      ],
      lastSignOut: { at: Date.parse('2026-09-20T11:00:04Z'), reason: 'refresh_rejected' }
    })

    await user.press(screen.getByText('Connection test'))

    expect(screen.getByTestId('debug-auth-signout')).toHaveTextContent(/last sign-out: refresh_rejected/)

    const lines = screen.getAllByTestId('debug-auth-event').map(node => String(node.props.children))

    expect(lines).toHaveLength(5)
    expect(lines[2]).toContain('ws.closed · close 4401')
    expect(lines[3]).toContain('refresh.failed · http 401 · auth')
    // Signed, so an already-expired token is visibly expired rather than rounded
    // into looking fine — which is how clock drift shows itself.
    expect(lines[0]).toContain('expires in -12s')
  })

  it('says so plainly when no sign-out has been recorded', async () => {
    const user = userEvent.setup()

    renderScreen(
      <GatewayProvider>
        <SettingsScreen />
      </GatewayProvider>
    )

    await waitFor(() => expect(screen.getByText('GATEWAY')).toBeTruthy())
    await user.press(screen.getByText('Connection test'))

    expect(screen.getByTestId('debug-auth-signout')).toHaveTextContent(/none recorded on this device/)
    expect(screen.queryAllByTestId('debug-auth-event')).toHaveLength(0)
  })
})
