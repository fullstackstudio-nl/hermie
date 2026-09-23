/** Small, dependency-free formatters shared by the chat components. */
import { type ChatPreview, chatRowPreview, type MessageAuthor } from '@hermie/transcript'

import { plainTextPreview } from '../markdown/plain-text'
import { ACCENTS, SENDER_INK_ORDER, type Scheme } from '../ui/tokens'

/** `12:48`, in the device's locale-independent 24h-or-not default. */
export function formatClock(unixSeconds: number | undefined): string {
  if (!unixSeconds) {
    return ''
  }

  const date = new Date(unixSeconds * 1000)

  if (Number.isNaN(date.getTime())) {
    return ''
  }

  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')

  return `${hours}:${minutes}`
}

/** `0.4s`, `12s`, `1m 12s`, `1h 04m` — the tool-card and agents-bar dial. */
export function formatDuration(seconds: number | undefined): string {
  if (seconds === undefined || Number.isNaN(seconds) || seconds < 0) {
    return ''
  }

  if (seconds < 10) {
    return `${Math.round(seconds * 10) / 10}s`
  }

  if (seconds < 60) {
    return `${Math.round(seconds)}s`
  }

  const totalMinutes = Math.floor(seconds / 60)
  const restSeconds = Math.round(seconds % 60)

  if (totalMinutes < 60) {
    return `${totalMinutes}m ${String(restSeconds).padStart(2, '0')}s`
  }

  const hours = Math.floor(totalMinutes / 60)

  return `${hours}h ${String(totalMinutes % 60).padStart(2, '0')}m`
}

/**
 * `0:42`, `1:12`, `1:02:33` — a running clock, for the agents bar.
 *
 * Not `formatDuration`. The bar's number ticks every second in a fixed slot, and
 * `1m 12s` changes WIDTH as it counts (`9s` → `10s` → `1m 00s`), which shoves
 * the "Show" beside it left and right once a second — the one thing a bar the
 * design board calls static must not do. A colon clock only ever grows, and only
 * at a minute or an hour.
 */
export function formatElapsedClock(seconds: number | undefined): string {
  if (seconds === undefined || Number.isNaN(seconds) || seconds < 0) {
    return '0:00'
  }

  const whole = Math.floor(seconds)
  const minutes = Math.floor(whole / 60)
  const rest = String(whole % 60).padStart(2, '0')

  if (minutes < 60) {
    return `${minutes}:${rest}`
  }

  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${rest}`
}

/** `1.2k`, `912` — token counts in a bubble footer. */
export function formatCount(value: number | undefined): string {
  if (value === undefined || Number.isNaN(value)) {
    return ''
  }

  if (value < 1000) {
    return String(value)
  }

  if (value < 1_000_000) {
    return `${Math.round(value / 100) / 10}k`
  }

  return `${Math.round(value / 100_000) / 10}M`
}

/**
 * Does this reply get the READING treatment?
 *
 * §6.3 and §7.1: a long reply drops the frosted interior for the near-opaque
 * `bubbleInRead` wash, looser leading and more generous padding. That is not a
 * stylistic variant — it is the only way body-text contrast becomes a fixed
 * number instead of a function of whatever wallpaper is behind the bubble, and a
 * wall of text is exactly where that matters.
 *
 * The test is deliberately crude and cheap: it runs on every streaming flush. A
 * fenced block or a table qualifies at any length, because both are wide machine
 * text that has to sit on a known surface to be readable at all.
 */
export function needsReadingTreatment(text: string): boolean {
  if (text.length >= 480) {
    return true
  }

  if (text.includes('```')) {
    return true
  }

  // A table's delimiter row is the one line whose shape is unambiguous.
  return /^\s*\|?[\s:-]*-{2,}[\s:|-]*$/m.test(text)
}

