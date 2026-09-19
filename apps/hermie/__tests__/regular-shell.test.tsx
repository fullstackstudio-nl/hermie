/**
 * The wide-window shell — an iPad or a Mac: sidebar plus detail.
 *
 * There is no navigator here, both panes are always mounted, and a window too
 * narrow for two never reaches this component (`useLayoutMode` hands that case
 * to the compact stack). So the whole behaviour is which pane is on screen and
 * which row is marked selected, which is exactly what a test can assert and
 * what a screenshot of a Mac window cannot.
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

  it('keeps both panes mounted while a chat is open', () => {
    renderScreen(<RegularShell />)

    fireEvent.press(screen.getByTestId('bot-row-researcher'))

    expect(screen.getByTestId('bot-row-writer')).toBeTruthy()
  })
})
