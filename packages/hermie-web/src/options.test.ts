import { describe, expect, it } from 'vitest'

import { isSameOriginPath, normalizeLoginReturn, resolveOptions } from './options'

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
