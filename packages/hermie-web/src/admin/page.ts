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
  /** Bot names, for the per-user allow list. Empty where the roster is unknown. */
  bots: string[]
  /** Who is looking, for the "you cannot remove yourself last" hint. */
  viewer: string
  notice: string
}

const yes = (value: boolean): string => (value ? 'yes' : 'no')

const megabytes = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(1)} MB`

function hitRate(status: AdminStatus): string {
  const total = status.cacheHits + status.cacheMisses

  // "0 of 0" rather than a percentage of nothing: a service that has answered
  // no cache reads has no hit rate, and printing 0% would read as a problem.
  return total ? `${Math.round((status.cacheHits / total) * 100)}% of ${total}` : 'nothing asked yet'
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

const head = (title: string): string =>
  `<!doctype html>\n<html lang="en">\n<meta charset="utf-8">\n` +
  `<meta name="viewport" content="width=device-width, initial-scale=1">\n` +
  `<title>${escapeHtml(title)}</title>\n<style>${STYLE}</style>\n`

/**
 * The sign-in for a deployment with no gateway accounts.
 *
 * Only ever drawn when a local administrator secret exists. A gateway WITH
 * accounts never sees this page: its operator is already signed in to the
 * gateway and the gate is their user id.
 */
export function adminSignInPage(input: { csrf: string; notice: string }): string {
  return `${head('Hermie Web administration')}<main>
  <h1>Administration</h1>
  <p>This service has no gateway accounts to recognise you by, so it asks for the administrator secret set during setup.</p>
  ${input.notice ? `<p class="note bad">${escapeHtml(input.notice)}</p>` : ''}
  <section>
    <form method="post" action="/admin/sign-in">
      <input type="hidden" name="${CSRF_FIELD}" value="${escapeHtml(input.csrf)}">
      <label for="secret">Administrator secret</label>
      <input id="secret" name="secret" type="password" autocomplete="current-password">
      <p class="note">Stored as a scrypt hash. This page never shows it back.</p>
      <button type="submit">Sign in</button>
    </form>
  </section>
</main>
</html>
`
}

/** The page somebody who is signed in but is not an administrator gets. */
export function adminForbiddenPage(viewer: string): string {
  return `${head('Not an administrator')}<main>
  <h1>Not an administrator</h1>
  <p>${
    viewer
      ? `The gateway knows you as <code>${escapeHtml(viewer)}</code>, and that id is not on this service’s administrator list.`
      : 'This gateway did not say who you are, so this service has nobody to check against.'
  }</p>
  <p class="note">An existing administrator can add an id on this page. On a service with no gateway accounts, the administrator secret set during setup is the way in.</p>
</main>
</html>
`
}

function usersTable(input: AdminPageInput): string {
  const rows = Object.values(input.state.users).sort((left, right) => right.seenAt - left.seenAt)

  if (!rows.length) {
    return '<p class="note">Nobody has signed in through this service yet.</p>'
  }

  return `<table>
  <tr><th>Who</th><th>Last seen</th><th>Bots</th><th>Read-only</th><th>Push</th><th></th></tr>
  ${rows.map(row => userRow(row, input)).join('\n  ')}
