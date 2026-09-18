import { View } from 'react-native'

import { Screen, Text } from '../../ui/primitives'
import { useTheme } from '../../ui/theme'

export type ChatScreenProps = {
  route?: { params?: { bot?: string } }
}

export function ChatScreen({ route }: ChatScreenProps) {
  const theme = useTheme()
  const bot = route?.params?.bot

  return (
    <Screen>
      <View style={{ flex: 1, justifyContent: 'center', gap: theme.space.sm }}>
        <Text variant="display">{bot ?? 'Chat'}</Text>
        <Text color="textMuted">The transcript, the composer, tool cards and the approval sheets land with M3.</Text>
      </View>
    </Screen>
  )
}
