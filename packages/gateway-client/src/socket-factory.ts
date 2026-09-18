import { type DialPlan, GatewayError } from './types'

/**
 * The 3-argument WebSocket constructor React Native ships (and the `ws` package
 * mirrors): `new WebSocket(url, protocols, { headers })`. Typed here rather than
 * imported so this package stays free of React Native.
 */
export type WebSocketConstructorLike = new (
  url: string,
  protocols?: string | string[],
  options?: { headers?: Record<string, string> }
) => WebSocket

export interface SocketCloseInfo {
  code: number
  reason: string
}

/**
 * The `socketFactory` the vendored `JsonRpcGatewayClient` calls. That client
 * only passes a URL, but a gated gateway needs a single-use ticket in the
 * subprotocol list and a session-token gateway needs extra headers — so the
 * connection owner *arms* the factory with a freshly minted plan immediately
 * before calling `connect()`, and the factory refuses to build a socket it was
 * not armed for.
 */
export class DialPlanSocketFactory {
  private plan: DialPlan | null = null
  private onClose: ((info: SocketCloseInfo) => void) | undefined

  constructor(
    private readonly WebSocketImpl: WebSocketConstructorLike,
    onClose?: (info: SocketCloseInfo) => void
  ) {
    this.onClose = onClose
  }

  /** Install the plan for the next (single) dial. */
  arm(plan: DialPlan): void {
    this.plan = plan
  }

  /** Forget the armed plan; a stale ticket must not be reused on a later dial. */
  disarm(): void {
    this.plan = null
  }

  get armed(): boolean {
    return this.plan !== null
  }

  /** Replace the close callback (the connection sets this once at construction). */
  setOnClose(onClose: (info: SocketCloseInfo) => void): void {
    this.onClose = onClose
  }

  create = (url: string): WebSocket => {
    const plan = this.plan

    if (!plan) {
      throw new GatewayError('protocol', 'The gateway socket factory was asked to dial without an armed plan.')
    }

    if (plan.url !== url) {
      throw new GatewayError(
        'protocol',
        `The gateway socket factory was armed for ${plan.url} but asked to dial ${url}.`
      )
    }

    // One plan, one dial: a ticket is single-use and lives 30 seconds.
    this.plan = null

    const socket = new this.WebSocketImpl(
      plan.url,
      plan.protocols,
      plan.headers && Object.keys(plan.headers).length > 0 ? { headers: plan.headers } : undefined
    )

    socket.addEventListener('close', event => {
      const closeEvent = event as CloseEvent
      this.onClose?.({ code: closeEvent.code ?? 0, reason: closeEvent.reason ?? '' })
    })

    return socket
  }
}
