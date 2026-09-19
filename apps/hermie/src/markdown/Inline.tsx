/**
 * Inline token rendering.
 *
 * Everything nests inside one `Text`, which is what makes a bold word inside a
 * sentence wrap with the sentence instead of becoming its own box. Only images
 * break out, because an `Image` cannot live inside a `Text` on Android.
 */
import { Fragment, useState, type ReactNode } from 'react'
import { Image, StyleSheet, Text, type TextStyle, View } from 'react-native'
import type { Token, Tokens } from 'marked'

import { MONOSPACE, resolveImageUri, type MarkdownContext } from './context'

export interface InlineProps {
  tokens: Token[]
  context: MarkdownContext
  style?: TextStyle
}

/**
 * The chip's fake horizontal padding. React Native will not apply padding to a
 * `Text` nested inside a `Text`, so the padding has to be characters — and they
 * are NON-BREAKING on purpose. Do not "tidy" this back into a normal space.
 *
 * A background-coloured nested `Text` paints EVERY line fragment of its range,
 * and a fragment that holds only the line's trailing whitespace is painted
 * across the whole rest of the line. So a chip that broke on its own ASCII
 * padding space drew a full-width empty bar at the end of the previous line and
 * then the real chip on the next one. Non-breaking padding means a break can
 * never land at the chip's edge: the whole chip moves down instead.
 */
const CODE_PAD = '\u00a0'

/**
 * The wrap point inside a chip. Zero width, so the fragment it ends is painted
 * behind glyphs only — never a bar of empty background. It is what lets a chip
 * still wrap on word boundaries (design/liquid-glass-tokens.md, 6.3) now that
 * none of its spaces are breakable.
 */
const CODE_BREAK = '\u200b'

/**
 * Pad the chip and move its wrap points off its whitespace.
 *
 * No ASCII space survives inside a chip, at either edge or between words: any
 * of them could end up as a line's trailing whitespace and paint the bar above.
 * A gap between words keeps its width as non-breaking spaces and gains a
 * zero-width break opportunity in FRONT of it, so the gap travels to the next
 * line with the word it belongs to.
 */
function padCode(text: string): string {
  const leading = /^\s*/.exec(text)?.[0] ?? ''
  const rest = text.slice(leading.length)
  const trailing = /\s*$/.exec(rest)?.[0] ?? ''
  const core = rest.slice(0, rest.length - trailing.length)
  const wrapped = core.replace(/\s+/g, gap => `${CODE_BREAK}${CODE_PAD.repeat(gap.length)}`)

  // Whitespace the code itself opened or closed on is padding, not a wrap point.
  return `${CODE_PAD}${CODE_PAD.repeat(leading.length)}${wrapped}${CODE_PAD.repeat(trailing.length)}${CODE_PAD}`
}

/**
 * The chip reads as a sunk well on whatever surface it sits on, NOT as the
 * code-BLOCK surface: `blockBackground` is an opaque near-black in dark mode, and
 * a near-black slab behind a few words on a blue-slate bubble reads as a
 * redaction bar. `inlineCodeBackground` is a translucent tint instead, so it
 * steps one rung off its own surface wherever it lands.
 *
 * The hairline is carried but is very likely inert: React Native draws a nested
 * `Text` as a span on both platforms, and a span takes a background colour but
 * not a border. It is here so a caller's value survives to whatever renders the
 * chip, and the tint alone has to do the separating today.
 */
function codeStyle(context: MarkdownContext): TextStyle {
  const border = context.inlineCodeBorderColor

  return {
    backgroundColor: context.inlineCodeBackground ?? context.blockBackground,
    color: context.textColor,
    fontFamily: MONOSPACE,
    fontSize: Math.max(11, context.fontSize - 2),
    ...(border ? { borderColor: border, borderWidth: StyleSheet.hairlineWidth } : {})
  }
}

/**
 * Images are hoisted out of the inline flow by `renderInline`; this keeps a
 * sane box for one without knowing its intrinsic size. `expo-image` is not a
 * dependency of this app, so the platform `Image` does the work.
 *
 * Three things the platform `Image` will not do by itself: resolve the
 * gateway-relative `/api/...` src an agent actually writes, carry the headers a
 * gated gateway demands, and say anything at all when the fetch fails. The
 * third is the one a reader sees — a grey rectangle where a chart should be —
 * so a failed image falls back to its alt text, which is the description the
 * agent already wrote.
 */
