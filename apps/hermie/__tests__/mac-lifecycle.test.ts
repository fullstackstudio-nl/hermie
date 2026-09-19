/**
 * A Mac window does not pause the connection when it leaves the front.
 *
 * `pause()` tears the socket down. On a phone that is right — the OS is about to
 * kill a half-open socket anyway — and on a Mac it is the difference between a
 * window you Cmd+Tab away from and a window that says "gateway not connected"
 * when you come back. The native macOS target skipped AppState entirely for this
 * reason, and the rule has to survive that target's removal.
 *
 * `resume()` on `active` is wired on both, deliberately: it returns immediately
 * unless the connection really is paused or stopped, so on a Mac it is a no-op
 * and on anything else it is the recovery.
 */
import type { GatewayConnection } from '@hermie/gateway-client'
import { AppState, type AppStateStatus } from 'react-native'

import { attachLifecycle } from '../src/gateway/client'

jest.mock('../src/platform/runs-on-mac', () => ({ RUNS_ON_MAC: false }))

const runsOnMac = jest.requireMock('../src/platform/runs-on-mac') as { RUNS_ON_MAC: boolean }

function attach() {
  const connection = {
    pause: jest.fn(),
    resume: jest.fn(),
    setOnline: jest.fn()
  }

  let handler: ((state: AppStateStatus) => void) | undefined

  const spy = jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, next) => {
    handler = next as (state: AppStateStatus) => void

    return { remove: jest.fn() } as unknown as ReturnType<typeof AppState.addEventListener>
  })

  const detach = attachLifecycle(connection as unknown as GatewayConnection)

  if (!handler) {
    throw new Error('attachLifecycle did not subscribe to AppState')
  }

  return { connection, send: handler, detach, spy }
}

afterEach(() => {
  jest.restoreAllMocks()
  runsOnMac.RUNS_ON_MAC = false
})

describe('attachLifecycle', () => {
  it('pauses on background on a phone', () => {
    const { connection, send, detach } = attach()

    send('background')
    expect(connection.pause).toHaveBeenCalledTimes(1)

    send('active')
    expect(connection.resume).toHaveBeenCalledTimes(1)

    detach()
  })

  it('never pauses on a Mac, and still resumes', () => {
    runsOnMac.RUNS_ON_MAC = true
    const { connection, send, detach } = attach()

    send('background')
    expect(connection.pause).not.toHaveBeenCalled()

    send('active')
    expect(connection.resume).toHaveBeenCalledTimes(1)

    detach()
  })

  it('ignores `inactive` on both, which is what a window losing focus reports', () => {
    const { connection, send, detach } = attach()

    send('inactive')
    expect(connection.pause).not.toHaveBeenCalled()
    expect(connection.resume).not.toHaveBeenCalled()

    detach()
  })
})
