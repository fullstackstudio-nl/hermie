/**
 * `/admin/oidc` — the built-in identity provider's own page.
 *
 * A page of its own rather than a panel on `/admin`, for two reasons. It is
 * long: a switch, a configuration guide, an account list and a diagnostic. And
 * it is the page an operator reads ONCE, when they are setting the thing up,
 * whereas `/admin` is the page they come back to. `/admin` carries a three-line
 * summary and a link.
 *
 * Same rules as every other page in this service: no script, every control a
 * form that posts and redirects, a double-submit CSRF token checked before the
 * body is read, and nothing secret rendered — with the two deliberate
 * exceptions an identity provider cannot avoid, both shown exactly once and
 * never again:
 *
 *  - **an invitation link**, at the moment it is minted, because its whole
 *    purpose is to be copied and sent;
 *  - **a TOTP secret**, on `/oidc/enrol`, because enrolling an authenticator
 *    means reading it.
 *
 * Neither is recoverable from this page afterwards. The state file holds a
 * digest of the first and the operator's own copy of the second is the only one.
 */
import { escapeHtml } from '../setup'
import { htmlLang, type WebLocale, type WebStrings } from '../i18n'
import { CSRF_FIELD } from './session'
import { issuerForOrigin } from '../oidc/accounts'
import type { SelfTestStep } from '../oidc/selftest'
import type { OidcState } from '../oidc/state'
import type { OidcRole, OidcUser } from '../oidc/users'

export interface IdentityPageInput {
  state: OidcState
  csrf: string
  /** The origin this page was reached on; the issuer would be built from it. */
  origin: string
  /** The gateway's public URL, which decides the redirect URI. */
  gatewayPublicUrl: string
  /** Whether `--allow-insecure-oidc` was passed. */
  allowInsecure: boolean
  /** Whether this origin is one the gateway would accept as an issuer. */
  originAcceptable: boolean
  /** The last invitation minted, shown once and then gone. */
  invite: { username: string; url: string } | null
  /** The last test sign-in's steps, held in memory so a reload is harmless. */
  selfTest: SelfTestStep[]
  /** The language this request negotiated, for `<html lang>`. */
  locale: WebLocale
  /** Every sentence on the page, in that language. */
  strings: WebStrings
  notice: string
}

const STYLE = `
  :root { color-scheme: light dark; --ink: #16181d; --muted: #5d636e; --line: #d9dce2; --bg: #f6f7f9; --card: #fff; --accent: #2f6df6; --bad: #b3261e; --good: #1a7f37; }
  @media (prefers-color-scheme: dark) { :root { --ink: #eceef2; --muted: #9aa1ad; --line: #2c3038; --bg: #101216; --card: #181b21; --good: #3fb950; } }
  * { box-sizing: border-box }
  body { font: 16px/1.55 system-ui, sans-serif; margin: 0; background: var(--bg); color: var(--ink) }
  main { max-width: 50rem; margin: 0 auto; padding: 2.5rem 1rem 4rem }
  h1 { font-size: 1.4rem; margin: 0 0 .25rem }
  h2 { font-size: 1rem; margin: 0 0 .5rem }
  p { color: var(--muted); margin: .25rem 0 1rem }
  section { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 1.25rem; margin: 1.25rem 0 }
  label { display: block; font-size: .85rem; color: var(--muted); margin-bottom: .35rem }
  input[type=text], input[type=password], input[type=number], input[type=email], select, textarea { width: 100%; font: inherit; padding: .5rem .6rem; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); color: inherit }
  button { font: inherit; padding: .5rem .9rem; border: 0; border-radius: 8px; background: var(--accent); color: #fff; cursor: pointer }
  button.quiet { background: transparent; color: var(--accent); border: 1px solid var(--line) }
  table { width: 100%; border-collapse: collapse; font-size: .9rem }
  th, td { text-align: left; padding: .45rem .4rem; border-bottom: 1px solid var(--line); vertical-align: top }
  th { color: var(--muted); font-weight: 600 }
  .row { display: flex; gap: .6rem; align-items: flex-end; flex-wrap: wrap }
  .row > div { flex: 1; min-width: 9rem }
  .note { font-size: .85rem }
  .bad { color: var(--bad) }
  .ok { color: var(--good) }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: .25rem .9rem; margin: 0; font-size: .9rem }
  dt { color: var(--muted) }
  code { font-family: ui-monospace, monospace; font-size: .9em; word-break: break-all }
  pre { background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: .75rem; overflow-x: auto; font-size: .85rem }
  a { color: var(--accent) }
`

