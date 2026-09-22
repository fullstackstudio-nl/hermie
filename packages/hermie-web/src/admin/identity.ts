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
import { avatar, cell, pill, rosterHead, whenAgo, whenCell } from './roster'
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

/** The whole stamp, for the panel. The line above it says it the short way. */
const when = (seconds: number, strings: WebStrings): string => (seconds ? whenAgo(seconds, strings).title : '—')

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

/**
 * One account: the line, and the panel behind the link at the end of it.
 *
 * Every control an account has is in the panel, and that is the whole of the
 * change. They used to be in the last cell of the row — a role select, a Save,
 * and then Reset password, Disable and Delete wrapped onto two more lines — so
 * an account was about 170 pixels tall and no column lined up with the one above
 * it. A line is a line now, and the four things an operator does to an account
 * are one click away with room to say what they do.
 *
 * The subject id is not on the line. It is 22 characters of base64url that mean
 * nothing to a reader and wrap mid-string when the column is narrow; it is on
 * the pointer, and in the panel where it can be copied.
 */
function accountRow(user: OidcUser, index: number, input: IdentityPageInput): string {
  const text = input.strings.identity.accounts
  const common = input.strings.common
  const panel = `account-${index}`
  const hidden = `<input type="hidden" name="${CSRF_FIELD}" value="${escapeHtml(input.csrf)}">
          <input type="hidden" name="sub" value="${escapeHtml(user.sub)}">`
  const name = user.displayName || user.email

  return `<li>
    <div class="roster-row">
      <span class="who">
        ${avatar(user.displayName || user.username, user.sub)}
        <span class="who-text">
          <span class="who-name"><strong>${escapeHtml(user.username)}</strong>${
            user.role === 'admin' ? pill(text.administrator, 'on') : ''
          }${user.invite ? pill(text.invited) : ''}${user.totpSecret ? pill(text.twoFactorOn) : ''}${
            user.disabled ? pill(text.disabled, 'bad') : ''
          }</span>
          <span class="who-sub" title="${escapeHtml(user.sub)}">${escapeHtml(name || '—')}</span>
        </span>
      </span>
      ${cell(text.role, roleName(user.role, text))}
      ${cell(text.twoFactor, user.totpSecret ? text.totpOn : user.invite ? text.totpInvited : text.totpOff)}
      ${whenCell(text.lastSignIn, user.lastSignInAt, input.strings)}
      <a class="more" href="#${panel}" aria-label="${escapeHtml(common.detailsFor(user.username))}">${
        common.details
      }</a>
    </div>
    <div class="panel" id="${panel}">
      <dl>
        <dt>${text.subject}</dt><dd><code>${escapeHtml(user.sub)}</code></dd>
        ${user.email ? `<dt>${text.email}</dt><dd>${escapeHtml(user.email)}</dd>` : ''}
        <dt>${text.lastSignIn}</dt><dd>${escapeHtml(when(user.lastSignInAt, input.strings))}</dd>
      </dl>
      <p class="note">${text.subjectNote}</p>
      <h3>${text.actionsHeading}</h3>
      <form method="post" action="/admin/oidc/user">
        ${hidden}
        <div class="fields">
          <div>
            <label for="role-${panel}">${text.role}</label>
            <select id="role-${panel}" name="role">
              <option value="user"${user.role === 'user' ? ' selected' : ''}>${text.roleUser}</option>
              <option value="admin"${user.role === 'admin' ? ' selected' : ''}>${text.roleAdmin}</option>
            </select>
          </div>
          <div class="narrow"><button type="submit" name="do" value="role">${common.save}</button></div>
        </div>
      </form>
      <form method="post" action="/admin/oidc/user" class="actions">
        ${hidden}
        <button class="quiet" type="submit" name="do" value="invite">${text.resetPassword}</button>
        ${
          user.totpSecret
            ? `<button class="quiet" type="submit" name="do" value="clear-totp">${text.clearTotp}</button>`
            : ''
        }
        <button class="quiet spread" type="submit" name="do" value="${user.disabled ? 'enable' : 'disable'}">${
          user.disabled ? text.reEnable : text.disable
        }</button>
        <button class="quiet" type="submit" name="do" value="remove">${text.remove}</button>
        <a class="more" href="#accounts">${common.close}</a>
      </form>
    </div>
  </li>`
}

function accountsRoster(input: IdentityPageInput): string {
  const text = input.strings.identity.accounts
  const rows = [...input.state.users].sort((left, right) => left.username.localeCompare(right.username))

  if (!rows.length) {
    return `<p class="note">${text.empty}</p>`
  }

  return `<div class="roster accounts" id="accounts">
  ${rosterHead([text.who, text.role, text.twoFactor, text.lastSignIn, ''])}
  <ul class="roster-list">
    ${rows.map((user, index) => accountRow(user, index, input)).join('\n    ')}
  </ul>
</div>`
}

function peopleSection(input: IdentityPageInput): string {
  const text = input.strings.identity.accounts

  return card({
    heading: text.heading,
    intro: text.intro,
    body: `${accountsRoster(input)}
    ${
      input.invite
        ? `<p class="note ok">${text.invitation(escapeHtml(input.invite.username))}<br><code>${escapeHtml(
            input.invite.url
          )}</code></p>`
        : ''
    }`
  })
}

/**
 * The invitation form, as its own card.
 *
 * Four fields in a 2×2 grid rather than a row that flexed: the row gave each
 * field whatever was left over, so Username was twice the width of Display name
 * and the labels above them started in four different places. Two equal columns
 * is one rule that holds at every width, and on a phone it is one column.
 */
function inviteSection(input: IdentityPageInput): string {
  const text = input.strings.identity.accounts

  return card({
    heading: text.inviteHeading,
    body: `<form method="post" action="/admin/oidc/user">
      <input type="hidden" name="${CSRF_FIELD}" value="${escapeHtml(input.csrf)}">
      <div class="grid2">
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
      </div>
      <p class="note">${text.inviteNote}</p>
      <div class="actions"><button type="submit" name="do" value="create">${text.invite}</button></div>
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
  ${inviteSection(input)}
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
