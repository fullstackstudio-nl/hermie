/**
 * The administration pages, as HTML a browser can use with JavaScript off.
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
 * **One subject per page.** This used to be a single document with the Service,
 * Push, Cache, Branding, Features and People panels stacked down it. Six forms
 * on one page share one notice and one scroll position, so an operator who
 * pressed Save had to work out which of the six it belonged to; the chrome and
 * the nav are in `layout.ts` and each function below renders the body of one
 * page. The POST routes did not move, so nothing an operator has bookmarked or
 * scripted against changed.
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
import type { WebLocale, WebStrings } from '../i18n'
import { adminBarePage, adminShell, card, csrfField, type AdminChrome } from './layout'
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

/**
 * The deployment's own name, for the chrome.
 *
 * The branding name where an operator set one, else Hermie. A team that renamed
 * the app should see the renamed thing on the page that renamed it.
 */
export const brandOf = (state: AdminState): string => state.branding.name || 'Hermie'

/** The chrome, built from the same input every page already takes. */
function chromeOf(input: AdminPageInput, current: AdminChrome['current']): AdminChrome {
  return {
    brand: brandOf(input.state),
    version: input.status.version,
    current,
    csrf: input.csrf,
    canSelfUpdate: input.status.canSelfUpdate,
    updateReason: input.status.updateReason,
    notice: input.notice,
    locale: input.locale,
    strings: input.strings
  }
}

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
  brand: string
  locale: WebLocale
  strings: WebStrings
}): string {
  const { common, admin } = input.strings

  return adminBarePage({
    brand: input.brand,
    title: common.administration,
    locale: input.locale,
    strings: input.strings,
    body: `<p class="lede">${admin.signIn.intro}</p>
    ${input.notice ? `<p class="banner bad">${escapeHtml(input.notice)}</p>` : ''}
    ${card({
      body: `<form method="post" action="/admin/sign-in">
        ${csrfField(input.csrf)}
        <label for="secret">${common.administratorSecret}</label>
        <input id="secret" name="secret" type="password" autocomplete="current-password">
        <p class="note">${admin.signIn.secretNote}</p>
        <div class="actions"><button type="submit">${common.signIn}</button></div>
      </form>`
    })}`
  })
}

/** The page somebody who is signed in but is not an administrator gets. */
export function adminForbiddenPage(input: {
  viewer: string
  brand: string
  locale: WebLocale
  strings: WebStrings
}): string {
  const text = input.strings.admin.forbidden

  return adminBarePage({
    brand: input.brand,
    title: text.title,
    locale: input.locale,
    strings: input.strings,
    body: `<p class="lede">${input.viewer ? text.knownAs(escapeHtml(input.viewer)) : text.unknown}</p>
    <p class="note">${text.note}</p>`
  })
}

/** Overview: the figures, and a link to the page each of them belongs to. */
export function adminOverviewPage(input: AdminPageInput): string {
  const { status, strings } = input
  const text = strings.admin
  const service = text.service

  return adminShell(chromeOf(input, 'overview'), {
    title: text.overview.title,
    intro: text.overview.intro,
    body: `${card({
      heading: service.heading,
      body: `<dl>
        <dt>${service.version}</dt><dd>${escapeHtml(status.version)} — ${
          status.updateAvailable ? service.updateAvailable(escapeHtml(status.latestVersion)) : service.upToDate
        }</dd>
        <dt>${text.gateway}</dt><dd><code>${escapeHtml(status.gatewayUrl)}</code></dd>
        <dt>${service.serviceLogin}</dt><dd>${yes(status.serviceLogin, strings)}</dd>
        <dt>${service.pushDaemon}</dt><dd>${status.pushRunning ? service.running : service.notRunning}</dd>
        <dt>${service.vapidKey}</dt><dd>${yes(status.vapidPresent, strings)}</dd>
      </dl>`
    })}
    ${card({
      heading: service.messageCache,
      body: `<dl>
        <dt>${service.messageCache}</dt><dd>${
          status.cacheEnabled
            ? service.cacheFill(status.cacheEntries, megabytes(status.cacheBytes), megabytes(status.cacheMaxBytes))
            : service.cacheOff
        }</dd>
        <dt>${service.cacheHits}</dt><dd>${escapeHtml(hitRate(status, strings))}</dd>
      </dl>
      <p><a href="/admin/cache">${text.nav.cache} →</a></p>`
    })}
    ${card({
      heading: text.people.heading,
      body: `<dl>
        <dt>${service.userList}</dt><dd>${status.usersFrom === 'gateway' ? service.fromGateway : service.fromSeen}</dd>
        <dt>${text.nav.people}</dt><dd>${text.overview.peopleSeen(Object.keys(input.state.users).length)}</dd>
      </dl>
      <p><a href="/admin/people">${text.nav.people} →</a></p>`
    })}
    ${card({
      heading: text.identity.heading,
      intro: input.identity.enabled
        ? text.identity.on(escapeHtml(input.identity.issuer), input.identity.accounts)
        : text.identity.off,
      body: `<p><a href="/admin/oidc">${text.identity.link}</a></p>`
    })}`
  })
}

