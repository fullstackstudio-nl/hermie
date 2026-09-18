import AsyncStorage from '@react-native-async-storage/async-storage'

/**
 * Storage for non-secret configuration: the gateway URL, per-chat display
 * preferences, the last selected bot. Anything sensitive belongs in the
 * SecretStore instead.
 */
export type KeyValueStore = {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
  getJson<T>(key: string): Promise<T | null>
  setJson(key: string, value: unknown): Promise<void>
}

export const keyValueStore: KeyValueStore = {
  async get(key) {
    return AsyncStorage.getItem(key)
  },
  async set(key, value) {
    await AsyncStorage.setItem(key, value)
  },
  async delete(key) {
    await AsyncStorage.removeItem(key)
  },
  async getJson<T>(key: string) {
    const raw = await AsyncStorage.getItem(key)
    if (raw === null) {
      return null
    }
    try {
      return JSON.parse(raw) as T
    } catch {
      // A value written by an older build is not worth crashing over.
      await AsyncStorage.removeItem(key)
      return null
    }
  },
  async setJson(key, value) {
    await AsyncStorage.setItem(key, JSON.stringify(value))
  }
}
