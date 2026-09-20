/**
 * The remaining surfaces: bubbles, the agents bar and its sheet, and the
 * gallery that mounts all of them at once.
 */
import { fireEvent, screen } from '@testing-library/react-native'
import { attachmentRefName } from '@hermie/transcript'

import {
  AgentsBar,
  AgentsSheet,
  AssistantBubble,
  attachmentName,
  BotDmInBubble,
  BotDmOutLine,
  ChatHeader,
  ExpandedProvider,
  UserBubble,
  formatCount,
  formatDuration,
  markerFor
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
  // The receipt is now TICKS beside the clock rather than the word under the
  // bubble: a bubble that says "Delivered" under every line is noise, and §4's
  // metadata line has no room for it. The word survives as the accessibility
  // label, which is the only place it is still needed — a tick is not readable.
  it('shows the receipt as a labelled tick on an own bubble', () => {
    renderScreen(<UserBubble item={userItem} receipt="delivered" />)

    expect(screen.getByLabelText(/Delivered$/)).toBeTruthy()
  })

  it('distinguishes read from delivered', () => {
    renderScreen(<UserBubble item={userItem} receipt="read" />)

    expect(screen.getByLabelText(/Read$/)).toBeTruthy()
  })

  it('renders a sent file as a chip, never as the raw @file: token', () => {
    renderScreen(
      <UserBubble item={{ ...userItem, attachments: ['@file:/srv/work/quarterly-report.xlsx'], text: 'Here it is.' }} />
    )

    expect(screen.getByText(/quarterly-report\.xlsx$/)).toBeTruthy()
    expect(screen.queryByText(/@file:/)).toBeNull()
  })

  /**
   * `attachments` holds references, and the reference is the only thing stored:
   * the chip's name is derived from it here, at render time. So the bubble has to
   * read every shape one can arrive in — an absolute path the gateway chose, a
   * quoted path with a space in it, and the bare name that is all a client can
   * say about an image it has only just handed over.
   */
  it.each([
    ['a path the gateway chose', '@file:/srv/work/uploads/hermie/2026-09-20/8setj4h3-ui.xml', '8setj4h3-ui.xml'],
    ['a quoted path with a space', '@file:"/srv/work/my notes.txt"', 'my notes.txt'],
    ['a backticked path', '@file:`/srv/work/my notes.txt`', 'my notes.txt'],
    ['an image the gateway has not placed yet', '@image:shot.png', 'shot.png'],
    ['an image the gateway did place', '@image:/srv/work/.hermes/images/shot.png', 'shot.png']
  ])('names the chip from %s', (_label, reference, name) => {
    renderScreen(<UserBubble item={{ ...userItem, attachments: [reference], text: '' }} />)

    expect(screen.getByText(name)).toBeTruthy()
    expect(screen.queryByText(new RegExp('@(?:file|image):'))).toBeNull()
  })

  it('paints a bubble that carries only a file and says nothing', () => {
    // The send that reported the duplicate. There is no text at all, so the chip
    // is the whole bubble — and it still needs its metadata line.
    renderScreen(<UserBubble item={{ ...userItem, attachments: ['@file:/srv/work/ui.xml'], text: '' }} />)

    expect(screen.getByText('ui.xml')).toBeTruthy()
    expect(screen.getByTestId(`user-meta-${userItem.id}`)).toBeTruthy()
  })

  it('derives the same name the engine compares on', () => {
    // Two functions, one truth: the kit paints the name and the transcript
    // engine pairs on it, and the kit must not grow a runtime dependency on the
    // engine to keep them in step. This is what keeps them honest instead.
    for (const reference of [
      '@file:/srv/work/uploads/hermie/2026-09-20/8setj4h3-ui.xml',
      '@file:"/srv/work/my notes.txt"',
      '@image:shot.png',
      '@image:/srv/work/.hermes/images/shot.png'
    ]) {
      expect(attachmentName(reference)).toBe(attachmentRefName(reference))
    }
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

    // The caption is the micro type now, which is uppercase.
    expect(screen.getByText('REPLY TO @WRITER')).toBeTruthy()
  })

  it('keeps the sender chip on an inbound DM, in the micro type', () => {
    renderScreen(<BotDmInBubble item={botDmInItem} selfHandle="researcher" />)

    expect(screen.getByText('WRITER · BOT')).toBeTruthy()
    expect(screen.getByText('@writer → @researcher')).toBeTruthy()
  })

  it('marks an inbound DM this bot has answered', () => {
    renderScreen(<BotDmInBubble answered item={botDmInItem} selfHandle="researcher" />)

    expect(screen.getByText(/answered$/)).toBeTruthy()
  })
})