const head = (locale: WebLocale, title: string): string =>
  `<!doctype html>\n<html lang="${htmlLang(locale)}">\n<meta charset="utf-8">\n` +
  `<meta name="viewport" content="width=device-width, initial-scale=1">\n` +
  `<title>${escapeHtml(title)}</title>\n<style>${STYLE}</style>\n`

const when = (seconds: number): string =>
  seconds ? new Date(seconds * 1000).toISOString().slice(0, 16).replace('T', ' ') : '—'

/**
 * The name of a role, as opposed to its value.
 *
 * The two are the same word in English and the `<option value>` keeps the
 * value, because that is what the form posts and what the state file holds. A
 * reader of a translated page gets the word for it in their own language.
 */
const roleName = (role: OidcRole, text: WebStrings['identity']['accounts']): string =>
  role === 'admin' ? text.roleAdmin : text.roleUser

/**
 * The gateway snippet, with this deployment's real values in it.
 *
 * Printed rather than described, because the failure mode this replaces is an
 * operator transcribing an issuer URL by hand and getting the path wrong. The
 * keys are the ones upstream actually reads — `dashboard.oauth.self_hosted.*`
 * — and `offline_access` is in the scopes because without it the gateway issues
 * no refresh token and this service's own push login cannot be made.
 */
export function gatewaySnippet(state: OidcState, gatewayPublicUrl: string): string {
  return [
    'dashboard:',
    `  public_url: ${gatewayPublicUrl}`,
    '  oauth:',
    '    self_hosted:',
    `      issuer: ${state.issuer}`,
    `      client_id: ${state.client.clientId}`,
    '      scopes: openid profile email offline_access'
  ].join('\n')
}

/** The same three settings as environment variables, for a container deployment. */
export function gatewayEnvSnippet(state: OidcState): string {
  return [
    `HERMES_DASHBOARD_OIDC_ISSUER=${state.issuer}`,
    `HERMES_DASHBOARD_OIDC_CLIENT_ID=${state.client.clientId}`,
    'HERMES_DASHBOARD_OIDC_SCOPES="openid profile email offline_access"'
  ].join('\n')
}

function userRow(user: OidcUser, input: IdentityPageInput): string {
  const text = input.strings.identity.accounts
  const hidden = `<input type="hidden" name="${CSRF_FIELD}" value="${escapeHtml(input.csrf)}">
        <input type="hidden" name="sub" value="${escapeHtml(user.sub)}">`

  return `<tr>
    <td>
      <strong>${escapeHtml(user.username)}</strong>${
        user.disabled ? ` <span class="note bad">${text.disabled}</span>` : ''
      }
      <br><span class="note">${escapeHtml(user.displayName || user.email || '—')}</span>
      <br><code class="note">${escapeHtml(user.sub)}</code>
    </td>
    <td class="note">${roleName(user.role, text)}</td>
    <td class="note">${user.totpSecret ? text.totpOn : user.invite ? text.totpInvited : text.totpOff}</td>
    <td class="note">${when(user.lastSignInAt)}</td>
    <td>
      <form method="post" action="/admin/oidc/user">
        ${hidden}
        <div class="row">
          <div>
            <label for="role-${escapeHtml(user.sub)}">${text.role}</label>
            <select id="role-${escapeHtml(user.sub)}" name="role">
              <option value="user"${user.role === 'user' ? ' selected' : ''}>${text.roleUser}</option>
              <option value="admin"${user.role === 'admin' ? ' selected' : ''}>${text.roleAdmin}</option>
            </select>
          </div>
          <div><button type="submit" name="do" value="role">${input.strings.common.save}</button></div>
        </div>
      </form>
      <form method="post" action="/admin/oidc/user">
        ${hidden}
        <button class="quiet" type="submit" name="do" value="invite">${text.resetPassword}</button>
        <button class="quiet" type="submit" name="do" value="${user.disabled ? 'enable' : 'disable'}">${
          user.disabled ? text.reEnable : text.disable
        }</button>
        ${
          user.totpSecret
            ? `<button class="quiet" type="submit" name="do" value="clear-totp">${text.clearTotp}</button>`
            : ''
        }
        <button class="quiet" type="submit" name="do" value="remove">${text.remove}</button>
      </form>
    </td>
  </tr>`
}

