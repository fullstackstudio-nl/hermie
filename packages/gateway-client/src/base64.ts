/**
 * Base64, from raw bytes, with no platform API in the way.
 *
 * `fetchAuthenticatedPicture` needs this to turn `/api/auth/picture`'s response
 * into a `data:` URI that `Image` can load on every platform without a second
 * authenticated request. Neither `btoa` nor `Buffer` can be relied on here:
 * Hermes (React Native's engine) does not give a plain `btoa` for arbitrary
 * bytes, and `Buffer` is a Node global this package does not assume. Encoding
 * three bytes at a time from a `Uint8Array` needs neither.
 */
const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export function bytesToBase64(bytes: Uint8Array): string {
  let out = ''

  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] as number
    const hasB1 = i + 1 < bytes.length
    const hasB2 = i + 2 < bytes.length
    const b1 = hasB1 ? (bytes[i + 1] as number) : 0
    const b2 = hasB2 ? (bytes[i + 2] as number) : 0

    out += BASE64_CHARS[b0 >> 2]
    out += BASE64_CHARS[((b0 & 0x03) << 4) | (b1 >> 4)]
    out += hasB1 ? BASE64_CHARS[((b1 & 0x0f) << 2) | (b2 >> 6)] : '='
    out += hasB2 ? BASE64_CHARS[b2 & 0x3f] : '='
  }

  return out
}
