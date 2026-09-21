/**
 * `hermie-web login` — the one interactive moment a daemon is allowed.
 *
 * A gated gateway will not take a token off the command line, so the daemon
 * needs the same grant the app gets: the native PKCE flow of
 * [ADR-0004](../../../../docs/adr/0004-native-pkce-via-webview.md), run from a
 * terminal instead of a WebView. The app intercepts the loopback redirect inside
 * its own WebView and never listens on the port; a terminal has no WebView, so
 * this DOES listen — on `127.0.0.1` only, for one request, with the port closed
 * again the moment the code arrives. RFC 8252 §8.3 is why it is a loopback IP
 * literal and not `localhost`: the gateway rejects the name.
 *
 * What it stores is the REFRESH token, and only that. An access token is an hour
 * long and a daemon that held one would stop notifying in the middle of the
 * night with nothing to say why.
 *
 * **If the gateway's provider issues no refresh token, push is not available.**
 * That is ADR-0017's own conclusion and this command says it in those words
 * rather than storing an hour-long credential and letting it lapse. The fix is
 * on the provider's client registration — the `offline_access` scope — which is
 * the same thing the app's sign-in warns about.
 */
import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import { gatewayApiUrl, type FetchLike, sameGateway } from './credentials'
import { defaultStateDir, loadPushState, savePushState, type StoredRefreshToken } from './state'

/**
 * The port the app's redirect URI names, so a gateway that whitelists one
 * redirect URI accepts both clients without being reconfigured.
 */
export const DEFAULT_REDIRECT_PORT = 38007

export const REDIRECT_PATH = '/callback'

export interface Pkce {
  verifier: string
  challenge: string
  state: string
}

/** base64url without padding (RFC 7636 §4). */
const b64url = (bytes: Buffer): string => bytes.toString('base64url')

export function createPkce(random: (size: number) => Buffer = randomBytes): Pkce {
  const verifier = b64url(random(32))

  return {
    verifier,
    challenge: b64url(createHash('sha256').update(verifier, 'ascii').digest()),
    state: b64url(random(24))
  }
}

export function buildAuthorizeUrl(
  gatewayUrl: string,
  params: { challenge: string; state: string; redirectUri: string; provider?: string | undefined }
): string {
  const url = new URL(gatewayApiUrl(gatewayUrl, '/auth/native/authorize'))

  if (params.provider) {
    url.searchParams.set('provider', params.provider)
  }

  url.searchParams.set('code_challenge', params.challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('redirect_uri', params.redirectUri)
  url.searchParams.set('state', params.state)

  return url.toString()
}

export type LoopbackResult = { code: string; state: string } | { error: string; description: string }

const PAGE = (title: string, detail: string): string =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font:16px/1.5 system-ui;margin:4rem auto;max-width:34rem;padding:0 1rem">` +
  `<h1 style="font-size:1.25rem">${title}</h1><p>${detail}</p></body>`

export interface LoopbackListener {
  redirectUri: string
  /** Resolves with the first callback the browser makes. */
  code: Promise<LoopbackResult>
  close: () => Promise<void>
}

/**
 * Listen on the loopback redirect for exactly one callback.
 *
 * Any other path answers 404 rather than resolving: a browser preloading
 * `/favicon.ico` must not look like a failed sign-in.
 */
export async function listenForRedirect(port = DEFAULT_REDIRECT_PORT): Promise<LoopbackListener> {
  let settle: (result: LoopbackResult) => void = () => undefined
  const code = new Promise<LoopbackResult>(resolve => {
    settle = resolve
  })

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')

    if (url.pathname !== REDIRECT_PATH) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('not found')

      return
    }

    const error = url.searchParams.get('error')

    if (error) {
      const description = url.searchParams.get('error_description') ?? ''
      response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
      response.end(PAGE('Sign-in failed', `${error}${description ? `: ${description}` : ''}`))
      settle({ error, description })

      return
    }

    const value = url.searchParams.get('code')
    const state = url.searchParams.get('state')

    if (!value || !state) {
      response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
      response.end(PAGE('Sign-in failed', 'The redirect carried no code and no error.'))
      settle({ error: 'invalid_redirect', description: 'The redirect carried no code and no error.' })

      return
    }

    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(PAGE('Signed in', 'Hermie Web has the sign-in it needed. You can close this tab.'))
    settle({ code: value, state })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })

  const actual = (server.address() as AddressInfo).port

  return {
    redirectUri: `http://127.0.0.1:${actual}${REDIRECT_PATH}`,
    code,
    close: () =>
      new Promise<void>(resolve => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
}

export interface ExchangedTokens {
  refreshToken: string
  provider: string
  /** Present so the caller can say how long the access token it is discarding was good for. */
  expiresAt: number
}

/** Redeem the one-time code. The gateway consumes it on every path, so a failure here is final. */
export async function exchangeCode(
  gatewayUrl: string,
  params: { code: string; verifier: string },
  fetchImpl: FetchLike = fetch
): Promise<ExchangedTokens> {
  const url = gatewayApiUrl(gatewayUrl, '/auth/native/token')
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ code: params.code, code_verifier: params.verifier })
  })

  if (response.status === 400) {
    throw new Error('That sign-in code was already used or has expired. Run `hermie-web login` again.')
  }

  if (!response.ok) {
    throw new Error(`The code exchange failed with HTTP ${response.status}.`)
  }

  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>

  if (typeof body.access_token !== 'string' || !body.access_token) {
    throw new Error(`${url} answered without an access_token.`)
  }

  const refreshToken = typeof body.refresh_token === 'string' ? body.refresh_token : ''

  if (!refreshToken) {
    // ADR-0017: an hour-long credential is not a credential a daemon can hold.
    throw new Error(
      'This gateway signed in without issuing a refresh token, so push cannot run: the daemon would need somebody ' +
        'at a terminal every hour. Add the `offline_access` scope to the provider’s client registration and try ' +
        'again — it is the same scope the app warns about at sign-in.'
    )
  }

  return {
    refreshToken,
    provider: typeof body.provider === 'string' ? body.provider : '',
    expiresAt: typeof body.expires_at === 'number' ? body.expires_at : 0
  }
}

