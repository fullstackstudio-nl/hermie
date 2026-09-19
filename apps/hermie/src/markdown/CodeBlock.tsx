/**
 * A fenced code block: language label, then the listing on one horizontally
 * scrollable surface.
 *
 * No wrapping. A wrapped line in a listing reads as two statements, and the
 * design board puts code in a scrollable row for exactly that reason.
 */
import { memo, useMemo } from 'react'
import { ScrollView, Text, View } from 'react-native'

import { MONOSPACE, type MarkdownContext } from './context'
import { codeScopeColor } from './code-theme'
import { highlightToLines } from './highlight'

export interface CodeBlockProps {
  code: string
  language?: string
  context: MarkdownContext
}

function CodeBlockView({ code, language, context }: CodeBlockProps) {
  const lines = useMemo(() => highlightToLines(code.replace(/\n$/, ''), language), [code, language])
  const fontSize = Math.max(11, context.fontSize - 4)

  return (
    <View
      style={{
        backgroundColor: context.blockBackground,
        borderColor: context.borderColor,
        borderRadius: 12,
        borderWidth: 1,
        marginVertical: 8,
        overflow: 'hidden'
      }}
    >
      {language ? (
        <View
          style={{
            borderBottomColor: context.borderColor,
            borderBottomWidth: 1,
            paddingHorizontal: 12,
            paddingVertical: 6
          }}
        >
          <Text style={{ color: context.mutedTextColor, fontSize: 11, letterSpacing: 0.6 }}>
            {language.toUpperCase()}
          </Text>
        </View>
      ) : null}

      <ScrollView
        contentContainerStyle={{ padding: 12 }}
        // A code block inside a transcript must not steal the list's drag.
        directionalLockEnabled
        horizontal
        showsHorizontalScrollIndicator={false}
        // A horizontal `ScrollView` defaults to `flexGrow: 1`, so inside a
        // scrollable column it balloons to the viewport height instead of
        // hugging its listing.
        style={{ flexGrow: 0 }}
      >
        <Text selectable={context.selectable} style={{ fontFamily: MONOSPACE, fontSize, lineHeight: fontSize * 1.45 }}>
          {lines.map((spans, lineIndex) => (
            <Text key={lineIndex}>
              {lineIndex > 0 ? '\n' : ''}
              {spans.length ? (
                spans.map((span, spanIndex) => (
                  <Text
                    key={spanIndex}
                    style={{ color: codeScopeColor(span.scope, context.scheme) ?? context.textColor }}
                  >
                    {span.text}
                  </Text>
                ))
              ) : (
                <Text> </Text>
              )}
            </Text>
          ))}
        </Text>
      </ScrollView>
    </View>
  )
}

export const CodeBlock = memo(CodeBlockView)
