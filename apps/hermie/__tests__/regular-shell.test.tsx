/**
 * The wide-window shell — an iPad or a Mac: two floating glass panels over a
 * wallpaper.
 *
 * There is no navigator here, both panels are always mounted, and a window too
 * narrow for two never reaches this component (`useLayoutMode` hands that case
 * to the compact stack). So the whole behaviour is which row is marked selected
 * and what the overlay panel is doing, which is exactly what a test can assert
 * and what a screenshot of a Mac window cannot.
 *
 * The one thing worth stating about the overlay: it COVERS the chat column, it
 * does not replace it. The sidebar stays outside the scrim and stays usable,
 * which is the whole reason the destinations are an overlay rather than a third
 * pane.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react-native'
import { StyleSheet, useWindowDimensions } from 'react-native'

import { RegularShell } from '../src/app/RegularShell'
import { type Bot, useBotsStore } from '../src/store/bots'
import { useChatLayoutStore } from '../src/store/chat-layout'
import { useChatsStore } from '../src/store/chats'
import { WINDOW_GAP } from '../src/ui/tokens'
import { renderScreen } from './support/render'

const gateway = { status: 'ready', config: { baseUrl: 'https://gateway.example.com', authMode: 'native_pkce' } }

jest.mock('../src/gateway', () => ({
  useGateway: () => gateway,
  hostOf: (url: string) => url.replace(/^https:\/\//, '')
}))

jest.mock('../src/gateway/GatewayProvider', () => ({
  useGateway: () => ({
    ...gateway,
    adoptTokens: jest.fn(),
    changeGateway: jest.fn(),
    extraHeaders: {},
    signOut: jest.fn()
  })
}))

jest.mock('../src/features/chats/ChatRuntime', () => ({
  useChatRuntime: () => null
}))

jest.mock('../src/platform/runs-on-mac', () => ({ RUNS_ON_MAC: false }))

jest.mock('react-native/Libraries/Utilities/useWindowDimensions')

const mockDimensions = useWindowDimensions as unknown as jest.Mock
const runsOnMac = jest.requireMock('../src/platform/runs-on-mac') as { RUNS_ON_MAC: boolean }

const bot = (name: string, displayName: string): Bot => ({
  name,
  displayName,
  description: '',
  model: 'example-provider/example-model',
  provider: 'example-provider',
  isDefault: false,
  hasAvatar: false,
  uiMetaRevision: 0,
  canonical: { id: `stored-${name}`, resolvedId: `stored-${name}`, preview: 'Hello.', lastActive: 1, messageCount: 2 }
})

const wide = () => mockDimensions.mockReturnValue({ width: 1024, height: 1366, scale: 2, fontScale: 1 })

const paddingOf = (testID: string) =>
  StyleSheet.flatten(screen.getByTestId(testID).props.style as never) as {
    paddingTop?: number
    paddingBottom?: number
  }

beforeEach(() => {
  runsOnMac.RUNS_ON_MAC = false
  useBotsStore.getState().reset()
  useChatsStore.getState().reset()
  useChatLayoutStore.getState().reset()
  useBotsStore.getState().setBots([bot('researcher', 'Researcher'), bot('writer', 'Writer')])
  wide()
})

describe('RegularShell', () => {
  it('asks the reader to pick a bot before one is selected', () => {
    renderScreen(<RegularShell />)

    expect(screen.getByText('Pick a conversation to start reading.')).toBeTruthy()
  })

  it('marks the selected conversation in the sidebar and keeps it marked', () => {
    renderScreen(<RegularShell />)

    fireEvent.press(screen.getByTestId('bot-row-researcher'))

    expect(screen.getByTestId('bot-row-researcher').props.accessibilityState).toMatchObject({ selected: true })
    expect(screen.getByTestId('bot-row-writer').props.accessibilityState).toMatchObject({ selected: false })
  })

  it('keeps both panels mounted while a chat is open', () => {
    renderScreen(<RegularShell />)

    fireEvent.press(screen.getByTestId('bot-row-researcher'))

    expect(screen.getByTestId('bot-row-writer')).toBeTruthy()
  })

  it('drops the selection highlight while a destination is open', () => {
    renderScreen(<RegularShell />)

    fireEvent.press(screen.getByTestId('bot-row-researcher'))
    fireEvent.press(screen.getByTestId('tab-settings'))

    expect(screen.getByTestId('bot-row-researcher').props.accessibilityState).toMatchObject({ selected: false })
  })
})

describe('the overlay panel', () => {
  it('slides Activity over the chat column and leaves the sidebar alone', () => {
    renderScreen(<RegularShell />)

    fireEvent.press(screen.getByTestId('tab-activity'))

    expect(screen.getByTestId('overlay-panel')).toBeTruthy()
    expect(screen.getByTestId('activity-list')).toBeTruthy()
    // Covered, not replaced — and the list underneath is still there to tap.
    expect(screen.getByText('Pick a conversation to start reading.')).toBeTruthy()
    expect(screen.getByTestId('bot-row-writer')).toBeTruthy()
  })

  // The panel stays mounted for its own slide-out — one that unmounted on the
  // first frame of its exit would simply vanish — so these wait for it to go.
  it('closes on the round close button', async () => {
    renderScreen(<RegularShell />)

    fireEvent.press(screen.getByTestId('tab-settings'))
    expect(screen.getByTestId('overlay-panel')).toBeTruthy()

    fireEvent.press(screen.getByTestId('overlay-close'))

    await waitFor(() => expect(screen.queryByTestId('overlay-panel')).toBeNull())
  })

  it('closes on a tap outside itself', async () => {
    renderScreen(<RegularShell />)

    fireEvent.press(screen.getByTestId('tab-settings'))
    fireEvent.press(screen.getByTestId('overlay-scrim'))

    await waitFor(() => expect(screen.queryByTestId('overlay-panel')).toBeNull())
  })
})

describe('the shell insets', () => {
  /**
   * Reported from a real Mac session: the empty strip under the title bar was
   * gone above the chat column and still there above the list, because the
   * sidebar carried a top padding of its own that the Mac-aware inset never
   * reached. The fix is structural — ONE source — so this asserts the structure
   * rather than a number: the row that holds both panels carries the inset, and
   * neither panel adds any.
   */
  it('applies the safe area once, to the row that holds both panels', () => {
    renderScreen(<RegularShell />)

    // The metrics `renderScreen` provides are an iPhone 17 Pro's.
    expect(paddingOf('shell-window').paddingTop).toBe(WINDOW_GAP + 59)
    expect(paddingOf('shell-sidebar').paddingTop).toBeUndefined()
    expect(paddingOf('shell-content').paddingTop).toBeUndefined()
  })

  it('leaves no strip above either column on a Mac', () => {
    runsOnMac.RUNS_ON_MAC = true
    renderScreen(<RegularShell />)

    expect(paddingOf('shell-window').paddingTop).toBe(WINDOW_GAP)
    expect(paddingOf('shell-sidebar').paddingTop).toBeUndefined()
    expect(paddingOf('shell-content').paddingTop).toBeUndefined()
  })
})

