/**
 * The render context a Markdown block needs.
 *
 * It is one frozen object so a memoized block has exactly two props — the raw
 * source and this — and a streaming reply cannot invalidate settled blocks by
 * handing them a fresh callback identity on every flush.
 */
import { Platform } from 'react-native'

import type { ColorRole } from '../ui/tokens'

export interface MarkdownContext {
  scheme: 'light' | 'dark'
  /** Body colour role; headings and code derive from it. */
  color: ColorRole
  /** Muted role, for rules, table headers and the code language label. */
  mutedColor: ColorRole
  /** Link colour; white-on-blue bubbles override it. */
  linkColor: string
  fontSize: number
  lineHeight: number
  selectable: boolean
  /** Surface a code block, table or blockquote paints on. */
  blockBackground: string
  /**
   * Surface an INLINE code chip paints on, separate from the code-block one.
   *
   * A chip sits on running text, on whatever surface that text is on — an
   * incoming bubble, a reading bubble, a tool card. The code-block surface is
   * opaque and near-black in dark mode, so borrowing it paints a redaction bar
   * through the middle of a sentence. This is a translucent sunk tint instead,
   * which steps one rung off its own background wherever it lands. Defaults to
   * the theme's `tintSunk`.
   */
  inlineCodeBackground?: string
  /** Hairline around a chip. See `codeStyle` in `Inline.tsx`: likely inert. */
  inlineCodeBorderColor?: string
  borderColor: string
  textColor: string
  mutedTextColor: string
  /** Stable for the lifetime of the renderer. */
  onLinkPress: (href: string) => void
  /**
   * What an image in the text needs to actually load.
   *
   * A gateway serves its attachments from its own origin, behind whatever
   * guards the rest of the API is behind, and it writes them into replies as
   * `/api/...` — a path, not a URL. Without a base an image like that resolves
   * against nothing and renders as a grey box; without the headers a gated
   * gateway answers 401 and it renders as the same grey box.
   */
  images?: MarkdownImageSource
}

export interface MarkdownImageSource {
  /** The gateway's base URL, for a relative `src`. */
  baseUrl?: string
  /** Sent with the image request; stable identity, or every block re-renders. */
  headers?: Record<string, string>
}

const ABSOLUTE_URI_RE = /^[a-z][a-z0-9+.-]*:/i

/**
 * Turn an image `src` into something `Image` can fetch.
 *
 * Anything already carrying a scheme (`https:`, `data:`, `file:`) is left
 * exactly as written. A path is joined onto the gateway's base; without a base
 * it is handed back unchanged, so the renderer falls back to the alt text
 * rather than requesting a URL that cannot exist.
 */
export function resolveImageUri(href: string, baseUrl?: string): string {
  const src = href.trim()

  if (!src || ABSOLUTE_URI_RE.test(src)) {
    return src
  }

  if (!baseUrl) {
    return src
  }

  return `${baseUrl.replace(/\/+$/, '')}/${src.replace(/^\/+/, '')}`
}

/**
 * Android has no Menlo and iOS has no family called `monospace`; naming
 * a font that does not exist falls back to the UI face, which is precisely what
 * a command or a diff must not render in.
 */
export const MONOSPACE = Platform.select({ android: 'monospace', default: 'Menlo' })
