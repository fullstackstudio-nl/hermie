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
  borderColor: string
  textColor: string
  mutedTextColor: string
  /** Stable for the lifetime of the renderer. */
  onLinkPress: (href: string) => void
}

/**
 * Android has no Menlo and iOS/macOS have no family called `monospace`; naming
 * a font that does not exist falls back to the UI face, which is precisely what
 * a command or a diff must not render in.
 */
export const MONOSPACE = Platform.select({ android: 'monospace', default: 'Menlo' })