/**
 * What a panel is allowed to paint over the glass: nothing.
 *
 * Measured on an iPad Pro 13" simulator in the dark theme, the chat column
 * sampled `#0A1830` — `elevation.e0`, the wallpaper's own rung — while the
 * sidebar beside it sampled `#1B2744`, the panel rung. Same `GlassSurface`,
 * same variant, so the difference was the `Screen` inside the column filling it
 * with `colors.bg`. Every wide-layout destination goes through `Screen`, so
 * every one of them was painting the wallpaper's colour over the material meant
 * to refract it, and the elevation ladder collapsed to one flat field.
 */
describe('a screen inside a floating panel', () => {
  const styleOf = (testID: string) =>
    StyleSheet.flatten(screen.getByTestId(testID).props.style as never) as {
      backgroundColor?: string
      paddingTop?: number
      paddingBottom?: number
    }

  it('paints no background of its own, so the panel stays glass', () => {
    renderScreen(<RegularShell />)

    expect(styleOf('chat-empty').backgroundColor).toBe('transparent')
  })

  it('adds no second copy of the safe-area inset the shell already applied', () => {
    renderScreen(<RegularShell />)

    const inner = styleOf('chat-empty')

    expect(inner.paddingTop).toBe(0)
    expect(inner.paddingBottom).toBe(0)
  })
})

describe('the signed-out state', () => {
  it('takes the whole content column rather than sitting under a chat error', () => {
    gateway.status = 'needs_signin'

    try {
      renderScreen(<RegularShell />)

      expect(screen.getByTestId('signed-out-panel')).toBeTruthy()
      expect(screen.queryByText('Pick a conversation to start reading.')).toBeNull()
      // The list stays: it is the half of the shell that still works.
      expect(screen.getByTestId('bot-row-writer')).toBeTruthy()
      // …and it says so in the one place the connection speaks, which on this
      // layout is the line under the title rather than a card at the foot.
      expect(screen.getByTestId('connection-line')).toHaveTextContent('Signed out')
      expect(screen.queryByTestId('gateway-card')).toBeNull()
    } finally {
      gateway.status = 'ready'
    }
  })
})
