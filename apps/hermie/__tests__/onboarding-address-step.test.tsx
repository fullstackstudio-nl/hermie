import { GatewayError, type ProbeResult, type ResolvedAddress } from '@hermie/gateway-client'
import { fireEvent, screen, waitFor } from '@testing-library/react-native'
import { useState } from 'react'

import { emptyDraft, type OnboardingDraft } from '../src/features/onboarding'
import { GatewayAddressStep } from '../src/features/onboarding/steps/GatewayAddressStep'
import { deferred, renderScreen } from './support/render'

jest.mock('@hermie/gateway-client', () => ({
  ...jest.requireActual('@hermie/gateway-client'),
  resolveGatewayAddress: jest.fn()
}))

const { resolveGatewayAddress } = require('@hermie/gateway-client') as { resolveGatewayAddress: jest.Mock }

const GATED: ProbeResult = {
  version: '2026.9.14',
  authRequired: true,
  authFlows: ['cookie', 'native_pkce'],
  providers: [{ name: 'self-hosted', displayName: 'Self-Hosted OIDC', supportsPassword: false }],
  supportsNativePkce: true
}

const UNGATED: ProbeResult = {
  version: '2026.9.14',
  authRequired: false,
  authFlows: [],
  providers: [],
  supportsNativePkce: false
}

/** What the resolver hands back: a probe plus the address that answered. */
const at = (baseUrl: string, probe: ProbeResult = GATED, foundOverHttp = false): ResolvedAddress => ({
  ...probe,
  baseUrl,
  foundOverHttp
})

let latest: OnboardingDraft = emptyDraft()

function Harness() {
  const [draft, setDraft] = useState<OnboardingDraft>(emptyDraft())
  latest = draft

  return (
    <GatewayAddressStep
      draft={draft}
      update={patch => setDraft(current => ({ ...current, ...patch }))}
      debounceMs={0}
    />
  )
}

const type = (value: string) => fireEvent.changeText(screen.getByTestId('gateway-address'), value)

beforeEach(() => {
  resolveGatewayAddress.mockReset()
  latest = emptyDraft()
})

