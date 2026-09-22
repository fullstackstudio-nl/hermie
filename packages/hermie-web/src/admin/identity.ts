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
import { CSRF_FIELD } from './session'
import type { SelfTestStep } from '../oidc/selftest'
import type { OidcState } from '../oidc/state'
import type { OidcUser } from '../oidc/users'

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

const head = (title: string): string =>
  `<!doctype html>\n<html lang="en">\n<meta charset="utf-8">\n` +
  `<meta name="viewport" content="width=device-width, initial-scale=1">\n` +
  `<title>${escapeHtml(title)}</title>\n<style>${STYLE}</style>\n`

const when = (seconds: number): string =>
  seconds ? new Date(seconds * 1000).toISOString().slice(0, 16).replace('T', ' ') : '—'

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

function userRow(user: OidcUser, csrf: string): string {
  const hidden = `<input type="hidden" name="${CSRF_FIELD}" value="${escapeHtml(csrf)}">
        <input type="hidden" name="sub" value="${escapeHtml(user.sub)}">`

  return `<tr>
    <td>
      <strong>${escapeHtml(user.username)}</strong>${user.disabled ? ' <span class="note bad">disabled</span>' : ''}
      <br><span class="note">${escapeHtml(user.displayName || user.email || '—')}</span>
      <br><code class="note">${escapeHtml(user.sub)}</code>
    </td>
    <td class="note">${escapeHtml(user.role)}</td>
    <td class="note">${user.totpSecret ? 'on' : user.invite ? 'invited' : 'off'}</td>
    <td class="note">${when(user.lastSignInAt)}</td>
    <td>
      <form method="post" action="/admin/oidc/user">
        ${hidden}
        <div class="row">
          <div>
            <label for="role-${escapeHtml(user.sub)}">Role</label>
            <select id="role-${escapeHtml(user.sub)}" name="role">
              <option value="user"${user.role === 'user' ? ' selected' : ''}>user</option>
              <option value="admin"${user.role === 'admin' ? ' selected' : ''}>admin</option>
            </select>
          </div>
          <div><button type="submit" name="do" value="role">Save</button></div>
        </div>
      </form>
      <form method="post" action="/admin/oidc/user">
        ${hidden}
        <button class="quiet" type="submit" name="do" value="invite">Reset password</button>
        <button class="quiet" type="submit" name="do" value="${user.disabled ? 'enable' : 'disable'}">${
          user.disabled ? 'Re-enable' : 'Disable'
        }</button>
        ${user.totpSecret ? '<button class="quiet" type="submit" name="do" value="clear-totp">Clear two-factor</button>' : ''}
        <button class="quiet" type="submit" name="do" value="remove">Remove</button>
      </form>
    </td>
  </tr>`
}

function peopleSection(input: IdentityPageInput): string {
  const rows = [...input.state.users].sort((left, right) => left.username.localeCompare(right.username))

  return `<section>
    <h2>Accounts</h2>
    <p><strong>These are this issuer’s own accounts</strong> — the people it will sign in. They are not the
    same list as the one on <a href="/admin">the main page</a>, which is whoever the GATEWAY has seen; a
    person appears there only once they have signed in through it.</p>
    ${
      rows.length
        ? `<table>
      <tr><th>Who</th><th>Role</th><th>2FA</th><th>Last sign-in</th><th></th></tr>
      ${rows.map(user => userRow(user, input.csrf)).join('\n      ')}
    </table>`
        : '<p class="note">Nobody has an account on this issuer yet.</p>'
    }
    ${
      input.invite
        ? `<p class="note ok"><strong>Invitation for ${escapeHtml(input.invite.username)}</strong> — send them this link.
      It works once, lapses in a day, and is <em>not shown again</em>:<br><code>${escapeHtml(input.invite.url)}</code></p>`
        : ''
    }
    <form method="post" action="/admin/oidc/user">
      <input type="hidden" name="${CSRF_FIELD}" value="${escapeHtml(input.csrf)}">
      <div class="row">
        <div>
          <label for="new-username">Username</label>
          <input id="new-username" name="username" type="text" autocapitalize="off" spellcheck="false">
        </div>
        <div>
          <label for="new-email">Email</label>
          <input id="new-email" name="email" type="email" autocapitalize="off" spellcheck="false">
        </div>
        <div>
          <label for="new-name">Display name</label>
          <input id="new-name" name="displayName" type="text">
        </div>
        <div>
          <label for="new-role">Role</label>
          <select id="new-role" name="role"><option value="user">user</option><option value="admin">admin</option></select>
        </div>
        <div><button type="submit" name="do" value="create">Invite</button></div>
      </div>
      <p class="note">Creating somebody mints a one-time link they use to choose their own password. Nobody
      else, including you, ever sees it — which is the only way to add an account that does not end with a
      password in a chat window.</p>
    </form>
  </section>`
}

