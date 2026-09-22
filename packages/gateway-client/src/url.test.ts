import { describe, expect, it } from 'vitest'

import { GatewayError } from './types'
import {
  apiUrl,
  hasExplicitScheme,
  isBlockedHeaderName,
  normalizeBaseUrl,
  normalizeHeader,
  normalizeHeaders,
  wsUrlFor
} from './url'

describe('normalizeBaseUrl', () => {
  it('assumes https when the user types no scheme', () => {
    expect(normalizeBaseUrl('hermes-test.fullstackstudio.nl')).toBe('https://hermes-test.fullstackstudio.nl')
  })

  it('keeps an explicit http scheme and port', () => {
    expect(normalizeBaseUrl('http://localhost:9119')).toBe('http://localhost:9119')
  })

  it('drops trailing slashes, query and fragment but keeps a path prefix', () => {
    expect(normalizeBaseUrl('https://example.test/hermes/?x=1#frag')).toBe('https://example.test/hermes')
    expect(normalizeBaseUrl('https://example.test///')).toBe('https://example.test')
  })

  it('trims surrounding whitespace', () => {
    expect(normalizeBaseUrl('  example.test  ')).toBe('https://example.test')
  })

  it('refuses a scheme that is not http or https', () => {
    expect(() => normalizeBaseUrl('ws://example.test')).toThrow(GatewayError)
    expect(() => normalizeBaseUrl('file:///etc/passwd')).toThrow(/http:\/\/ or https:\/\//)
  })

  it('refuses an empty address', () => {
    expect(() => normalizeBaseUrl('   ')).toThrow(/Enter a gateway address/)
  })
})

describe('hasExplicitScheme', () => {
  it('tells an address the user gave a scheme from one that was coerced', () => {
    expect(hasExplicitScheme('https://example.test')).toBe(true)
    expect(hasExplicitScheme('  http://example.test  ')).toBe(true)
    expect(hasExplicitScheme('HTTP://example.test')).toBe(true)
    expect(hasExplicitScheme('example.test')).toBe(false)
    // A port is not a scheme, however much a colon looks like one.
    expect(hasExplicitScheme('example.test:9119')).toBe(false)
  })
})

describe('wsUrlFor', () => {
  it('maps https to wss and appends /api/ws', () => {
    expect(wsUrlFor('https://example.test')).toBe('wss://example.test/api/ws')
  })

  it('maps http to ws', () => {
    expect(wsUrlFor('http://127.0.0.1:9119')).toBe('ws://127.0.0.1:9119/api/ws')
  })

  it('keeps a reverse-proxy path prefix', () => {
    expect(wsUrlFor('https://example.test/hermes/')).toBe('wss://example.test/hermes/api/ws')
  })
})

describe('apiUrl', () => {
  it('joins a path onto the prefix', () => {
    expect(apiUrl('https://example.test/hermes', '/api/status')).toBe('https://example.test/hermes/api/status')
    expect(apiUrl('https://example.test', 'api/status')).toBe('https://example.test/api/status')
  })
})

describe('header validation', () => {
  it('accepts a token name and strips CR/LF from the value', () => {
    expect(normalizeHeader('CF-Access-Client-Id', ' abc\r\ndef ')).toEqual(['CF-Access-Client-Id', 'abcdef'])
  })

  it('refuses a name that is not an HTTP token', () => {
    expect(() => normalizeHeader('bad header', 'x')).toThrow(/not a valid header name/)
    expect(() => normalizeHeader('bad:header', 'x')).toThrow(GatewayError)
  })

  it('refuses transport-owned and credential header names, case-insensitively', () => {
    for (const name of ['Authorization', 'host', 'Cookie', 'Content-Length', 'X-Hermes-Session-Token']) {
      expect(isBlockedHeaderName(name)).toBe(true)
      expect(() => normalizeHeader(name, 'x')).toThrow(/cannot be an extra header/)
    }
  })

  it('normalizes a whole map and tolerates undefined', () => {
    expect(normalizeHeaders(undefined)).toEqual({})
    expect(normalizeHeaders({ 'CF-Access-Client-Secret': 'shh' })).toEqual({ 'CF-Access-Client-Secret': 'shh' })
  })
})
