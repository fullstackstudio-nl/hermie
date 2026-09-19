/**
 * Native modules a test renderer has no implementation for. Each of these is a
 * real dependency of a screen under test, so the alternative to a shared mock is
 * the same three blocks at the top of every suite.
 */

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
)

jest.mock('@react-native-community/netinfo', () => require('@react-native-community/netinfo/jest/netinfo-mock.js'))

jest.mock('expo-secure-store', () => {
  const store = new Map()

  return {
    AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY',
    getItemAsync: jest.fn(async key => (store.has(key) ? store.get(key) : null)),
    setItemAsync: jest.fn(async (key, value) => {
      store.set(key, value)
    }),
    deleteItemAsync: jest.fn(async key => {
      store.delete(key)
    })
  }
})

/**
 * The glass stack. All three render native views, and two of them reach for a
 * native module the moment they are imported — `expo-glass-effect` throws
 * outright from `requireNativeModule`, which is exactly the case
 * `src/ui/glass/material.ts` catches in the app and which a test renderer would
 * otherwise hit on every import.
 *
 * The stand-ins keep the props, so a test can assert which material a surface
 * asked for. `isLiquidGlassAvailable` answers false, so the suite renders the
 * SOLID fallback — the one path that has to look right with no blur at all, and
 * the one whose colours are assertable.
 */
jest.mock('expo-glass-effect', () => {
  const React = require('react')

  return {
    GlassView: props => React.createElement('ExpoGlassView', props),
    GlassContainer: props => React.createElement('ExpoGlassContainer', props),
    isLiquidGlassAvailable: () => false,
    isGlassEffectAPIAvailable: () => false
  }
})

jest.mock('expo-blur', () => {
  const React = require('react')

  return { BlurView: props => React.createElement('ExpoBlurView', props) }
})

jest.mock('expo-linear-gradient', () => {
  const React = require('react')

  return { LinearGradient: props => React.createElement('ExpoLinearGradient', props) }
})

// react-native-webview reaches for its native module at import time, which is
// the one thing a test renderer cannot provide. The stand-in keeps the props so
// a test can assert on how the web view was configured.
jest.mock('react-native-webview', () => {
  const React = require('react')

  return {
    WebView: props => React.createElement('RNCWebView', props)
  }
})
