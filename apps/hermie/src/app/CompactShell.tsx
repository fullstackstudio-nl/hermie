import { NavigationContainer, useNavigation } from '@react-navigation/native'
import { createNativeStackNavigator, type NativeStackNavigationProp } from '@react-navigation/native-stack'

import { ActivityScreen } from '../features/activity'
import { BotsScreen, type BotsSection } from '../features/bots'
import { ChatScreen } from '../features/chats'
import { CronScreen } from '../features/cron'
import { SettingsScreen } from '../features/settings'
import { strings } from '../i18n/strings'
import { useTheme } from '../ui/theme'

export type CompactStackParamList = {
  Bots: undefined
  Chat: { bot: string }
  Activity: undefined
  Cron: undefined
  Settings: undefined
}

const Stack = createNativeStackNavigator<CompactStackParamList>()

const SECTION_ROUTES: Record<BotsSection, keyof CompactStackParamList> = {
  activity: 'Activity',
  cron: 'Cron',
  settings: 'Settings'
}

function BotsRoute() {
  const navigation = useNavigation<NativeStackNavigationProp<CompactStackParamList>>()

  return (
    <BotsScreen
      onOpenBot={bot => navigation.navigate('Chat', { bot: bot.name })}
      onOpenSection={section => navigation.navigate(SECTION_ROUTES[section] as 'Settings')}
    />
  )
}

function ChatRoute({
  route,
  navigation
}: {
  route: { params?: { bot?: string } }
  navigation: NativeStackNavigationProp<CompactStackParamList>
}) {
  return (
    <ChatScreen onBack={() => navigation.goBack()} onOpenBot={bot => navigation.push('Chat', { bot })} route={route} />
  )
}

/**
 * The phone stack.
 *
 * The chat route hides the stack's own header rather than configuring it: the
 * design board's chat header carries an avatar, a live subtitle and the options
 * button, and a native title bar can carry none of those. Every other route
 * keeps the platform header, so the only screen that draws its own is the one
 * that has a header component of its own.
 */
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
        <Stack.Screen component={BotsRoute} name="Bots" options={{ headerShown: false }} />
        <Stack.Screen component={ChatRoute} name="Chat" options={{ headerShown: false }} />
        <Stack.Screen component={ActivityScreen} name="Activity" options={{ title: strings.tabs.activity }} />
        <Stack.Screen component={CronScreen} name="Cron" options={{ title: strings.tabs.routines }} />
        <Stack.Screen component={SettingsScreen} name="Settings" options={{ title: strings.tabs.settings }} />
      </Stack.Navigator>
    </NavigationContainer>
  )
}
