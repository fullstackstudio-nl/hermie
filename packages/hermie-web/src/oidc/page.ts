/**
 * The provider's own pages, as HTML a browser can use with JavaScript off.
 *
 * The same approach `setup.ts` and `admin/page.ts` take, and here it matters
 * more than in either: this is a SIGN-IN form. It is the page a reader is sent
 * to from somewhere else, the page a password is typed into, and the page an
 * operator will be looking at on the morning the bundle does not load. It has
 * no script, makes no external request, and loads no font.
 *
 * Three rules, the same three the admin page keeps:
 *
 *  - **Nothing secret is rendered** — not a password, not a TOTP secret except
 *    on the one enrolment page whose entire purpose is to show it once.
 *  - **Every value is escaped**, with the `escapeHtml` the setup page already
 *    has, so there is one of it.
 *  - **Every POST carries the CSRF token**, checked before the body is read.
 *
 * One more that is this page's own: **the failure message never says which half
 * was wrong.** "That sign-in was not right" covers an unknown username, a wrong
 * password and a wrong second factor, because a form that distinguishes them is
 * a form that answers "does this person have an account here".
 */
import { escapeHtml } from '../setup'
import { CSRF_FIELD } from '../admin/session'

const STYLE = `
  :root { color-scheme: light dark; --ink: #16181d; --muted: #5d636e; --line: #d9dce2; --bg: #f6f7f9; --card: #fff; --accent: #2f6df6; --bad: #b3261e; }
  @media (prefers-color-scheme: dark) { :root { --ink: #eceef2; --muted: #9aa1ad; --line: #2c3038; --bg: #101216; --card: #181b21; } }
  * { box-sizing: border-box }
  body { font: 16px/1.55 system-ui, sans-serif; margin: 0; background: var(--bg); color: var(--ink) }
  main { max-width: 26rem; margin: 0 auto; padding: 3rem 1rem 4rem }
  h1 { font-size: 1.3rem; margin: 0 0 .25rem }
  p { color: var(--muted); margin: .25rem 0 1rem }
  section { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 1.25rem; margin: 1.25rem 0 }
  label { display: block; font-size: .85rem; color: var(--muted); margin: .75rem 0 .35rem }
  input { width: 100%; font: inherit; padding: .55rem .65rem; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); color: inherit }
  button { font: inherit; margin-top: 1rem; padding: .55rem 1rem; border: 0; border-radius: 8px; background: var(--accent); color: #fff; cursor: pointer; width: 100% }
  .note { font-size: .85rem }
  .bad { color: var(--bad) }
  code { font-family: ui-monospace, monospace; font-size: .9em; word-break: break-all }
  ol { color: var(--muted); padding-left: 1.2rem; font-size: .9rem }
  .codes { display: grid; grid-template-columns: 1fr 1fr; gap: .35rem; font-family: ui-monospace, monospace; font-size: .9rem; margin: .75rem 0 }
`

const head = (title: string): string =>
  `<!doctype html>\n<html lang="en">\n<meta charset="utf-8">\n` +
  `<meta name="viewport" content="width=device-width, initial-scale=1">\n` +
  `<meta name="robots" content="noindex">\n` +
  `<title>${escapeHtml(title)}</title>\n<style>${STYLE}</style>\n`

export interface SignInPageInput {
  issuerName: string
  csrf: string
  /** The authorize query, carried through the form so the POST can resume it. */
  query: string
  username: string
  /** Ask for the second factor as well; set once a password has been accepted. */
  wantsSecondFactor: boolean
  notice: string
}

/**
 * The sign-in form.
 *
 * The second factor is a second STEP rather than a third field on the first
 * page, because asking for a code before a password has been accepted tells an
 * unauthenticated visitor which accounts have one enrolled.
 */
export function signInPage(input: SignInPageInput): string {
  return `${head(`Sign in to ${input.issuerName}`)}<main>
  <h1>Sign in</h1>
  <p>${escapeHtml(input.issuerName)}</p>
  ${input.notice ? `<p class="note bad">${escapeHtml(input.notice)}</p>` : ''}
  <section>
    <form method="post" action="/oidc/authorize?${escapeHtml(input.query)}">
      <input type="hidden" name="${CSRF_FIELD}" value="${escapeHtml(input.csrf)}">
      ${
        input.wantsSecondFactor
          ? `<input type="hidden" name="username" value="${escapeHtml(input.username)}">
      <label for="totp">Six-digit code</label>
      <input id="totp" name="totp" inputmode="numeric" autocomplete="one-time-code" autofocus>
      <label for="recovery">…or one recovery code</label>
      <input id="recovery" name="recovery" autocomplete="off">`
          : `<label for="username">Username</label>
      <input id="username" name="username" value="${escapeHtml(input.username)}" autocomplete="username" autocapitalize="off" spellcheck="false" autofocus>
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password">`
      }
      <button type="submit">${input.wantsSecondFactor ? 'Verify' : 'Sign in'}</button>
    </form>
  </section>