function peopleSection(input: IdentityPageInput): string {
  const text = input.strings.identity.accounts
  const rows = [...input.state.users].sort((left, right) => left.username.localeCompare(right.username))

  return `<section>
    <h2>${text.heading}</h2>
    <p>${text.intro}</p>
    ${
      rows.length
        ? `<table>
      <tr><th>${text.who}</th><th>${text.role}</th><th>${text.twoFactor}</th><th>${text.lastSignIn}</th><th></th></tr>
      ${rows.map(user => userRow(user, input)).join('\n      ')}
    </table>`
        : `<p class="note">${text.empty}</p>`
    }
    ${
      input.invite
        ? `<p class="note ok">${text.invitation(escapeHtml(input.invite.username))}<br><code>${escapeHtml(
            input.invite.url
          )}</code></p>`
        : ''
    }
    <form method="post" action="/admin/oidc/user">
      <input type="hidden" name="${CSRF_FIELD}" value="${escapeHtml(input.csrf)}">
      <div class="row">
        <div>
          <label for="new-username">${text.username}</label>
          <input id="new-username" name="username" type="text" autocapitalize="off" spellcheck="false">
        </div>
        <div>
          <label for="new-email">${text.email}</label>
          <input id="new-email" name="email" type="email" autocapitalize="off" spellcheck="false">
        </div>
        <div>
          <label for="new-name">${text.displayName}</label>
          <input id="new-name" name="displayName" type="text">
        </div>
        <div>
          <label for="new-role">${text.role}</label>
          <select id="new-role" name="role"><option value="user">${text.roleUser}</option><option value="admin">${
            text.roleAdmin
          }</option></select>
        </div>
        <div><button type="submit" name="do" value="create">${text.invite}</button></div>
      </div>
      <p class="note">${text.inviteNote}</p>
    </form>
  </section>`
}

function guideSection(input: IdentityPageInput): string {
  const text = input.strings.identity.guide

  return `<section>
    <h2>${text.heading}</h2>
    <p>${text.intro}</p>
    <pre>${escapeHtml(gatewaySnippet(input.state, input.gatewayPublicUrl))}</pre>
    <p>${text.orContainer}</p>
    <pre>${escapeHtml(gatewayEnvSnippet(input.state))}</pre>
    <dl>
      <dt>${text.issuer}</dt><dd><code>${escapeHtml(input.state.issuer)}</code></dd>
      <dt>${text.clientId}</dt><dd>${text.clientIdValue(escapeHtml(input.state.client.clientId))}</dd>
      <dt>${text.redirectUri}</dt><dd>${input.state.client.redirectUris
        .map(uri => `<code>${escapeHtml(uri)}</code>`)
        .join('<br>')}</dd>
      <dt>${text.clientSecret}</dt><dd>${text.clientSecretValue}</dd>
    </dl>
    <p class="note">${text.offlineAccess}</p>
    <p class="note">${text.redirectIsTheGateways}</p>
    <form method="post" action="/admin/oidc/redirects">
      <input type="hidden" name="${CSRF_FIELD}" value="${escapeHtml(input.csrf)}">
      <label for="redirects">${text.redirectsLabel}</label>
      <textarea id="redirects" name="redirectUris" rows="3" spellcheck="false">${escapeHtml(
        input.state.client.redirectUris.join('\n')
      )}</textarea>
      <p class="note">${text.redirectsNote}</p>
      <button type="submit">${text.saveRedirects}</button>
    </form>
  </section>`
}

function testSection(input: IdentityPageInput): string {
  const text = input.strings.identity.test

  return `<section>
    <h2>${text.heading}</h2>
    <p>${text.intro}</p>
    <form method="post" action="/admin/oidc/test">
      <input type="hidden" name="${CSRF_FIELD}" value="${escapeHtml(input.csrf)}">
      <div class="row">
        <div>
          <label for="test-username">${text.username}</label>
          <input id="test-username" name="username" type="text" autocapitalize="off" spellcheck="false">
        </div>
        <div>
          <label for="test-password">${text.password}</label>
          <input id="test-password" name="password" type="password" autocomplete="off">
        </div>
        <div>
          <label for="test-totp">${text.code}</label>
          <input id="test-totp" name="totp" type="text" inputmode="numeric" autocomplete="off">
        </div>
        <div><button type="submit">${text.run}</button></div>
      </div>
      <p class="note">${text.note}</p>
    </form>
    ${
      input.selfTest.length
        ? `<table>
      ${input.selfTest
        .map(
          step =>
            `<tr><td><strong>${escapeHtml(step.name)}</strong></td><td class="${
              step.ok ? 'ok' : 'bad'
            }">${step.ok ? text.stepOk : text.stepFailed}</td><td class="note">${escapeHtml(step.detail)}</td></tr>`
        )
        .join('\n      ')}
    </table>`
        : ''
    }
  </section>`
}

