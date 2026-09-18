import { useState } from 'react'
import { View } from 'react-native'

import { Button, Screen, Text } from '../../ui/primitives'
import { useTheme } from '../../ui/theme'
import { DebugConnectionScreen } from './DebugConnectionScreen'

export function SettingsScreen() {
  const theme = useTheme()
  const [showConnectionTest, setShowConnectionTest] = useState(false)

  if (showConnectionTest) {
    return <DebugConnectionScreen onClose={() => setShowConnectionTest(false)} />
  }

  return (
    <Screen>
      <View style={{ flex: 1, justifyContent: 'center', gap: theme.space.sm }}>
        <Text variant="display">Settings</Text>
        <Text color="textMuted">Gateway details, chat defaults and appearance land with M2 and M3.</Text>
        <Text variant="caption" color="textMuted" style={{ marginTop: theme.space.lg }}>
          DEVELOPER
        </Text>
        <Button title="Connection test" variant="secondary" onPress={() => setShowConnectionTest(true)} />
      </View>
    </Screen>
  )
}
