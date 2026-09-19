import { DefaultTheme, NavigationContainer, useNavigation, type Theme as NavTheme } from '@react-navigation/native'
import { createNativeStackNavigator, type NativeStackNavigationProp } from '@react-navigation/native-stack'
import { useMemo } from 'react'

import { ActivityScreen } from '../features/activity'
import { BotsScreenOrSignedOut, type BotsSection } from '../features/bots'
import { ChatScreen } from '../features/chats'
import { CronScreen } from '../features/cron'
import { SettingsScreen } from '../features/settings'
import { strings } from '../i18n/strings'
import { GlassSurface, Wallpaper } from '../ui/glass'
import { useTheme } from '../ui/theme'

export type CompactStackParamList = {
  Bots: undefined
  Chat: { bot: string; focusItemId?: string }
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

  // Full-bleed rather than floating: at 393pt there is no room to spend 14pt on
  // each side proving the panel floats, and the mockup's phone frame draws the
  // same panel with its corners squared off.
  return (
    <GlassSurface contentStyle={{ flex: 1 }} radius={0} shadow="none" style={{ flex: 1 }} variant="panel">
      <BotsScreenOrSignedOut
        onOpenBot={bot => navigation.navigate('Chat', { bot: bot.name })}
        onOpenSection={section => navigation.navigate(SECTION_ROUTES[section] as 'Settings')}
      />
    </GlassSurface>
  )
}

function ChatRoute({
  route,
  navigation
}: {
  route: { params?: { bot?: string; focusItemId?: string } }
  navigation: NativeStackNavigationProp<CompactStackParamList>
}) {
  return (
    <ChatScreen
      onBack={() => navigation.goBack()}
      // Pushed rather than replaced: following a DM across chats is a path, and
      // Back has to walk it in reverse.
      onOpenBot={(bot, options) =>
        navigation.push('Chat', { bot, ...(options?.focusItemId ? { focusItemId: options.focusItemId } : {}) })
      }
      route={route}
    />
  )
}

function ActivityRoute() {
  const navigation = useNavigation<NativeStackNavigationProp<CompactStackParamList>>()

  return (
    <ActivityScreen
      onOpenBot={(bot, options) =>
        navigation.navigate('Chat', { bot, ...(options?.focusItemId ? { focusItemId: options.focusItemId } : {}) })
      }
    />
  )
}

/**
 * The phone stack.
 *
 * Same visual language as the wide layout — the wallpaper is drawn once, behind
 * the whole navigator, and every screen is transparent over it, so a push does
 * not slide one background over another. The list is a full-bleed panel rather
 * than a floating one, which is what the mockup's phone frame shows: at 393pt
 * there is no room to spend 14pt on each side proving the panel floats.
 *
 * The chat route hides the stack's own header rather than configuring it: the
 * chat header carries an avatar, a live subtitle and the options button, and a
 * native title bar can carry none of those. Every other route keeps the
 * platform header.
 */
export function CompactShell() {
  const theme = useTheme()

  // A navigator paints its own background over everything, including the
  // wallpaper, unless both the container theme and the screen say otherwise.
  const navTheme = useMemo<NavTheme>(
    () => ({
      ...DefaultTheme,
      dark: theme.scheme === 'dark',
      colors: {
        ...DefaultTheme.colors,
        background: 'transparent',
        border: theme.colors.border,
        card: theme.elevation.e1,
        primary: theme.colors.accent,
        text: theme.colors.text
      }
    }),
    [theme]
  )

  // The navigation container lives with the stack rather than at the root,
  // because the regular shell has no navigator at all.
  return (
    <Wallpaper style={{ flex: 1 }} testID="wallpaper">
      <NavigationContainer theme={navTheme}>
        <Stack.Navigator
          screenOptions={{
            contentStyle: { backgroundColor: 'transparent' },
            headerStyle: { backgroundColor: theme.elevation.e1 },
            headerTintColor: theme.colors.text
          }}
        >
          <Stack.Screen component={BotsRoute} name="Bots" options={{ headerShown: false }} />
          <Stack.Screen component={ChatRoute} name="Chat" options={{ headerShown: false }} />
          <Stack.Screen component={ActivityRoute} name="Activity" options={{ title: strings.tabs.activity }} />
          <Stack.Screen component={CronScreen} name="Cron" options={{ title: strings.tabs.routines }} />
          <Stack.Screen component={SettingsScreen} name="Settings" options={{ title: strings.tabs.settings }} />
        </Stack.Navigator>
      </NavigationContainer>
    </Wallpaper>
  )
}
