import {
  DefaultTheme,
  NavigationContainer,
  useNavigation,
  useNavigationContainerRef,
  type Theme as NavTheme
} from '@react-navigation/native'
import { createNativeStackNavigator, type NativeStackNavigationProp } from '@react-navigation/native-stack'
import { useCallback, useMemo, useRef } from 'react'

import type { DevInitialView } from '../dev'
import { ActivityScreen } from '../features/activity'
import { BotsScreenOrSignedOut, type BotsSection } from '../features/bots'
import { ChatScreen } from '../features/chats'
import { CronScreen } from '../features/cron'
import { SettingsScreen } from '../features/settings'
import { strings } from '../i18n/strings'
import { useHermieLink } from '../platform/deep-link'
import { GlassSurface, Wallpaper } from '../ui/glass'
import { useTheme } from '../ui/theme'
import { useShortcut } from '../ui/useShortcut'

export type CompactStackParamList = {
  Bots: undefined
  Chat: { bot: string; focusItemId?: string; findText?: string }
  Activity: undefined
  Cron: { jobId?: string } | undefined
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

  // ⌘, from a hardware keyboard, which an iPad in a case has as readily as a Mac.
  // Registered on the chat list rather than on the navigator because this is the
  // route that is always in the stack, so the shortcut cannot be shadowed by a
  // screen that happens to be on top of it.
  useShortcut('settings', () => navigation.navigate('Settings'))

  // Full-bleed rather than floating: at 393pt there is no room to spend 14pt on
  // each side proving the panel floats, and the mockup's phone frame draws the
  // same panel with its corners squared off.
  return (
    <GlassSurface contentStyle={{ flex: 1 }} radius={0} shadow="none" style={{ flex: 1 }} variant="panel">
      <BotsScreenOrSignedOut
        onOpenBot={(bot, options) =>
          navigation.navigate('Chat', {
            bot: bot.name,
            ...(options?.findText ? { findText: options.findText } : {})
          })
        }
        onOpenSection={section => navigation.navigate(SECTION_ROUTES[section] as 'Settings')}
      />
    </GlassSurface>
  )
}

function ChatRoute({
  route,
  navigation
}: {
  route: { params?: { bot?: string; focusItemId?: string; findText?: string } }
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
      // A cron card in the transcript pushes the Crons route straight onto that
      // cron's detail. Pushed rather than navigated: Back belongs to the chat the
      // card was in.
      onOpenCron={jobId => navigation.push('Cron', { jobId })}
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
export function CompactShell({ initial }: { initial?: DevInitialView } = {}) {
  const theme = useTheme()
  const navigationRef = useNavigationContainerRef<CompactStackParamList>()

  /**
   * `hermie://chat/<bot>`, from a home-screen widget.
   *
   * Through the container ref rather than a `linking` config on the navigator,
   * and the reason is the wide layout: `RegularShell` has no navigator at all,
   * so a link that only worked through React Navigation's own linking would
   * work on a phone and silently do nothing on an iPad or a Mac. One parser and
   * one hook (`platform/deep-link`) is what the two shells share instead.
   *
   * `navigate` and not `push`: a widget names a chat, and tapping the same
   * widget twice should land on that chat rather than build a stack of it.
   *
   * A cold start is the case that needs the parking space. The link is read
   * during the first mount, and the container is not ready until after it — so a
   * link that arrives before `onReady` is held and replayed there rather than
   * dropped, which is exactly the launch a widget tap on a closed app produces.
   */
  const pendingBot = useRef<string | null>(null)

  const openChat = useCallback(
    (botName: string) => {
      if (navigationRef.isReady()) {
        navigationRef.navigate('Chat', { bot: botName })

        return
      }

      pendingBot.current = botName
    },
    [navigationRef]
  )

  useHermieLink(link => openChat(link.bot))

  // A navigator paints its own background over everything, including the
  // wallpaper, unless both the container theme and the screen say otherwise.
  const navTheme = useMemo<NavTheme>(
    () => ({
      ...DefaultTheme,
      dark: theme.scheme === 'dark',
      colors: {
        ...DefaultTheme.colors,
        background: 'transparent',
        border: theme.hairline,
        card: theme.elevation.e1,
        primary: theme.colors.accentText,
        text: theme.colors.text
      }
    }),
    [theme]
  )

  // The navigation container lives with the stack rather than at the root,
  // because the regular shell has no navigator at all.
  return (
    <Wallpaper style={{ flex: 1 }} testID="wallpaper">
      <NavigationContainer
        onReady={() => {
          const botName = pendingBot.current
          pendingBot.current = null

          if (botName) {
            navigationRef.navigate('Chat', { bot: botName })
          }
        }}
        ref={navigationRef}
        theme={navTheme}
      >
        <Stack.Navigator
          // A launch argument puts one route in the stack rather than pushing
          // onto Bots: a screenshot wants the screen, not a back button to a
          // list nobody asked for.
          initialRouteName={initialRouteFor(initial)}
          screenOptions={{
            contentStyle: { backgroundColor: 'transparent' },
            headerStyle: { backgroundColor: theme.elevation.e1 },
            headerTintColor: theme.colors.text
          }}
        >
          <Stack.Screen component={BotsRoute} name="Bots" options={{ headerShown: false }} />
          <Stack.Screen
            component={ChatRoute}
            initialParams={initial?.bot ? { bot: initial.bot } : undefined}
            name="Chat"
            options={{ headerShown: false }}
          />
          <Stack.Screen component={ActivityRoute} name="Activity" options={{ title: strings.tabs.activity }} />
          <Stack.Screen name="Cron" options={{ title: strings.tabs.routines }}>
            {({ route }: { route: { params?: { jobId?: string } } }) => (
              <CronScreen {...(route.params?.jobId ? { initialJobId: route.params.jobId } : {})} />
            )}
          </Stack.Screen>
          <Stack.Screen name="Settings" options={{ title: strings.tabs.settings }}>
            {() => <SettingsScreen {...(initial?.page ? { initialPage: initial.page } : {})} />}
          </Stack.Screen>
        </Stack.Navigator>
      </NavigationContainer>
    </Wallpaper>
  )
}

const SECTION_START: Record<string, keyof CompactStackParamList> = {
  activity: 'Activity',
  cron: 'Cron',
  settings: 'Settings'
}

function initialRouteFor(initial: DevInitialView | undefined): keyof CompactStackParamList {
  if (initial?.bot) {
    return 'Chat'
  }

  return (initial?.section && SECTION_START[initial.section]) || 'Bots'
}
