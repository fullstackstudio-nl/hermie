/**
 * The provider's own pages, as HTML a browser can use with JavaScript off.
 *
 * The same approach `setup.ts` and the administration pages take, and here it
 * matters more than in either: this is a SIGN-IN form. It is the page a reader
 * is sent to from somewhere else, the page a password is typed into, and the
 * page an operator will be looking at on the morning the bundle does not load.
 * It has no script, makes no external request, and loads no font.
 *
 * **It looks like the deployment it belongs to.** The chrome is `admin/layout`'s
 * — the mark, the branding name, the cards, the light and dark palettes — so
 * somebody following an invitation link lands on a page that plainly belongs to
 * the thing they were invited to, rather than on unstyled HTML that reads like a
 * page that has lost its style sheet. The name in the header is the one the
 * operator set; the only thing this file knows about it is that it is a string.
 *
 * Three rules, the same three the administration keeps:
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
import type { WebLocale, WebStrings } from '../i18n'
import { barePage, card, csrfField } from '../admin/layout'

export interface SignInPageInput {
  issuerName: string
  csrf: string
  /** The authorize query, carried through the form so the POST can resume it. */
  query: string
  username: string
  /** Ask for the second factor as well; set once a password has been accepted. */
  wantsSecondFactor: boolean
  notice: string
  /** The language this request negotiated, for `<html lang>`. */
  locale: WebLocale
  /** Every sentence on the page, in that language. */
  strings: WebStrings
}

/**
 * The sign-in form.
 *
 * The second factor is a second STEP rather than a third field on the first
 * page, because asking for a code before a password has been accepted tells an
 * unauthenticated visitor which accounts have one enrolled.
 */
export function signInPage(input: SignInPageInput): string {
  const text = input.strings.oidc.signIn

  return barePage({
    brand: input.issuerName,
    title: text.heading,
    documentTitle: text.title(input.issuerName),
    width: 'narrow',
    locale: input.locale,
    strings: input.strings,
    body: `${input.notice ? `<p class="banner bad">${escapeHtml(input.notice)}</p>` : ''}
    ${card({
      body: `<form method="post" action="/oidc/authorize?${escapeHtml(input.query)}">
      ${csrfField(input.csrf)}
      ${
        input.wantsSecondFactor
          ? `<input type="hidden" name="username" value="${escapeHtml(input.username)}">
      <label for="totp">${text.totp}</label>
      <input id="totp" name="totp" inputmode="numeric" autocomplete="one-time-code" autofocus>
      <label for="recovery">${text.recovery}</label>
      <input id="recovery" name="recovery" autocomplete="off">`
          : `<label for="username">${text.username}</label>
      <input id="username" name="username" type="text" value="${escapeHtml(
        input.username
      )}" autocomplete="username" autocapitalize="off" spellcheck="false" autofocus>
      <label for="password">${text.password}</label>
      <input id="password" name="password" type="password" autocomplete="current-password">`
      }
      <div class="actions">
        <button type="submit">${input.wantsSecondFactor ? text.verify : input.strings.common.signIn}</button>
      </div>
    </form>`
    })}`
  })
}

/**
 * A refusal a browser sees, for the errors that must not be redirected.
 *
 * `detail` is a sentence the caller chose. Most come out of
 * `strings.oidc.error`; the ones that do not are a provider's own message about
 * a malformed request, which has no translation and is escaped like any other
 * value.
 */
export function oidcErrorPage(input: {
  code: string
  detail: string
  issuerName: string
  locale: WebLocale
  strings: WebStrings
}): string {
  const text = input.strings.oidc.error

  return barePage({
    brand: input.issuerName,
    title: text.title,
    width: 'narrow',
    locale: input.locale,
    strings: input.strings,
    body: `<p class="lede">${escapeHtml(input.detail)}</p>
    <p class="note"><code>${escapeHtml(input.code)}</code></p>`
  })
}

/**
 * The page at the end of something that WORKED.
 *
 * It exists because the two successes this provider has — a password chosen from
 * an invitation, an authenticator enrolled — were both drawn by
 * `oidcErrorPage`. The sentence under the heading said the password was set and
 * the heading over it said "Sign-in failed", so the reader who had just done
 * exactly what they were asked was told they had failed.
 *
 * `back` is a path on THIS origin rather than an absolute address, and
 * deliberately: the reader is already here, so a relative link cannot be pointed
 * at the wrong port by a proxy header. It is not `--login-return` either —
 * that one is a path on the GATEWAY's vhost, which the gateway redirects back
 * here, and resolving it against this origin would link to something this
 * service does not serve.
 */