/** `4 KB`, `1.2 MB`, `98.4 MB` — an attachment's size on a chip. */
export function formatBytes(bytes: number | undefined): string {
  if (!bytes || bytes < 0 || Number.isNaN(bytes)) {
    return ''
  }

  if (bytes < 1024) {
    return `${bytes} B`
  }

  const kilobytes = bytes / 1024

  if (kilobytes < 1024) {
    return `${Math.round(kilobytes)} KB`
  }

  const megabytes = kilobytes / 1024

  return megabytes < 1024 ? `${Math.round(megabytes * 10) / 10} MB` : `${Math.round((megabytes / 1024) * 10) / 10} GB`
}

/**
 * Ellipsise the HEAD of a file name and keep the tail.
 *
 * The extension is the most informative part of a file name, so it is the part
 * that survives: `…-final-v4.xlsx` tells a reader more than `Q3-report-fin…`.
 */
export function middleTruncate(name: string, max = 28): string {
  if (name.length <= max) {
    return name
  }

  // Keep a couple of leading characters as well: a tail alone loses which of
  // three similarly-named exports this is.
  const head = Math.max(0, Math.floor((max - 1) / 3))
  const tail = max - 1 - head

  return `${name.slice(0, head)}…${name.slice(name.length - tail)}`
}

/** One line, whitespace collapsed, ellipsised. */
export function clipInline(value: string, max = 80): string {
  const collapsed = value.replace(/\s+/g, ' ').trim()

  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed
}

/**
 * One clipped line of a reply, with the markdown taken off.
 *
 * Every preview in the app is the raw text of a message, and a message from a
 * model is markdown — the owner read `## Retry semantics: what actu…` off a chat
 * row, where two hashes and a space bought nothing and the sentence was cut
 * anyway. Anywhere a single line stands for a whole reply goes through here: the
 * chat list row, an Activity row, and a bot-to-bot line and its quoted answer.
 */
export function previewLine(value: string, max = 80): string {
  return clipInline(plainTextPreview(value), max)
}

/** The initial a generated avatar shows. */
export function initialFor(name: string): string {
  const first = name.trim()[0]

  return first ? first.toUpperCase() : '?'
}

/**
 * A stable tint index for a name, so the same bot always gets the same avatar
 * colour without anyone storing one.
 */
export function tintIndex(name: string, buckets: number): number {
  let hash = 0

  for (let index = 0; index < name.length; index += 1) {
    hash = (hash * 31 + name.charCodeAt(index)) >>> 0
  }

  return buckets > 0 ? hash % buckets : 0
}

/** How far a sender label or a stripped identity may run before it is cut. */
const SENDER_NAME_LIMIT = 80

/**
 * One line, whitespace collapsed and cut — the same rule `contextTextOf`
 * (`@hermie/gateway-client/context`) applies to a name before it reaches a
 * system prompt. Duplicated rather than imported: the kit takes items and
 * callbacks and carries no runtime dependency on the gateway layer, the same
 * reason `attachmentName` here re-derives a shape `@hermie/transcript` already
 * knows rather than importing its runtime. Two lines of arithmetic is a smaller
 * risk than a kit component reaching across that line.
 */
function flattenSenderText(value: string, limit: number): string {
  return value.split(/\s+/u).filter(Boolean).join(' ').slice(0, limit)
}

/** `authentik:7f3a…` → `7f3a…`, and an issuer URL used as a subject left alone. */
const PROVIDER_PREFIX = /^[A-Za-z][A-Za-z0-9._-]*:(?!\/\/)(.+)$/u

/**
 * The name a sender's label shows with nothing but the row itself to go on.
 *
 * D4's rungs 2 and 3: the gateway's own stamped name, sanitised, or failing
 * that the identity with its provider prefix stripped — never prettified,
 * because guessing a person's name out of an opaque id would put a wrong name
 * on screen. Rung 1, the `context.users` directory a teammate's own client
 * writes when they share their display name, sits above this and is a later
 * change (HERM-83 Task 4); this is what a bubble can always draw with nothing
 * else, and it is what Task 4's resolver falls back to when the directory has
 * no row for this identity either.
 */
