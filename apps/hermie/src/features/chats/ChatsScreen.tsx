import { View } from 'react-native'

import { Screen, Text } from '../../ui/primitives'
import { useTheme } from '../../ui/theme'

export function ChatsScreen() {
  const theme = useTheme()

  return (
    <Screen>
      <View style={{ flex: 1, justifyContent: 'center', gap: theme.space.sm }}>
        <Text variant="display">Bots</Text>
        <Text color="textMuted">Every bot on the gateway gets one canonical Bot Chat. The list lands with M3.</Text>
      </View>
    </Screen>
  )
}
