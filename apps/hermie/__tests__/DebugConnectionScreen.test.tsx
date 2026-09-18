import { screen, userEvent, waitFor } from '@testing-library/react-native'

import { SettingsScreen } from '../src/features/settings'
import { GatewayProvider } from '../src/gateway'
import { renderScreen } from './support/render'

describe('SettingsScreen → Connection test', () => {
  it('opens the developer connection screen and starts disconnected', async () => {
    const user = userEvent.setup()

    renderScreen(
      <GatewayProvider>
        <SettingsScreen />
      </GatewayProvider>
    )

    // The provider reads the (empty) configuration off disk before anything
    // renders its values.
    await waitFor(() => expect(screen.getByText('Settings')).toBeTruthy())
    await user.press(screen.getByText('Connection test'))

    expect(screen.getByText('Connection test')).toBeTruthy()
    expect(screen.getByDisplayValue('http://localhost:9119')).toBeTruthy()
    expect(screen.getByTestId('debug-status')).toHaveTextContent('disconnected')
  })
})
