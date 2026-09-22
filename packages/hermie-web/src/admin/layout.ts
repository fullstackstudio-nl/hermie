/**
 * The chrome every administration page sits in: the head, the mark, the nav,
 * the cards and the footer.
 *
 * `/admin` used to be one document with seven panels stacked down it, and the
 * cost of that was not only length. Every panel was a settings form, so the page
 * had seven submit buttons and no way to tell which of them the notice at the
 * top belonged to; the spacing came from whichever margin happened to collapse;
 * and an operator looking for one switch read the whole thing. It is a set of
 * pages now, one subject each, with a nav that says where they are.
 *
 * ## One style sheet, and no script at all
 *
 * The rules `page.ts` has always kept still hold, and the shared chrome is what
 * makes them cheap to keep: no script anywhere, every control a form that posts
 * and redirects, a double-submit CSRF token checked before the body is read,
 * nothing secret rendered, and every value escaped through the one `escapeHtml`.
 *
 * ## Why the design language is copied rather than imported
 *
 * The colours are Hermie's own — the Blue preset's elevation ladder and the ink
 * that `npm run contrast:check` measures, from `apps/hermie/src/ui/tokens.ts` —
 * and they are written out here as literals. This package imports nothing but
 * `node:` builtins (ADR-0015): the released artefact is a self-contained
 * CommonJS `dist/server` with no `node_modules` beside it, so reaching into the
 * app's TypeScript is not available at any price. The two can drift, and the
 * honest mitigation is that these are the same hex values with a comment saying
 * where they came from, not a claim that they cannot.
 *
 * Light and dark both come from `prefers-color-scheme`. There is no theme
 * switch, because a switch needs somewhere to keep the answer and this page has
 * no script and sets no cookie it does not have to.
 *
 * **No gradients**, per the design board's first rule. The one place the source
 * artwork has one is the app icon's backdrop, and the mark below is drawn on a
 * flat brand blue instead.
 */
import { escapeHtml } from '../setup'
import { htmlLang, type WebLocale, type WebStrings } from '../i18n'
import { CSRF_FIELD } from './session'

/** Which page is open, so the nav can say so and the title can match. */
export type AdminSection = 'overview' | 'people' | 'push' | 'cache' | 'branding' | 'features' | 'identity' | 'danger'

/** Where each section lives. The POST routes are unchanged and are not these. */
export const ADMIN_SECTION_PATHS: Record<AdminSection, string> = {
  overview: '/admin',
  people: '/admin/people',
  push: '/admin/push',
  cache: '/admin/cache',
  branding: '/admin/branding',
  features: '/admin/features',
  identity: '/admin/oidc',
  danger: '/admin/danger'
}

/**
 * The Hermie mark, inlined.
 *
 * `design/icon.svg` is the source and this is its `#mark` on a flat backdrop.
 * Inlined rather than served, because a page an operator reaches when something
 * is already wrong must not depend on a second request succeeding — the same
 * reason there is no script and no font here.
 *
 * The backdrop is the accent fill from `tokens.ts` rather than the icon's own
 * vertical gradient: these pages carry no gradients.
 */
const MARK = `<svg class="mark" viewBox="0 0 1024 1024" width="28" height="28" aria-hidden="true" focusable="false">
  <rect x="0" y="0" width="1024" height="1024" rx="224" fill="#1668E3"/>
  <path d="M 424 656 C 420 732 358 790 222 818 C 288 752 306 700 304 644 Z" fill="#FFFFFF"/>
  <rect x="168" y="216" width="688" height="464" rx="140" fill="#FFFFFF"/>
  <rect x="336" y="300" width="96" height="296" rx="24" fill="#1668E3"/>
  <rect x="592" y="300" width="96" height="296" rx="24" fill="#1668E3"/>
  <path d="M 336 434 C 452 434 562 396 688 366 L 688 438 C 562 468 452 522 336 522 Z" fill="#1668E3"/>
</svg>`

