import { NavigationContainer } from '@react-navigation/native'
import { createNativeStackNavigator } from '@react-navigation/native-stack'

import { ChatScreen, ChatsScreen } from '../features/chats'
import { CronScreen } from '../features/cron'
import { SettingsScreen } from '../features/settings'
import { useTheme } from '../ui/theme'

export type CompactStackParamList = {
  Chats: undefined
  Chat: { bot: string }
  Cron: undefined
  Settings: undefined
}

const Stack = createNativeStackNavigator<CompactStackParamList>()

export function CompactShell() {
  const theme = useTheme()

  // The navigation container lives with the stack rather than at the root: the
  // regular shell has no navigator, and on macOS neither @react-navigation/native
  // nor react-native-screens should end up in the bundle at all.
  return (
    <NavigationContainer>
      <Stack.Navigator
        screenOptions={{
          headerStyle: { backgroundColor: theme.colors.surface },
          headerTintColor: theme.colors.text,
          contentStyle: { backgroundColor: theme.colors.bg }
        }}
      >
        <Stack.Screen name="Chats" component={ChatsScreen} options={{ title: 'Bots' }} />
        <Stack.Screen
          name="Chat"
          component={ChatScreen}
          options={({ route }) => ({ title: route.params?.bot ?? 'Chat' })}
        />
        <Stack.Screen name="Cron" component={CronScreen} options={{ title: 'Routines' }} />
        <Stack.Screen name="Settings" component={SettingsScreen} options={{ title: 'Settings' }} />
      </Stack.Navigator>
    </NavigationContainer>
  )
}
