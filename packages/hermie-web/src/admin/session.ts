/**
 * The admin page's own session and its CSRF token.
 *
 * `/setup` needed neither: it exists only while nothing is configured, and the
 * one thing it can do is the thing it is for. `/admin` is different in both
 * respects — it outlives the setup, and every one of its forms changes
 * something — so it gets the two things a form-driven page has to have.
 *
 * **The session is in memory and dies with the process.** That is deliberate
 * rather than unfinished: an operator signs in again after a restart, which is
 * a few seconds once a month, and the alternative is a second credential on
 * disk that is as good as the first. On a gateway with accounts there is no
 * admin session at all — the gateway's own cookie is the credential and this
 * module only mints the CSRF token.
 *
 * **The CSRF token is a double submit**, which is the shape that needs no
 * server-side table: a random value in a `SameSite=Strict`, `HttpOnly=false`
 * cookie, echoed in a hidden field, and compared in constant time. Every POST
 * checks it, and a POST with no token is refused before its body is read.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'

/** The cookie the token rides in. Named so it cannot collide with the gateway's. */
export const CSRF_COOKIE = 'hermie_admin_csrf'
/** The form field that has to echo it. */
export const CSRF_FIELD = 'csrf'
/** The cookie one local-administrator sign-in rides in. */
export const ADMIN_SESSION_COOKIE = 'hermie_admin_session'

/**
 * How long a local-administrator sign-in lasts.
 *
 * Long enough to change a dozen settings and read the status; short enough that
 * a browser left open on a shared machine is not an open door for a day.
 */
export const ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1000

export function newToken(): string {
  return randomBytes(24).toString('base64url')
}

/** Read one cookie out of a request's `Cookie` header. */
export function cookieOf(header: string | undefined, name: string): string {
  for (const part of String(header ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=')

    if (key === name) {
      return decodeURIComponent(rest.join('='))
    }
  }

  return ''
}

export function tokensMatch(left: string, right: string): boolean {
  if (!left || !right || left.length !== right.length) {
    return false
  }

  return timingSafeEqual(Buffer.from(left), Buffer.from(right))
}

/**
 * Local-administrator sign-ins, in memory.
 *
 * A `Set` of opaque values with an expiry each. Nothing about the operator is
 * in it: the value is the credential, the same way the gateway's own session
 * cookie is.
 */
export class AdminSessions {
  private readonly open = new Map<string, number>()

  constructor(private readonly options: { now?: () => number; ttlMs?: number } = {}) {}

  private get now(): number {
    return this.options.now?.() ?? Date.now()
  }

  create(): string {
    const value = newToken()
    this.open.set(value, this.now + (this.options.ttlMs ?? ADMIN_SESSION_TTL_MS))
    this.sweep()

    return value
  }

  has(value: string): boolean {
    if (!value) {
      return false
    }

    const expires = this.open.get(value)

    if (expires === undefined) {
      return false
    }

    if (expires <= this.now) {
      this.open.delete(value)

      return false
    }

    return true
  }

  drop(value: string): void {
    this.open.delete(value)
  }

  private sweep(): void {
    for (const [value, expires] of this.open) {
      if (expires <= this.now) {
        this.open.delete(value)
      }
    }
  }
}

/**
 * The `Set-Cookie` line for a value on this origin.
 *
 * `SameSite=Strict` on both, which is what makes the double submit worth
 * anything: a cross-site POST cannot carry the cookie, so it cannot know the
 * token to echo. `Secure` only when the request arrived over TLS, for the same
 * reason `proxy.ts::rewriteSetCookie` drops it — a `Secure` cookie on a plain
 * HTTP origin is one the browser throws away, and an operator on loopback would
 * be unable to sign in at all.
 */
export function setCookie(
  name: string,
  value: string,
  options: { secure: boolean; httpOnly: boolean; maxAge?: number }
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'SameSite=Strict']

  if (options.httpOnly) {
    parts.push('HttpOnly')
  }

  if (options.secure) {
    parts.push('Secure')
  }

  parts.push(`Max-Age=${options.maxAge ?? Math.floor(ADMIN_SESSION_TTL_MS / 1000)}`)

  return parts.join('; ')
}