/** Push: the ceiling on what the daemon will send, and the preview policy. */
export function adminPushPage(input: AdminPageInput): string {
  const text = input.strings.admin.push
  const { state } = input

  return adminShell(chromeOf(input, 'push'), {
    title: text.heading,
    intro: text.intro,
    body: card({
      body: `<form method="post" action="/admin/push">
      ${csrfField(input.csrf)}
      ${PUSH_TYPES.map(
        type =>
          `<label class="check"><input type="checkbox" name="type-${type}" value="1"${
            state.push.types[type] ? ' checked' : ''
          }> ${type}</label>`
      ).join('\n      ')}
      <div class="fields">
        <div>
          <label for="preview">${text.previewLabel}</label>
          <select id="preview" name="preview">
            <option value="device"${state.push.preview === 'device' ? ' selected' : ''}>${text.previewDevice}</option>
            <option value="never"${state.push.preview === 'never' ? ' selected' : ''}>${text.previewNever}</option>
          </select>
        </div>
      </div>
      <div class="actions"><button type="submit">${text.saveButton}</button></div>
    </form>`
    })
  })
}

/** Cache: retention, what the size cap is, and the one button that deletes. */
export function adminCachePage(input: AdminPageInput): string {
  const { strings, status } = input
  const text = strings.admin.cache
  const service = strings.admin.service

  return adminShell(chromeOf(input, 'cache'), {
    title: service.messageCache,
    body: `${card({
      body: `<dl>
        <dt>${service.messageCache}</dt><dd>${
          status.cacheEnabled
            ? service.cacheFill(status.cacheEntries, megabytes(status.cacheBytes), megabytes(status.cacheMaxBytes))
            : service.cacheOff
        }</dd>
        <dt>${service.cacheHits}</dt><dd>${escapeHtml(hitRate(status, strings))}</dd>
      </dl>
      <form method="post" action="/admin/cache">
        ${csrfField(input.csrf)}
        <div class="fields">
          <div>
            <label for="retention">${text.retentionLabel}</label>
            <input id="retention" name="retentionHours" type="number" min="0" value="${
              input.state.cache.retentionHours
            }">
          </div>
        </div>
        <p class="note">${text.capNote}</p>
        <div class="actions">
          <button type="submit">${strings.common.save}</button>
          <button class="quiet" type="submit" name="clear" value="1">${text.clearButton}</button>
        </div>
      </form>`
    })}`
  })
}

/** Branding: the three values the app bootstraps with. */
export function adminBrandingPage(input: AdminPageInput): string {
  const text = input.strings.admin.branding
  const { state } = input

  return adminShell(chromeOf(input, 'branding'), {
    title: text.heading,
    intro: text.intro,
    body: card({
      body: `<form method="post" action="/admin/branding">
      ${csrfField(input.csrf)}
      <div class="fields">
        <div>
          <label for="brand-name">${text.nameLabel}</label>
          <input id="brand-name" name="name" type="text" value="${escapeHtml(
            state.branding.name
          )}" placeholder="Hermie">
        </div>
        <div>
          <label for="brand-accent">${text.accentLabel}</label>
          <input id="brand-accent" name="accent" type="text" value="${escapeHtml(
            state.branding.accent
          )}" placeholder="default">
        </div>
        <div>
          <label for="brand-theme">${text.themeLabel}</label>
          <input id="brand-theme" name="theme" type="text" value="${escapeHtml(
            state.branding.theme
          )}" placeholder="system">
        </div>
      </div>
      <p class="note">${text.note}</p>
      <div class="actions"><button type="submit">${text.saveButton}</button></div>
    </form>`
    })
  })
}

