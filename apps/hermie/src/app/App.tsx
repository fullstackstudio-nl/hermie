import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useMemo } from 'react'
import { ActivityIndicator, View } from 'react-native'

import { ChatRuntimeProvider } from '../features/chats'
import { OnboardingNavigator } from '../features/onboarding'
import { GatewayProvider, useGateway } from '../gateway'
import { strings } from '../i18n/strings'
import { SafeArea } from '../platform/safe-area'
import { Screen, Text } from '../ui/primitives'
import { ThemeProvider, useTheme } from '../ui/theme'
import { Shell } from './Shell'

export default function App() {
  // One client for the app's lifetime; refetching is driven by gateway events
  // rather than by focus or intervals.
  const queryClient = useMemo(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 30_000 }
        }
      }),
    []
  )

  return (
    <SafeArea>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <GatewayProvider>
            <Root />
          </GatewayProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </SafeArea>
  )
}

/**
 * Three states, decided by whether a gateway is configured and whether its
 * credentials are still there: the startup read, the wizard, and the app.
 */
function Root() {
  const { phase, resumeConfig, reload } = useGateway()

  if (phase === 'loading') {
    return <Booting />
  }

  if (phase === 'onboarding') {
    return <OnboardingNavigator resumeConfig={resumeConfig} onComplete={reload} />
  }

  // The chat runtime sits inside the `connected` branch on purpose: it owns the
  // subscriptions to the live connection, and there is no connection to
  // subscribe to until the gateway is configured.
  return (
    <ChatRuntimeProvider>
      <Shell />
    </ChatRuntimeProvider>
  )
}

function Booting() {
  const theme = useTheme()

  return (
    <Screen>
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: theme.space.md }}>
        <ActivityIndicator />
        <Text color="textMuted">{strings.app.loading}</Text>
      </View>
    </Screen>
  )
}