</table>`
}

function userRow(row: AdminUserRow, input: AdminPageInput): string {
  const label = row.displayName || row.email || row.userId
  const allowed = row.allowedBots === null ? '' : row.allowedBots.join(', ')
  const admin = input.state.admins.includes(row.userId)

  return `<tr>
    <td><strong>${escapeHtml(label)}</strong><br><code>${escapeHtml(row.userId)}</code>${
      admin ? ' <span class="ok note">administrator</span>' : ''
    }</td>
    <td class="note">${row.seenAt ? new Date(row.seenAt * 1000).toISOString().slice(0, 16).replace('T', ' ') : '—'}</td>
    <td colspan="4">
      <form method="post" action="/admin/user">
        <input type="hidden" name="${CSRF_FIELD}" value="${escapeHtml(input.csrf)}">
        <input type="hidden" name="userId" value="${escapeHtml(row.userId)}">
        <div class="row">
          <div>
            <label for="bots-${escapeHtml(row.userId)}">Allowed bots (blank = all)</label>
            <input id="bots-${escapeHtml(row.userId)}" name="allowedBots" type="text" value="${escapeHtml(allowed)}"
                   placeholder="${escapeHtml(input.bots.join(', ') || 'researcher, writer')}">
          </div>
          <div>
            <label><input type="checkbox" name="readOnly" value="1"${row.readOnly ? ' checked' : ''}> Read-only</label>
            <label><input type="checkbox" name="pushAllowed" value="1"${row.pushAllowed ? ' checked' : ''}> Push allowed</label>
          </div>
          <div>
            <label><input type="checkbox" name="admin" value="1"${admin ? ' checked' : ''}> Administrator</label>
            <button type="submit">Save</button>
          </div>
        </div>
      </form>
    </td>
  </tr>`
}

export function adminPage(input: AdminPageInput): string {
  const { state, status } = input

  return `${head('Hermie Web administration')}<main>
  <h1>Administration</h1>
  <p>Hermie Web ${escapeHtml(status.version)} · <code>${escapeHtml(status.gatewayUrl)}</code></p>
  ${input.notice ? `<p class="note ok">${escapeHtml(input.notice)}</p>` : ''}

  <section>
    <h2>Service</h2>
    <dl>
      <dt>Version</dt><dd>${escapeHtml(status.version)}${
        status.updateAvailable ? ` — <strong>${escapeHtml(status.latestVersion)} available</strong>` : ' — up to date'
      }</dd>
      <dt>Service login</dt><dd>${yes(status.serviceLogin)}</dd>
      <dt>Push daemon</dt><dd>${status.pushRunning ? 'running' : 'not running'}</dd>
      <dt>VAPID key</dt><dd>${yes(status.vapidPresent)}</dd>
      <dt>Message cache</dt><dd>${
        status.cacheEnabled
          ? `${status.cacheEntries} entries · ${megabytes(status.cacheBytes)} of ${megabytes(status.cacheMaxBytes)}`
          : 'off'
      }</dd>
      <dt>Cache hits</dt><dd>${escapeHtml(hitRate(status))}</dd>
      <dt>User list</dt><dd>${
        status.usersFrom === 'gateway' ? 'from the gateway' : 'people this service has seen sign in'
      }</dd>
    </dl>
    <form method="post" action="/admin/update">
      <input type="hidden" name="${CSRF_FIELD}" value="${escapeHtml(input.csrf)}">
      <button type="submit"${status.canSelfUpdate ? '' : ' disabled'}>Update and restart</button>
      ${status.canSelfUpdate ? '' : `<span class="note">${escapeHtml(status.updateReason || 'not available here')}</span>`}
    </form>
  </section>

  <section>
    <h2>Push</h2>
    <p>A ceiling, not a second opt-in: a device still has to have asked. Turning one off silences it for everybody.</p>
    <form method="post" action="/admin/push">
      <input type="hidden" name="${CSRF_FIELD}" value="${escapeHtml(input.csrf)}">
      ${PUSH_TYPES.map(
        type =>
          `<label><input type="checkbox" name="type-${type}" value="1"${
            state.push.types[type] ? ' checked' : ''
          }> ${type}</label>`
      ).join('\n      ')}
      <label for="preview">Preview policy</label>
      <select id="preview" name="preview">
        <option value="device"${state.push.preview === 'device' ? ' selected' : ''}>Each device decides</option>
        <option value="never"${state.push.preview === 'never' ? ' selected' : ''}>Never include message text</option>
      </select>
      <p class="note">&nbsp;</p>
      <button type="submit">Save push settings</button>
    </form>
  </section>

  <section>
    <h2>Message cache</h2>
    <form method="post" action="/admin/cache">
      <input type="hidden" name="${CSRF_FIELD}" value="${escapeHtml(input.csrf)}">
      <label for="retention">Drop entries unread for (hours, 0 = size cap only)</label>
      <input id="retention" name="retentionHours" type="number" min="0" value="${state.cache.retentionHours}">
      <p class="note">The size cap is <code>--cache-max-mb</code> and is set at start-up, not here.</p>
      <button type="submit">Save</button>
      <button type="submit" name="clear" value="1">Clear the cache now</button>
    </form>
  </section>

  <section>
    <h2>Branding</h2>
    <p>Served in <code>/hermie/config.json</code> and read by the app before it draws anything.</p>
    <form method="post" action="/admin/branding">
      <input type="hidden" name="${CSRF_FIELD}" value="${escapeHtml(input.csrf)}">
      <div class="row">
        <div>
          <label for="brand-name">Name</label>
          <input id="brand-name" name="name" type="text" value="${escapeHtml(state.branding.name)}" placeholder="Hermie">
        </div>
        <div>
          <label for="brand-accent">Accent</label>
          <input id="brand-accent" name="accent" type="text" value="${escapeHtml(state.branding.accent)}" placeholder="default">
        </div>
        <div>
          <label for="brand-theme">Default theme preset</label>
          <input id="brand-theme" name="theme" type="text" value="${escapeHtml(state.branding.theme)}" placeholder="system">
        </div>
      </div>
      <p class="note">A reader who has chosen their own keeps it; this is the starting point, not an override.</p>
      <button type="submit">Save branding</button>
    </form>
  </section>

  <section>
    <h2>Features</h2>
    <form method="post" action="/admin/flags">
      <input type="hidden" name="${CSRF_FIELD}" value="${escapeHtml(input.csrf)}">
      <label><input type="checkbox" name="userChats" value="1"${
        state.flags.userChats ? ' checked' : ''
      }> Private chats beside the shared Bot Chat</label>
      <label><input type="checkbox" name="messageCache" value="1"${
        state.flags.messageCache ? ' checked' : ''
      }> Serve the message cache to the app</label>
      <label><input type="checkbox" name="selfUpdate" value="1"${
        state.flags.selfUpdate ? ' checked' : ''
      }> Offer the update button in the app</label>
      <p class="note">&nbsp;</p>
      <button type="submit">Save features</button>
    </form>
  </section>

  <section>
    <h2>People</h2>
    <p><strong>These are service-level settings, not gateway permissions.</strong> Push and the message cache are this
    service’s own and are enforced completely. Read-only refuses every mutating HTTP request; it cannot police the
    gateway WebSocket, which is a byte pipe by design — so it is a guard rail, not a boundary.</p>
    ${usersTable(input)}
    <form method="post" action="/admin/user">
      <input type="hidden" name="${CSRF_FIELD}" value="${escapeHtml(input.csrf)}">
      <label for="add-user">Add somebody by gateway user id</label>
      <div class="row">
        <div><input id="add-user" name="userId" type="text" placeholder="someone@example.org"></div>
        <div>
          <label><input type="checkbox" name="admin" value="1"> Administrator</label>
          <label><input type="checkbox" name="pushAllowed" value="1" checked> Push allowed</label>
        </div>
        <div><button type="submit">Add</button></div>
      </div>
    </form>
    ${
      input.viewer
        ? `<p class="note">You are signed in as <code>${escapeHtml(input.viewer)}</code>. The last administrator cannot be removed.</p>`
        : '<p class="note">You are signed in with the local administrator secret.</p>'
    }
  </section>
</main>
</html>
`
}