describe('bot-to-bot lines', () => {
  // §6.6: collapsed outgoing is a LINE, and tapping it expands the exchange in
  // place. It used to be a card whose header navigated to the other bot's chat,
  // which cost the reader the conversation they were reading.
  it('draws a line with the reply marker and expands in place', () => {
    renderScreen(
      <ExpandedProvider>
        <BotDmOutLine item={botDmOutItem} presentation="collapsed" />
      </ExpandedProvider>
    )

    expect(screen.getByText('Message to @writer')).toBeTruthy()
    expect(screen.getByText(/replied/)).toBeTruthy()
    expect(screen.queryByTestId(`bot-dm-out-expanded-${botDmOutItem.id}`)).toBeNull()

    fireEvent.press(screen.getByTestId(`bot-dm-out-line-${botDmOutItem.id}`))
    expect(screen.getByTestId(`bot-dm-out-expanded-${botDmOutItem.id}`)).toBeTruthy()
  })

  it('never navigates from the line itself, only from the explicit link', () => {
    const onOpenBot = jest.fn()

    renderScreen(
      <ExpandedProvider>
        <BotDmOutLine item={botDmOutItem} onOpenBot={onOpenBot} presentation="collapsed" />
      </ExpandedProvider>
    )

    fireEvent.press(screen.getByTestId(`bot-dm-out-line-${botDmOutItem.id}`))
    expect(onOpenBot).not.toHaveBeenCalled()

    // The link carries the counterpart query, so the far chat lands on the
    // matching inbound row rather than at its bottom.
    fireEvent.press(screen.getByTestId(`bot-dm-out-open-${botDmOutItem.id}`))
    expect(onOpenBot).toHaveBeenCalledWith('writer', expect.objectContaining({ kind: 'bot_dm_in' }))
  })

  it('marks a failed delivery and says why', () => {
    renderScreen(
      <ExpandedProvider>
        <BotDmOutLine item={failedDmOutItem} presentation="collapsed" />
      </ExpandedProvider>
    )

    expect(screen.getByText('Failed')).toBeTruthy()

    fireEvent.press(screen.getByTestId(`bot-dm-out-line-${failedDmOutItem.id}`))
    expect(screen.getByText('The gateway timed out.')).toBeTruthy()
  })

  // The indicator is never absent: a line with nothing on its right would read
  // as "delivered and answered", the one state a reader cannot verify.
  it('always produces a marker', () => {
    expect(markerFor(botDmOutItem).label).toMatch(/replied/)
    expect(markerFor(failedDmOutItem).label).toBe('Failed')
    expect(markerFor({ ...botDmOutItem, reply: undefined }).hollow).toBe(true)
    expect(markerFor({ ...botDmOutItem, reply: undefined }).label).toBe('Delivered · waiting for reply')
  })
})

describe('ChatHeader', () => {
  it('opens the options menu', () => {
    const onOpenOptions = jest.fn()

    renderScreen(<ChatHeader handle="researcher" name="Researcher" onOpenOptions={onOpenOptions} running />)

    expect(screen.getByText(/@researcher/)).toBeTruthy()

    fireEvent.press(screen.getByTestId('chat-header-options'))
    expect(onOpenOptions).toHaveBeenCalled()
  })
})

describe('agents', () => {
  it('summarises the running children and opens on tap', () => {
    const onPress = jest.fn()

    renderScreen(<AgentsBar count={3} elapsedSeconds={72} onPress={onPress} />)

    // §5 splits the bar's halves: the count in bold, the clock in mono. It is a
    // clock rather than `1m 12s` because the number ticks in a fixed slot and a
    // label that changes width once a second moves the "Show" beside it.
    expect(screen.getByText('3 agents working')).toBeTruthy()
    expect(screen.getByText('1:12')).toBeTruthy()
    expect(screen.getByText('Show')).toBeTruthy()

    fireEvent.press(screen.getByTestId('agents-bar'))
    expect(onPress).toHaveBeenCalled()
  })

  it('hides itself when nothing is running', () => {
    const view = renderScreen(<AgentsBar count={0} onPress={jest.fn()} />)

    expect(view.queryByTestId('agents-bar')).toBeNull()
  })

  it('ticks from a start in MILLISECONDS, the unit the reducer stores', () => {
    // `Subagent.startedAt` is epoch milliseconds. The bar used to take unix
    // seconds, so the screen handed it a number a thousand times too large,
    // `now - startedAt` came out hugely negative, and the clock sat on `0:00`
    // for the entire run.
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_700_000_072_000)

    try {
      renderScreen(<AgentsBar count={2} onPress={jest.fn()} startedAtMs={1_700_000_000_000} />)

      expect(screen.getByText('2 agents working')).toBeTruthy()
      expect(screen.getByText('1:12')).toBeTruthy()
    } finally {
      now.mockRestore()
    }
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
