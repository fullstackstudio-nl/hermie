import { View } from 'react-native'

import { Screen, Text } from '../../ui/primitives'
import { useTheme } from '../../ui/theme'

export function OnboardingScreen() {
  const theme = useTheme()

  return (
    <Screen>
      <View style={{ flex: 1, justifyContent: 'center', gap: theme.space.sm }}>
        <Text variant="display">Connect a gateway</Text>
        <Text color="textMuted">
          Hermie talks to one Hermes gateway at a time. The setup wizard asks for its address, signs you in and verifies
          the connection before anything is stored.
        </Text>
      </View>
    </Screen>
  )
}