/**
 * The whole style sheet, once.
 *
 * Read it as four blocks: the tokens, the shell, the type, and the controls.
 * Every colour is a token so the dark half is one `@media` block rather than a
 * second copy of the sheet, and every gap is a step of the app's own 4pt scale
 * so two cards on two pages are the same distance apart.
 */
const STYLE = `
  :root {
    color-scheme: light dark;
    --s1: 4px; --s2: 8px; --s3: 12px; --s4: 16px; --s5: 20px; --s6: 24px; --s8: 32px;
    --r-card: 18px; --r-inset: 12px; --r-pill: 999px;
    /* Blue, light: the elevation ladder from apps/hermie/src/ui/themes.ts. */
    --bg: #eaf3ff;
    --panel: #f4f8fe;
    --card: #ffffff;
    --sunk: #dce8fb;
    --ink: #12151c;
    --muted: #4b5462;
    --faint: #586171;
    --accent: #1668e3;
    --accent-ink: #0b57c4;
    --accent-soft: rgba(22, 104, 227, 0.12);
    --on-accent: #ffffff;
    --danger: #c0293a;
    --danger-ink: #a81f30;
    --danger-soft: rgba(192, 41, 58, 0.1);
    --ok-ink: #116038;
    --warn-ink: #865600;
    --hair: rgba(16, 38, 78, 0.13);
    --hair-soft: rgba(16, 38, 78, 0.08);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0a1830;
      --panel: #1c2a45;
      --card: #2f4066;
      --sunk: rgba(6, 12, 24, 0.44);
      --ink: #f3f6fb;
      --muted: #c8d2e0;
      --faint: #cbd5e4;
      --accent: #2c7bea;
      --accent-ink: #b4d6ff;
      --accent-soft: rgba(90, 164, 255, 0.18);
      --danger: #d8465a;
      --danger-ink: #ffc2cd;
      --danger-soft: rgba(255, 120, 135, 0.16);
      --ok-ink: #8fe3b0;
      --warn-ink: #ffcb61;
      --hair: rgba(190, 212, 255, 0.22);
      --hair-soft: rgba(190, 212, 255, 0.13);
    }
  }

  * { box-sizing: border-box }
  body {
    font: 400 16px/1.55 -apple-system, "SF Pro Text", system-ui, sans-serif;
    margin: 0;
    background: var(--bg);
    color: var(--ink);
  }

  /* ---- the shell ---- */
  .top {
    display: flex;
    align-items: center;
    gap: var(--s3);
    flex-wrap: wrap;
    padding: var(--s4) var(--s5);
    border-bottom: 1px solid var(--hair);
    background: var(--panel);
  }
  .brand { display: flex; align-items: center; gap: var(--s2); text-decoration: none; color: inherit }
  .brand-name { font: 600 17px/22px inherit; letter-spacing: -0.01em }
  .mark { display: block; border-radius: var(--s2) }
  .where { color: var(--muted); font-size: 0.9rem; margin-left: auto }

  .shell {
    display: grid;
    grid-template-columns: 13rem minmax(0, 1fr);
    gap: var(--s6);
    align-items: start;
    max-width: 68rem;
    margin: 0 auto;
    padding: var(--s6) var(--s5) var(--s8);
  }
  nav { display: flex; flex-direction: column; gap: var(--s1); position: sticky; top: var(--s6) }
  nav a {
    display: block;
    padding: var(--s2) var(--s3);
    border-radius: var(--r-inset);
    text-decoration: none;
    color: var(--muted);
    font-size: 0.95rem;
    white-space: nowrap;
  }
  nav a:hover { background: var(--hair-soft); color: var(--ink) }
  nav a[aria-current="page"] { background: var(--accent-soft); color: var(--accent-ink); font-weight: 600 }
  main { min-width: 0 }

  footer {
    border-top: 1px solid var(--hair);
    background: var(--panel);
    padding: var(--s4) var(--s5);
  }
  .footer-inner {
    max-width: 68rem;
    margin: 0 auto;
    display: flex;
    align-items: center;
    gap: var(--s4);
    flex-wrap: wrap;
  }
  .footer-inner form { display: flex; align-items: center; gap: var(--s3); flex-wrap: wrap; margin: 0 0 0 auto }

  /* ---- type ---- */
  h1 { font: 700 26px/30px inherit; letter-spacing: -0.022em; margin: 0 0 var(--s2) }
  h2 { font: 600 17px/22px inherit; margin: 0 0 var(--s2) }
  p { color: var(--muted); margin: 0 0 var(--s4) }
  p:last-child { margin-bottom: 0 }
  .lede { margin-bottom: var(--s5) }
  .note { font-size: 0.85rem }
  .bad { color: var(--danger-ink) }
  .ok { color: var(--ok-ink) }
  .warn { color: var(--warn-ink) }
  code { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 0.875em; word-break: break-word }
  pre {
    background: var(--sunk);
    border: 1px solid var(--hair-soft);
    border-radius: var(--r-inset);
    padding: var(--s3);
    overflow-x: auto;
    font-size: 0.85rem;
    margin: 0 0 var(--s4);
  }
  a { color: var(--accent-ink) }

  /* ---- cards ---- */
  .card {
    background: var(--card);
    border: 1px solid var(--hair);
    border-radius: var(--r-card);
    padding: var(--s5);
    margin: 0 0 var(--s4);
  }
  .card > :last-child { margin-bottom: 0 }
  .card.danger { border-color: var(--danger); background: var(--danger-soft) }
  .banner {
    border-radius: var(--r-inset);
    padding: var(--s3) var(--s4);
    margin: 0 0 var(--s4);
    background: var(--accent-soft);
    color: var(--accent-ink);
  }
  .banner.bad { background: var(--danger-soft); color: var(--danger-ink) }

  /* ---- facts and tables ---- */
  dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: var(--s1) var(--s4); margin: 0 0 var(--s4); font-size: 0.9rem }
  dt { color: var(--muted) }
  dd { margin: 0 }
  table { width: 100%; border-collapse: collapse; font-size: 0.9rem; margin: 0 0 var(--s4) }
  caption { text-align: left; color: var(--muted); font-size: 0.85rem; padding-bottom: var(--s2) }
  th, td { text-align: left; padding: var(--s2) var(--s2) var(--s2) 0; border-bottom: 1px solid var(--hair-soft); vertical-align: top }
  th { color: var(--muted); font: 600 0.85rem/1.4 inherit }
  /* A count is compared with the count above it, so counts line up on the right. */
  th.num, td.num { text-align: right; padding-right: 0; font-variant-numeric: tabular-nums }
  /* A column of checkboxes reads as a column, so the box sits under its header. */
  th.tick, td.tick { text-align: center; padding-right: var(--s2); width: 1%; white-space: nowrap }
  tr:last-child td { border-bottom: 0 }
  /*
    A name for a screen reader where the column header is the visible one.
    The ordinary clip-rect recipe: it must stay in the accessibility tree, so
    neither display:none nor visibility:hidden will do.
  */
  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
    border: 0;
  }

  /* ---- controls ---- */
  label { display: block; font-size: 0.85rem; color: var(--muted); margin: 0 0 var(--s1) }
  label.check { display: flex; align-items: center; gap: var(--s2); color: var(--ink); font-size: 0.95rem; margin-bottom: var(--s2) }
  input[type="text"], input[type="password"], input[type="number"], input[type="email"], select, textarea {
    width: 100%;
    font: inherit;
    padding: var(--s2) var(--s3);
    border: 1px solid var(--hair);
    border-radius: var(--r-inset);
    background: var(--sunk);
    color: inherit;
  }
  button {
    font: 600 0.95rem/1.2 inherit;
    padding: var(--s3) var(--s5);
    border: 0;
    border-radius: var(--r-pill);
    background: var(--accent);
    color: var(--on-accent);
    cursor: pointer;
  }
  button:disabled { opacity: 0.45; cursor: default }
  button.quiet { background: transparent; color: var(--accent-ink); border: 1px solid var(--hair) }
  /*
    The colour is restated, and it has to be.

    .bad is also the utility that paints a line of text in the danger ink, and
    on a button that rule beats the element rule it would otherwise inherit
    white from — a single class outranks a bare element. The result was the
    destructive button's own label in dark red ON dark red: legible to nobody,
    and invisible to the contrast check, which reads the app's tokens and not this
    file.
  */
  button.bad { background: var(--danger); color: var(--on-accent) }
  /* The one indication a keyboard gets, since nothing here is hovered into. */
  :focus-visible { outline: 2px solid var(--accent-ink); outline-offset: 2px }

  .fields { display: flex; gap: var(--s3); align-items: flex-end; flex-wrap: wrap; margin: 0 0 var(--s3) }
  .fields > div { flex: 1 1 10rem; min-width: 0 }
  .fields > div.narrow { flex: 0 0 auto }
  .actions { display: flex; gap: var(--s2); align-items: center; flex-wrap: wrap; margin-top: var(--s3) }
  /* The enrolment page's numbered steps and its one-time recovery codes. */
  ol, ul { color: var(--muted); padding-left: 1.2rem; font-size: 0.9rem; margin: 0 0 var(--s4) }
  li { margin-bottom: var(--s1) }
  .codes {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--s1);
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 0.9rem;
  }
  .badge {
    display: inline-block;
    padding: 0 var(--s2);
    border-radius: var(--r-pill);
    background: var(--accent-soft);
    color: var(--accent-ink);
    font: 600 0.7rem/1.5 inherit;
    letter-spacing: 0.055em;
    text-transform: uppercase;
    vertical-align: 1px;
  }

  /* ---- one column, and the nav across the top ---- */
  @media (max-width: 52rem) {
    .shell { grid-template-columns: minmax(0, 1fr); gap: var(--s4); padding: var(--s4) var(--s4) var(--s6) }
    nav {
      position: static;
      flex-direction: row;
      gap: var(--s1);
      overflow-x: auto;
      padding-bottom: var(--s1);
      border-bottom: 1px solid var(--hair);
    }
    .where { margin-left: 0; width: 100% }
  }
`

