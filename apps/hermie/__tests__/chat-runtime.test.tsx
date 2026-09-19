/**
 * When the roster is actually read.
 *
 * A `GatewayConnection` exists from the moment a gateway is configured, long
 * before its socket is up. The runtime used to call `profiles.list` the instant
 * that object appeared: right after onboarding it failed with "gateway not
 * connected", nothing ever asked again, and the chat list sat on that error
 * while the header two lines above it said Connected.
 */
import { render, waitFor } from '@testing-library/react-native'
import { Text } from 'react-native'

import { ChatRuntimeProvider } from '../src/features/chats/ChatRuntime'

const mockRefresh = jest.fn(async () => [])
const mockPaintFromCache = jest.fn(async () => undefined)

let mockStatus = 'connecting'
let mockConnection: object | null = { id: 'connection-1' }

jest.mock('../src/gateway', () => ({
  useGateway: () => ({ connection: mockConnection, status: mockStatus })
}))

jest.mock('../src/gateway/link', () => ({ chatGatewayFor: () => ({}) }))

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
    onForeground = jest.fn()
    onBackground = jest.fn()
    persistAll = jest.fn()
  }
}))

beforeEach(() => {
  jest.clearAllMocks()
  mockStatus = 'connecting'
  mockConnection = { id: 'connection-1' }
})

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
