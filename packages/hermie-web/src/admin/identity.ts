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
import type { WebLocale, WebStrings } from '../i18n'
import { CSRF_FIELD } from './session'
import { adminShell, card, type AdminChrome } from './layout'
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
  /** What the shared chrome needs and this page does not otherwise know. */
  chrome: Pick<AdminChrome, 'brand' | 'version' | 'canSelfUpdate' | 'updateReason'>
}

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
        <div class="fields">
          <div>
            <label for="role-${escapeHtml(user.sub)}">${text.role}</label>
            <select id="role-${escapeHtml(user.sub)}" name="role">
              <option value="user"${user.role === 'user' ? ' selected' : ''}>${text.roleUser}</option>
              <option value="admin"${user.role === 'admin' ? ' selected' : ''}>${text.roleAdmin}</option>
            </select>
          </div>
          <div class="narrow"><button type="submit" name="do" value="role">${input.strings.common.save}</button></div>
        </div>
      </form>
      <form method="post" action="/admin/oidc/user" class="actions">
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

  return card({
    heading: text.heading,
    intro: text.intro,
    body: `${
      rows.length
        ? `<table>
      <thead><tr><th>${text.who}</th><th>${text.role}</th><th>${text.twoFactor}</th><th>${
        text.lastSignIn
      }</th><th></th></tr></thead>
      <tbody>${rows.map(user => userRow(user, input)).join('\n      ')}</tbody>
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
      <div class="fields">
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
        <div class="narrow"><button type="submit" name="do" value="create">${text.invite}</button></div>
      </div>
      <p class="note">${text.inviteNote}</p>
    </form>`
  })
}

function guideSection(input: IdentityPageInput): string {
  const text = input.strings.identity.guide

  return card({
    heading: text.heading,
    intro: text.intro,
    body: `<pre>${escapeHtml(gatewaySnippet(input.state, input.gatewayPublicUrl))}</pre>
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
      <div class="actions"><button type="submit">${text.saveRedirects}</button></div>
    </form>`
  })
}

function testSection(input: IdentityPageInput): string {
  const text = input.strings.identity.test

  return card({
    heading: text.heading,
    intro: text.intro,
    body: `<form method="post" action="/admin/oidc/test">
      <input type="hidden" name="${CSRF_FIELD}" value="${escapeHtml(input.csrf)}">
      <div class="fields">
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
        <div class="narrow"><button type="submit">${text.run}</button></div>
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
    }`
  })
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

  return adminShell(
    {
      ...input.chrome,
      current: 'identity',
      csrf: input.csrf,
      notice: input.notice,
      locale: input.locale,
      strings: input.strings
    },
    {
      title: text.heading,
      body: `${card({
        heading: provider.heading,
        intro: provider.intro,
        body: `<dl>
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
      <div class="actions"><button type="submit"${blocked ? ' disabled' : ''}>${provider.recapture}</button></div>
      <p class="note">${provider.recaptureNote}</p>
    </form>`
        : ''
    }
    <form method="post" action="/admin/oidc/enable">
      <input type="hidden" name="${CSRF_FIELD}" value="${escapeHtml(input.csrf)}">
      <div class="actions">
      ${
        state.enabled
          ? `<button class="quiet" type="submit" name="enabled" value="0">${provider.turnOff}</button>
      <span class="note">${provider.turnOffNote}</span>`
          : `<button type="submit" name="enabled" value="1"${blocked ? ' disabled' : ''}>${provider.turnOn}</button>
      <span class="note">${provider.turnOnNote(escapeHtml(input.origin))}</span>`
      }
      </div>
    </form>`
      })}
  ${
    state.enabled
      ? `${guideSection(input)}
  ${peopleSection(input)}
  ${testSection(input)}
  ${card({
    heading: text.settings.heading,
    body: `<form method="post" action="/admin/oidc/settings">
      <input type="hidden" name="${CSRF_FIELD}" value="${escapeHtml(input.csrf)}">
      <label class="check"><input type="checkbox" name="requireTotp" value="1"${
        state.settings.requireTotp ? ' checked' : ''
      }> ${text.settings.requireTotp}</label>
      <div class="fields">
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
        <div class="narrow"><button type="submit">${input.strings.common.save}</button></div>
      </div>
      <p class="note">${text.settings.note}</p>
    </form>`
  })}
  ${card({
    heading: text.keys.heading,
    intro: text.keys.intro,
    body: `<form method="post" action="/admin/oidc/rotate">
      <input type="hidden" name="${CSRF_FIELD}" value="${escapeHtml(input.csrf)}">
      <div class="actions"><button class="quiet" type="submit">${text.keys.rotate}</button></div>
    </form>`
  })}`
      : ''
  }`
    }
  )
}
