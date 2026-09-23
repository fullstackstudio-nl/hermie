import { describe, expect, it } from 'vitest'

import { bytesToBase64 } from './base64'

describe('bytesToBase64', () => {
  it('encodes an empty buffer as an empty string', () => {
    expect(bytesToBase64(new Uint8Array())).toBe('')
  })

  it('pads a one-byte tail with two `=`', () => {
    expect(bytesToBase64(new Uint8Array([0x4d]))).toBe('TQ==')
  })

  it('pads a two-byte tail with one `=`', () => {
    expect(bytesToBase64(new Uint8Array([0x4d, 0x61]))).toBe('TWE=')
  })

  it('encodes a full triplet with no padding', () => {
    expect(bytesToBase64(new Uint8Array([0x4d, 0x61, 0x6e]))).toBe('TWFu')
  })

  it('matches the textbook "Man is distinguished" example', () => {
    const bytes = Uint8Array.from('Man is distinguished'.split('').map(char => char.charCodeAt(0)))

    expect(bytesToBase64(bytes)).toBe('TWFuIGlzIGRpc3Rpbmd1aXNoZWQ=')
  })

  it('round-trips arbitrary bytes, decoded with the platform atob', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255, 128, 64, 32, 16])

    expect(atob(bytesToBase64(bytes))).toBe(String.fromCharCode(...bytes))
  })
})
