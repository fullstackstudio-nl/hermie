/**
 * Settings, and the one group that must not ship.
 *
 * The connection test prints the gateway's address and identity, and the
 * component gallery is a catalogue of fixtures. Both are tools for whoever is
 * building the app; neither belongs in a release someone installs.
 */
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native'

import { SettingsScreen } from '../src/features/settings/SettingsScreen'
import { GALLERY_ROW_TITLE } from '../src/features/settings/GalleryScreen'
import { useSettingsStore } from '../src/store/settings'
import { renderScreen } from './support/render'

const mockEscapeListeners = new Set<() => void>()

jest.mock('../src/platform/keyboard-modifiers', () => ({
  isShiftDown: jest.fn(() => false),
  hasHardwareKeyboard: jest.fn(() => false),
  subscribeToEscape: (handler: () => void) => {
    mockEscapeListeners.add(handler)

    return () => mockEscapeListeners.delete(handler)
  }
}))

// The licence data is half a megabyte of generated JSON; this suite is about the
// row that opens it, not about the payload.
jest.mock('../src/features/settings/licences-data', () => ({
  loadLicenceData: async () => ({
    generatedBy: 'scripts/generate-third-party-licenses.mjs',
    scope: 'production dependencies of apps/hermie',
    excludesWorkspacePackages: ['@hermie/transcript'],
    packages: [{ name: 'expo', version: '54.0.37', licence: 'MIT' }],
    texts: {}
  })
}))

jest.mock('../src/gateway', () => ({
  useGateway: () => ({
    changeGateway: jest.fn(),
    config: { authMode: 'native_pkce', baseUrl: 'https://gateway.example.com', version: '1.2.3' },
    signOut: jest.fn(),
    status: 'ready'
  })
}))

beforeEach(() => {
  mockEscapeListeners.clear()
  useSettingsStore.getState().reset()
})

/** Press Escape, the way the native module would deliver it. */
function pressEscape() {
  act(() => {
    for (const listener of [...mockEscapeListeners]) {
      listener()
    }
  })
}

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

describe('About', () => {
  it('opens the licences from a row that ships in every build', async () => {
    const view = renderScreen(<SettingsScreen />)

    // Not behind `__DEV__`: an attribution obligation is not a developer tool.
    expect(screen.getByText('Licences')).toBeTruthy()

    fireEvent.press(screen.getByText('Licences'))

    await waitFor(() => expect(view.getByTestId('licences-list')).toBeTruthy())
    expect(screen.getByText('expo')).toBeTruthy()
  })

  it('comes back to Settings on Escape', async () => {
    const view = renderScreen(<SettingsScreen />)

    fireEvent.press(screen.getByText('Licences'))
    await waitFor(() => expect(view.getByTestId('licences-list')).toBeTruthy())

    pressEscape()

    expect(view.queryByTestId('licences-list')).toBeNull()
    // The first group of the Settings root. It used to be the screen's own large
    // title, which is gone: both shells already name this screen above it.
    expect(screen.getByText('GATEWAY')).toBeTruthy()
  })
})

describe('Settings and Escape', () => {
  /**
   * Escape goes back ONE level. A developer screen opened from Settings
   * registers on the Escape stack above whatever is holding Settings — the
   * overlay panel on the wide layout — so the first press returns here rather
   * than closing the panel out from under the reader.
   */
  it('returns from a developer screen to Settings', () => {
    renderScreen(<SettingsScreen />)

    fireEvent.press(screen.getByText('Connection test'))
    expect(screen.getByTestId('debug-status')).toBeTruthy()

    pressEscape()

    expect(screen.queryByTestId('debug-status')).toBeNull()
    expect(screen.getByText(GALLERY_ROW_TITLE)).toBeTruthy()
  })

  it('takes no part in the stack while Settings itself is on top', () => {
    renderScreen(<SettingsScreen />)

    // Nothing registered: Escape belongs to whatever is holding this screen.
    expect(mockEscapeListeners.size).toBe(0)
  })
})
