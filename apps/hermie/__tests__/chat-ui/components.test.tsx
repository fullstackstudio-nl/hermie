/**
 * The remaining surfaces: bubbles, the agents bar and its sheet, and the
 * gallery that mounts all of them at once.
 */
import { fireEvent, screen } from '@testing-library/react-native'

import {
  AgentsBar,
  AgentsSheet,
  AssistantBubble,
  BotDmInBubble,
  BotDmOutCard,
  ChatHeader,
  UserBubble,
  formatCount,
  formatDuration
} from '../../src/chat-ui'
import {
  assistantItem,
  botDmInItem,
  botDmOutItem,
  errorAssistantItem,
  failedDmOutItem,
  recoverableAssistantItem,
  replyToBotItem,
  subagentTree,
  userItem
} from '../../src/chat-ui/fixtures'
import { GalleryScreen } from '../../src/features/settings/GalleryScreen'
import { renderScreen } from '../support/render'

describe('bubbles', () => {
  it('shows the receipt under an own bubble', () => {
    renderScreen(<UserBubble item={userItem} receipt="delivered" />)

    expect(screen.getByText(/^Delivered/)).toBeTruthy()
  })

  it('renders the reply footer only when asked', () => {
    const view = renderScreen(<AssistantBubble item={assistantItem} showFooter />)

    expect(view.getByText(/4.2s/)).toBeTruthy()
    expect(view.getByText(/3.1k in/)).toBeTruthy()
    expect(view.getByText(/example-model/)).toBeTruthy()
  })

  it('offers Retry for a lost turn and not for a recoverable one', () => {
    const onRetry = jest.fn()
    const view = renderScreen(<AssistantBubble item={errorAssistantItem} onRetry={onRetry} />)

    fireEvent.press(view.getByTestId(`assistant-error-${errorAssistantItem.id}-retry`))
    expect(onRetry).toHaveBeenCalled()

    const recoverable = renderScreen(<AssistantBubble item={recoverableAssistantItem} onRetry={onRetry} />)

    expect(recoverable.queryByTestId(`assistant-error-${recoverableAssistantItem.id}-retry`)).toBeNull()
    expect(recoverable.getByText('Reconnecting…')).toBeTruthy()
  })

  it('captions a reply that answers another bot', () => {
    renderScreen(<AssistantBubble item={replyToBotItem} />)

    expect(screen.getByText('Reply to @writer')).toBeTruthy()
  })

  it('opens the sender from an inbound DM header', () => {
    const onOpenBot = jest.fn()

    renderScreen(<BotDmInBubble item={botDmInItem} onOpenBot={onOpenBot} selfHandle="researcher" />)

    expect(screen.getByText('Writer · bot')).toBeTruthy()
    expect(screen.getByText('@writer → @researcher')).toBeTruthy()

    fireEvent.press(screen.getByTestId(`bot-dm-in-header-${botDmInItem.id}`))
    expect(onOpenBot).toHaveBeenCalledWith(
      'writer',
      expect.objectContaining({ kind: 'bot_dm_out', text: botDmInItem.text })
    )
  })

  it('nests the teammate reply inside the dispatch card', () => {
    renderScreen(<BotDmOutCard item={botDmOutItem} presentation="full" />)

    expect(screen.getByText('→ Writer')).toBeTruthy()
    expect(screen.getByTestId(`bot-dm-out-reply-${botDmOutItem.id}`)).toBeTruthy()
    expect(screen.getByText('Writer replied')).toBeTruthy()
  })

  it('marks a failed delivery', () => {
    renderScreen(<BotDmOutCard item={failedDmOutItem} presentation="full" />)

    expect(screen.getByText('Failed')).toBeTruthy()
    expect(screen.getByText('The gateway timed out.')).toBeTruthy()
  })
})

describe('ChatHeader', () => {
  it('opens the options menu', () => {
    const onOpenOptions = jest.fn()

    renderScreen(<ChatHeader handle="researcher" name="Researcher" onOpenOptions={onOpenOptions} running />)

    expect(screen.getByText('@researcher · Running')).toBeTruthy()

    fireEvent.press(screen.getByTestId('chat-header-options'))
    expect(onOpenOptions).toHaveBeenCalled()
  })
})