function guideSection(input: IdentityPageInput): string {
  return `<section>
    <h2>What to put in the gateway’s configuration</h2>
    <p>Enabling this here changes <strong>nothing</strong> on the gateway. Hermie Web does not write the
    gateway’s configuration and would not know how; it tells you what to write. Put this in
    <code>config.yaml</code> and restart the gateway.</p>
    <pre>${escapeHtml(gatewaySnippet(input.state, input.gatewayPublicUrl))}</pre>
    <p>Or, for a container:</p>
    <pre>${escapeHtml(gatewayEnvSnippet(input.state))}</pre>
    <dl>
      <dt>Issuer</dt><dd><code>${escapeHtml(input.state.issuer)}</code></dd>
      <dt>Client id</dt><dd><code>${escapeHtml(input.state.client.clientId)}</code> — fixed for this install</dd>
      <dt>Redirect URI</dt><dd>${input.state.client.redirectUris
        .map(uri => `<code>${escapeHtml(uri)}</code>`)
        .join('<br>')}</dd>
      <dt>Client secret</dt><dd>none — this is a public client, and PKCE is what authenticates the exchange</dd>
    </dl>
    <p class="note"><strong><code>offline_access</code> is in that scope list on purpose.</strong> Without it
    the gateway is issued no refresh token, and this service’s own push sign-in cannot be made at all — the
    daemon would need somebody at a terminal every hour.</p>
    <p class="note"><strong>The redirect URI is the gateway’s, not the app’s.</strong> A phone signing in
    never talks to this issuer: the gateway brokers that flow and its loopback redirect is registered with
    the gateway, not here.</p>
    <form method="post" action="/admin/oidc/redirects">
      <input type="hidden" name="${CSRF_FIELD}" value="${escapeHtml(input.csrf)}">
      <label for="redirects">Redirect URIs, one per line</label>
      <textarea id="redirects" name="redirectUris" rows="3" spellcheck="false">${escapeHtml(
        input.state.client.redirectUris.join('\n')
      )}</textarea>
      <p class="note">Only change this if the gateway’s <code>public_url</code> is not what this page derived.</p>
      <button type="submit">Save redirect URIs</button>
    </form>
  </section>`
}

function testSection(input: IdentityPageInput): string {
  return `<section>
    <h2>Test sign-in</h2>
    <p>Runs the whole round trip from this server against its own issuer — discovery, the JWKS, the sign-in
    form, the code exchange, the ID token's signature and the refresh grant — and reports each step. It uses
    a real account, because a test that skipped the sign-in form would be testing a path nobody takes. The
    redirect is read and never followed, so nothing is sent to the gateway.</p>
    <form method="post" action="/admin/oidc/test">
      <input type="hidden" name="${CSRF_FIELD}" value="${escapeHtml(input.csrf)}">
      <div class="row">
        <div>
          <label for="test-username">Username</label>
          <input id="test-username" name="username" type="text" autocapitalize="off" spellcheck="false">
        </div>
        <div>
          <label for="test-password">Password</label>
          <input id="test-password" name="password" type="password" autocomplete="off">
        </div>
        <div>
          <label for="test-totp">Code, if enrolled</label>
          <input id="test-totp" name="totp" type="text" inputmode="numeric" autocomplete="off">
        </div>
        <div><button type="submit">Run it</button></div>
      </div>
      <p class="note">Nothing typed here is stored or logged. The tokens it produces are discarded.</p>
    </form>
    ${
      input.selfTest.length
        ? `<table>
      ${input.selfTest
        .map(
          step =>
            `<tr><td><strong>${escapeHtml(step.name)}</strong></td><td class="${
              step.ok ? 'ok' : 'bad'
            }">${step.ok ? 'ok' : 'failed'}</td><td class="note">${escapeHtml(step.detail)}</td></tr>`
        )
        .join('\n      ')}
    </table>`
        : ''
    }
  </section>`
}

