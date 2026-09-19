/**
 * `<Markdown text streaming? />` — the incremental renderer.
 *
 * The text is preprocessed, split into top-level blocks, and each block is
 * rendered by a component memoized on its own source slice. While a reply
 * streams, every block but the last keeps byte-identical source, so only the
 * last one re-lexes and re-renders.
 *
 * One block does re-render a second time: the tail carries the streaming caret,
 * so when the caret moves on it renders once more without it. Twice per block
 * over a whole reply, rather than once per delta — which is the bound
 * `__tests__/chat-ui/markdown-blocks.test.tsx` asserts.
 */
import { useCallback, useMemo, useRef } from 'react'
import { Linking, View, type ViewStyle } from 'react-native'

import { useTheme } from '../ui/theme'
import type { ColorRole } from '../ui/tokens'
import { MarkdownBlock } from './Block'
import { splitBlocks } from './blocks'
import type { MarkdownContext, MarkdownImageSource } from './context'
import { preprocessMarkdown } from './preprocess'

export interface MarkdownProps {
  text: string
  /** The reply is still arriving: draws a caret after the last block. */
  streaming?: boolean
  /** Body colour role. Blue bubbles pass `onAccent`. */
  color?: ColorRole
  mutedColor?: ColorRole
  /** Link colour, when the body colour makes the accent unreadable. */
  linkColor?: string
  /** Surface that code blocks and tables paint on. */
  surface?: string
  /**
   * Surface an inline code chip paints on. Defaults to the theme's sunk tint,
   * which is translucent and therefore correct on any bubble; `surface` does not
   * reach the chip, because the code-block surface is opaque and a near-black
   * slab behind three words in a sentence reads as a redaction bar.
   */
  inlineCodeBackground?: string
  /** Hairline around an inline code chip. Defaults to the theme's hairline. */
  inlineCodeBorderColor?: string
  borderColor?: string
  fontSize?: number
  selectable?: boolean
  /** Replaces the default `Linking.openURL`; the gallery uses it to log taps. */
  onLinkPress?: (href: string) => void
  /**
   * Where a relative image resolves and what its request carries.
   *
   * Pass a STABLE object: it lands in the context every block is memoized on,
   * and a fresh one per render re-renders the whole reply on every delta.
   */
  images?: MarkdownImageSource
  style?: ViewStyle
}

const OPENABLE = /^(https?|mailto|tel):/i

export function Markdown({
  text,
  streaming = false,
  color = 'text',
  mutedColor = 'textMuted',
  linkColor,
  surface,
  inlineCodeBackground,
  inlineCodeBorderColor,
  borderColor,
  fontSize,
  selectable = true,
  onLinkPress,
  images,
  style
}: MarkdownProps) {
  const theme = useTheme()

  // The caller may hand a fresh closure on every render; a block must never be
  // invalidated by that.
  const linkHandler = useRef(onLinkPress)

  linkHandler.current = onLinkPress

  const handleLink = useCallback((href: string) => {
    if (linkHandler.current) {
      linkHandler.current(href)

      return
    }

    // A path on the gateway's disk is not something this device can open; the
    // link stays inert rather than throwing.
    if (OPENABLE.test(href)) {
      void Linking.openURL(href).catch(() => undefined)
    }
  }, [])

  const body = fontSize ?? theme.type.body.fontSize

  const context = useMemo<MarkdownContext>(
    () => ({
      blockBackground: surface ?? theme.tintSunk,
      inlineCodeBackground: inlineCodeBackground ?? theme.tintSunk,
      inlineCodeBorderColor: inlineCodeBorderColor ?? theme.hairline,
      borderColor: borderColor ?? theme.hairline,
      color,
      fontSize: body,
      lineHeight: Math.round(body * 1.45),
      linkColor: linkColor ?? theme.colors.accent,
      mutedColor,
      mutedTextColor: theme.colors[mutedColor],
      onLinkPress: handleLink,
      scheme: theme.scheme,
      selectable,
      textColor: theme.colors[color],
      ...(images ? { images } : {})
    }),
    [
      body,
      borderColor,
      color,
      handleLink,
      images,
      inlineCodeBackground,
      inlineCodeBorderColor,
      linkColor,
      mutedColor,
      selectable,
      surface,
      theme
    ]
  )

  const blocks = useMemo(() => splitBlocks(preprocessMarkdown(text)), [text])
  const lastIndex = useMemo(() => {
    for (let index = blocks.length - 1; index >= 0; index -= 1) {
      if ((blocks[index] ?? '').trim()) {
        return index
      }
    }

    return -1
  }, [blocks])

  return (
    <View style={style}>
      {blocks.map((raw, index) => (
        <MarkdownBlock context={context} key={index} raw={raw} streaming={streaming && index === lastIndex} />
      ))}
    </View>
  )
}
