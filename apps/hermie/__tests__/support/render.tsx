import { render } from '@testing-library/react-native'
import type { ReactElement } from 'react'
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context'

import { ThemeProvider } from '../../src/ui/theme'

// react-native-safe-area-context measures a real view, which a test renderer
// never lays out; these are an iPhone 17 Pro's numbers.
const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 402, height: 874 },
  insets: { top: 59, left: 0, right: 0, bottom: 34 }
}

/**
 * The providers every screen assumes are above it.
 *
 * Exported separately because `rerender` replaces the WHOLE tree, providers
 * included: `view.rerender(<Thing />)` drops the safe-area provider on the
 * floor and the next render throws "No safe area value available".
 */
export function withProviders(ui: ReactElement) {
  return (
    <SafeAreaProvider initialMetrics={METRICS}>
      <ThemeProvider>{ui}</ThemeProvider>
    </SafeAreaProvider>
  )
}

/** Render a screen with the providers every screen assumes are above it. */
export function renderScreen(ui: ReactElement) {
  return render(withProviders(ui))
}

export function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })

  return { promise, resolve, reject }
}