describe('the gateway address step', () => {
  it('reports a gated gateway as needing a sign-in, naming the provider', async () => {
    resolveGatewayAddress.mockResolvedValue(at('https://hermes.example.com'))
    renderScreen(<Harness />)
    type('hermes.example.com')

    await waitFor(() =>
      expect(screen.getByTestId('probe-result')).toHaveTextContent(
        'Hermes 2026.9.14 · sign-in required via Self-Hosted OIDC · Found over https://'
      )
    )
  })

  it('names every provider when the gateway offers more than one', async () => {
    resolveGatewayAddress.mockResolvedValue(
      at('https://hermes.example.com', {
        ...GATED,
        providers: [
          { name: 'self-hosted', displayName: 'Self-Hosted OIDC', supportsPassword: false },
          { name: 'local', displayName: 'Local Accounts', supportsPassword: true }
        ]
      })
    )
    renderScreen(<Harness />)
    type('hermes.example.com')

    await waitFor(() =>
      expect(screen.getByTestId('probe-result')).toHaveTextContent(/Self-Hosted OIDC or Local Accounts/)
    )
  })

  it('reports an ungated gateway as needing a session token', async () => {
    resolveGatewayAddress.mockResolvedValue(at('http://localhost:9119', UNGATED))
    renderScreen(<Harness />)
    type('http://localhost:9119')

    await waitFor(() =>
      expect(screen.getByTestId('probe-result')).toHaveTextContent('Hermes 2026.9.14 · session token required')
    )
  })

  it('says so when a gated gateway lists no providers at all', async () => {
    resolveGatewayAddress.mockResolvedValue(at('https://hermes.example.com', { ...GATED, providers: [] }))
    renderScreen(<Harness />)
    type('hermes.example.com')

    await waitFor(() => expect(screen.getByTestId('probe-result')).toHaveTextContent(/lists no identity providers/))
  })

  it('hands the resolver exactly what was typed and keeps the address that answered', async () => {
    resolveGatewayAddress.mockResolvedValue(at('https://hermes.example.com'))
    renderScreen(<Harness />)
    type('hermes.example.com/')

    await waitFor(() => expect(latest.baseUrl).toBe('https://hermes.example.com'))
    expect(resolveGatewayAddress).toHaveBeenCalledWith('hermes.example.com/', {})
  })

  it.each([
    ['network', /Could not reach hermes\.example\.com/],
    ['tls', /The secure connection to hermes\.example\.com failed/],
    ['timeout', /hermes\.example\.com did not answer in time/],
    ['not_hermes', /answered, but not like a Hermes gateway/]
  ] as const)('explains a %s failure', async (kind, expected) => {
    resolveGatewayAddress.mockRejectedValue(new GatewayError(kind, 'raw'))
    renderScreen(<Harness />)
    type('hermes.example.com')

    await waitFor(() => expect(screen.getByTestId('probe-error')).toHaveTextContent(expected))
    expect(latest.probe).toBeNull()
  })

  it('names the access proxy behind a 401 on the public status endpoint', async () => {
    resolveGatewayAddress.mockRejectedValue(new GatewayError('auth', 'raw', { status: 403 }))
    renderScreen(<Harness />)
    type('hermes.example.com')

    await waitFor(() =>
      expect(screen.getByTestId('probe-error')).toHaveTextContent(/An access proxy answered HTTP 403/)
    )
  })

  it('explains a 503 from the gateway itself', async () => {
    resolveGatewayAddress.mockRejectedValue(new GatewayError('server', 'raw', { status: 503 }))
    renderScreen(<Harness />)
    type('hermes.example.com')

    await waitFor(() => expect(screen.getByTestId('probe-error')).toHaveTextContent(/The gateway answered HTTP 503/))
  })

  it('rejects an address that is not http or https before probing anything', async () => {
    renderScreen(<Harness />)
    type('ftp://hermes.example.com')

    await waitFor(() => expect(screen.getByTestId('probe-error')).toHaveTextContent(/must be http:\/\/ or https:\/\//))
    expect(resolveGatewayAddress).not.toHaveBeenCalled()
  })

  it('never lets a slow probe overwrite the answer to a newer one', async () => {
    const slow = deferred<ResolvedAddress>()
    const fast = deferred<ResolvedAddress>()
    resolveGatewayAddress.mockReturnValueOnce(slow.promise).mockReturnValueOnce(fast.promise)

    renderScreen(<Harness />)
    type('slow.example.com')
    await waitFor(() => expect(resolveGatewayAddress).toHaveBeenCalledTimes(1))

    type('fast.example.com')
    await waitFor(() => expect(resolveGatewayAddress).toHaveBeenCalledTimes(2))

    fast.resolve(at('https://fast.example.com', UNGATED))
    await waitFor(() => expect(screen.getByTestId('probe-result')).toHaveTextContent(/session token required/))

    // The stale answer lands second and must be discarded, not rendered.
    slow.resolve(at('https://slow.example.com', GATED))
    await waitFor(() => expect(screen.getByTestId('probe-result')).toHaveTextContent(/session token required/))
    expect(latest.baseUrl).toBe('https://fast.example.com')
  })

  it('sends validated extra headers along with the probe', async () => {
    resolveGatewayAddress.mockResolvedValue(at('https://hermes.example.com'))
    renderScreen(<Harness />)
    type('hermes.example.com')
    await waitFor(() => expect(resolveGatewayAddress).toHaveBeenCalled())

    fireEvent.press(screen.getByText('▸ Advanced'))
    fireEvent.press(screen.getByText('Add a header'))
    fireEvent.changeText(screen.getAllByLabelText('Header')[0]!, 'CF-Access-Client-Id')
    fireEvent.changeText(screen.getAllByLabelText('Value')[0]!, 'client-id')

    await waitFor(() =>
      expect(resolveGatewayAddress).toHaveBeenLastCalledWith('hermes.example.com', {
        'CF-Access-Client-Id': 'client-id'
      })
    )
  })

  it('marks a header the transport owns as invalid and keeps it off the wire', async () => {
    resolveGatewayAddress.mockResolvedValue(at('https://hermes.example.com'))
    renderScreen(<Harness />)
    type('hermes.example.com')
    await waitFor(() => expect(resolveGatewayAddress).toHaveBeenCalled())

    fireEvent.press(screen.getByText('▸ Advanced'))
    fireEvent.press(screen.getByText('Add a header'))
    fireEvent.changeText(screen.getAllByLabelText('Header')[0]!, 'Authorization')

    await waitFor(() => expect(screen.getByText(/cannot be an extra header/)).toBeTruthy())
    expect(resolveGatewayAddress).toHaveBeenLastCalledWith('hermes.example.com', {})
  })
})

describe('the gateway address step: a cleartext gateway', () => {
  it('says out loud that the gateway was found over http', async () => {
    resolveGatewayAddress.mockResolvedValue(at('http://hermes.tail9f3c.ts.net', UNGATED, true))
    renderScreen(<Harness />)
    type('hermes.tail9f3c.ts.net')

    await waitFor(() => expect(screen.getByTestId('probe-result')).toHaveTextContent(/Found over http:\/\//))
  })

  // The step used to say nothing when https answered. The owner asked for the
  // opposite: he could not tell that a scheme-less address is resolved at all,
  // so the successful case has to name the scheme it landed on too. The notice
  // — which is about cleartext, not about the resolution — still stays away.
  it('names https as the scheme it found when the reader left the scheme out', async () => {
    resolveGatewayAddress.mockResolvedValue(at('https://hermes.example.com'))
    renderScreen(<Harness />)
    type('hermes.example.com')

    await waitFor(() => expect(screen.getByTestId('probe-result')).toHaveTextContent(/Found over https:\/\//))
    expect(screen.queryByTestId('transport-notice')).toBeNull()
  })

  it('says nothing about the scheme when the reader pinned one', async () => {
    resolveGatewayAddress.mockResolvedValue(at('https://hermes.example.com'))
    renderScreen(<Harness />)
    type('https://hermes.example.com')

    await waitFor(() => expect(screen.getByTestId('probe-result')).toBeTruthy())
    expect(screen.queryByText(/Found over/)).toBeNull()
  })

  it('says which scheme it is trying while the probe is in flight', async () => {
    resolveGatewayAddress.mockReturnValue(new Promise(() => {}))
    renderScreen(<Harness />)
    type('hermes.example.com')

    await waitFor(() =>
      expect(screen.getByTestId('probe-result')).toHaveTextContent('Checking https://, then http://…')
    )
  })

  it('names the pinned scheme while the probe is in flight', async () => {
    resolveGatewayAddress.mockReturnValue(new Promise(() => {}))
    renderScreen(<Harness />)
    type('http://192.0.2.10:9119')

    await waitFor(() => expect(screen.getByTestId('probe-result')).toHaveTextContent('Checking http://…'))
  })

  it('states a tailnet address calmly and offers no way out of it', async () => {
    resolveGatewayAddress.mockResolvedValue(at('http://hermes.tail9f3c.ts.net', UNGATED, true))
    renderScreen(<Harness />)
    type('hermes.tail9f3c.ts.net')

    await waitFor(() => expect(screen.getByTestId('transport-notice')).toHaveTextContent(/WireGuard/))
    expect(screen.queryByText('Use https instead')).toBeNull()
  })

  it('states a loopback address as never leaving the machine', async () => {
    resolveGatewayAddress.mockResolvedValue(at('http://localhost:9119', UNGATED))
    renderScreen(<Harness />)
    type('http://localhost:9119')

    await waitFor(() => expect(screen.getByTestId('transport-notice')).toHaveTextContent(/never leaves this machine/))
  })

  it('warns about a public address and offers https instead', async () => {
    resolveGatewayAddress.mockResolvedValue(at('http://hermes.example.com:9119/prefix', UNGATED, true))
    renderScreen(<Harness />)
    type('hermes.example.com:9119/prefix')

    await waitFor(() => expect(screen.getByTestId('transport-notice')).toHaveTextContent(/Anyone on the path/))

    // The action re-types the address with the scheme spelled out, port and
    // prefix intact, which is what stops the fallback running a second time.
    resolveGatewayAddress.mockResolvedValue(at('https://hermes.example.com:9119/prefix', UNGATED))
    fireEvent.press(screen.getByText('Use https instead'))

    await waitFor(() =>
      expect(resolveGatewayAddress).toHaveBeenLastCalledWith('https://hermes.example.com:9119/prefix', {})
    )
    await waitFor(() => expect(screen.queryByTestId('transport-notice')).toBeNull())
  })

  it('says nothing while a new probe is in flight', async () => {
    const pending = deferred<ResolvedAddress>()
    resolveGatewayAddress.mockResolvedValueOnce(at('http://hermes.example.com', UNGATED, true))
    renderScreen(<Harness />)
    type('hermes.example.com')
    await waitFor(() => expect(screen.getByTestId('transport-notice')).toBeTruthy())

    resolveGatewayAddress.mockReturnValueOnce(pending.promise)
    type('other.example.com')

    await waitFor(() => expect(screen.queryByTestId('transport-notice')).toBeNull())
    pending.resolve(at('https://other.example.com', UNGATED))
  })
})
