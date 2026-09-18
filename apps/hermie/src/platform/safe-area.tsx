import type { ReactNode } from 'react'
import { SafeAreaProvider } from 'react-native-safe-area-context'

export function SafeArea({ children }: { children: ReactNode }) {
  return <SafeAreaProvider>{children}</SafeAreaProvider>
}

export { useSafeAreaInsets } from 'react-native-safe-area-context'