export function fallbackSenderName(author: MessageAuthor): string {
  const stamped = flattenSenderText(author.name ?? '', SENDER_NAME_LIMIT)

  if (stamped) {
    return stamped
  }

  const id = flattenSenderText(author.id, SENDER_NAME_LIMIT)

  return flattenSenderText(PROVIDER_PREFIX.exec(id)?.[1] ?? id, SENDER_NAME_LIMIT)
}

/**
 * The colour a sender's name and avatar circle are keyed to — deterministic
 * from their IDENTITY, never their name (D5): a rename must not recolour a
 * conversation, and two people who both call themselves the same thing must
 * not merge. `ACCENT_ORDER` minus `default` is ten colours, so a teammate's
 * ink is never mistaken for the chat's own accent.
 */
export function senderInk(authorId: string, scheme: Scheme): string {
  const name = SENDER_INK_ORDER[tintIndex(authorId, SENDER_INK_ORDER.length)] ?? SENDER_INK_ORDER[0] ?? 'indigo'

  return ACCENTS[name].text[scheme]
}

const DAY_SECONDS = 86_400
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/**
 * The right-aligned stamp on a chat-list row: `Now`, `12:47`, `Tue`, `12/09`.
 *
 * Deliberately relative rather than absolute — the list is read at a glance,
 * and "Now" against "12:47" is the difference a reader is actually after.
 */
export function formatListTime(unixSeconds: number | undefined, now = Date.now() / 1000): string {
  if (!unixSeconds || unixSeconds <= 0) {
    return ''
  }

  const date = new Date(unixSeconds * 1000)

  if (Number.isNaN(date.getTime())) {
    return ''
  }

  const age = now - unixSeconds

  if (age < 60) {
    return 'Now'
  }

  const today = new Date(now * 1000)
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate()

  if (sameDay) {
    return formatClock(unixSeconds)
  }

  if (age < 7 * DAY_SECONDS) {
    return WEEKDAYS[date.getDay()] ?? ''
  }

  return `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}`
}

/**
 * A chat-list preview line.
 *
 * The gateway's preview for an inbound teammate message is the raw row text,
 * which starts `Message from 🤖 Writer (@writer): …`. Spelling that out in full
 * on a 40-character row buries the message itself, so it is folded to
 * `🤖 @writer: …` — the same shape the transcript's DM bubble uses.
 *
 * A raw string still goes through here, and it still reaches this app from the
 * gateway unexamined, so the wrapper strip is HERE rather than only in the
 * caller: whatever asks for a preview line gets one that is not scaffolding. The
 * widget snapshot is the reason that matters — it shares this function and has
 * no derivation of its own.
 */
export function formatPreview(preview: string): string {
  return formatChatPreview(chatRowPreview(undefined, preview))
}

/**
 * The same line, from a preview the transcript derived.
 *
 * `chatRowPreview` decides WHAT to show — the last real message, or the
 * gateway's string with any wrapper taken off — and this decides how it reads.
 * The split is what lets one row prefer its own transcript while the widget,
 * which has none, keeps working off the string.
 */
export function formatChatPreview(preview: ChatPreview | null): string {
  if (!preview) {
    return ''
  }

  if (preview.fromHandle) {
    // The handle is ours, not the message's, so only the body is markdown.
    return clipInline(`🤖 @${preview.fromHandle}: ${plainTextPreview(preview.text)}`)
  }

  const match = preview.text.match(/^Message from\s+(?:🤖\s*)?([^(:]+?)(?:\s*\(@([^)]+)\))?\s*:\s*([\s\S]*)$/)

  if (!match) {
    return previewLine(preview.text)
  }

  const handle = (match[2] ?? match[1] ?? '').trim()

  return clipInline(`🤖 @${handle}: ${plainTextPreview(match[3] ?? '')}`)
}
