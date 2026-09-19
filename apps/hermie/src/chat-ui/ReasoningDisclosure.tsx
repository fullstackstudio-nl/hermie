/**
 * "Thought for 4s" — a collapsed disclosure above a reply.
 *
 * Collapsed by default on purpose: reasoning is context for the answer, not
 * the answer, and the default verbosity hides it altogether.
 */
import { useState } from 'react'
import { Pressable, View } from 'react-native'

import { Text } from '../ui/primitives'
import { useTheme } from '../ui/theme'
import { chatStrings } from './strings'

export interface ReasoningDisclosureProps {
  text: string
  /** Wall-clock seconds the model spent thinking, when the gateway sent one. */
  durationS?: number
  /** Still arriving: the row says "Thinking" and shows no duration. */
  streaming?: boolean
  initialExpanded?: boolean
  testID?: string
}

export function ReasoningDisclosure({
  text,
  durationS,
  streaming = false,
  initialExpanded = false,
  testID
}: ReasoningDisclosureProps) {
  const theme = useTheme()
  const [expanded, setExpanded] = useState(initialExpanded)

  if (!text.trim() && !streaming) {
    return null
  }

  const label = streaming
    ? chatStrings.assistant.thinking
    : chatStrings.assistant.thoughtFor(Math.max(1, Math.round(durationS ?? 0)))

  return (
    <View style={{ marginBottom: theme.space.xs }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded(current => !current)}
        style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
        testID={testID}
      >
        <View style={{ alignItems: 'center', flexDirection: 'row', gap: theme.space.xs }}>
          <Text color="textMuted" variant="caption">
            {label}
          </Text>
          <Text color="textMuted" variant="caption">
            {expanded ? '⌄' : '›'}
          </Text>
        </View>
      </Pressable>

      {expanded && text.trim() ? (
        <Text color="textMuted" selectable style={{ fontSize: 14, lineHeight: 20, marginTop: theme.space.xs }}>
          {text}
        </Text>
      ) : null}
    </View>
  )
}
