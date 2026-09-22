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
import { barePage, adminShell, card, csrfField, type AdminChrome } from './layout'
import { avatar, cell, pill, rosterHead, toggle, whenAgo, whenCell } from './roster'
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
  /**
   * The built-in identity provider, as the pages here need it.
   *
   * `bySub` is what lets the people list say which of its rows are accounts on
   * this service's own issuer rather than ids from somewhere else. It is read at
   * render time rather than stored on the row, because it is the provider's
   * answer and a copy of it would be a second one.
   */
  identity: {
    enabled: boolean
    issuer: string
    accounts: number
    bySub: Record<string, { username: string; admin: boolean } | undefined>
  }
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

  return barePage({
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

  return barePage({
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
 * One person, as the list needs them.
 *
 * Gathered before anything is drawn because two of these answers are about the
 * list rather than the row: whether an id is an account on the built-in issuer,
 * and whether the username on this row is also the username on a row of the
 * other kind. The second one cannot be answered from inside a row at all.
 */
interface PersonView {
  row: AdminUserRow
  /** The panel's id. An ordinal, because a user id may be an email address. */
  index: number
  name: string
  username: string
  admin: boolean
  fromIssuer: boolean
  /** The other row with this username, where there is one of the other kind. */
  alsoKnownAs: 'issuer' | 'gateway' | null
}

/** What this row calls somebody, for the second line. */
const usernameOf = (row: AdminUserRow, account: { username: string } | undefined): string =>
  account?.username || row.email || row.userId

/**
 * The name two rows would have to share to be worth a note, lowercased.
 *
 * The part before the at-sign, because a gateway that authenticates `max` and an
 * issuer account called `max` are the case this exists for, and so is a gateway
 * that calls the same person `max@example.org`. It is never a reason to merge
 * anything: the note says so and the rows stay two rows.
 */
const usernameKey = (username: string): string => (username.split('@')[0] ?? username).toLowerCase()

function peopleViews(input: AdminPageInput): PersonView[] {
  const rows = Object.values(input.state.users).sort((left, right) => right.seenAt - left.seenAt)
  const kinds = new Map<string, { issuer: boolean; gateway: boolean }>()

  for (const row of rows) {
    const account = input.identity.bySub[row.userId]
    const key = usernameKey(usernameOf(row, account))
    const held = kinds.get(key) ?? { issuer: false, gateway: false }

    kinds.set(key, account ? { ...held, issuer: true } : { ...held, gateway: true })
  }

  return rows.map((row, index) => {
    const account = input.identity.bySub[row.userId]
    const username = usernameOf(row, account)
    const both = kinds.get(usernameKey(username))
    const shared = both?.issuer && both.gateway

    return {
      row,
      index,
      name: row.displayName || account?.username || row.email || row.userId,
      username,
      admin: input.state.admins.includes(row.userId),
      fromIssuer: !!account,
      alsoKnownAs: shared ? (account ? 'gateway' : 'issuer') : null
    }
  })
}

/**
 * The bots column, as few characters as will still answer the question.
 *
 * The names when they fit, because "researcher, notes" is the whole answer and
 * a count would send the reader into the panel for it. A count when they do
 * not, because the alternative is a cell that is either truncated mid-name or
 * as wide as the roster.
 */
function botsSummary(row: AdminUserRow, input: AdminPageInput): string {
  const text = input.strings.admin.people

  if (row.allowedBots === null) {
    return text.allBots
  }

  if (!row.allowedBots.length) {
    return text.noBots
  }

  const names = row.allowedBots.join(', ')
  // The roster, or the allow list where it is longer — a list that still names a
  // bot the gateway has dropped must not be reported as "4 of 2".
  const total = Math.max(input.bots.length, row.allowedBots.length)

  return names.length <= 22 ? escapeHtml(names) : text.someBots(row.allowedBots.length, total)
}

/**
 * The bot allow list, as one box per bot.
 *
 * A text field of comma-separated names was the control this replaces, and it
 * asked an operator to know the roster by heart and to spell it. The field is
 * still what a deployment whose bot roster is unknown gets, because a list of
 * checkboxes with nothing to put in it is not a control at all.
 *
 * `allBots` and the boxes are two different answers, and the route reads them
 * in that order: no list is every bot — including bots added next month — and
 * an empty list is none. A text field could never say the second one.
 */
function botControls(view: PersonView, input: AdminPageInput): string {
  const text = input.strings.admin.people
  const { row } = view

  if (!input.bots.length) {
    const allowed = row.allowedBots === null ? '' : row.allowedBots.join(', ')

    return `<label for="bots-${view.index}">${text.allowedBotsLabel}</label>
      <input id="bots-${view.index}" name="allowedBots" type="text" value="${escapeHtml(allowed)}"
             placeholder="researcher, writer">`
  }

  const every = row.allowedBots === null
  /*
    The roster, plus whatever this person was already allowed that is not on it.

    A name on the list that the gateway has since stopped serving would
    otherwise have no box, and a save would drop it without saying so — the one
    way a list of checkboxes can lose an answer a text field kept.
  */
  const names = [...input.bots, ...(row.allowedBots ?? []).filter(bot => !input.bots.includes(bot))]

  return `<input type="hidden" name="botList" value="1">
      <div class="ticks">
        <label><input type="checkbox" name="allBots" value="1"${every ? ' checked' : ''}> ${text.everyBot}</label>
        ${names
          .map(
            bot =>
              `<label><input type="checkbox" name="bot" value="${escapeHtml(bot)}"${
                !every && row.allowedBots?.includes(bot) ? ' checked' : ''
              }> ${escapeHtml(bot)}</label>`
          )
          .join('\n        ')}
      </div>
      <p class="note">${text.botsNote}</p>`
}

/**
 * One person: the line, and the panel behind the link at the end of it.
 *
 * The form is the whole of it, which is what settles where Save goes. A row
 * cannot carry a Save button of its own without carrying five more beside it,
 * so the one button lives in the panel and the switches on the line are inside
 * the same form — flip one, open the panel, save. The panel says as much.
 */
function personRow(view: PersonView, input: AdminPageInput): string {
  const text = input.strings.admin.people
  const { row } = view
  const panel = `person-${view.index}`
  const source = view.fromIssuer
    ? `<a href="/admin/oidc">${text.sourceIssuer}</a>`
    : `<span>${text.sourceGateway}</span>`
  /*
    Three words on the line and the sentence behind them.

    "same username as the account on this service" beside a name is wider than
    the name, the pills and the column put together — it wrapped, and what it
    wrapped over was the next column. It sits on the quiet second line, which is
    one line and clips, with the whole sentence on the pointer and in the panel.
  */
  const shared =
    view.alsoKnownAs === 'issuer'
      ? { short: text.alsoIssuer, long: text.sameAsIssuer }
      : view.alsoKnownAs === 'gateway'
        ? { short: text.alsoGateway, long: text.sameAsGateway }
        : null

  return `<li>
    <form method="post" action="/admin/user">
      ${csrfField(input.csrf)}
      <input type="hidden" name="userId" value="${escapeHtml(row.userId)}">
      <div class="roster-row">
        <span class="who">
          ${avatar(view.name, row.userId)}
          <span class="who-text">
            <span class="who-name"><strong>${escapeHtml(view.name)}</strong>${
              view.admin ? pill(text.administrator, 'on') : ''
            }</span>
            <span class="who-sub" title="${escapeHtml(row.userId)}">${escapeHtml(
              view.username
            )} · ${source}${shared ? ` · <span title="${escapeHtml(shared.long)}">${shared.short}</span>` : ''}</span>
          </span>
        </span>
        ${whenCell(text.lastSeen, row.seenAt, input.strings)}
        ${cell(text.bots, `<a href="#${panel}">${botsSummary(row, input)}</a>`)}
        <span class="switches">
          ${toggle({ name: 'readOnly', label: text.readOnly, checked: row.readOnly })}
          ${toggle({ name: 'pushAllowed', label: text.push, checked: row.pushAllowed })}
          ${toggle({ name: 'admin', label: text.administratorBox, checked: view.admin })}
        </span>
        <a class="more" href="#${panel}" aria-label="${escapeHtml(
          input.strings.common.detailsFor(view.name)
        )}">${input.strings.common.details}</a>
      </div>
      <div class="panel" id="${panel}">
        <dl>
          <dt>${text.gatewayUserId}</dt><dd><code>${escapeHtml(row.userId)}</code></dd>
          <dt>${text.source}</dt><dd>${view.fromIssuer ? text.sourceIssuer : text.sourceGateway}${
            shared ? ` — ${shared.long}` : ''
          }</dd>
          <dt>${text.lastSeen}</dt><dd>${row.seenAt ? escapeHtml(whenAgo(row.seenAt, input.strings).title) : '—'}</dd>
          ${row.email ? `<dt>${input.strings.identity.accounts.email}</dt><dd>${escapeHtml(row.email)}</dd>` : ''}
        </dl>
        ${view.fromIssuer ? `<p class="note"><a href="/admin/oidc">${text.openAccount}</a></p>` : ''}
        <h3>${text.botsHeading}</h3>
        ${botControls(view, input)}
        <div class="actions">
          <button type="submit">${input.strings.common.save}</button>
          <span class="note">${text.savesRow}</span>
          <a class="more spread" href="#people">${input.strings.common.close}</a>
        </div>
      </div>
    </form>
  </li>`
}

/** The roster: a head strip, and one line per person under it. */
function peopleRoster(input: AdminPageInput): string {
  const text = input.strings.admin.people
  const views = peopleViews(input)

  if (!views.length) {
    return `<p class="note">${text.empty}</p>`
  }

  return `<div class="roster people" id="people">
  ${rosterHead([
    text.who,
    text.lastSeen,
    text.bots,
    `<span class="switches"><span>${text.readOnly}</span><span>${text.push}</span><span>${
      text.administratorBox
    }</span></span>`,
    ''
  ])}
  <ul class="roster-list">
    ${views.map(view => personRow(view, input)).join('\n    ')}
  </ul>
</div>`
}

/** People: everyone this service has seen, and what it will do for each of them. */
export function adminPeoplePage(input: AdminPageInput): string {
  const text = input.strings.admin.people

  return adminShell(chromeOf(input, 'people'), {
    title: text.heading,
    intro: text.intro,
    body: `${card({
      body: `${peopleRoster(input)}
      <details class="how">
        <summary>${text.howHeading}</summary>
        <p>${text.howReadOnly}</p>
        ${input.identity.enabled ? `<p>${text.issuerNote}</p>` : ''}
      </details>`
    })}
    ${card({
      heading: text.addHeading,
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
