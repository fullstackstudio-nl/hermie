import type { ChatGateway } from '../../src/gateway/link'

export interface RecordedCall {
  method: string
  params: Record<string, unknown>
}

type Responder = (params: Record<string, unknown>) => unknown

/**
 * A `ChatGateway` with no socket behind it.
 *
 * The controller is written against the interface rather than against
 * `GatewayConnection` precisely so a test can be this small: queue the replies,
 * drive the events by hand, and read back exactly which calls went out in which
 * order.
 */
export class FakeChatGateway implements ChatGateway {
  readonly calls: RecordedCall[] = []
  readonly responders = new Map<string, Responder>()
  restMessages: unknown[] | null = []
  readonly restCalls: { sessionId: string; limit: number; order: string }[] = []

  private eventHandlers: ((event: unknown) => void)[] = []
  private requestHandlers: ((request: never) => boolean | void)[] = []
  private statusHandlers: ((status: never, error: never) => void)[] = []

  /** Answer `method` with `value`, or with whatever `value(params)` returns. */
  reply(method: string, value: unknown | Responder): this {
    this.responders.set(method, typeof value === 'function' ? (value as Responder) : () => value)

    return this
  }

  /** The params of the most recent call to `method`, if there was one. */
  lastCall(method: string): Record<string, unknown> | undefined {
    return [...this.calls].reverse().find(call => call.method === method)?.params
  }

  methodOrder(): string[] {
    return this.calls.map(call => call.method)
  }

  request = (async (method: string, params: Record<string, unknown> = {}) => {
    this.calls.push({ method, params })

    const responder = this.responders.get(method)

    if (!responder) {
      throw new Error(`FakeChatGateway has no reply for ${method}`)
    }

    return responder(params)
  }) as ChatGateway['request']

  on = ((_type: string, _handler: unknown) => () => undefined) as ChatGateway['on']

  onAny: ChatGateway['onAny'] = handler => {
    const wrapped = handler as unknown as (event: unknown) => void
    this.eventHandlers.push(wrapped)

    return () => {
      this.eventHandlers = this.eventHandlers.filter(entry => entry !== wrapped)
    }
  }

  onRequest: ChatGateway['onRequest'] = handler => {
    const wrapped = handler as unknown as (request: never) => boolean | void
    this.requestHandlers.push(wrapped)

    return () => {
      this.requestHandlers = this.requestHandlers.filter(entry => entry !== wrapped)
    }
  }

  onStatus: ChatGateway['onStatus'] = handler => {
    const wrapped = handler as unknown as (status: never, error: never) => void
    this.statusHandlers.push(wrapped)

    return () => {
      this.statusHandlers = this.statusHandlers.filter(entry => entry !== wrapped)
    }
  }

  fetchMessages: ChatGateway['fetchMessages'] = async (sessionId, options) => {
    this.restCalls.push({ sessionId, limit: options.limit, order: options.order })

    return this.restMessages as never
  }

  /** Publish one gateway event to every subscriber. */
  emit(event: { type: string; session_id?: string; seq?: number; payload?: unknown }): void {
    for (const handler of [...this.eventHandlers]) {
      handler(event)
    }
  }

  /**
   * Deliver one server→client request. `answer()` reads what the client
   * eventually replied, which for an approval is whenever the user taps.
   */
  serverRequest(
    id: string,
    method: string,
    params: Record<string, unknown>
  ): { accepted: boolean; answer: () => Record<string, unknown> | null } {
    let answer: Record<string, unknown> | null = null
    const request = {
      id,
      method,
      params,
      respond: (result: Record<string, unknown>) => {
        answer = result
      },
      fail: () => undefined
    }

    for (const handler of [...this.requestHandlers]) {
      if ((handler as unknown as (value: unknown) => boolean | void)(request) !== false) {
        return { accepted: true, answer: () => answer }
      }
    }

    return { accepted: false, answer: () => null }
  }

  /** Announce a connection status change. */
  status(next: string): void {
    for (const handler of [...this.statusHandlers]) {
      ;(handler as unknown as (status: string, error: null) => void)(next, null)
    }
  }
}
