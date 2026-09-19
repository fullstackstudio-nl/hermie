import { NavigationContainer, useNavigation } from '@react-navigation/native'
import { createNativeStackNavigator, type NativeStackNavigationProp } from '@react-navigation/native-stack'
import { Pressable } from 'react-native'

import { BotsScreen } from '../features/bots'
import { ChatScreen } from '../features/chats'
import { CronScreen } from '../features/cron'
import { SettingsScreen } from '../features/settings'
import { useBotsStore } from '../store'
import { Text } from '../ui/primitives'
import { useTheme } from '../ui/theme'

export type CompactStackParamList = {
  Bots: undefined
  Chat: { bot: string }
  Cron: undefined
  Settings: undefined
}

const Stack = createNativeStackNavigator<CompactStackParamList>()

/** The only way into Settings on a phone; the regular shell has a sidebar instead. */
function SettingsLink() {
  const navigation = useNavigation<NativeStackNavigationProp<CompactStackParamList>>()

  return (
    <Pressable accessibilityRole="button" onPress={() => navigation.navigate('Settings')} hitSlop={8}>
      <Text variant="callout" color="accent">
        Settings
      </Text>
    </Pressable>
  )
}

function BotsRoute() {
  const navigation = useNavigation<NativeStackNavigationProp<CompactStackParamList>>()

  return <BotsScreen onOpenBot={bot => navigation.navigate('Chat', { bot: bot.name })} />
}

/** The header shows the bot's display name, which is not always its profile name. */
function useChatTitle(botName: string | undefined): string {
  return useBotsStore(state => (botName ? (state.byName[botName]?.displayName ?? botName) : 'Chat'))
}

function ChatTitle({ bot }: { bot: string | undefined }) {
  const title = useChatTitle(bot)

  return <Text variant="heading">{title}</Text>
}

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
        <Stack.Screen
          name="Bots"
          component={BotsRoute}
          options={{ title: 'Bots', headerRight: () => <SettingsLink /> }}
        />
        <Stack.Screen
          name="Chat"
          component={ChatScreen}
          options={({ route }) => ({
            title: route.params?.bot ?? 'Chat',
            headerTitle: () => <ChatTitle bot={route.params?.bot} />
          })}
        />
        <Stack.Screen name="Cron" component={CronScreen} options={{ title: 'Routines' }} />
        <Stack.Screen name="Settings" component={SettingsScreen} options={{ title: 'Settings' }} />
      </Stack.Navigator>
    </NavigationContainer>
  )
}