function InlineImage({ token, context }: { token: Tokens.Image; context: MarkdownContext }) {
  const [failed, setFailed] = useState(false)
  const uri = resolveImageUri(token.href, context.images?.baseUrl)
  const headers = context.images?.headers
  const alt = token.text || token.title || ''

  if (failed || !uri) {
    return alt ? (
      <Text selectable={context.selectable} style={{ color: context.mutedTextColor, fontSize: 12, marginVertical: 8 }}>
        {alt}
      </Text>
    ) : null
  }

  return (
    <View style={{ gap: 4, marginVertical: 8 }}>
      <Image
        accessibilityLabel={alt || undefined}
        onError={() => setFailed(true)}
        resizeMode="contain"
        source={{ uri, ...(headers && Object.keys(headers).length ? { headers } : {}) }}
        style={{
          width: '100%',
          height: 180,
          borderRadius: 12,
          backgroundColor: context.blockBackground
        }}
      />
      {token.text ? (
        <Text selectable={context.selectable} style={{ color: context.mutedTextColor, fontSize: 12 }}>
          {token.text}
        </Text>
      ) : null}
    </View>
  )
}

function renderToken(token: Token, index: number, context: MarkdownContext): ReactNode {
  const key = `${token.type}-${index}`

  switch (token.type) {
    case 'text':
    case 'escape': {
      const nested = (token as Tokens.Text).tokens

      if (nested?.length) {
        return <Fragment key={key}>{nested.map((child, at) => renderToken(child, at, context))}</Fragment>
      }

      return <Fragment key={key}>{(token as Tokens.Text).text}</Fragment>
    }

    case 'strong':
      return (
        <Text key={key} style={{ fontWeight: '700' }}>
          {(token as Tokens.Strong).tokens.map((child, at) => renderToken(child, at, context))}
        </Text>
      )

    case 'em':
      return (
        <Text key={key} style={{ fontStyle: 'italic' }}>
          {(token as Tokens.Em).tokens.map((child, at) => renderToken(child, at, context))}
        </Text>
      )

    case 'del':
      return (
        <Text key={key} style={{ textDecorationLine: 'line-through' }}>
          {(token as Tokens.Del).tokens.map((child, at) => renderToken(child, at, context))}
        </Text>
      )

    case 'codespan':
      return (
        <Text key={key} style={codeStyle(context)}>
          {padCode((token as Tokens.Codespan).text)}
        </Text>
      )

    case 'br':
      return <Fragment key={key}>{'\n'}</Fragment>

    case 'link': {
      const link = token as Tokens.Link

      return (
        <Text
          accessibilityRole="link"
          key={key}
          onPress={() => context.onLinkPress(link.href)}
          style={{ color: context.linkColor, textDecorationLine: 'underline' }}
        >
          {link.tokens?.length ? link.tokens.map((child, at) => renderToken(child, at, context)) : link.text}
        </Text>
      )
    }

    case 'image':
      // Reached only when an image sits inside emphasis or a link; the block
      // renderer hoists the common case. Fall back to the alt text so the
      // sentence still reads.
      return <Fragment key={key}>{(token as Tokens.Image).text}</Fragment>

    case 'html':
      // No HTML renderer here by design: an agent's stray `<div>` should read
      // as the literal characters it typed.
      return <Fragment key={key}>{(token as Tokens.HTML).raw}</Fragment>

    default: {
      const nested = (token as { tokens?: Token[] }).tokens

      if (nested?.length) {
        return <Fragment key={key}>{nested.map((child, at) => renderToken(child, at, context))}</Fragment>
      }

      return <Fragment key={key}>{(token as { raw?: string }).raw ?? ''}</Fragment>
    }
  }
}

/** Splits a token list into the images that need their own box and the rest. */
export function partitionImages(tokens: Token[]): { images: Tokens.Image[]; inline: Token[] } {
  const images: Tokens.Image[] = []
  const inline: Token[] = []

  for (const token of tokens) {
    if (token.type === 'image') {
      images.push(token as Tokens.Image)

      continue
    }

    inline.push(token)
  }

  return { images, inline }
}

export function Inline({ tokens, context, style }: InlineProps) {
  const { images, inline } = partitionImages(tokens)
  const hasText = inline.some(token => (token as { raw?: string }).raw?.trim())

  return (
    <>
      {hasText ? (
        <Text
          selectable={context.selectable}
          style={[{ color: context.textColor, fontSize: context.fontSize, lineHeight: context.lineHeight }, style]}
        >
          {inline.map((token, index) => renderToken(token, index, context))}
        </Text>
      ) : null}
      {images.map((token, index) => (
        <InlineImage context={context} key={`img-${index}`} token={token} />
      ))}
    </>
  )
}
