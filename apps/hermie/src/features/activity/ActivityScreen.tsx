import { View } from 'react-native'

import { Screen, Text } from '../../ui/primitives'
import { useTheme } from '../../ui/theme'

export function ActivityScreen() {
  const theme = useTheme()

  return (
    <Screen>
      <View style={{ flex: 1, justifyContent: 'center', gap: theme.space.sm }}>
        <Text variant="display">Activity</Text>
        <Text color="textMuted">Bot-to-bot traffic and running subagents land with M4.</Text>
      </View>
    </Screen>
  )
}
