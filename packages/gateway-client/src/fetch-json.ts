import { GatewayError } from './types'

export type FetchLike = typeof fetch

/** Default window for a single HTTP call to a gateway. */
export const DEFAULT_HTTP_TIMEOUT_MS = 10_000

export interface JsonRequest {
  method?: string
  headers?: Record<string, string>
  body?: unknown
  timeoutMs?: number
  signal?: AbortSignal
  fetchImpl?: FetchLike
}

export interface JsonResponse {
  status: number
  ok: boolean
  text: string
}

/**
 * Did the secure channel fail, whatever the reason?
 *
 * Worth knowing where this DOES and does not fire. React Native's `fetch` is
 * `whatwg-fetch` over its own `XMLHttpRequest`, and the polyfill's `onerror`
 * rejects with a flat `TypeError('Network request failed')` — the `NSError` and
 * OkHttp's exception are both discarded before JavaScript sees them. Measured
 * on iOS 27: CFNetwork logged `NSURLErrorDomain -1200 "A TLS error caused the
 * secure connection to fail."` for a request the app reported as unreachable.
 * So in the app this predicate is never true; it earns its place in Node, where
 * a real message arrives, and it is what the fallback in `probe.ts` reads.
 */
export function looksLikeTlsFailure(message: string): boolean {
  const lowered = message.toLowerCase()

  return (
    lowered.includes('ssl') || lowered.includes('certificate') || lowered.includes('tls') || lowered.includes('-1200')
  )
}

/**
 * Did the secure channel fail because of the CERTIFICATE, rather than because
 * there was no TLS there at all?
 *
 * The difference decides whether an address the user typed without a scheme may
 * be retried in the clear. A rejected certificate means there IS an https
 * server on that port and it has a problem worth fixing; a handshake that died
 * because the peer answered in plain HTTP means there is no https server there,
 * which is the ordinary shape of `hermes serve` on a tailnet port somebody
 * probed with `https://` first.
 */
export function looksLikeCertificateFailure(message: string): boolean {
  const lowered = message.toLowerCase()

  return (
    lowered.includes('certificate') ||
    lowered.includes('untrusted') ||
    lowered.includes('self signed') ||
    lowered.includes('self-signed') ||
    // NSURLErrorServerCertificateUntrusted and its neighbours.
    /-120[2-6]\b/.test(lowered)
  )
}

/**
 * One HTTP round trip with a timeout, returning the raw body. Transport
 * failures come back as `GatewayError` (`timeout` / `tls` / `network`); HTTP
 * status codes are the caller's to interpret, because what a 404 means depends
 * on which endpoint was asked.
 */
export async function requestText(url: string, request: JsonRequest = {}): Promise<JsonResponse> {
  const fetchImpl = request.fetchImpl ?? fetch
  const timeoutMs = request.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS
  const controller = new AbortController()
  let timedOut = false
  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true
          controller.abort()
        }, timeoutMs)
      : undefined

  const abortOuter = () => controller.abort()
  request.signal?.addEventListener('abort', abortOuter, { once: true })

  const headers: Record<string, string> = { accept: 'application/json', ...request.headers }
  let body: string | undefined

  if (request.body !== undefined) {
    body = JSON.stringify(request.body)
    headers['content-type'] = 'application/json'
  }

  try {
    const response = await fetchImpl(url, {
      method: request.method ?? 'GET',
      headers,
      ...(body === undefined ? {} : { body }),
      signal: controller.signal
    })

    return { status: response.status, ok: response.ok, text: await response.text() }
  } catch (error) {
    if (timedOut) {
      throw new GatewayError('timeout', `${url} did not answer within ${Math.round(timeoutMs / 1000)} seconds.`, {
        cause: error
      })
    }

    if (request.signal?.aborted) {
      throw new GatewayError('network', `The request to ${url} was cancelled.`, { cause: error })
    }

    const message = error instanceof Error ? error.message : String(error)

    if (looksLikeTlsFailure(message)) {
      // Two different stories, and naming a certificate that was never offered
      // sends the reader looking for one.
      throw new GatewayError(
        'tls',
        looksLikeCertificateFailure(message)
          ? `The TLS certificate for ${url} was rejected: ${message}`
          : `The TLS handshake with ${url} failed: ${message}`,
        { cause: error }
      )
    }

    throw new GatewayError('network', `Could not reach ${url}: ${message}`, { cause: error })
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer)
    }

    request.signal?.removeEventListener('abort', abortOuter)
  }
}

/** Parse a response body that must be a JSON object. */
export function parseJsonObject(text: string, url: string, kind: 'not_hermes' | 'protocol'): Record<string, unknown> {
  const parsed = parseJsonBody(text, url, kind)

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new GatewayError(kind, `${url} answered with JSON that is not an object.`)
  }

  return parsed as Record<string, unknown>
}

/**
 * Parse a response body that must be JSON, object or ARRAY.
 *
 * Not every REST route answers with an envelope. `GET /api/cron/jobs` answers
 * with a bare array — the cron controller says so in `listRows` and reads both
 * shapes — so a transport that rejected an array made that route unreachable
 * whatever the caller was prepared to accept. Which SHAPE is acceptable is the
 * caller's question; the transport's question is only whether it is JSON.
 *
 * `parseJsonObject` stays for the handshakes that genuinely require an object:
 * the status probe, the credential exchange, the token endpoints. An array
 * arriving there is a gateway that is not the gateway, and saying so early is
 * the point of that check.
 */
export function parseJsonBody(text: string, url: string, kind: 'not_hermes' | 'protocol'): unknown {
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new GatewayError(kind, `${url} answered with something that is not JSON.`, { cause: error })
  }
}