</main>
</html>
`
}

/** A refusal a browser sees, for the errors that must not be redirected. */
export function oidcErrorPage(code: string, detail: string): string {
  return `${head('Sign-in failed')}<main>
  <h1>Sign-in failed</h1>
  <p>${escapeHtml(detail)}</p>
  <p class="note"><code>${escapeHtml(code)}</code></p>
</main>
</html>
`
}

/** The page at the end of `/oidc/logout` when no redirect was asked for. */
export function signedOutPage(issuerName: string): string {
  return `${head('Signed out')}<main>
  <h1>Signed out</h1>
  <p>Your sign-in to ${escapeHtml(issuerName)} has been forgotten on this server.</p>
  <p class="note">The application you came from may keep its own session until it expires.</p>
</main>
</html>
`
}

export interface InvitePageInput {
  issuerName: string
  csrf: string
  token: string
  username: string
  notice: string
}

/**
 * The one-time invitation: where somebody sets their own first password.
 *
 * It exists so that creating an account never ends with an operator knowing
 * somebody else's password, or sending one over a channel neither of them
 * chose. The link is single-use and lapses.
 */
export function invitePage(input: InvitePageInput): string {
  return `${head('Choose a password')}<main>
  <h1>Choose a password</h1>
  <p>${escapeHtml(input.issuerName)} — <code>${escapeHtml(input.username)}</code></p>
  ${input.notice ? `<p class="note bad">${escapeHtml(input.notice)}</p>` : ''}
  <section>
    <form method="post" action="/oidc/invite">
      <input type="hidden" name="${CSRF_FIELD}" value="${escapeHtml(input.csrf)}">
      <input type="hidden" name="token" value="${escapeHtml(input.token)}">
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="new-password" autofocus>
      <label for="confirm">Again</label>
      <input id="confirm" name="confirm" type="password" autocomplete="new-password">
      <button type="submit">Set the password</button>
    </form>
  </section>
  <p class="note">This link works once and then stops. Nobody else, including whoever invited you, ever sees what you type here.</p>
</main>
</html>
`
}

/**
 * The enrolment page: the TOTP secret, shown once.
 *
 * It is the one page in this file that renders a secret, and it does so because
 * there is no other way to enrol an authenticator. There is no QR code — that
 * would mean either an image dependency or a script — so the `otpauth://` URI
 * and the base32 secret are both printed, and every authenticator app accepts
 * one or the other.
 */
export function enrolPage(input: {
  issuerName: string
  csrf: string
  username: string
  secret: string
  uri: string
  recoveryCodes: string[]
  notice: string
}): string {
  return `${head('Set up two-factor')}<main>
  <h1>Two-factor</h1>
  <p>${escapeHtml(input.issuerName)} — <code>${escapeHtml(input.username)}</code></p>
  ${input.notice ? `<p class="note bad">${escapeHtml(input.notice)}</p>` : ''}
  <section>
    <ol>
      <li>Add this to your authenticator:<br><code>${escapeHtml(input.secret)}</code></li>
      <li>Or open <code>${escapeHtml(input.uri)}</code></li>
      <li>Type the code it shows, to prove it works.</li>
    </ol>
    <form method="post" action="/oidc/enrol">
      <input type="hidden" name="${CSRF_FIELD}" value="${escapeHtml(input.csrf)}">
      <label for="totp">Six-digit code</label>
      <input id="totp" name="totp" inputmode="numeric" autocomplete="one-time-code">
      <button type="submit">Confirm</button>
    </form>
  </section>
  ${
    input.recoveryCodes.length
      ? `<section>
    <h1 style="font-size:1rem">Recovery codes</h1>
    <p>Each works once, in place of a code from the app. This is the only time they are shown.</p>
    <div class="codes">${input.recoveryCodes.map(code => `<span>${escapeHtml(code)}</span>`).join('')}</div>
  </section>`
      : ''
  }
</main>
</html>
`
}
