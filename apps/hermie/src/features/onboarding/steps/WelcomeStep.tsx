import { View } from 'react-native'

import { strings } from '../../../i18n/strings'
import { Text } from '../../../ui/primitives'
import { useTheme } from '../../../ui/theme'

export function WelcomeStep() {
  const theme = useTheme()

  return (
    <View style={{ gap: theme.space.lg, paddingTop: theme.space.xxl }}>
      <Text variant="display">{strings.onboarding.welcome.title}</Text>
      <Text color="textMuted">{strings.onboarding.welcome.body}</Text>
      <Text variant="caption" color="textMuted">
        {strings.onboarding.welcome.note}
      </Text>
    </View>
  )
}
