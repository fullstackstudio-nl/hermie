/**
 * A tool call, as an attachment-style card in the transcript.
 *
 * Collapsed it is one line: family glyph, name, what it did, how long it took.
 * Expanded it shows arguments, the humanised result, a diff when the call
 * produced one, and the raw `args_text`/`result_text` the gateway only sends at
 * `display.tool_progress verbose`.
 *
 * Silent tools (`todo`, `react_to_message`) render NOTHING while they succeed —
 * their UI is somewhere else entirely — but they do render when they fail,
 * because a failure nobody can see is the worst of both.
 */
import { useState } from 'react'
import { ActivityIndicator, Pressable, View } from 'react-native'

import { MONOSPACE } from '../markdown'
import { Text } from '../ui/primitives'
import { useTheme } from '../ui/theme'
import { CONTROL_MIN_HEIGHT, TAP_SLOP } from '../ui/tokens'
import { DiffView } from './DiffView'
import { clipInline, formatDuration } from './format'
import { chatStrings } from './strings'
import { argumentRows, extractToolErrorMessage, formatToolResultSummary } from './tool-result-summary'
import { isSilentTool, toolFamily, toolGlyph } from './tool-render-class'
import type { Presentation, ToolItem } from './types'

export interface ToolCardProps {
  item: ToolItem
  presentation?: Presentation
  /** Controlled disclosure; omit to let the card manage its own. */
  expanded?: boolean
  onToggleExpanded?: (expanded: boolean) => void
}

const LONG_VALUE_CHARS = 280

function SectionLabel({ children }: { children: string }) {
  const theme = useTheme()

  return (
    <Text color="textMuted" style={{ fontSize: 11, letterSpacing: 0.6, marginTop: theme.space.sm }}>
      {children.toUpperCase()}
    </Text>
  )
}

function Truncatable({ value, testID }: { value: string; testID?: string }) {
  const theme = useTheme()
  const [open, setOpen] = useState(false)
  const long = value.length > LONG_VALUE_CHARS

  return (
    <View>
      <Text
        selectable
        style={{ color: theme.colors.text, fontFamily: MONOSPACE, fontSize: 12, lineHeight: 18 }}
        testID={testID}
      >
        {long && !open ? `${value.slice(0, LONG_VALUE_CHARS)}…` : value}
      </Text>
      {long ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          hitSlop={TAP_SLOP}
          onPress={() => setOpen(current => !current)}
          style={{ justifyContent: 'center', minHeight: CONTROL_MIN_HEIGHT }}
        >
          <Text color="accent" variant="caption">
            {open ? chatStrings.tool.showLess : chatStrings.tool.showMore}
          </Text>
        </Pressable>
      ) : null}
    </View>
  )
}

function oneLineSummary(item: ToolItem): string {
  if (item.summary?.trim()) {
    return clipInline(item.summary, 90)
  }

  if (item.status === 'running') {
    return chatStrings.tool.running
  }

  if (item.status === 'generating') {
    return chatStrings.tool.generating
  }

  if (item.context?.trim()) {
    return clipInline(item.context, 90)
  }

  if (item.resultKnown && item.result !== undefined) {
    return clipInline(formatToolResultSummary(item.result), 90)
  }

  return ''
}

