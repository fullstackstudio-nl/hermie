import { View } from 'react-native'

import { Screen, Text } from '../../ui/primitives'
import { useTheme } from '../../ui/theme'

export function CronScreen() {
  const theme = useTheme()

  return (
    <Screen>
      <View style={{ flex: 1, justifyContent: 'center', gap: theme.space.sm }}>
        <Text variant="display">Routines</Text>
        <Text color="textMuted">Scheduled prompts and their run history land with M6.</Text>
      </View>
    </Screen>
  )
}
