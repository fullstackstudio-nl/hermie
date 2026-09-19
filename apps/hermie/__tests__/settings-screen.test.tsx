/**
 * Settings, and the one group that must not ship.
 *
 * The connection test prints the gateway's address and identity, and the
 * component gallery is a catalogue of fixtures. Both are tools for whoever is
 * building the app; neither belongs in a release someone installs.
 */
import { screen } from '@testing-library/react-native'

import { SettingsScreen } from '../src/features/settings/SettingsScreen'
import { GALLERY_ROW_TITLE } from '../src/features/settings/GalleryScreen'
import { useSettingsStore } from '../src/store/settings'
import { renderScreen } from './support/render'

jest.mock('../src/gateway', () => ({
  useGateway: () => ({
    changeGateway: jest.fn(),
    config: { authMode: 'native_pkce', baseUrl: 'https://gateway.example.com', version: '1.2.3' },
    signOut: jest.fn(),
    status: 'ready'
  })
}))

beforeEach(() => useSettingsStore.getState().reset())

describe('SettingsScreen', () => {
  it('shows the developer group in a development build', () => {
    renderScreen(<SettingsScreen />)

    expect(screen.getByText(GALLERY_ROW_TITLE)).toBeTruthy()
    expect(screen.getByText('Connection test')).toBeTruthy()
  })

  it('hides it everywhere else', () => {
    const previous = __DEV__

    ;(globalThis as unknown as { __DEV__: boolean }).__DEV__ = false

    try {
      const view = renderScreen(<SettingsScreen />)

      expect(view.queryByText(GALLERY_ROW_TITLE)).toBeNull()
      expect(view.queryByText('Connection test')).toBeNull()
      // The rest of the screen is untouched.
      expect(screen.getByText('https://gateway.example.com')).toBeTruthy()
    } finally {
      ;(globalThis as unknown as { __DEV__: boolean }).__DEV__ = previous
    }
  })
})