const head = (locale: WebLocale, title: string): string =>
  `<!doctype html>\n<html lang="${htmlLang(locale)}">\n<meta charset="utf-8">\n` +
  `<meta name="viewport" content="width=device-width, initial-scale=1">\n` +
  `<meta name="robots" content="noindex">\n` +
  `<title>${escapeHtml(title)}</title>\n<style>${STYLE}</style>\n`

/** Everything the chrome needs, and nothing a page body needs. */
export interface AdminChrome {
  /** The deployment's name: the branding name where one is set, else Hermie. */
  brand: string
  version: string
  current: AdminSection
  csrf: string
  /** Whether the footer's update button can do anything, and why not. */
  canSelfUpdate: boolean
  updateReason: string
  notice: string
  /** Whether the notice is a complaint. Notices are English; see `routes.ts`. */
  noticeIsBad?: boolean
  locale: WebLocale
  strings: WebStrings
}

const NAV_ORDER: readonly AdminSection[] = [
  'overview',
  'people',
  'push',
  'cache',
  'branding',
  'features',
  'identity',
  'danger'
]

function nav(chrome: AdminChrome): string {
  const labels = chrome.strings.admin.nav

  return `<nav aria-label="${escapeHtml(chrome.strings.common.administration)}">
    ${NAV_ORDER.map(
      section =>
        `<a href="${ADMIN_SECTION_PATHS[section]}"${section === chrome.current ? ' aria-current="page"' : ''}>${
          labels[section]
        }</a>`
    ).join('\n    ')}
  </nav>`
}