/** Features: what an operator can switch off for everybody. */
export function adminFeaturesPage(input: AdminPageInput): string {
  const text = input.strings.admin.features
  const { state } = input

  return adminShell(chromeOf(input, 'features'), {
    title: text.heading,
    body: card({
      body: `<form method="post" action="/admin/flags">
      ${csrfField(input.csrf)}
      <label class="check"><input type="checkbox" name="userChats" value="1"${
        state.flags.userChats ? ' checked' : ''
      }> ${text.userChats}</label>
      <label class="check"><input type="checkbox" name="messageCache" value="1"${
        state.flags.messageCache ? ' checked' : ''
      }> ${text.messageCache}</label>
      <label class="check"><input type="checkbox" name="selfUpdate" value="1"${
        state.flags.selfUpdate ? ' checked' : ''
      }> ${text.selfUpdate}</label>
      <div class="actions"><button type="submit">${text.saveButton}</button></div>
    </form>`
    })
  })
}

/**
 * The people table.
 *
 * Real columns, and the trick that makes them possible without a script: a
 * `<form>` cannot be a child of a `<tr>`, so one row's form would have had to
 * live inside a single cell — which is what it used to do, and why every switch
 * for one person was stacked into one column while the headers above described
 * something else. HTML5's `form` attribute puts the element in the last cell and
 * points every input in the row at it by id, so the row is a row and the form is
 * still one form that posts.
 *
 * The id is the row's ORDINAL rather than the user id: a gateway user id is an
 * email address or worse, and an HTML id that contains an `@` or a space is one
 * no `form=` attribute can name.
 */
function peopleTable(input: AdminPageInput): string {
  const text = input.strings.admin.people
  const rows = Object.values(input.state.users).sort((left, right) => right.seenAt - left.seenAt)

  if (!rows.length) {
    return `<p class="note">${text.empty}</p>`
  }

  return `<table>
  <thead><tr>
    <th>${text.who}</th>
    <th>${text.lastSeen}</th>
    <th>${text.bots}</th>
    <th class="tick">${text.readOnly}</th>
    <th class="tick">${text.push}</th>
    <th class="tick">${text.administratorBox}</th>
    <th></th>
  </tr></thead>
  <tbody>
  ${rows.map((row, index) => personRow(row, index, input)).join('\n  ')}
  </tbody>
</table>`
}

function personRow(row: AdminUserRow, index: number, input: AdminPageInput): string {
  const text = input.strings.admin.people
  const label = row.displayName || row.email || row.userId
  const allowed = row.allowedBots === null ? '' : row.allowedBots.join(', ')
  const admin = input.state.admins.includes(row.userId)
  const form = `person-${index}`

  return `<tr>
    <td><strong>${escapeHtml(label)}</strong>${admin ? ` <span class="badge">${text.administrator}</span>` : ''}
      <br><code class="note">${escapeHtml(row.userId)}</code></td>
    <td class="note">${row.seenAt ? new Date(row.seenAt * 1000).toISOString().slice(0, 16).replace('T', ' ') : '—'}</td>
    <td>
      <label class="sr" for="bots-${form}">${text.allowedBotsLabel}</label>
      <input id="bots-${form}" form="${form}" name="allowedBots" type="text" value="${escapeHtml(allowed)}"
             placeholder="${escapeHtml(input.bots.join(', ') || 'researcher, writer')}">
    </td>
    <td class="tick"><input type="checkbox" form="${form}" name="readOnly" value="1"${
      row.readOnly ? ' checked' : ''
    } aria-label="${escapeHtml(text.readOnly)}"></td>
    <td class="tick"><input type="checkbox" form="${form}" name="pushAllowed" value="1"${
      row.pushAllowed ? ' checked' : ''
    } aria-label="${escapeHtml(text.pushAllowed)}"></td>
    <td class="tick"><input type="checkbox" form="${form}" name="admin" value="1"${
      admin ? ' checked' : ''
    } aria-label="${escapeHtml(text.administratorBox)}"></td>
    <td>
      <form id="${form}" method="post" action="/admin/user">
        ${csrfField(input.csrf)}
        <input type="hidden" name="userId" value="${escapeHtml(row.userId)}">
        <button type="submit">${input.strings.common.save}</button>
      </form>
    </td>
  </tr>`
}

/** People: everyone this service has seen, and what it will do for each of them. */
export function adminPeoplePage(input: AdminPageInput): string {
  const text = input.strings.admin.people

  return adminShell(chromeOf(input, 'people'), {
    title: text.heading,
    intro: text.intro,
    body: `${card({ body: peopleTable(input) })}
    ${card({
      body: `<form method="post" action="/admin/user">
        ${csrfField(input.csrf)}
        <div class="fields">
          <div>
            <label for="add-user">${text.addLabel}</label>
            <input id="add-user" name="userId" type="text" placeholder="someone@example.org">
          </div>
          <div class="narrow">
            <label class="check"><input type="checkbox" name="admin" value="1"> ${text.administratorBox}</label>
            <label class="check"><input type="checkbox" name="pushAllowed" value="1" checked> ${
              text.pushAllowed
            }</label>
          </div>
          <div class="narrow"><button type="submit">${text.addButton}</button></div>
        </div>
      </form>
      <p class="note">${input.viewer ? text.signedInAs(escapeHtml(input.viewer)) : text.signedInLocally}</p>`
    })}`
  })
}

