import { GatewayError, type ProbeResult } from '@hermie/gateway-client'
import { fireEvent, screen, waitFor } from '@testing-library/react-native'
import { useState } from 'react'

import { emptyDraft, type OnboardingDraft } from '../src/features/onboarding'
import { GatewayAddressStep } from '../src/features/onboarding/steps/GatewayAddressStep'
import { deferred, renderScreen } from './support/render'

jest.mock('@hermie/gateway-client', () => ({
  ...jest.requireActual('@hermie/gateway-client'),
  probeGateway: jest.fn()
}))

const { probeGateway } = require('@hermie/gateway-client') as { probeGateway: jest.Mock }

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
  probeGateway.mockReset()
  latest = emptyDraft()
})

describe('the gateway address step', () => {
  it('reports a gated gateway as needing a sign-in, naming the provider', async () => {
    probeGateway.mockResolvedValue(GATED)
    renderScreen(<Harness />)
    type('hermes.example.com')

    await waitFor(() =>
      expect(screen.getByTestId('probe-result')).toHaveTextContent(
        'Hermes 2026.9.14 · sign-in required via Self-Hosted OIDC'
      )
    )
  })

  it('names every provider when the gateway offers more than one', async () => {
    probeGateway.mockResolvedValue({
      ...GATED,
      providers: [
        { name: 'self-hosted', displayName: 'Self-Hosted OIDC', supportsPassword: false },
        { name: 'local', displayName: 'Local Accounts', supportsPassword: true }
      ]
    })
    renderScreen(<Harness />)
    type('hermes.example.com')

    await waitFor(() =>
      expect(screen.getByTestId('probe-result')).toHaveTextContent(/Self-Hosted OIDC or Local Accounts/)
    )
  })

  it('reports an ungated gateway as needing a session token', async () => {
    probeGateway.mockResolvedValue(UNGATED)
    renderScreen(<Harness />)
    type('http://localhost:9119')

    await waitFor(() =>
      expect(screen.getByTestId('probe-result')).toHaveTextContent('Hermes 2026.9.14 · session token required')
    )
  })

  it('says so when a gated gateway lists no providers at all', async () => {
    probeGateway.mockResolvedValue({ ...GATED, providers: [] })
    renderScreen(<Harness />)
    type('hermes.example.com')

    await waitFor(() => expect(screen.getByTestId('probe-result')).toHaveTextContent(/lists no identity providers/))
  })

  it('coerces a scheme-less address to https and remembers the normalized form', async () => {
    probeGateway.mockResolvedValue(GATED)
    renderScreen(<Harness />)
    type('hermes.example.com/')

    await waitFor(() => expect(latest.baseUrl).toBe('https://hermes.example.com'))
    expect(probeGateway).toHaveBeenCalledWith('https://hermes.example.com', {})
  })

  it.each([
    ['network', /Could not reach hermes\.example\.com/],
    ['tls', /The TLS certificate for hermes\.example\.com was rejected/],
    ['timeout', /hermes\.example\.com did not answer in time/],
    ['not_hermes', /answered, but not like a Hermes gateway/]
  ] as const)('explains a %s failure', async (kind, expected) => {
    probeGateway.mockRejectedValue(new GatewayError(kind, 'raw'))
    renderScreen(<Harness />)
    type('hermes.example.com')

    await waitFor(() => expect(screen.getByTestId('probe-error')).toHaveTextContent(expected))
    expect(latest.probe).toBeNull()
  })

  it('names the access proxy behind a 401 on the public status endpoint', async () => {
    probeGateway.mockRejectedValue(new GatewayError('auth', 'raw', { status: 403 }))
    renderScreen(<Harness />)
    type('hermes.example.com')

    await waitFor(() =>
      expect(screen.getByTestId('probe-error')).toHaveTextContent(/An access proxy answered HTTP 403/)
    )
  })

  it('explains a 503 from the gateway itself', async () => {
    probeGateway.mockRejectedValue(new GatewayError('server', 'raw', { status: 503 }))
    renderScreen(<Harness />)
    type('hermes.example.com')

    await waitFor(() => expect(screen.getByTestId('probe-error')).toHaveTextContent(/The gateway answered HTTP 503/))
  })

  it('rejects an address that is not http or https before probing anything', async () => {
    renderScreen(<Harness />)
    type('ftp://hermes.example.com')

    await waitFor(() => expect(screen.getByTestId('probe-error')).toHaveTextContent(/must be http:\/\/ or https:\/\//))
    expect(probeGateway).not.toHaveBeenCalled()
  })

  it('never lets a slow probe overwrite the answer to a newer one', async () => {
    const slow = deferred<ProbeResult>()
    const fast = deferred<ProbeResult>()
    probeGateway.mockReturnValueOnce(slow.promise).mockReturnValueOnce(fast.promise)

    renderScreen(<Harness />)
    type('slow.example.com')
    await waitFor(() => expect(probeGateway).toHaveBeenCalledTimes(1))

    type('fast.example.com')
    await waitFor(() => expect(probeGateway).toHaveBeenCalledTimes(2))

    fast.resolve(UNGATED)
    await waitFor(() => expect(screen.getByTestId('probe-result')).toHaveTextContent(/session token required/))

    // The stale answer lands second and must be discarded, not rendered.
    slow.resolve(GATED)
    await waitFor(() => expect(screen.getByTestId('probe-result')).toHaveTextContent(/session token required/))
    expect(latest.baseUrl).toBe('https://fast.example.com')
  })

  it('sends validated extra headers along with the probe', async () => {
    probeGateway.mockResolvedValue(GATED)
    renderScreen(<Harness />)
    type('hermes.example.com')
    await waitFor(() => expect(probeGateway).toHaveBeenCalled())

    fireEvent.press(screen.getByText('+ Advanced'))
    fireEvent.press(screen.getByText('Add a header'))
    fireEvent.changeText(screen.getAllByLabelText('Header')[0]!, 'CF-Access-Client-Id')
    fireEvent.changeText(screen.getAllByLabelText('Value')[0]!, 'client-id')

    await waitFor(() =>
      expect(probeGateway).toHaveBeenLastCalledWith('https://hermes.example.com', {
        'CF-Access-Client-Id': 'client-id'
      })
    )
  })

  it('marks a header the transport owns as invalid and keeps it off the wire', async () => {
    probeGateway.mockResolvedValue(GATED)
    renderScreen(<Harness />)
    type('hermes.example.com')
    await waitFor(() => expect(probeGateway).toHaveBeenCalled())

    fireEvent.press(screen.getByText('+ Advanced'))
    fireEvent.press(screen.getByText('Add a header'))
    fireEvent.changeText(screen.getAllByLabelText('Header')[0]!, 'Authorization')

    await waitFor(() => expect(screen.getByText(/cannot be an extra header/)).toBeTruthy())
    expect(probeGateway).toHaveBeenLastCalledWith('https://hermes.example.com', {})
  })
})
