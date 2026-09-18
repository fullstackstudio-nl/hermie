import AsyncStorage from '@react-native-async-storage/async-storage'

import type { SecretStore } from './secret-store'

// expo-secure-store has no verified macOS implementation for the react-native-macos
// runtime, so this variant keeps the app usable while that verification is open.
// It is NOT a security equivalent: values are cached in memory for the session and
// mirrored into AsyncStorage, which is an unencrypted file in the app container.
// Until a keychain-backed implementation replaces it, a macOS build must be treated
// as a development build. docs/platform-notes.md tracks the state of that work.
const PREFIX = 'hermie.insecure-secret.'

const memory = new Map<string, string>()

export const secretStore: SecretStore = {
  async get(key) {
    const cached = memory.get(key)
    if (cached !== undefined) {
      return cached
    }
    const stored = await AsyncStorage.getItem(PREFIX + key)
    if (stored !== null) {
      memory.set(key, stored)
    }
    return stored
  },
  async set(key, value) {
    memory.set(key, value)
    await AsyncStorage.setItem(PREFIX + key, value)
  },
  async delete(key) {
    memory.delete(key)
    await AsyncStorage.removeItem(PREFIX + key)
  }
}
