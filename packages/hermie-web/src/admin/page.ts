/**
 * `/admin`, as HTML a browser can use with JavaScript switched off.
 *
 * The same zero-dependency approach `setup.ts` takes, and for the same reason:
 * this file ships inside `dist/server` with no `node_modules` beside it and no
 * build step of its own. There is no framework, no client-side state and — one
 * step further than the setup page — **no script at all**. Every control is a
 * `<form method="post">` that posts, changes one thing, and redirects back.
 *
 * That is not austerity for its own sake. An admin page is the surface an
 * operator reaches for when something is already wrong, which is exactly when a
 * bundle that has to load first is the thing that will not.
 *
 * Three rules this file keeps, because they are the ones an admin page gets
 * wrong:
 *
 *  - **Nothing secret is ever rendered.** No VAPID private key, no refresh
 *    token, no local administrator secret, no cookie. Where a secret exists the
 *    page says whether it exists and nothing else.
 *  - **Every value is escaped.** `escapeHtml` is shared with the setup page so
 *    there is one of it.
 *  - **Every form carries the CSRF token**, and the server refuses a post
 *    without it before it reads the body.
 */
import { escapeHtml } from '../setup'
import { htmlLang, type WebLocale, type WebStrings } from '../i18n'
import { CSRF_FIELD } from './session'
import { PUSH_TYPES } from '../push/registrations'
import type { AdminState, AdminUserRow } from './state'

export interface AdminStatus {
  version: string
  /** The service login: is one stored? Never what it is. */
  serviceLogin: boolean
  pushRunning: boolean
  /** Whether the daemon has a VAPID key pair. The public half only, elsewhere. */
  vapidPresent: boolean
  cacheEnabled: boolean
  cacheEntries: number
  cacheBytes: number
  cacheMaxBytes: number
  /** Served reads and misses since this process started. */
  cacheHits: number
  cacheMisses: number
  gatewayUrl: string
  updateAvailable: boolean
  latestVersion: string
  canSelfUpdate: boolean
  updateReason: string
  /** Where the user list came from, said plainly so nobody over-reads it. */
  usersFrom: 'gateway' | 'seen'
}

export interface AdminPageInput {
  state: AdminState
  status: AdminStatus
  csrf: string
  /** The language this request negotiated, for `<html lang>`. */
  locale: WebLocale
  /** Every sentence on the page, in that language. */
  strings: WebStrings
  /** Bot names, for the per-user allow list. Empty where the roster is unknown. */
  bots: string[]
  /** Who is looking, for the "you cannot remove yourself last" hint. */
  viewer: string
  /** A three-line summary of the built-in identity provider; the page for it is its own. */
  identity: { enabled: boolean; issuer: string; accounts: number }
  notice: string
}

const yes = (value: boolean, strings: WebStrings): string => (value ? strings.common.yes : strings.common.no)

