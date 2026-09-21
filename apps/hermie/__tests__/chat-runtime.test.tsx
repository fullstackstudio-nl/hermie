/**
 * When the roster is actually read.
 *
 * A `GatewayConnection` exists from the moment a gateway is configured, long
 * before its socket is up. The runtime used to call `profiles.list` the instant
 * that object appeared: right after onboarding it failed with "gateway not
 * connected", nothing ever asked again, and the chat list sat on that error
 * while the header two lines above it said Connected.
 */
import { act, render, waitFor } from '@testing-library/react-native'
import { AppState, type AppStateStatus, Text } from 'react-native'

import { ChatRuntimeProvider } from '../src/features/chats/ChatRuntime'

const mockRefresh = jest.fn(async () => [])
const mockPaintFromCache = jest.fn(async () => undefined)
const mockOnForeground = jest.fn(async () => undefined)
const mockOnBackground = jest.fn()
const mockPersistAll = jest.fn(async () => undefined)

jest.mock('../src/platform/runs-on-mac', () => ({ RUNS_ON_MAC: false }))

const runsOnMac = jest.requireMock('../src/platform/runs-on-mac') as { RUNS_ON_MAC: boolean }

let mockStatus = 'connecting'
let mockConnection: object | null = { id: 'connection-1' }

jest.mock('../src/gateway', () => ({
  useGateway: () => ({ connection: mockConnection, status: mockStatus })
}))

// `on` is not decoration here: the runtime subscribes to `sessions.changed` to
// re-read ADR-0016's settings section, because a profile row changing is the
// only signal a gateway gives that another client wrote one.
jest.mock('../src/gateway/link', () => ({
  chatGatewayFor: () => ({ on: () => () => undefined, request: async () => ({}) })
}))

jest.mock('../src/features/bots/bots-controller', () => ({
  BotsController: class {
    paintFromCache = mockPaintFromCache
    refresh = mockRefresh
    dispose = jest.fn()
  }
}))

jest.mock('../src/features/chats/chat-controller', () => ({
  ChatController: class {
    start = jest.fn()
    stop = jest.fn()
    onForeground = mockOnForeground
    onBackground = mockOnBackground
    persistAll = mockPersistAll
  }
}))

beforeEach(() => {
  jest.clearAllMocks()
  mockStatus = 'connecting'
  mockConnection = { id: 'connection-1' }
  runsOnMac.RUNS_ON_MAC = false
})

afterEach(() => jest.restoreAllMocks())

function renderRuntime() {
  return render(
    <ChatRuntimeProvider>
      <Text>ready</Text>
    </ChatRuntimeProvider>
  )
}

describe('ChatRuntimeProvider', () => {
  it('does not read the roster while the connection is still dialling', async () => {
    renderRuntime()

    await waitFor(() => expect(mockPaintFromCache).toHaveBeenCalled())
    expect(mockRefresh).not.toHaveBeenCalled()
  })

  it('reads it as soon as the connection is ready', async () => {
    const view = renderRuntime()

    mockStatus = 'ready'
    view.rerender(
      <ChatRuntimeProvider>
        <Text>ready</Text>
      </ChatRuntimeProvider>
    )

    await waitFor(() => expect(mockRefresh).toHaveBeenCalledTimes(1))
  })

  it('reads it again after a reconnect, and only then', async () => {
    mockStatus = 'ready'

    const view = renderRuntime()
    const rerender = () =>
      view.rerender(
        <ChatRuntimeProvider>
          <Text>ready</Text>
        </ChatRuntimeProvider>
      )

    await waitFor(() => expect(mockRefresh).toHaveBeenCalledTimes(1))

    // Still ready: no second read.
    rerender()
    expect(mockRefresh).toHaveBeenCalledTimes(1)

    mockStatus = 'reconnecting'
    rerender()
    mockStatus = 'ready'
    rerender()

    await waitFor(() => expect(mockRefresh).toHaveBeenCalledTimes(2))
  })
})

/**
 * The chat side of the app lifecycle, and the one place a Mac differs.
 *
 * `onBackground()` stops the approval and subagent polls. That is right where
 * the socket goes down with it, and wrong on a Mac: a hidden window keeps its
 * connection (see `__tests__/mac-lifecycle.test.ts`), so stopping the polls
 * would leave an agent's question unanswered while the window sat one Cmd+Tab
 * away. `foregrounded` starts true in the controller, so not calling it is
 * exactly what the deleted native macOS target did by ignoring AppState.
 */
describe('ChatRuntimeProvider and AppState', () => {
  function subscribe() {
    let handler: ((state: AppStateStatus) => void) | undefined

    jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, next) => {
      handler = next as (state: AppStateStatus) => void

      return { remove: jest.fn() } as unknown as ReturnType<typeof AppState.addEventListener>
    })

    renderRuntime()

    if (!handler) {
      throw new Error('ChatRuntimeProvider did not subscribe to AppState')
    }

    return handler
  }

  it('stops the polls in the background on a phone, and persists', async () => {
    const send = subscribe()

    await act(async () => send('background'))

    expect(mockOnBackground).toHaveBeenCalledTimes(1)
    expect(mockPersistAll).toHaveBeenCalledTimes(1)
  })

  it('keeps polling in the background on a Mac, and still persists', async () => {
    runsOnMac.RUNS_ON_MAC = true
    const send = subscribe()

    await act(async () => send('background'))

    expect(mockOnBackground).not.toHaveBeenCalled()
    expect(mockPersistAll).toHaveBeenCalledTimes(1)
  })

  it('re-reads what the agent is waiting on when the window comes forward, on both', async () => {
    runsOnMac.RUNS_ON_MAC = true
    const send = subscribe()

    await act(async () => send('active'))

    expect(mockOnForeground).toHaveBeenCalledTimes(1)
  })
})
