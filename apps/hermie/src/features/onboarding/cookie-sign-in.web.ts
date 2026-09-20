/**
 * Starting and ending the gateway's cookie session, from the page it serves.
 *
 * Two doors, both the gateway's own:
 *
 *  - **`GET /auth/login?provider=<name>&next=/`** is the OAuth door. It is a
 *    FULL-PAGE navigation, not a fetch, and it has to be: the chain ends at an
 *    identity provider on another origin, which sets its own cookies and
 *    redirects back to `/auth/callback`, and nothing about that survives being
 *    read with `fetch`. The app is reloaded from scratch when it returns, which
 *    is why the wizard's only durable state is the cookie itself.
 *    A provider that `supports_password` makes this route redirect to the
 *    gateway's own `/login` page instead, so this door works for both kinds —
 *    it is simply a worse experience for the password kind, which is what
 *    `passwordLogin` below is for.
 *  - **`POST /auth/password-login`** is the in-page door for password
 *    providers. It answers `{ok: true, next}` and sets the session cookies on
 *    that response, so the app never leaves the SPA and never sees a password
 *    again after the field is cleared.
 *
 * `next` is validated by the gateway against its own allow-list of in-app
 * targets, so a value it dislikes comes back as the root rather than as an open
 * redirect.
 */
import { GatewayError } from '@hermie/gateway-client'

export interface PasswordLoginInput {
  baseUrl: string
  provider: string
  username: string
  password: string
  next?: string
}

export const COOKIE_SIGN_IN_AVAILABLE = true

export function startCookieSignIn(baseUrl: string, provider?: string, next = '/'): void {
  const url = new URL('/auth/login', baseUrl)

  if (provider) {
    url.searchParams.set('provider', provider)
  }

  url.searchParams.set('next', next)
  window.location.assign(url.toString())
}

export async function passwordLogin(input: PasswordLoginInput): Promise<string> {
  const response = await fetch(new URL('/auth/password-login', input.baseUrl).toString(), {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      provider: input.provider,
      username: input.username,
      password: input.password,
      next: input.next ?? '/'
    })
  })

  if (response.status === 401) {
    throw new GatewayError('auth', 'That user name and password were not accepted.', { status: 401 })
  }

  if (response.status === 429) {
    throw new GatewayError('auth', 'Too many sign-in attempts. Wait a moment and try again.', { status: 429 })
  }

  if (response.status === 404) {
    throw new GatewayError('config', 'This gateway has no password provider by that name.', { status: 404 })
  }

  if (!response.ok) {
    throw new GatewayError('server', `The gateway answered HTTP ${response.status} to the sign-in.`, {
      status: response.status
    })
  }

  const body = (await response.json()) as { ok?: boolean; next?: string }

  if (body.ok !== true) {
    throw new GatewayError('protocol', 'The gateway answered the sign-in without an outcome.')
  }

  return typeof body.next === 'string' && body.next ? body.next : '/'
}
