import { describe, expect, it } from 'vitest'

import { DEFAULT_GATEWAY_URL, isSameOriginPath, normalizeLoginReturn, resolveOptions } from './options'

/**
 * The option that decides where a finished sign-in lands. Everything it refuses
 * is a way to hand the gateway a `next=` that leaves this origin — and while the
 * gateway checks that again, an install whose unit file says something unsafe
 * should fail at start rather than quietly redirect somewhere else.
 */
describe('the login return path', () => {
  it('defaults to the root', () => {
    expect(resolveOptions({ env: {} }).loginReturn).toBe('/')
    expect(normalizeLoginReturn('')).toBe('/')
    expect(normalizeLoginReturn('   ')).toBe('/')
  })

  it('keeps a path on this origin, trimmed', () => {
    expect(normalizeLoginReturn('/hermie')).toBe('/hermie')
    expect(normalizeLoginReturn(' /hermie/back ')).toBe('/hermie/back')
    expect(normalizeLoginReturn('/hermie?from=login')).toBe('/hermie?from=login')
  })

  it('refuses anything that could name another host', () => {
    for (const hostile of ['https://evil.example', '//evil.example', '/\\evil.example', 'hermie', '/a b']) {
      expect(isSameOriginPath(hostile)).toBe(false)
      expect(() => normalizeLoginReturn(hostile)).toThrow(/--login-return/)
    }
  })

  it('refuses a control character, which no header could carry anyway', () => {
    expect(() => normalizeLoginReturn('/hermie\nSet-Cookie: x=1')).toThrow(/--login-return/)
  })

  it('is read from the environment when no flag gives one', () => {
    expect(resolveOptions({ env: { HERMIE_LOGIN_RETURN: '/hermie' } }).loginReturn).toBe('/hermie')
  })

  it('lets the flag beat the environment', () => {
    expect(resolveOptions({ env: { HERMIE_LOGIN_RETURN: '/from-env' }, loginReturn: '/from-flag' }).loginReturn).toBe(
      '/from-flag'
    )
  })
})

/**
 * Every option a container has to be configured through entirely from the
 * environment — the point of this whole file: a Kubernetes Deployment sets
 * env vars, never `args`. One test per flag would be a lot of ceremony for the
 * same `??` chain, so this checks the full set at once, then the two things
 * that matter beyond plain string passthrough: precedence, and validation.
 */
describe('container configuration from the environment', () => {
  it('resolves every option from environment variables alone, with no flags at all', () => {
    const options = resolveOptions({
      env: {
        HERMIE_GATEWAY_URL: 'http://hermes:9119',
        HERMIE_PORT: '8080',
        HERMIE_HOST: '0.0.0.0',
        HERMIE_PUBLIC_URL: 'https://hermie.example.com',
        HERMIE_STATIC_DIR: '/srv/hermie-web/web',
        HERMIE_LOGIN_RETURN: '/hermie',
        HERMIE_INSTALL_ROOT: '/opt/hermie-web',
        HERMIE_SELF_UPDATE: '0',
        HERMIE_CACHE_MAX_MB: '128',
        HERMIE_PUSH: '1',
        HERMIE_GATEWAY_TOKEN: 'a-token',
        HERMIE_STATE_DIR: '/var/lib/hermie-web',
        HERMIE_VAPID_SUBJECT: 'mailto:ops@example.com',
        HERMIE_PUSH_SERVER_REQUESTS: '1',
        HERMIE_ALLOW_INSECURE_OIDC: '1'
      }
    })

    expect(options.gatewayUrl).toBe('http://hermes:9119/')
    expect(options.gatewayConfigured).toBe(true)
    expect(options.port).toBe(8080)
    expect(options.host).toBe('0.0.0.0')
    expect(options.publicUrl).toBe('https://hermie.example.com')
    expect(options.staticDir).toBe('/srv/hermie-web/web')
    expect(options.loginReturn).toBe('/hermie')
    expect(options.installRoot).toBe('/opt/hermie-web')
    expect(options.selfUpdate).toBe(false)
    expect(options.cacheMaxMb).toBe(128)
    expect(options.push).toBe(true)
    expect(options.gatewayToken).toBe('a-token')
    expect(options.stateDir).toBe('/var/lib/hermie-web')
    expect(options.vapidSubject).toBe('mailto:ops@example.com')
    expect(options.pushServerRequests).toBe(true)
    expect(options.allowInsecureOidc).toBe(true)
  })

  it('defaults to the built-in gateway when neither a flag nor the environment sets one', () => {
    const options = resolveOptions({ env: {} })

    expect(options.gatewayUrl).toBe(`${DEFAULT_GATEWAY_URL}/`)
    expect(options.gatewayConfigured).toBe(false)
  })

  it('lets a flag beat the environment for every option, not only the gateway', () => {
    const options = resolveOptions({
      env: { HERMIE_PORT: '8080', HERMIE_HOST: '0.0.0.0', HERMIE_PUSH: '1' },
      port: '9999',
      host: '10.0.0.1',
      push: false
    })

    expect(options.port).toBe(9999)
    expect(options.host).toBe('10.0.0.1')
    expect(options.push).toBe(false)
  })

  it.each(['yes', 'true', '1', 'YES', ' yes '])('accepts %s as an "on" boolean environment value', value => {
    expect(resolveOptions({ env: { HERMIE_PUSH: value } }).push).toBe(true)
  })

  it.each(['no', 'false', '0', 'NO', ' no '])('accepts %s as an "off" boolean environment value', value => {
    expect(resolveOptions({ env: { HERMIE_PUSH: value } }).push).toBe(false)
  })

  it('fails at start on an invalid boolean environment value, naming the variable', () => {
    expect(() => resolveOptions({ env: { HERMIE_PUSH: 'sure' } })).toThrow(/HERMIE_PUSH/)
    expect(() => resolveOptions({ env: { HERMIE_ALLOW_INSECURE_OIDC: 'enabled' } })).toThrow(
      /HERMIE_ALLOW_INSECURE_OIDC/
    )
  })

  it('fails at start on an invalid HERMIE_PORT, naming the variable', () => {
    expect(() => resolveOptions({ env: { HERMIE_PORT: 'not-a-port' } })).toThrow(/HERMIE_PORT/)
    expect(() => resolveOptions({ env: { HERMIE_PORT: '99999' } })).toThrow(/HERMIE_PORT/)
  })

  it('fails at start on an invalid HERMIE_GATEWAY_URL, naming the variable', () => {
    expect(() => resolveOptions({ env: { HERMIE_GATEWAY_URL: 'not a url' } })).toThrow(/HERMIE_GATEWAY_URL/)
  })

  it('fails at start on an invalid HERMIE_CACHE_MAX_MB, naming the variable', () => {
    expect(() => resolveOptions({ env: { HERMIE_CACHE_MAX_MB: '-5' } })).toThrow(/HERMIE_CACHE_MAX_MB/)
  })

  it('still lets a bad --port flag name itself, not just the environment variable', () => {
    expect(() => resolveOptions({ env: {}, port: 'nope' })).toThrow(/--port/)
  })
})
