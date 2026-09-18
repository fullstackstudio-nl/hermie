import * as SecureStore from 'expo-secure-store'

/**
 * Storage for values that must never land in a plain-text preference file:
 * access and refresh tokens, the ungated session token, and any extra request
 * headers the operator configured.
 */
export type SecretStore = {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}

// Hermie reconnects from the background, so the keychain item has to survive a
// locked screen after the first unlock. It is deliberately not synced to iCloud
// and not migrated to a new device: a gateway is re-authenticated per device.
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY
}

export const secretStore: SecretStore = {
  async get(key) {
    return SecureStore.getItemAsync(key, OPTIONS)
  },
  async set(key, value) {
    await SecureStore.setItemAsync(key, value, OPTIONS)
  },
  async delete(key) {
    await SecureStore.deleteItemAsync(key, OPTIONS)
  }
}
