import { type GatewayConnection, GatewayError } from '@hermie/gateway-client'

import { createGatewayConnection, createMemoryTokenStore, createTokenCoordinator } from '../../gateway/client'
import {
  authModeOf,
  connectionPayloadKey,
  type ConnectionTestOutcome,
  headerRecord,
  type OnboardingDraft
} from './draft'

/** How long the whole dial — ticket, socket, `gateway.ready` — gets before the test fails. */
export const CONNECTION_TEST_TIMEOUT_MS = 30_000

/**
 * Wait for the connection to reach `ready`, or fail at the first sign that it
 * will not.
 *
 * During normal use a drop is something to ride out with backoff. During a test
 * it is the answer: the point of the step is to tell the user now whether this
 * address and this credential work, so `reconnecting` counts as a failure
 * rather than as a reason to wait another fifteen seconds.
 */
function waitForReady(connection: GatewayConnection, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // A box rather than a bare `let`: `onStatus` reports the current status
    // synchronously, so the handler can run before the subscription handle
    // exists, and reading a not-yet-initialised binding would throw.
    const subscription: { off?: () => void } = {}
    let settled = false

    const finish = (error?: unknown) => {
      if (settled) {
        return
      }

      settled = true
      clearTimeout(timer)
      subscription.off?.()

      if (error) {
        reject(error)
      } else {
        resolve()
      }
    }

    const timer = setTimeout(() => {
      finish(new GatewayError('timeout', `The gateway did not answer within ${Math.round(timeoutMs / 1000)} seconds.`))
    }, timeoutMs)

    subscription.off = connection.onStatus((status, error) => {
      if (status === 'ready') {
        finish()

        return
      }

      if (status === 'needs_signin' || status === 'incompatible' || status === 'reconnecting' || status === 'offline') {
        finish(error ?? new GatewayError('network', 'The gateway connection failed.'))

        return
      }

      if (status === 'disconnected' && error) {
        finish(error)
      }
    })

    connection.start()
  })
}

/**
 * The mandatory step before anything is stored: exercise both halves of the
 * transport with the credential the user just obtained. REST first, because a
 * bearer or session token that is refused there fails with an HTTP status that
 * explains itself; then the socket, which is where a reverse proxy that does
 * not pass upgrades through finally shows up.
 */
export async function runConnectionTest(
  draft: OnboardingDraft,
  timeoutMs: number = CONNECTION_TEST_TIMEOUT_MS
): Promise<ConnectionTestOutcome> {
  const baseUrl = draft.baseUrl

  if (!baseUrl) {
    throw new GatewayError('config', 'There is no gateway address to test.')
  }

  const authMode = authModeOf(draft.probe)
  const extraHeaders = headerRecord(draft.headers)
  const coordinator =
    authMode === 'native_pkce'
      ? createTokenCoordinator({ baseUrl, extraHeaders, store: createMemoryTokenStore(draft.tokens) })
      : undefined

  const connection = createGatewayConnection({
    config: {
      baseUrl,
      authMode,
      ...(draft.provider ? { provider: draft.provider.name } : {}),
      extraHeaders
    },
    ...(authMode === 'session_token' ? { sessionToken: draft.sessionToken.trim() } : {}),
    ...(coordinator ? { coordinator } : {})
  })

  try {
    let userDisplayName = ''

    if (authMode === 'native_pkce') {
      const identity = await connection.http.authMe()
      userDisplayName = identity.displayName || identity.email || identity.userId
    } else {
      // An ungated gateway has no identity to report, so the equivalent check is
      // simply that an authenticated read succeeds with the session token.
      await connection.http.get('/api/profiles')
    }

    await waitForReady(connection, timeoutMs)

    const result = await connection.request('profiles.list', { include_sessions: true })
    // Read the coordinator back rather than the draft: if the dial rotated the
    // pair, this is the only place the live one exists. The payload key is
    // computed against the rotated draft too, or the step would invalidate its
    // own result the moment the caller adopts the token.
    const tokens = coordinator ? await coordinator.current() : null
    const tested = tokens ? { ...draft, tokens } : draft

    return {
      key: connectionPayloadKey(tested),
      userDisplayName,
      botCount: (result.profiles ?? []).length,
      ...(tokens ? { tokens } : {})
    }
  } finally {
    connection.stop()
  }
}
