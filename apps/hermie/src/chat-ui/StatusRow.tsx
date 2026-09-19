/**
 * A transient one-liner from `status.update` — compaction, lifecycle, a
 * background process. Centred and quiet: it is weather, not a message.
 */
import { View } from 'react-native'

import { Text } from '../ui/primitives'
import { useTheme } from '../ui/theme'
import { Chip } from './primitives/Chip'
import type { Presentation, StatusItem } from './types'

export interface StatusRowProps {
  item: StatusItem
  presentation?: Presentation
}

export function StatusRow({ item, presentation = 'chip' }: StatusRowProps) {
  const theme = useTheme()

  if (presentation === 'hidden-placeholder') {
    return null
  }

  if (presentation === 'chip') {
    return <Chip centered label={item.text} testID={`status-${item.id}`} />
  }

  return (
    <View style={{ alignItems: 'center', marginVertical: theme.space.xs }} testID={`status-${item.id}`}>
      <Text color="textMuted" style={{ fontSize: 11, letterSpacing: 0.4 }}>
        {item.statusKind.toUpperCase()}
      </Text>
      <Text color="textMuted" style={{ fontSize: 12, textAlign: 'center' }}>
        {item.text}
      </Text>
    </View>
  )
}