/**
 * The page, with a body already rendered into it.
 *
 * `title` is the `<h1>`; the `<title>` gets the deployment's name after it,
 * because a tab strip has no other context and three open tabs of one
 * deployment used to read identically.
 */
export function adminShell(chrome: AdminChrome, page: { title: string; intro?: string; body: string }): string {
  const { strings } = chrome
  const update = strings.admin.service

  return `${head(chrome.locale, `${page.title} — ${chrome.brand}`)}<body>
<header class="top">
  <a class="brand" href="/admin">${MARK}<span class="brand-name">${escapeHtml(chrome.brand)}</span></a>
  <span class="where">${strings.common.administration}</span>
</header>
<div class="shell">
  ${nav(chrome)}
  <main>
    <h1>${escapeHtml(page.title)}</h1>
    ${page.intro ? `<p class="lede">${page.intro}</p>` : ''}
    ${chrome.notice ? `<p class="banner${chrome.noticeIsBad ? ' bad' : ''}">${escapeHtml(chrome.notice)}</p>` : ''}
    ${page.body}
  </main>
</div>
<footer>
  <div class="footer-inner">
    <span class="note">${strings.admin.footer.version(escapeHtml(chrome.version))}</span>
    <form method="post" action="/admin/update">
      <input type="hidden" name="${CSRF_FIELD}" value="${escapeHtml(chrome.csrf)}">
      ${
        chrome.canSelfUpdate
          ? ''
          : `<span class="note">${escapeHtml(chrome.updateReason || update.updateUnavailable)}</span>`
      }
      <button class="quiet" type="submit"${chrome.canSelfUpdate ? '' : ' disabled'}>${update.updateButton}</button>
    </form>
  </div>
</footer>
</body>
</html>
`
}

