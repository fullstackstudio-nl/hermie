/**
 * A system notice: a model switch, an auto-continue, a background process that
 * finished. Centred pill; tapping one with a body opens it.
 *
 * An `error` notice is the exception and stays a card, because it is the one
 * kind that survives every verbosity level.
 */
import { useState } from 'react'
import { Pressable, View } from 'react-native'

import { Text } from '../ui/primitives'
import { useTheme } from '../ui/theme'
import { Chip } from './primitives/Chip'
import type { NoticeItem, Presentation } from './types'

export interface NoticePillProps {
  item: NoticeItem
  presentation?: Presentation
}

export function NoticePill({ item, presentation = 'collapsed' }: NoticePillProps) {
  const theme = useTheme()
  const [expanded, setExpanded] = useState(presentation === 'full')

  if (presentation === 'hidden-placeholder') {
    return null
  }

  const error = item.noticeKind === 'error'
  const hasBody = Boolean(item.body?.trim())

  if (!error && presentation === 'chip') {
    return <Chip centered label={item.title} testID={`notice-${item.id}`} />
  }

  return (
    <View style={{ alignItems: 'center', marginVertical: theme.space.sm }} testID={`notice-${item.id}`}>
      <Pressable
        accessibilityRole={hasBody ? 'button' : undefined}
        accessibilityState={hasBody ? { expanded } : undefined}
        disabled={!hasBody}
        onPress={() => setExpanded(current => !current)}
        style={({ pressed }) => ({ maxWidth: '92%', opacity: pressed ? 0.7 : 1 })}
        testID={`notice-toggle-${item.id}`}
      >
        <View
          style={{
            backgroundColor: error ? theme.colors.surface : theme.colors.surfaceRaised,
            borderColor: error ? theme.colors.danger : 'transparent',
            borderRadius: error ? theme.radii.lg : theme.radii.pill,
            borderWidth: error ? 1 : 0,
            paddingHorizontal: theme.space.md,
            paddingVertical: theme.space.sm
          }}
        >
          <Text color={error ? 'danger' : 'textMuted'} style={{ fontSize: 12, textAlign: 'center' }}>
            {item.title}
          </Text>

          {expanded && hasBody ? (
            <Text
              color="textMuted"
              selectable
              style={{ fontSize: 12, lineHeight: 18, marginTop: theme.space.xs }}
              testID={`notice-body-${item.id}`}
            >
              {item.body}
            </Text>
          ) : null}
        </View>
      </Pressable>
    </View>
  )
}