export function identityPage(input: IdentityPageInput): string {
  const { state } = input
  const text = input.strings.identity
  const provider = text.provider
  const blocked = !input.originAcceptable && !input.allowInsecure
  /*
    The issuer that is STORED against the issuer this address would give.

    They are the same on every deployment that was set up on the address it is
    still reached on, and they disagree the moment something in front of this
    service changes the origin — a port that a reverse proxy dropped being the
    case this was written for. The page says so rather than leaving an operator
    to compare two URLs in their head, because the symptom at the other end is
    "nobody can sign in" with nothing in any log about a port.
  */
  const issuerHere = issuerForOrigin(input.origin)
  const moved = state.enabled && state.issuer !== issuerHere

  return `${head(input.locale, text.title)}<main>
  <h1>${text.heading}</h1>
  <p><a href="/admin">${text.backToAdmin}</a></p>
  ${input.notice ? `<p class="note ok">${escapeHtml(input.notice)}</p>` : ''}

  <section>
    <h2>${provider.heading}</h2>
    <p>${provider.intro}</p>
    <dl>
      <dt>${provider.status}</dt><dd>${state.enabled ? `<span class="ok">${provider.on}</span>` : provider.off}</dd>
      ${
        state.enabled
          ? `<dt>${provider.issuer}</dt><dd><code>${escapeHtml(state.issuer)}</code></dd>
      <dt>${provider.reachedOn}</dt><dd><code>${escapeHtml(input.origin)}</code></dd>
      <dt>${provider.signingKeys}</dt><dd>${provider.keysPublished(state.keys.length)}</dd>
      <dt>${provider.accounts}</dt><dd>${state.users.length}</dd>`
          : ''
      }
    </dl>
    ${blocked ? `<p class="note bad">${provider.originBlocked(escapeHtml(input.origin))}</p>` : ''}
    ${
      moved
        ? `<p class="note bad">${provider.issuerElsewhere(escapeHtml(state.issuer), escapeHtml(input.origin))}</p>
    <form method="post" action="/admin/oidc/recapture">
      <input type="hidden" name="${CSRF_FIELD}" value="${escapeHtml(input.csrf)}">
      <button type="submit"${blocked ? ' disabled' : ''}>${provider.recapture}</button>
      <p class="note">${provider.recaptureNote}</p>
    </form>`
        : ''
    }
    <form method="post" action="/admin/oidc/enable">
      <input type="hidden" name="${CSRF_FIELD}" value="${escapeHtml(input.csrf)}">
      ${
        state.enabled
          ? `<button type="submit" name="enabled" value="0">${provider.turnOff}</button>
      <span class="note">${provider.turnOffNote}</span>`
          : `<button type="submit" name="enabled" value="1"${blocked ? ' disabled' : ''}>${provider.turnOn}</button>
      <span class="note">${provider.turnOnNote(escapeHtml(input.origin))}</span>`
      }
    </form>
  </section>

  ${
    state.enabled
      ? `${guideSection(input)}
  ${peopleSection(input)}
  ${testSection(input)}

  <section>
    <h2>${text.settings.heading}</h2>
    <form method="post" action="/admin/oidc/settings">
      <input type="hidden" name="${CSRF_FIELD}" value="${escapeHtml(input.csrf)}">
      <label><input type="checkbox" name="requireTotp" value="1"${state.settings.requireTotp ? ' checked' : ''}> ${
        text.settings.requireTotp
      }</label>
      <div class="row">
        <div>
          <label for="id-ttl">${text.settings.idTokenTtl}</label>
          <input id="id-ttl" name="idTokenTtlSeconds" type="number" min="60" value="${
            state.settings.idTokenTtlSeconds
          }">
        </div>
        <div>
          <label for="rt-ttl">${text.settings.refreshTokenTtl}</label>
          <input id="rt-ttl" name="refreshTokenTtlSeconds" type="number" min="300" value="${
            state.settings.refreshTokenTtlSeconds
          }">
        </div>
        <div><button type="submit">${input.strings.common.save}</button></div>
      </div>
      <p class="note">${text.settings.note}</p>
    </form>
  </section>

  <section>
    <h2>${text.keys.heading}</h2>
    <p>${text.keys.intro}</p>
    <form method="post" action="/admin/oidc/rotate">
      <input type="hidden" name="${CSRF_FIELD}" value="${escapeHtml(input.csrf)}">
      <button type="submit">${text.keys.rotate}</button>
    </form>
  </section>`
      : ''
  }
</main>
</html>
`
}