/**
 * A page with no nav: the sign-in and the refusal.
 *
 * Neither may carry the nav, and for the same reason rather than for symmetry:
 * a reader of either is somebody this service has not let in, and a list of the
 * pages they cannot open is both useless to them and an inventory for anybody
 * else.
 */
export function barePage(input: {
  brand: string
  /** The `<h1>`. */
  title: string
  /**
   * The whole `<title>`, where the heading plus the brand will not do.
   *
   * Taken verbatim: "Sign in to Acme Chat" already names the deployment, and
   * appending it again gives a tab reading "Sign in to Acme Chat — Acme Chat".
   */
  documentTitle?: string
  /** `narrow` for a page that is one form: a sign-in has no use for 34rem. */
  width?: 'narrow' | 'wide'
  locale: WebLocale
  strings: WebStrings
  body: string
}): string {
  const column = input.width === 'narrow' ? '26rem' : '34rem'

  return `${head(input.locale, input.documentTitle ?? `${input.title} — ${input.brand}`)}<body>
<header class="top">
  <span class="brand">${MARK}<span class="brand-name">${escapeHtml(input.brand)}</span></span>
</header>
<div class="shell" style="grid-template-columns: minmax(0, ${column})">
  <main>
    <h1>${escapeHtml(input.title)}</h1>
    ${input.body}
  </main>
</div>
</body>
</html>
`
}

/** One card: a heading, an optional sentence, and whatever the page put in it. */
export function card(input: { heading?: string; intro?: string; body: string; kind?: 'danger' }): string {
  return `<section class="card${input.kind === 'danger' ? ' danger' : ''}">
    ${input.heading ? `<h2>${input.heading}</h2>` : ''}
    ${input.intro ? `<p>${input.intro}</p>` : ''}
    ${input.body}
  </section>`
}

/** The hidden field every form on every one of these pages carries. */
export const csrfField = (csrf: string): string =>
  `<input type="hidden" name="${CSRF_FIELD}" value="${escapeHtml(csrf)}">`
