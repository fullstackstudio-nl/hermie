/** Small, dependency-free formatters shared by the chat components. */

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

/** One line, whitespace collapsed, ellipsised. */
export function clipInline(value: string, max = 80): string {
  const collapsed = value.replace(/\s+/g, ' ').trim()

  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed
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
