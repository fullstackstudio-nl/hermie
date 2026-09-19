/**
 * The slice of a `GatewayConnection` the chat layer is allowed to see.
 *
 * The controller is written against this interface rather than against the
 * connection class for one reason: a test should be able to hand it four
 * functions and drive a whole hydration without a socket, a fetch or a token
 * store. `GatewayConnection` satisfies it structurally, so production wiring is
 * `chatGatewayFor(connection)` and nothing else.
 */
import type { RpcMethods } from '@hermes/shared/gateway-contract'
import type { GatewayEvent, GatewayEventName } from '@hermes/shared/gateway-events'
import type { ServerRequestHandler } from '@hermes/shared/json-rpc-channel'
import type { ConnectionStatus, GatewayConnection, GatewayError, RequestOptions } from '@hermie/gateway-client'
import type { TranscriptRow } from '@hermie/transcript'

export interface ChatGateway {
  request<M extends keyof RpcMethods>(
    method: M,
    params?: RpcMethods[M]['params'],
    options?: RequestOptions
  ): Promise<RpcMethods[M]['result']>
  on<K extends GatewayEventName>(type: K, handler: (event: GatewayEvent<K>) => void): () => void
  onAny(handler: (event: GatewayEvent) => void): () => void
  onRequest(handler: ServerRequestHandler): () => void
  onStatus(handler: (status: ConnectionStatus, error: GatewayError | null) => void): () => void
  /**
   * The REST transcript, newest rows first, or `null` when this gateway has no
   * REST surface. It exists because `session.history` is unpaginated: a chat
   * with thousands of rows would otherwise re-download all of them to learn
   * what the last thirty were.
   */
  fetchMessages: (resolvedSessionId: string, options: RestMessagesOptions) => Promise<TranscriptRow[] | null>
}

export interface RestMessagesOptions {
  limit: number
  order: 'latest' | 'oldest'
}

interface RestMessagesResponse {
  messages?: TranscriptRow[]
  rows?: TranscriptRow[]
}

/** Wrap the app's live connection as a `ChatGateway`. */
export function chatGatewayFor(connection: GatewayConnection): ChatGateway {
  return {
    request: (method, params, options) => connection.request(method, params, options),
    on: (type, handler) => connection.on(type, handler),
    onAny: handler => connection.onAny(handler),
    onRequest: handler => connection.onRequest(handler),
    onStatus: handler => connection.onStatus(handler),
    async fetchMessages(resolvedSessionId, options) {
      const path = `/api/sessions/${encodeURIComponent(resolvedSessionId)}/messages?limit=${options.limit}&order=${options.order}`

      try {
        const body = await connection.http.get<RestMessagesResponse>(path)
        const rows = body?.messages ?? body?.rows

        return Array.isArray(rows) ? rows : []
      } catch {
        // A gateway without the REST transcript is a supported gateway, not a
        // broken one; the caller falls back to `session.history`.
        return null
      }
    }
  }
}
