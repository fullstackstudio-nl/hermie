import type { ReactNode } from 'react'

// A macOS window has no notch, no home indicator and no rotation, so the safe
// area is always zero and react-native-safe-area-context — which ships no macOS
// implementation — is not needed. Keeping the same shape means screens do not
// have to branch on the platform.
const ZERO_INSETS = { top: 0, right: 0, bottom: 0, left: 0 } as const

export function SafeArea({ children }: { children: ReactNode }) {
  return children
}

export function useSafeAreaInsets() {
  return ZERO_INSETS
}
