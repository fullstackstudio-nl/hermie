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
 * iOS surfaces a failed TLS handshake as NSURLErrorSecureConnectionFailed
 * (-1200) inside the message; Android and Node say "certificate" or "SSL".
 */
export function looksLikeTlsFailure(message: string): boolean {
  const lowered = message.toLowerCase()

  return lowered.includes('ssl') || lowered.includes('certificate') || lowered.includes('-1200')
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
      throw new GatewayError('tls', `The TLS certificate for ${url} was rejected: ${message}`, { cause: error })
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
  let parsed: unknown

  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new GatewayError(kind, `${url} answered with something that is not JSON.`, { cause: error })
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new GatewayError(kind, `${url} answered with JSON that is not an object.`)
  }

  return parsed as Record<string, unknown>
}
