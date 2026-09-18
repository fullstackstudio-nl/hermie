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

// react-native-webview reaches for its native module at import time, which is
// the one thing a test renderer cannot provide. The stand-in keeps the props so
// a test can assert on how the web view was configured.
jest.mock('react-native-webview', () => {
  const React = require('react')

  return {
    WebView: props => React.createElement('RNCWebView', props)
  }
})
