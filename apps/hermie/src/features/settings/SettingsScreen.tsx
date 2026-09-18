import { View } from 'react-native'

import { Screen, Text } from '../../ui/primitives'
import { useTheme } from '../../ui/theme'

export function SettingsScreen() {
  const theme = useTheme()

  return (
    <Screen>
      <View style={{ flex: 1, justifyContent: 'center', gap: theme.space.sm }}>
        <Text variant="display">Settings</Text>
        <Text color="textMuted">Gateway details, chat defaults and appearance land with M2 and M3.</Text>
      </View>
    </Screen>
  )
}
