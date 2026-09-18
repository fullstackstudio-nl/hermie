import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useMemo } from 'react'

import { SafeArea } from '../platform/safe-area'
import { ThemeProvider } from '../ui/theme'
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
          <Shell />
        </ThemeProvider>
      </QueryClientProvider>
    </SafeArea>
  )
}