export function identityPage(input: IdentityPageInput): string {
  const { state } = input
  const blocked = !input.originAcceptable && !input.allowInsecure

  return `${head('Identity — Hermie Web')}<main>
  <h1>Identity</h1>
  <p><a href="/admin">← Administration</a></p>
  ${input.notice ? `<p class="note ok">${escapeHtml(input.notice)}</p>` : ''}

  <section>
    <h2>The built-in identity provider</h2>
    <p>An OpenID Provider inside this service, for a deployment with no identity provider of its own.
    It is <strong>off unless you turn it on</strong>, it federates with nothing, and turning it on makes
    <strong>this service the identity root of your gateway</strong>: whoever holds this state directory can
    mint any account on it.</p>
    <dl>
      <dt>Status</dt><dd>${state.enabled ? '<span class="ok">on</span>' : 'off'}</dd>
      ${
        state.enabled
          ? `<dt>Issuer</dt><dd><code>${escapeHtml(state.issuer)}</code></dd>
      <dt>Signing keys</dt><dd>${state.keys.length} published${
        state.keys.length > 1 ? ' (one current, the rest being retired)' : ''
      }</dd>
      <dt>Accounts</dt><dd>${state.users.length}</dd>`
          : ''
      }
    </dl>
    ${
      blocked
        ? `<p class="note bad"><strong>This origin cannot be an issuer.</strong> You reached this page on
      <code>${escapeHtml(input.origin)}</code>, and the gateway refuses an issuer that is not
      <code>https</code> (or <code>http</code> on loopback) — so a provider enabled here would work in a
      browser and be rejected by the gateway. Put TLS in front of this service, or restart it with
      <code>--allow-insecure-oidc</code> if you are testing.</p>`
        : ''
    }
    <form method="post" action="/admin/oidc/enable">
      <input type="hidden" name="${CSRF_FIELD}" value="${escapeHtml(input.csrf)}">
      ${
        state.enabled
          ? `<button type="submit" name="enabled" value="0">Turn it off</button>
      <span class="note">Accounts and keys are kept; every refresh token is dropped.</span>`
          : `<button type="submit" name="enabled" value="1"${blocked ? ' disabled' : ''}>Turn it on</button>
      <span class="note">The issuer becomes <code>${escapeHtml(input.origin)}/oidc</code>, taken from the
      address you reached this page on.</span>`
      }
    </form>
  </section>

  ${
    state.enabled
      ? `${guideSection(input)}
  ${peopleSection(input)}
  ${testSection(input)}

  <section>
    <h2>Settings</h2>
    <form method="post" action="/admin/oidc/settings">
      <input type="hidden" name="${CSRF_FIELD}" value="${escapeHtml(input.csrf)}">
      <label><input type="checkbox" name="requireTotp" value="1"${
        state.settings.requireTotp ? ' checked' : ''
      }> Require a second factor, enrolling anybody who has not got one</label>
      <div class="row">
        <div>
          <label for="id-ttl">ID token lifetime (seconds)</label>
          <input id="id-ttl" name="idTokenTtlSeconds" type="number" min="60" value="${
            state.settings.idTokenTtlSeconds
          }">
        </div>
        <div>
          <label for="rt-ttl">Refresh token lifetime (seconds)</label>
          <input id="rt-ttl" name="refreshTokenTtlSeconds" type="number" min="300" value="${
            state.settings.refreshTokenTtlSeconds
          }">
        </div>
        <div><button type="submit">Save</button></div>
      </div>
      <p class="note">The ID token’s lifetime is the gateway’s session length: it holds the ID token and
      re-verifies it on every request, refreshing only once it has expired.</p>
    </form>
  </section>

  <section>
    <h2>Signing keys</h2>
    <p>Rotating mints a new key and signs with it immediately. The old key stays in the published JWKS
    until everything it signed has expired, plus the window a relying party caches the JWKS for — so a
    rotation signs nobody out.</p>
    <form method="post" action="/admin/oidc/rotate">
      <input type="hidden" name="${CSRF_FIELD}" value="${escapeHtml(input.csrf)}">
      <button type="submit">Rotate the signing key</button>
    </form>
  </section>`
      : ''
  }
</main>
</html>
`
}
