/**
 * `Today`, `Yesterday`, `Tue 16 September` — the date stamp between two days of
 * conversation.
 *
 * Centred, in the micro type (uppercase, tracked out), on nothing: a pill behind
 * it would be a fourth surface in the transcript and the stamp is read once per
 * screenful at most. Which stamp goes where is `grouping.ts`'s answer, not this
 * component's.
 */
import { View } from 'react-native'

import { Text } from '../ui/primitives'
import { useTheme } from '../ui/theme'

export interface DateSeparatorProps {
  label: string
  testID?: string
}

export function DateSeparator({ label, testID }: DateSeparatorProps) {
  const theme = useTheme()

  return (
    <View
      accessibilityRole="header"
      style={{ alignItems: 'center', paddingBottom: theme.space.sm, paddingTop: theme.space.lg }}
      testID={testID}
    >
      <Text color="textFaint" variant="micro">
        {label.toUpperCase()}
      </Text>
    </View>
  )
}
