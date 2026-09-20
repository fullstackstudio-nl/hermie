/**
 * What a launch can tell you when the credentials are not there any more.
 *
 * The owner was dropped back into the sign-in step three times in one day,
 * every time straight after `/Applications/Hermie.app` was replaced, and never
 * after a plain quit and relaunch. The gateway ADDRESS survived each time, so
 * the key-value store was intact and only the keychain came back empty.
 *
 * That shape is exactly what a changed keychain access group looks like, and
 * also exactly what a genuinely empty keychain looks like: `SecItemCopyMatching`
 * answers `errSecItemNotFound` for both, and `expo-secure-store` turns both into
 * `null`. The two can only be told apart by whether the read THREW, and nothing
 * used to write that down — so the investigation had to be done from first
 * principles rather than read off the ring.
 */
import { CONFIG_KEY, loadGatewaySetup, SECRET_KEYS } from '../src/gateway/config'
import { keyValueStore } from '../src/platform/key-value-store'
import { secretStore } from '../src/platform/secret-store'

jest.mock('../src/platform/secret-store', () => ({
  secretStore: {
    get: jest.fn(async () => null),
    set: jest.fn(async () => undefined),
    delete: jest.fn(async () => undefined)
  }
}))

jest.mock('../src/platform/key-value-store', () => ({
  keyValueStore: {
    get: jest.fn(async () => null),
    set: jest.fn(async () => undefined),
    delete: jest.fn(async () => undefined),
    getJson: jest.fn(async () => null),
    setJson: jest.fn(async () => undefined)
  }
}))

const CONFIG = {
  baseUrl: 'https://hermes.example.com',
  authMode: 'native_pkce' as const,
  provider: 'self-hosted',
  version: '2026.9.14'
}

beforeEach(() => {
  jest.clearAllMocks()
  ;(keyValueStore.getJson as jest.Mock).mockImplementation(async (key: string) => (key === CONFIG_KEY ? CONFIG : null))
})

describe('reading the stored credentials', () => {
  it('reports an empty keychain as empty, with nothing to explain', async () => {
    const setup = await loadGatewaySetup()

    expect(setup?.config.baseUrl).toBe('https://hermes.example.com')
    expect(setup?.hasCredentials).toBe(false)
    expect(setup?.credentialError).toBeUndefined()
  })

  it('reports a keychain that REFUSED, rather than swallowing it as empty', async () => {
    ;(secretStore.get as jest.Mock).mockRejectedValue(new Error('A required entitlement isn’t present.'))

    const setup = await loadGatewaySetup()

    // The address still survives, which is what puts the wizard on the sign-in
    // step rather than on the cover.
    expect(setup?.config.baseUrl).toBe('https://hermes.example.com')
    expect(setup?.hasCredentials).toBe(false)
    expect(setup?.credentialError).toMatch(/entitlement/)
  })

  it('never lets a throwing keychain strand the launch', async () => {
    ;(secretStore.get as jest.Mock).mockRejectedValue(new Error('keychain is locked'))

    // The whole point: this resolves. It used to reject, and the rejection
    // escaped an un-awaited `reload()` and left the app on the splash for ever.
    await expect(loadGatewaySetup()).resolves.not.toBeNull()
  })

  it('still reads a credential that IS there', async () => {
    ;(secretStore.get as jest.Mock).mockImplementation(async (key: string) =>
      key === SECRET_KEYS.accessToken ? 'access-1' : null
    )

    const setup = await loadGatewaySetup()

    expect(setup?.hasCredentials).toBe(true)
    expect(setup?.credentialError).toBeUndefined()
  })
})