const megabytes = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(1)} MB`

function hitRate(status: AdminStatus, strings: WebStrings): string {
  const total = status.cacheHits + status.cacheMisses

  // "0 of 0" rather than a percentage of nothing: a service that has answered
  // no cache reads has no hit rate, and printing 0% would read as a problem.
  return total
    ? strings.admin.service.hitRate(Math.round((status.cacheHits / total) * 100), total)
    : strings.admin.service.nothingAsked
}

const STYLE = `
  :root { color-scheme: light dark; --ink: #16181d; --muted: #5d636e; --line: #d9dce2; --bg: #f6f7f9; --card: #fff; --accent: #2f6df6; --bad: #b3261e; }
  @media (prefers-color-scheme: dark) { :root { --ink: #eceef2; --muted: #9aa1ad; --line: #2c3038; --bg: #101216; --card: #181b21; } }
  * { box-sizing: border-box }
  body { font: 16px/1.55 system-ui, sans-serif; margin: 0; background: var(--bg); color: var(--ink) }
  main { max-width: 46rem; margin: 0 auto; padding: 2.5rem 1rem 4rem }
  h1 { font-size: 1.4rem; margin: 0 0 .25rem }
  h2 { font-size: 1rem; margin: 0 0 .5rem }
  p { color: var(--muted); margin: .25rem 0 1rem }
  section { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 1.25rem; margin: 1.25rem 0 }
  label { display: block; font-size: .85rem; color: var(--muted); margin-bottom: .35rem }
  input[type=text], input[type=password], input[type=number], select { width: 100%; font: inherit; padding: .5rem .6rem; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); color: inherit }
  button { font: inherit; padding: .5rem .9rem; border: 0; border-radius: 8px; background: var(--accent); color: #fff; cursor: pointer }
  table { width: 100%; border-collapse: collapse; font-size: .9rem }
  th, td { text-align: left; padding: .45rem .4rem; border-bottom: 1px solid var(--line); vertical-align: top }
  th { color: var(--muted); font-weight: 600 }
  .row { display: flex; gap: .6rem; align-items: flex-end; flex-wrap: wrap }
  .row > div { flex: 1; min-width: 9rem }
  .note { font-size: .85rem }
  .bad { color: var(--bad) }
  .ok { color: var(--accent) }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: .25rem .9rem; margin: 0; font-size: .9rem }
  dt { color: var(--muted) }
  code { font-family: ui-monospace, monospace; font-size: .9em }
`

const head = (locale: WebLocale, title: string): string =>
  `<!doctype html>\n<html lang="${htmlLang(locale)}">\n<meta charset="utf-8">\n` +
  `<meta name="viewport" content="width=device-width, initial-scale=1">\n` +
  `<title>${escapeHtml(title)}</title>\n<style>${STYLE}</style>\n`

/**
 * The sign-in for a deployment with no gateway accounts.
 *
 * Only ever drawn when a local administrator secret exists. A gateway WITH
 * accounts never sees this page: its operator is already signed in to the
 * gateway and the gate is their user id.
 */
export function adminSignInPage(input: {
  csrf: string
  notice: string
  locale: WebLocale
  strings: WebStrings
}): string {
  const { common, admin } = input.strings

  return `${head(input.locale, common.administrationTitle)}<main>
  <h1>${common.administration}</h1>
  <p>${admin.signIn.intro}</p>
  ${input.notice ? `<p class="note bad">${escapeHtml(input.notice)}</p>` : ''}
  <section>
    <form method="post" action="/admin/sign-in">
      <input type="hidden" name="${CSRF_FIELD}" value="${escapeHtml(input.csrf)}">
      <label for="secret">${common.administratorSecret}</label>
      <input id="secret" name="secret" type="password" autocomplete="current-password">
      <p class="note">${admin.signIn.secretNote}</p>
      <button type="submit">${common.signIn}</button>
    </form>
  </section>
</main>
</html>
`
}

/** The page somebody who is signed in but is not an administrator gets. */
export function adminForbiddenPage(input: { viewer: string; locale: WebLocale; strings: WebStrings }): string {
  const text = input.strings.admin.forbidden

  return `${head(input.locale, text.title)}<main>
  <h1>${text.title}</h1>
  <p>${input.viewer ? text.knownAs(escapeHtml(input.viewer)) : text.unknown}</p>
  <p class="note">${text.note}</p>
</main>
</html>
`
}

function usersTable(input: AdminPageInput): string {
  const text = input.strings.admin.people
  const rows = Object.values(input.state.users).sort((left, right) => right.seenAt - left.seenAt)

  if (!rows.length) {
    return `<p class="note">${text.empty}</p>`
  }

  return `<table>
  <tr><th>${text.who}</th><th>${text.lastSeen}</th><th>${text.bots}</th><th>${text.readOnly}</th><th>${
    text.push
  }</th><th></th></tr>
  ${rows.map(row => userRow(row, input)).join('\n  ')}
</table>`
}

function userRow(row: AdminUserRow, input: AdminPageInput): string {
  const text = input.strings.admin.people
  const label = row.displayName || row.email || row.userId
  const allowed = row.allowedBots === null ? '' : row.allowedBots.join(', ')
  const admin = input.state.admins.includes(row.userId)

  return `<tr>
    <td><strong>${escapeHtml(label)}</strong><br><code>${escapeHtml(row.userId)}</code>${
      admin ? ` <span class="ok note">${text.administrator}</span>` : ''
    }</td>
    <td class="note">${row.seenAt ? new Date(row.seenAt * 1000).toISOString().slice(0, 16).replace('T', ' ') : '—'}</td>
    <td colspan="4">
      <form method="post" action="/admin/user">
        <input type="hidden" name="${CSRF_FIELD}" value="${escapeHtml(input.csrf)}">
        <input type="hidden" name="userId" value="${escapeHtml(row.userId)}">
        <div class="row">
          <div>
            <label for="bots-${escapeHtml(row.userId)}">${text.allowedBotsLabel}</label>
            <input id="bots-${escapeHtml(row.userId)}" name="allowedBots" type="text" value="${escapeHtml(allowed)}"
                   placeholder="${escapeHtml(input.bots.join(', ') || 'researcher, writer')}">
          </div>
          <div>
            <label><input type="checkbox" name="readOnly" value="1"${row.readOnly ? ' checked' : ''}> ${
              text.readOnly
            }</label>
            <label><input type="checkbox" name="pushAllowed" value="1"${row.pushAllowed ? ' checked' : ''}> ${
              text.pushAllowed
            }</label>
          </div>
          <div>
            <label><input type="checkbox" name="admin" value="1"${admin ? ' checked' : ''}> ${
              text.administratorBox
            }</label>
            <button type="submit">${input.strings.common.save}</button>
          </div>
        </div>
      </form>
    </td>
  </tr>`
}

export function adminPage(input: AdminPageInput): string {
  const { state, status, strings } = input
  const { common } = strings
  const text = strings.admin

  return `${head(input.locale, common.administrationTitle)}<main>
  <h1>${common.administration}</h1>
  <p>${text.header(escapeHtml(status.version), escapeHtml(status.gatewayUrl))}</p>
  ${input.notice ? `<p class="note ok">${escapeHtml(input.notice)}</p>` : ''}

  <section>
    <h2>${text.service.heading}</h2>
    <dl>
      <dt>${text.service.version}</dt><dd>${escapeHtml(status.version)} — ${
        status.updateAvailable ? text.service.updateAvailable(escapeHtml(status.latestVersion)) : text.service.upToDate
      }</dd>
      <dt>${text.service.serviceLogin}</dt><dd>${yes(status.serviceLogin, strings)}</dd>
      <dt>${text.service.pushDaemon}</dt><dd>${status.pushRunning ? text.service.running : text.service.notRunning}</dd>
      <dt>${text.service.vapidKey}</dt><dd>${yes(status.vapidPresent, strings)}</dd>
      <dt>${text.service.messageCache}</dt><dd>${
        status.cacheEnabled
          ? text.service.cacheFill(status.cacheEntries, megabytes(status.cacheBytes), megabytes(status.cacheMaxBytes))
          : text.service.cacheOff
      }</dd>
      <dt>${text.service.cacheHits}</dt><dd>${escapeHtml(hitRate(status, strings))}</dd>
      <dt>${text.service.userList}</dt><dd>${
        status.usersFrom === 'gateway' ? text.service.fromGateway : text.service.fromSeen
      }</dd>
    </dl>
    <form method="post" action="/admin/update">
      <input type="hidden" name="${CSRF_FIELD}" value="${escapeHtml(input.csrf)}">
      <button type="submit"${status.canSelfUpdate ? '' : ' disabled'}>${text.service.updateButton}</button>
      ${
        status.canSelfUpdate
          ? ''
          : `<span class="note">${escapeHtml(status.updateReason || text.service.updateUnavailable)}</span>`
      }
    </form>
  </section>

  <section>
    <h2>${text.push.heading}</h2>
    <p>${text.push.intro}</p>
    <form method="post" action="/admin/push">
      <input type="hidden" name="${CSRF_FIELD}" value="${escapeHtml(input.csrf)}">
      ${PUSH_TYPES.map(
        type =>
          `<label><input type="checkbox" name="type-${type}" value="1"${
            state.push.types[type] ? ' checked' : ''
          }> ${type}</label>`
      ).join('\n      ')}
      <label for="preview">${text.push.previewLabel}</label>
      <select id="preview" name="preview">
        <option value="device"${state.push.preview === 'device' ? ' selected' : ''}>${text.push.previewDevice}</option>
        <option value="never"${state.push.preview === 'never' ? ' selected' : ''}>${text.push.previewNever}</option>
      </select>
      <p class="note">&nbsp;</p>
      <button type="submit">${text.push.saveButton}</button>
    </form>
  </section>

  <section>
    <h2>${text.cache.heading}</h2>
    <form method="post" action="/admin/cache">
      <input type="hidden" name="${CSRF_FIELD}" value="${escapeHtml(input.csrf)}">
      <label for="retention">${text.cache.retentionLabel}</label>
      <input id="retention" name="retentionHours" type="number" min="0" value="${state.cache.retentionHours}">
      <p class="note">${text.cache.capNote}</p>
      <button type="submit">${common.save}</button>
      <button type="submit" name="clear" value="1">${text.cache.clearButton}</button>
    </form>
  </section>

  <section>
    <h2>${text.identity.heading}</h2>
    <p>${
      input.identity.enabled
        ? text.identity.on(escapeHtml(input.identity.issuer), input.identity.accounts)
        : text.identity.off
    }</p>
    <p><a href="/admin/oidc">${text.identity.link}</a></p>
  </section>

  <section>
    <h2>${text.branding.heading}</h2>
    <p>${text.branding.intro}</p>
    <form method="post" action="/admin/branding">
      <input type="hidden" name="${CSRF_FIELD}" value="${escapeHtml(input.csrf)}">
      <div class="row">
        <div>
          <label for="brand-name">${text.branding.nameLabel}</label>
          <input id="brand-name" name="name" type="text" value="${escapeHtml(state.branding.name)}" placeholder="Hermie">
        </div>
        <div>
          <label for="brand-accent">${text.branding.accentLabel}</label>
          <input id="brand-accent" name="accent" type="text" value="${escapeHtml(state.branding.accent)}" placeholder="default">
        </div>
        <div>
          <label for="brand-theme">${text.branding.themeLabel}</label>
          <input id="brand-theme" name="theme" type="text" value="${escapeHtml(state.branding.theme)}" placeholder="system">
        </div>
      </div>
      <p class="note">${text.branding.note}</p>
      <button type="submit">${text.branding.saveButton}</button>
    </form>
  </section>

  <section>
    <h2>${text.features.heading}</h2>
    <form method="post" action="/admin/flags">
      <input type="hidden" name="${CSRF_FIELD}" value="${escapeHtml(input.csrf)}">
      <label><input type="checkbox" name="userChats" value="1"${
        state.flags.userChats ? ' checked' : ''
      }> ${text.features.userChats}</label>
      <label><input type="checkbox" name="messageCache" value="1"${
        state.flags.messageCache ? ' checked' : ''
      }> ${text.features.messageCache}</label>
      <label><input type="checkbox" name="selfUpdate" value="1"${
        state.flags.selfUpdate ? ' checked' : ''
      }> ${text.features.selfUpdate}</label>
      <p class="note">&nbsp;</p>
      <button type="submit">${text.features.saveButton}</button>
    </form>
  </section>

  <section>
    <h2>${text.people.heading}</h2>
    <p>${text.people.intro}</p>
    ${usersTable(input)}
    <form method="post" action="/admin/user">
      <input type="hidden" name="${CSRF_FIELD}" value="${escapeHtml(input.csrf)}">
      <label for="add-user">${text.people.addLabel}</label>
      <div class="row">
        <div><input id="add-user" name="userId" type="text" placeholder="someone@example.org"></div>
        <div>
          <label><input type="checkbox" name="admin" value="1"> ${text.people.administratorBox}</label>
          <label><input type="checkbox" name="pushAllowed" value="1" checked> ${text.people.pushAllowed}</label>
        </div>
        <div><button type="submit">${text.people.addButton}</button></div>
      </div>
    </form>
    ${
      input.viewer
        ? `<p class="note">${text.people.signedInAs(escapeHtml(input.viewer))}</p>`
        : `<p class="note">${text.people.signedInLocally}</p>`
    }
  </section>
</main>
</html>
`
}
