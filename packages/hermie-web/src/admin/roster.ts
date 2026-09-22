/**
 * The pieces a roster is built from: the disc, the pills, the switches, and the
 * way a timestamp is said.
 *
 * Two pages list people — `/admin/people` lists whoever the gateway has seen,
 * `/admin/oidc` lists the accounts this service's own issuer holds — and they
 * were drawn twice, so they looked like two products. What they have in common
 * is exactly this file, and what stays on each page is the columns, because the
 * columns are the only thing the two lists genuinely disagree about.
 *
 * The same rules as the rest of the administration hold here: no script, every
 * value escaped, every control a real one the browser posts.
 */
import { escapeHtml } from '../setup'
import type { WebStrings } from '../i18n'

/** How many tints `layout.ts` defines. A hash lands in one of them. */
const TONES = 6

/**
 * Up to two initials, from whatever the row is willing to call somebody.
 *
 * Words rather than characters, so `Grace Hopper` is `GH` and `max` is `M`. A
 * name that is an email address is cut at the `@` first: `MAX@EXAMPLE` is not
 * initials, it is the field not fitting.
 */
export function initialsOf(name: string): string {
  const words = name
    .split('@')[0]
    ?.split(/[\s._-]+/)
    .filter(Boolean)

  if (!words?.length) {
    return '·'
  }

  const letters = words.slice(0, 2).map(word => [...word][0] ?? '')

  return letters.join('').toUpperCase()
}

/**
 * Which tint this id gets, for ever.
 *
 * A sum of code points rather than anything cryptographic: the only properties
 * that matter are that one id always answers the same tone, and that two ids
 * that differ anywhere usually answer different ones. It is a colour, not a
 * decision.
 */
export function toneOf(id: string): number {
  let total = 0

  for (const code of id) {
    total = (total * 31 + (code.codePointAt(0) ?? 0)) % 100003
  }

  return total % TONES
}

/** The initials disc: the tint from the id, the letters from the name. */
export function avatar(name: string, id: string): string {
  return `<span class="avatar av-${toneOf(id)}" aria-hidden="true">${escapeHtml(initialsOf(name))}</span>`
}

/** A quiet annotation beside a name. `on` is the accent one, `bad` the red one. */
export function pill(text: string, kind: 'quiet' | 'on' | 'bad' = 'quiet'): string {
  return `<span class="pill${kind === 'quiet' ? '' : ` ${kind}`}">${text}</span>`
}

/**
 * One switch: a real checkbox, the track that is painted, and its own name.
 *
 * `form` is the id of the form that owns it, for the rows whose Save button
 * lives somewhere the row cannot reach. The name is carried twice on purpose —
 * as the label a reader of the accessibility tree gets, and as the caption a
 * phone shows once the column head strip is gone.
 */
export function toggle(input: { name: string; label: string; checked: boolean; form?: string }): string {
  const owner = input.form ? ` form="${input.form}"` : ''
  const label = escapeHtml(input.label)

  return `<label class="switch"><input type="checkbox" name="${input.name}" value="1"${
    input.checked ? ' checked' : ''
  }${owner} aria-label="${label}"><span class="track"></span><span class="switch-name" aria-hidden="true">${
    label
  }</span></label>`
}

/** The head strip. One cell per column, laid out from the roster's own template. */
export function rosterHead(cells: readonly string[]): string {
  return `<div class="roster-head">${cells.map(cell => `<span>${cell}</span>`).join('')}</div>`
}

/** A cell of plain text, with the column's name for a reader who hears the page. */
export function cell(label: string, text: string, extra = ''): string {
  return `<span class="cell"${extra}><span class="sr">${label} </span>${text}</span>`
}

const pad = (value: number): string => String(value).padStart(2, '0')

/** Which day a moment falls on, in this server's own zone, as a number. */
const dayOf = (at: Date): number => Math.floor((at.getTime() - at.getTimezoneOffset() * 60_000) / 86_400_000)

/**
 * A timestamp as one line, with the whole of it in the title attribute.
 *
 * It used to be `2026-09-22 11:58` in a column six characters too narrow, so
 * every row was two lines and no column below it lined up. What an operator
 * reads a last-seen column for is "was that recent", and the answer to that is
 * a clock time today, a date this year, and a year before that. The full stamp
 * is still there for whoever needs to compare two of them: it is what the
 * pointer and the accessibility tree both get.
 *
 * Server-local throughout, because a page rendered before any script runs has
 * no way to know the reader's zone and inventing one would be worse than
 * naming the machine's.
 */
export function whenAgo(
  seconds: number,
  strings: WebStrings,
  now: number = Date.now()
): { text: string; title: string } {
  if (!seconds) {
    return { text: '—', title: '' }
  }

  const at = new Date(seconds * 1000)
  const clock = `${pad(at.getHours())}:${pad(at.getMinutes())}`
  const title = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${clock}`
  const days = dayOf(new Date(now)) - dayOf(at)

  if (days === 0) {
    return { text: `${strings.common.today} ${clock}`, title }
  }

  if (days === 1) {
    return { text: `${strings.common.yesterday} ${clock}`, title }
  }

  const month = strings.common.monthShort(at.getMonth())
  const year = at.getFullYear() === new Date(now).getFullYear() ? '' : ` ${at.getFullYear()}`

  return { text: `${at.getDate()} ${month}${year}`, title }
}

/** A last-seen cell: the short form, the full stamp on the pointer. */
export function whenCell(label: string, seconds: number, strings: WebStrings, now?: number): string {
  const { text, title } = whenAgo(seconds, strings, now)

  return cell(label, escapeHtml(text), title ? ` title="${escapeHtml(title)}"` : '')
}
