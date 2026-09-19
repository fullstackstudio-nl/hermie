/**
 * One top-level Markdown block.
 *
 * `MarkdownBlock` takes the block's SOURCE TEXT, not a token, and lexes it
 * itself. That is what makes the memo work: during streaming the text of every
 * settled block is byte-identical flush after flush, so `React.memo` on the raw
 * string keeps them all mounted and only the tail re-lexes.
 */
import { memo, useMemo } from 'react'
import { ScrollView, Text, View } from 'react-native'
import { marked, type Token, type Tokens } from 'marked'

import { CodeBlock } from './CodeBlock'
import { Inline } from './Inline'
import { MONOSPACE, type MarkdownContext } from './context'

const HEADING_SCALE = [1.5, 1.32, 1.18, 1.08, 1, 0.94]

function Blocks({ tokens, context }: { tokens: Token[]; context: MarkdownContext }) {
  return (
    <>
      {tokens.map((token, index) => (
        <BlockToken context={context} key={index} token={token} />
      ))}
    </>
  )
}

function ListBlock({ token, context }: { token: Tokens.List; context: MarkdownContext }) {
  return (
    <View style={{ gap: 4, marginVertical: 4 }}>
      {token.items.map((item, index) => {
        const marker = token.ordered ? `${Number(token.start || 1) + index}.` : '•'

        return (
          <View key={index} style={{ flexDirection: 'row', gap: 8 }}>
            <Text
              style={{
                color: context.mutedTextColor,
                fontSize: context.fontSize,
                lineHeight: context.lineHeight,
                minWidth: token.ordered ? 22 : 14
              }}
            >
              {item.task ? (item.checked ? '☑' : '☐') : marker}
            </Text>
            <View style={{ flex: 1 }}>
              {/* A loose item holds block tokens; a tight one holds inline
                  tokens under a single `text` token. */}
              <Blocks context={context} tokens={item.tokens} />
            </View>
          </View>
        )
      })}
    </View>
  )
}

function TableBlock({ token, context }: { token: Tokens.Table; context: MarkdownContext }) {
  const columnWidth = 150

  const cellStyle = {
    borderColor: context.borderColor,
    borderRightWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 8,
    width: columnWidth
  } as const

  return (
    <ScrollView
      directionalLockEnabled
      horizontal
      showsHorizontalScrollIndicator={false}
      // `flexGrow: 0`: a horizontal `ScrollView` otherwise grows to the height
      // of whatever column it sits in.
      style={{ flexGrow: 0, marginVertical: 8 }}
    >
      <View
        style={{
          borderColor: context.borderColor,
          borderRadius: 10,
          borderWidth: 1,
          overflow: 'hidden'
        }}
      >
        <View style={{ backgroundColor: context.blockBackground, flexDirection: 'row' }}>
          {token.header.map((cell, index) => (
            <View key={index} style={cellStyle}>
              <Inline
                context={context}
                style={{ fontWeight: '600', textAlign: cell.align ?? 'left' }}
                tokens={cell.tokens}
              />
            </View>
          ))}
        </View>

        {token.rows.map((row, rowIndex) => (
          <View key={rowIndex} style={{ borderColor: context.borderColor, borderTopWidth: 1, flexDirection: 'row' }}>
            {row.map((cell, cellIndex) => (
              <View key={cellIndex} style={cellStyle}>
                <Inline context={context} style={{ textAlign: cell.align ?? 'left' }} tokens={cell.tokens} />
              </View>
            ))}
          </View>
        ))}
      </View>
    </ScrollView>
  )
}

function BlockToken({ token, context }: { token: Token; context: MarkdownContext }) {
  switch (token.type) {
    case 'space':
      return null

    case 'heading': {
      const heading = token as Tokens.Heading
      const scale = HEADING_SCALE[Math.min(heading.depth, HEADING_SCALE.length) - 1] ?? 1

      return (
        <View style={{ marginBottom: 4, marginTop: 10 }}>
          <Inline
            context={context}
            style={{
              fontSize: Math.round(context.fontSize * scale),
              fontWeight: '700',
              lineHeight: Math.round(context.lineHeight * scale)
            }}
            tokens={heading.tokens}
          />
        </View>
      )
    }

    case 'paragraph':
      return (
        <View style={{ marginVertical: 4 }}>
          <Inline context={context} tokens={(token as Tokens.Paragraph).tokens} />
        </View>
      )

    case 'text': {
      const text = token as Tokens.Text

      return text.tokens?.length ? (
        <Inline context={context} tokens={text.tokens} />
      ) : (
        <Text
          selectable={context.selectable}
          style={{ color: context.textColor, fontSize: context.fontSize, lineHeight: context.lineHeight }}
        >
          {text.text}
        </Text>
      )
    }

    case 'code': {
      const code = token as Tokens.Code

      return <CodeBlock code={code.text} context={context} language={code.lang?.split(/\s/)[0] || undefined} />
    }

    case 'blockquote':
      return (
        <View
          style={{
            borderLeftColor: context.borderColor,
            borderLeftWidth: 3,
            marginVertical: 6,
            paddingLeft: 12
          }}
        >
          <Blocks context={context} tokens={(token as Tokens.Blockquote).tokens} />
        </View>
      )

    case 'list':
      return <ListBlock context={context} token={token as Tokens.List} />

    case 'table':
      return <TableBlock context={context} token={token as Tokens.Table} />

    case 'hr':
      return <View style={{ backgroundColor: context.borderColor, height: 1, marginVertical: 12 }} />

    case 'html':
      return (
        <Text
          selectable={context.selectable}
          style={{ color: context.mutedTextColor, fontFamily: MONOSPACE, fontSize: context.fontSize - 3 }}
        >
          {(token as Tokens.HTML).raw.trimEnd()}
        </Text>
      )

    default: {
      const raw = (token as { raw?: string }).raw ?? ''

      return raw.trim() ? (
        <Text
          selectable={context.selectable}
          style={{ color: context.textColor, fontSize: context.fontSize, lineHeight: context.lineHeight }}
        >
          {raw}
        </Text>
      ) : null
    }
  }
}

export interface MarkdownBlockProps {
  /** The block's own source slice, exactly as `splitBlocks` cut it. */
  raw: string
  context: MarkdownContext
  /** The tail of a reply still arriving: draws the streaming caret. */
  streaming?: boolean
}

function MarkdownBlockView({ raw, context, streaming = false }: MarkdownBlockProps) {
  const tokens = useMemo(() => marked.lexer(raw), [raw])

  if (!raw.trim()) {
    return null
  }

  return (
    <View>
      <Blocks context={context} tokens={tokens} />
      {streaming ? (
        <Text
          accessibilityLabel="Streaming"
          style={{ color: context.mutedTextColor, fontSize: context.fontSize, lineHeight: context.lineHeight }}
        >
          {'▍'}
        </Text>
      ) : null}
    </View>
  )
}

/**
 * Memoized on `(raw, context, streaming)`. `context` is one frozen object from
 * `Markdown`, so in practice the raw string is the only thing that changes —
 * which is exactly the invariant the streaming path depends on.
 */
export const MarkdownBlock = memo(MarkdownBlockView)
