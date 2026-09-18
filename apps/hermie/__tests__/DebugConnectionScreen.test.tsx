import { render, screen, userEvent } from '@testing-library/react-native'
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context'

import { SettingsScreen } from '../src/features/settings'
import { ThemeProvider } from '../src/ui/theme'

// react-native-safe-area-context measures a real view; tests hand it a frame.
const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 59, left: 0, right: 0, bottom: 34 }
}

jest.mock('@react-native-community/netinfo', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@react-native-community/netinfo/jest/netinfo-mock.js')
)

describe('SettingsScreen → Connection test', () => {
  it('opens the developer connection screen and starts disconnected', async () => {
    const user = userEvent.setup()

    render(
      <SafeAreaProvider initialMetrics={METRICS}>
        <ThemeProvider>
          <SettingsScreen />
        </ThemeProvider>
      </SafeAreaProvider>
    )

    await user.press(screen.getByText('Connection test'))

    expect(screen.getByText('Connection test')).toBeTruthy()
    expect(screen.getByDisplayValue('http://localhost:9119')).toBeTruthy()
    expect(screen.getByTestId('debug-status')).toHaveTextContent('disconnected')
  })
})