export interface LoginOptions {
  gatewayUrl: string
  stateDir?: string
  provider?: string | undefined
  port?: number
  fetchImpl?: FetchLike
  /** Where the instructions go. Printed rather than opened: a server has no browser. */
  print?: (line: string) => void
  random?: (size: number) => Buffer
}

/**
 * Run the whole flow and store the grant.
 *
 * Nothing is opened for the operator. This may be a machine with no desktop at
 * all, so the URL is PRINTED and the loopback port is the one the operator has
 * to be able to reach — over an SSH tunnel if the gateway is remote, which the
 * deployment notes spell out.
 */
export async function login(options: LoginOptions): Promise<StoredRefreshToken> {
  const print = options.print ?? ((line: string) => console.warn(line))
  const stateDir = options.stateDir ?? defaultStateDir()
  const pkce = createPkce(options.random ?? randomBytes)
  const listener = await listenForRedirect(options.port ?? DEFAULT_REDIRECT_PORT)

  try {
    const authorizeUrl = buildAuthorizeUrl(options.gatewayUrl, {
      challenge: pkce.challenge,
      state: pkce.state,
      redirectUri: listener.redirectUri,
      provider: options.provider
    })

    print('Open this address in a browser that can reach both the gateway and this machine:')
    print('')
    print(`  ${authorizeUrl}`)
    print('')
    print(`Waiting for the redirect to ${listener.redirectUri} …`)

    const result = await listener.code

    if ('error' in result) {
      throw new Error(`Sign-in failed: ${result.error}${result.description ? ` — ${result.description}` : ''}`)
    }

    if (result.state !== pkce.state) {
      // The CSRF value did not come back. Somebody else's redirect landed here.
      throw new Error('The sign-in redirect carried the wrong state value; nothing was stored.')
    }

    const tokens = await exchangeCode(
      options.gatewayUrl,
      { code: result.code, verifier: pkce.verifier },
      options.fetchImpl ?? fetch
    )
    const stored: StoredRefreshToken = {
      refreshToken: tokens.refreshToken,
      provider: tokens.provider,
      gateway: options.gatewayUrl
    }
    const state = await loadPushState(stateDir)

    if (state.oidc && !sameGateway(state.oidc.gateway, options.gatewayUrl)) {
      // A credential is only meaningful for the gateway it was made on, and so
      // is everything else in this file: the watermarks and dedupe keys belong
      // to sessions that do not exist on the new one.
      state.seq = {}
      state.sent = {}
      state.invalid = {}
      state.tickets = []
      print('The stored sign-in was for a different gateway; its watch state was cleared.')
    }

    state.oidc = stored
    await savePushState(stateDir, state)

    print(`Stored the sign-in for ${options.gatewayUrl} in ${stateDir} (0600). Start the daemon with --push.`)

    return stored
  } finally {
    await listener.close()
  }
}
