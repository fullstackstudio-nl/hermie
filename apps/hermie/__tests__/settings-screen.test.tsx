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

const HTTPS_CONFIG = { authMode: 'native_pkce', baseUrl: 'https://gateway.example.com', version: '1.2.3' }
let mockGatewayConfig: Record<string, unknown> = HTTPS_CONFIG

jest.mock('../src/gateway', () => ({
  useGateway: () => ({
    changeGateway: jest.fn(),
    config: mockGatewayConfig,
    signOut: jest.fn(),
    status: 'ready'
  })
}))

beforeEach(() => {
  mockEscapeListeners.clear()
  mockGatewayConfig = HTTPS_CONFIG
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

/**
 * Settings names the scheme in the address either way. The extra line under it
 * is only for the case the reader can do something about: cleartext to an
 * address anybody can be on the path to.
 */
describe('Settings and a cleartext gateway', () => {
  it('says nothing under an https address', () => {
    renderScreen(<SettingsScreen />)

    expect(screen.getByText('https://gateway.example.com')).toBeTruthy()
    expect(screen.queryByTestId('transport-notice')).toBeNull()
  })

  it('says nothing under a tailnet address, which is the ordinary setup', () => {
    mockGatewayConfig = { ...HTTPS_CONFIG, baseUrl: 'http://hermes.tail9f3c.ts.net' }
    renderScreen(<SettingsScreen />)

    expect(screen.getByText('http://hermes.tail9f3c.ts.net')).toBeTruthy()
    expect(screen.queryByTestId('transport-notice')).toBeNull()
  })

  it('warns under a public http address', () => {
    mockGatewayConfig = { ...HTTPS_CONFIG, baseUrl: 'http://gateway.example.com' }
    renderScreen(<SettingsScreen />)

    expect(screen.getByTestId('transport-notice')).toHaveTextContent(/Anyone on the path/)
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

/**
 * The theme picker.
 *
 * The cards are the part worth a test, because they are the part that can
 * silently stop being true: each one paints the theme it names, through the same
 * `resolveThemeFace` the live window is built with. If a card ever stopped
 * following the theme it points at, a reader would pick a window they were never
 * shown.
 */
describe('Settings → Appearance', () => {
  it('offers a card per preset, and marks the one that is on', () => {
    renderScreen(<SettingsScreen />)

    for (const name of ['blue', 'graphite', 'lime']) {
      expect(screen.getByTestId(`theme-card-${name}`)).toBeTruthy()
    }

    // The card is authored with `aria-checked`, because react-native-web drops
    // an `accessibilityState` object entirely and a radio's state is `checked`
    // in ARIA rather than `selected`. React Native normalises the aria spelling
    // back into `accessibilityState` on the host node, which is why this
    // assertion did not have to move: the native announcement is unchanged.
    expect(screen.getByTestId('theme-card-blue').props.accessibilityState.checked).toBe(true)
    expect(screen.getByTestId('theme-card-lime').props.accessibilityState.checked).toBe(false)
  })

  it('switches the theme, and the preview follows', () => {
    renderScreen(<SettingsScreen />)

    fireEvent.press(screen.getByTestId('theme-card-lime'))

    expect(useSettingsStore.getState().themeChoice).toEqual({ kind: 'preset', name: 'lime' })
  })

  it('paints each card in its own theme rather than in the app’s', () => {
    renderScreen(<SettingsScreen />)

    const backgroundOf = (name: string): unknown =>
      // `style` is an array on a `View` with two style objects; the flat form is
      // what the renderer hands back here.
      screen.getByTestId(`theme-card-${name}-preview`).props.style.backgroundColor

    expect(backgroundOf('blue')).not.toBe(backgroundOf('graphite'))
    expect(backgroundOf('graphite')).not.toBe(backgroundOf('lime'))
  })

  it('shows a theme the reader made beside the presets', () => {
    act(() => {
      useSettingsStore.getState().createUserTheme('lime', 'Studio')
    })

    renderScreen(<SettingsScreen />)

    const id = useSettingsStore.getState().userThemes[0]?.id ?? ''

    expect(screen.getByTestId(`theme-card-user-${id}`)).toBeTruthy()
  })

  it('opens the advanced page and comes back with Escape', () => {
    renderScreen(<SettingsScreen />)

    fireEvent.press(screen.getByTestId('settings-themes-advanced'))
    expect(screen.getByTestId('theme-new-lime')).toBeTruthy()

    pressEscape()

    expect(screen.queryByTestId('theme-new-lime')).toBeNull()
    expect(screen.getByTestId('theme-card-blue')).toBeTruthy()
  })
})

describe('the theme editor', () => {
  it('keeps a colour the contrast check would refuse, and says why', () => {
    renderScreen(<SettingsScreen />)

    fireEvent.press(screen.getByTestId('settings-themes-advanced'))
    fireEvent.press(screen.getByTestId('theme-new-blue'))

    const id = useSettingsStore.getState().userThemes[0]?.id ?? ''
    const before = useSettingsStore.getState().userThemes[0]?.light?.accentBubble

    // The studio lime as a BUBBLE: white on it is about 1.3 : 1.
    fireEvent.changeText(screen.getByTestId('theme-colour-accentBubble'), '#C7FF4A')

    expect(screen.getByText(/measures 1\.\d+ : 1, and needs 4\.5/u)).toBeTruthy()
    expect(useSettingsStore.getState().userThemes.find(theme => theme.id === id)?.light?.accentBubble).toBe(before)
  })

  it('takes one the check would pass, and writes it', () => {
    renderScreen(<SettingsScreen />)

    fireEvent.press(screen.getByTestId('settings-themes-advanced'))
    fireEvent.press(screen.getByTestId('theme-new-blue'))
    fireEvent.changeText(screen.getByTestId('theme-colour-accentBubble'), '#4A7F15')

    const id = useSettingsStore.getState().userThemes[0]?.id ?? ''

    expect(useSettingsStore.getState().userThemes.find(theme => theme.id === id)?.light?.accentBubble).toBe('#4A7F15')
  })
})