/** What an operator may also throw away, ticked one at a time. */
export interface ResetChoices {
  cache: boolean
  push: boolean
}

/** The danger zone: the self-update, and starting the setup over. */
export function adminDangerPage(input: AdminPageInput): string {
  const text = input.strings.admin
  const reset = text.reset

  return adminShell(chromeOf(input, 'danger'), {
    title: text.danger.title,
    intro: text.danger.intro,
    body: `${card({
      heading: text.service.updateButton,
      body: `<dl>
        <dt>${text.service.version}</dt><dd>${escapeHtml(input.status.version)} — ${
          input.status.updateAvailable
            ? text.service.updateAvailable(escapeHtml(input.status.latestVersion))
            : text.service.upToDate
        }</dd>
      </dl>
      <form method="post" action="/admin/update">
        ${csrfField(input.csrf)}
        <div class="actions">
          <button type="submit"${input.status.canSelfUpdate ? '' : ' disabled'}>${text.service.updateButton}</button>
          ${
            input.status.canSelfUpdate
              ? ''
              : `<span class="note">${escapeHtml(input.status.updateReason || text.service.updateUnavailable)}</span>`
          }
        </div>
      </form>`
    })}
    ${card({
      kind: 'danger',
      heading: reset.heading,
      intro: reset.intro,
      body: `<form method="post" action="/admin/reset-setup">
        ${csrfField(input.csrf)}
        <label class="check"><input type="checkbox" name="alsoCache" value="1"> ${reset.alsoCache}</label>
        <label class="check"><input type="checkbox" name="alsoPush" value="1"> ${reset.alsoPush}</label>
        <div class="actions"><button class="bad" type="submit">${reset.button}</button></div>
      </form>`
    })}`
  })
}

/**
 * The second step: what is about to go, and the one control that does it.
 *
 * A rendered POST rather than a redirect, which is the opposite of the rule
 * every other form here follows — and deliberately. The rule exists because
 * reloading a rendered POST repeats it; reloading THIS one repeats a question,
 * which costs nothing. Putting the choices in a redirect's query string would
 * put them in the browser's history instead, on a page whose entire job is to
 * be read once and acted on once.
 *
 * The two ticks are carried as hidden fields, so the thing that is confirmed is
 * the thing that was asked for rather than whatever the next form happens to
 * post.
 */
export function adminResetConfirmPage(input: AdminPageInput & { choices: ResetChoices; setupOpens: boolean }): string {
  const text = input.strings.admin.reset

  return adminShell(chromeOf(input, 'danger'), {
    title: text.confirmTitle,
    intro: text.confirmIntro,
    body: card({
      kind: 'danger',
      body: `<h2>${text.clearsHeading}</h2>
      <ul>
        <li>${text.clearsGateway}</li>
        <li>${text.clearsAdministrators}</li>
        <li>${text.clearsBranding}</li>
        <li>${text.clearsServiceLogin}</li>
        <li>${text.clearsPeople}</li>
        ${input.choices.cache ? `<li>${text.alsoCache}</li>` : ''}
        ${input.choices.push ? `<li>${text.alsoPush}</li>` : ''}
      </ul>
      <h2>${text.keepsHeading}</h2>
      <ul>
        <li>${text.keepsIdentity}</li>
        ${input.choices.cache ? '' : `<li>${text.keepsCache}</li>`}
        ${input.choices.push ? '' : `<li>${text.keepsPush}</li>`}
      </ul>
      <p>${input.setupOpens ? text.thenSetup : text.thenStays(escapeHtml(input.status.gatewayUrl))}</p>
      <p class="note">${text.pushKeepsRunning}</p>
      <form method="post" action="/admin/reset-setup">
        ${csrfField(input.csrf)}
        <input type="hidden" name="confirm" value="1">
        ${input.choices.cache ? '<input type="hidden" name="alsoCache" value="1">' : ''}
        ${input.choices.push ? '<input type="hidden" name="alsoPush" value="1">' : ''}
        <div class="actions">
          <button class="bad" type="submit">${text.confirmButton}</button>
          <a href="/admin/danger">${text.cancel}</a>
        </div>
      </form>`
    })
  })
}