export function oidcDonePage(input: {
  title: string
  detail: string
  issuerName: string
  back: string
  locale: WebLocale
  strings: WebStrings
}): string {
  return barePage({
    brand: input.issuerName,
    title: input.title,
    width: 'narrow',
    locale: input.locale,
    strings: input.strings,
    body: `<p class="lede">${escapeHtml(input.detail)}</p>
    <p><a href="${escapeHtml(input.back)}">${input.strings.oidc.done.back(escapeHtml(input.issuerName))}</a></p>`
  })
}

/** The page at the end of `/oidc/logout` when no redirect was asked for. */
export function signedOutPage(input: { issuerName: string; locale: WebLocale; strings: WebStrings }): string {
  const text = input.strings.oidc.signedOut

  return barePage({
    brand: input.issuerName,
    title: text.title,
    width: 'narrow',
    locale: input.locale,
    strings: input.strings,
    body: `<p class="lede">${text.detail(escapeHtml(input.issuerName))}</p>
    <p class="note">${text.note}</p>`
  })
}

export interface InvitePageInput {
  issuerName: string
  csrf: string
  token: string
  username: string
  notice: string
  /** The language this request negotiated, for `<html lang>`. */
  locale: WebLocale
  /** Every sentence on the page, in that language. */
  strings: WebStrings
}

/**
 * The one-time invitation: where somebody sets their own first password.
 *
 * It exists so that creating an account never ends with an operator knowing
 * somebody else's password, or sending one over a channel neither of them
 * chose. The link is single-use and lapses.
 */
export function invitePage(input: InvitePageInput): string {
  const text = input.strings.oidc.invite

  return barePage({
    brand: input.issuerName,
    title: text.title,
    width: 'narrow',
    locale: input.locale,
    strings: input.strings,
    body: `<p class="lede"><code>${escapeHtml(input.username)}</code></p>
    ${input.notice ? `<p class="banner bad">${escapeHtml(input.notice)}</p>` : ''}
    ${card({
      body: `<form method="post" action="/oidc/invite">
      ${csrfField(input.csrf)}
      <input type="hidden" name="token" value="${escapeHtml(input.token)}">
      <label for="password">${text.password}</label>
      <input id="password" name="password" type="password" autocomplete="new-password" autofocus>
      <label for="confirm">${text.again}</label>
      <input id="confirm" name="confirm" type="password" autocomplete="new-password">
      <div class="actions"><button type="submit">${text.submit}</button></div>
    </form>`
    })}
    <p class="note">${text.note}</p>`
  })
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
  /** The language this request negotiated, for `<html lang>`. */
  locale: WebLocale
  /** Every sentence on the page, in that language. */
  strings: WebStrings
}): string {
  const text = input.strings.oidc.enrol

  return barePage({
    brand: input.issuerName,
    title: text.heading,
    documentTitle: text.title,
    width: 'narrow',
    locale: input.locale,
    strings: input.strings,
    body: `<p class="lede"><code>${escapeHtml(input.username)}</code></p>
    ${input.notice ? `<p class="banner bad">${escapeHtml(input.notice)}</p>` : ''}
    ${card({
      body: `<ol>
      <li>${text.addToAuthenticator}<br><code>${escapeHtml(input.secret)}</code></li>
      <li>${text.orOpen} <code>${escapeHtml(input.uri)}</code></li>
      <li>${text.typeTheCode}</li>
    </ol>
    <form method="post" action="/oidc/enrol">
      ${csrfField(input.csrf)}
      <label for="totp">${text.totp}</label>
      <input id="totp" name="totp" inputmode="numeric" autocomplete="one-time-code">
      <div class="actions"><button type="submit">${text.confirm}</button></div>
    </form>`
    })}
    ${
      input.recoveryCodes.length
        ? card({
            heading: text.recoveryHeading,
            intro: text.recoveryNote,
            body: `<div class="codes">${input.recoveryCodes
              .map(code => `<span>${escapeHtml(code)}</span>`)
              .join('')}</div>`
          })
        : ''
    }`
  })
}