describe('agents', () => {
  it('summarises the running children and opens on tap', () => {
    const onPress = jest.fn()

    renderScreen(<AgentsBar count={3} elapsedSeconds={72} onPress={onPress} />)

    expect(screen.getByText('3 agents working · 1m 12s')).toBeTruthy()

    fireEvent.press(screen.getByTestId('agents-bar'))
    expect(onPress).toHaveBeenCalled()
  })

  it('hides itself when nothing is running', () => {
    const view = renderScreen(<AgentsBar count={0} onPress={jest.fn()} />)

    expect(view.queryByTestId('agents-bar')).toBeNull()
  })

  it('steers and stops a child from the sheet', () => {
    const onSteer = jest.fn()
    const onInterrupt = jest.fn()

    renderScreen(
      <AgentsSheet
        onClose={jest.fn()}
        onInterrupt={onInterrupt}
        onOpenTranscript={jest.fn()}
        onSteer={onSteer}
        tree={subagentTree}
        visible
      />
    )

    // The tree is rendered in full, nested child included.
    expect(screen.getByTestId('agent-row-sa-1')).toBeTruthy()
    expect(screen.getByTestId('agent-row-sa-3')).toBeTruthy()

    fireEvent.press(screen.getByTestId('agent-steer-sa-1'))
    fireEvent.changeText(screen.getByTestId('agent-steer-input-sa-1'), 'Use the archived changelog')
    fireEvent.press(screen.getByTestId('agent-steer-send-sa-1'))

    expect(onSteer).toHaveBeenCalledWith('sa-1', 'Use the archived changelog')

    fireEvent.press(screen.getByTestId('agent-stop-sa-1'))
    expect(onInterrupt).toHaveBeenCalledWith('sa-1')
  })

  it('offers neither steer nor stop for a finished child', () => {
    const view = renderScreen(
      <AgentsSheet onClose={jest.fn()} onInterrupt={jest.fn()} onSteer={jest.fn()} tree={subagentTree} visible />
    )

    expect(view.queryByTestId('agent-steer-sa-2')).toBeNull()
    expect(view.queryByTestId('agent-stop-sa-2')).toBeNull()
  })
})

describe('formatters', () => {
  it('formats durations the way the cards read them', () => {
    expect(formatDuration(0.42)).toBe('0.4s')
    expect(formatDuration(12)).toBe('12s')
    expect(formatDuration(72)).toBe('1m 12s')
    expect(formatDuration(3700)).toBe('1h 01m')
    expect(formatDuration(undefined)).toBe('')
  })

  it('formats token counts', () => {
    expect(formatCount(912)).toBe('912')
    expect(formatCount(3120)).toBe('3.1k')
    expect(formatCount(2_500_000)).toBe('2.5M')
  })
})

describe('GalleryScreen', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  it('mounts every component with fixture data', () => {
    renderScreen(<GalleryScreen />)

    expect(screen.getByText('Component gallery')).toBeTruthy()
    expect(screen.getByTestId('gallery-chat-header')).toBeTruthy()
    expect(screen.getByTestId('gallery-agents-bar')).toBeTruthy()
    expect(screen.getByTestId('composer-input')).toBeTruthy()
  })

  it('opens the full chat screen, transcript and all', () => {
    renderScreen(<GalleryScreen />)

    fireEvent.press(screen.getByText('Open the full chat screen'))

    expect(screen.getByTestId('gallery-chat')).toBeTruthy()
    expect(screen.getByTestId('gallery-transcript')).toBeTruthy()
    expect(screen.getByTestId('agents-bar')).toBeTruthy()
  })

  it('opens the approval sheet from the gallery', () => {
    renderScreen(<GalleryScreen />)

    fireEvent.press(screen.getByText('Open approval sheet'))
    expect(screen.getByTestId('approval-command')).toBeTruthy()
  })
})
