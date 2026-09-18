import { describe, expect, it } from 'vitest'

describe('@hermie/gateway-client', () => {
  it('loads without side effects', async () => {
    const exported = await import('./index')
    expect(Object.keys(exported)).toEqual([])
  })
})
