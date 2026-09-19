/**
 * The iPad/macOS shell: sidebar plus detail.
 *
 * There is no navigator here — both panes are always mounted — so the whole
 * behaviour is which pane is on screen and which row is marked selected. That
 * is exactly what a test can assert, and what a screenshot of a Mac window
 * cannot: `docs/platform-notes.md` records that react-native-macos cannot be
 * driven past a text field by a script, so macOS is verified by build plus
 * these assertions rather than by walking the UI.
 */
import { fireEvent, screen } from '@testing-library/react-native'
import { useWindowDimensions } from 'react-native'

import { RegularShell } from '../src/app/RegularShell'
import { type Bot, useBotsStore } from '../src/store/bots'
import { useChatsStore } from '../src/store/chats'
import { renderScreen } from './support/render'

jest.mock('../src/gateway', () => ({
  useGateway: () => ({ status: 'ready' })
}))

jest.mock('../src/features/chats/ChatRuntime', () => ({
  useChatRuntime: () => null
}))

jest.mock('react-native/Libraries/Utilities/useWindowDimensions')

const mockDimensions = useWindowDimensions as unknown as jest.Mock

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
const narrow = () => mockDimensions.mockReturnValue({ width: 520, height: 900, scale: 2, fontScale: 1 })

beforeEach(() => {
  useBotsStore.getState().reset()
  useChatsStore.getState().reset()
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

  it('opens Activity as a detail pane and marks its sidebar row', () => {
    renderScreen(<RegularShell />)

    fireEvent.press(screen.getByTestId('sidebar-activity'))

    // Two matches: the sidebar row and the pane's own title.
    expect(screen.getAllByText('Activity')).toHaveLength(2)
    expect(screen.getByTestId('activity-list')).toBeTruthy()
    expect(screen.getByTestId('sidebar-activity').props.accessibilityState).toMatchObject({ selected: true })
    // The chat pane is gone, not merely covered.
    expect(screen.queryByText('Pick a conversation to start reading.')).toBeNull()
  })

  it('drops the selection highlight while a non-chat pane is open', () => {
    renderScreen(<RegularShell />)

    fireEvent.press(screen.getByTestId('bot-row-researcher'))
    fireEvent.press(screen.getByTestId('sidebar-settings'))

    expect(screen.getByTestId('bot-row-researcher').props.accessibilityState).toMatchObject({ selected: false })
  })

  it('shows one pane at a time in a window too narrow for two', () => {
    narrow()
    renderScreen(<RegularShell />)

    // The list first, with no detail beside it.
    expect(screen.getByTestId('bot-row-researcher')).toBeTruthy()
    expect(screen.queryByTestId('regular-back-to-list')).toBeNull()

    fireEvent.press(screen.getByTestId('bot-row-researcher'))

    // …and then the chat, with a way back.
    expect(screen.getByTestId('regular-back-to-list')).toBeTruthy()
    expect(screen.queryByTestId('bot-row-researcher')).toBeNull()

    fireEvent.press(screen.getByTestId('regular-back-to-list'))
    expect(screen.getByTestId('bot-row-researcher')).toBeTruthy()
  })

  it('keeps both panes when the window is wide enough', () => {
    renderScreen(<RegularShell />)

    fireEvent.press(screen.getByTestId('bot-row-researcher'))

    expect(screen.queryByTestId('regular-back-to-list')).toBeNull()
    expect(screen.getByTestId('bot-row-writer')).toBeTruthy()
  })
})