export function ToolCard({ item, presentation = 'collapsed', expanded, onToggleExpanded }: ToolCardProps) {
  const theme = useTheme()
  // `null` means "the user has not decided", so a verbosity change still opens
  // or closes the card; one tap pins it and verbosity stops overriding it.
  const [selfExpanded, setSelfExpanded] = useState<boolean | null>(null)
  const isExpanded = expanded ?? selfExpanded ?? presentation === 'full'

  const failed = Boolean(item.isError) || item.status === 'error'

  if (isSilentTool(item.name) && !failed) {
    return null
  }

  if (presentation === 'hidden-placeholder') {
    // Quiet mode keeps one "working" row standing in for the whole tool
    // stream; the row belongs to the list, not to this card.
    return null
  }

  const running = item.status === 'running' || item.status === 'generating'
  const family = toolFamily(item.name)
  const duration = formatDuration(item.durationS)
  const errorText = failed ? extractToolErrorMessage(item.result) || item.summary || chatStrings.tool.failed : ''
  const resultSummary = item.resultKnown && item.result !== undefined ? formatToolResultSummary(item.result) : ''
  const rows = argumentRows(item.args)
  const summaryLine = oneLineSummary(item)

  const toggle = () => {
    const next = !isExpanded

    setSelfExpanded(next)
    onToggleExpanded?.(next)
  }

  return (
    <View
      style={{
        backgroundColor: theme.colors.surfaceRaised,
        borderLeftColor: failed ? theme.colors.danger : 'transparent',
        borderLeftWidth: failed ? 3 : 0,
        borderRadius: theme.radii.xl,
        marginRight: 26,
        marginVertical: theme.space.md,
        overflow: 'hidden'
      }}
      testID={`tool-card-${item.id}`}
    >
      <Pressable
        accessibilityLabel={`${item.name}. ${summaryLine}`}
        accessibilityRole="button"
        accessibilityState={{ expanded: isExpanded }}
        onPress={toggle}
        style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
        testID={`tool-toggle-${item.id}`}
      >
        <View
          style={{
            alignItems: 'center',
            flexDirection: 'row',
            gap: theme.space.sm,
            padding: theme.space.md
          }}
        >
          <Text color={failed ? 'danger' : 'textMuted'} style={{ fontSize: 15, width: 22 }}>
            {failed ? '!' : toolGlyph(family)}
          </Text>

          <View style={{ flex: 1, gap: 2 }}>
            <Text color={failed ? 'danger' : 'text'} style={{ fontSize: 14, fontWeight: '600' }}>
              {item.name}
            </Text>
            {summaryLine ? (
              <Text color="textMuted" numberOfLines={1} style={{ fontSize: 12 }}>
                {summaryLine}
              </Text>
            ) : null}
          </View>

          {running ? <ActivityIndicator color={theme.colors.textMuted} size="small" /> : null}

          {duration && !running ? (
            <Text color="textMuted" style={{ fontSize: 12 }}>
              {duration}
            </Text>
          ) : null}

          <Text color="textMuted" style={{ fontSize: 16 }}>
            {isExpanded ? '⌄' : '›'}
          </Text>
        </View>
      </Pressable>

      {isExpanded ? (
        <View
          style={{
            borderTopColor: theme.colors.border,
            borderTopWidth: 1,
            padding: theme.space.md,
            paddingTop: theme.space.xs
          }}
          testID={`tool-body-${item.id}`}
        >
          {item.outputRisk ? (
            <View
              style={{
                backgroundColor: theme.colors.surface,
                borderColor: theme.colors.danger,
                borderRadius: theme.radii.md,
                borderWidth: 1,
                gap: 2,
                marginTop: theme.space.sm,
                padding: theme.space.sm
              }}
              testID={`tool-risk-${item.id}`}
            >
              <Text color="danger" style={{ fontSize: 12, fontWeight: '600' }}>
                {`${chatStrings.tool.riskTitle} · ${item.outputRisk.risk}`}
              </Text>
              {item.outputRisk.findings.map((finding, index) => (
                <Text color="textMuted" key={index} style={{ fontSize: 12 }}>
                  {`• ${finding}`}
                </Text>
              ))}
              {item.outputRisk.redacted ? (
                <Text color="textMuted" style={{ fontSize: 11 }}>
                  {chatStrings.tool.redacted}
                </Text>
              ) : null}
            </View>
          ) : null}

          {rows.length ? (
            <>
              <SectionLabel>{chatStrings.tool.arguments}</SectionLabel>
              {rows.map(row => (
                <View key={row.key} style={{ marginTop: theme.space.xs }}>
                  <Text color="textMuted" style={{ fontSize: 11 }}>
                    {row.key}
                  </Text>
                  <Truncatable testID={`tool-arg-${item.id}-${row.key}`} value={row.value} />
                </View>
              ))}
            </>
          ) : null}

          {item.inlineDiff ? <DiffView diff={item.inlineDiff} testID={`tool-diff-${item.id}`} /> : null}

          {failed ? (
            <>
              <SectionLabel>{chatStrings.tool.failed}</SectionLabel>
              <Text color="danger" selectable style={{ fontSize: 13, lineHeight: 19 }}>
                {errorText}
              </Text>
            </>
          ) : null}

          {!failed && resultSummary ? (
            <>
              <SectionLabel>{chatStrings.tool.result}</SectionLabel>
              <Text color="text" selectable style={{ fontSize: 13, lineHeight: 19 }}>
                {resultSummary}
              </Text>
            </>
          ) : null}

          {!failed && !resultSummary && !item.resultKnown && !running ? (
            <Text color="textMuted" style={{ fontSize: 12, marginTop: theme.space.sm }}>
              {chatStrings.tool.noResult}
            </Text>
          ) : null}

          {item.argsText ? (
            <>
              <SectionLabel>{chatStrings.tool.rawArguments}</SectionLabel>
              <Truncatable testID={`tool-args-text-${item.id}`} value={item.argsText} />
            </>
          ) : null}

          {item.resultText ? (
            <>
              <SectionLabel>{chatStrings.tool.rawResult}</SectionLabel>
              <Truncatable testID={`tool-result-text-${item.id}`} value={item.resultText} />
            </>
          ) : null}
        </View>
      ) : null}
    </View>
  )
}
