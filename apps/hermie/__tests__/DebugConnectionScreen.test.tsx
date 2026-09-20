import { screen, userEvent, waitFor } from '@testing-library/react-native'

import { SettingsScreen } from '../src/features/settings'
import { GatewayProvider } from '../src/gateway'
import { useChatsStore } from '../src/store/chats'
import { renderScreen } from './support/render'

describe('SettingsScreen → Connection test', () => {
  // Before, not after: resetting a store while the screen reading it is still
  // mounted is a state update outside `act`.
  beforeEach(() => {
    useChatsStore.getState().reset()
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
})
