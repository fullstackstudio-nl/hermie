import {
  DefaultTheme,
  NavigationContainer,
  useNavigation,
  useNavigationContainerRef,
  type Theme as NavTheme
} from '@react-navigation/native'
import { createNativeStackNavigator, type NativeStackNavigationProp } from '@react-navigation/native-stack'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { DevInitialView } from '../dev'
import { ActivityScreen } from '../features/activity'
import { BotsScreenOrSignedOut, type BotsSection } from '../features/bots'
import { ChatScreen } from '../features/chats'
import { CronScreen } from '../features/cron'
import { SettingsScreen } from '../features/settings'
import { requestIntentRun } from '../features/intents'
import { requestShareDelivery } from '../features/share'
import { strings } from '../i18n/strings'
import { useHermieLink } from '../platform/deep-link'
import { usePageTitle } from '../platform/page-title'
import { onOpenChatRequest } from './open-chat-bus'
import { useBotDisplayName } from '../store/bots'
import { GlassSurface, Wallpaper } from '../ui/glass'
import { useTheme } from '../ui/theme'
import { useShortcut } from '../ui/useShortcut'

export type CompactStackParamList = {
  Bots: undefined
  Chat: { bot: string; focusItemId?: string; findText?: string }
  Activity: undefined
  Cron: { jobId?: string; create?: boolean } | undefined
  Settings: undefined
}

const Stack = createNativeStackNavigator<CompactStackParamList>()

const SECTION_ROUTES: Record<BotsSection, keyof CompactStackParamList> = {
  activity: 'Activity',
  cron: 'Cron',
  settings: 'Settings'
}

/**
 * What a route is CALLED, as opposed to what it is keyed by.
 *
 * `Bots` is the key of the screen whose header says Chats, and a browser tab
 * that says `Bots` is the source leaking into the window.
 *
 * The chat route answers with a `bot` rather than a title, because the handle
 * in its params (`researcher`) is not the label a person reads (`Researcher`)
 * and resolving one to the other needs the store — which a plain function has
 * no business reaching into. The caller does that.
 */
function screenNameOf(route: { name: string; params?: object } | undefined): {
  title?: string
  bot?: string
} {
  switch (route?.name) {
    case 'Bots':
      return { title: strings.tabs.chats }
    case 'Chat': {
      const bot = (route.params as CompactStackParamList['Chat'] | undefined)?.bot

      return bot ? { bot } : { title: strings.tabs.chats }
    }
    case 'Activity':
      return { title: strings.tabs.activity }
    case 'Cron':
      return { title: strings.tabs.routines }
    case 'Settings':
      return { title: strings.tabs.settings }
    default:
      return {}
  }
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
        onOpenSection={(section, options) =>
          navigation.navigate(SECTION_ROUTES[section] as 'Cron', options?.create ? { create: true } : undefined)
        }
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

  // Neither of the other two link kinds carries a destination of its own. The
  // share sheet and the Shortcut have each already written their request into
  // the shared container, and the id in the URL is only there so that the tap
  // arrives as a pump rather than as a foreground three seconds later — both
  // readers work from the directory, not from the link.
  useHermieLink(link => {
    if (link.kind === 'chat') {
      openChat(link.bot)
    } else if (link.kind === 'share') {
      requestShareDelivery()
    } else {
      requestIntentRun()
    }
  })

  // The same destination from a notification. `PushSync` sits beside the chat
  // controller and cannot know which shell is mounted, so it asks through the
  // bus rather than navigating — see `app/open-chat-bus.ts`.
  useEffect(() => onOpenChatRequest(openChat), [openChat])

  // The browser tab's name follows the route that is actually on top. Held as
  // state rather than read during render because the container only answers
  // `getCurrentRoute` once it is ready, which is after the first mount.
  const [screen, setScreen] = useState<{ title?: string; bot?: string }>({})
  const botLabel = useBotDisplayName(screen.bot)

  usePageTitle(screen.bot ? botLabel : screen.title)

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
        /*
         * The navigator's own web titling is switched OFF. It runs whether or
         * not it was asked to and defaults to the route KEY, which is how a tab
         * came to say `Bots` for the screen headed Chats; `usePageTitle` above
         * is the one answer instead, and it works in the shell that has no
         * navigator too.
         */
        documentTitle={{ enabled: false }}
        onReady={() => {
          setScreen(screenNameOf(navigationRef.getCurrentRoute()))

          const botName = pendingBot.current
          pendingBot.current = null

          if (botName) {
            navigationRef.navigate('Chat', { bot: botName })
          }
        }}
        onStateChange={() => setScreen(screenNameOf(navigationRef.getCurrentRoute()))}
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
            {({ route }: { route: { params?: { jobId?: string; create?: boolean } } }) => (
              <CronScreen
                {...(route.params?.jobId ? { initialJobId: route.params.jobId } : {})}
                {...(route.params?.create ? { initialCreate: true } : {})}
              />
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
