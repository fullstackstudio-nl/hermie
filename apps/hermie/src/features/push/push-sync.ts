/**
 * ADR-0017's app half, as one object with a lifetime.
 *
 * It owns four things and nothing else:
 *
 *  1. **Turning it on.** Permission, then an address from the platform, then a
 *     row in the store. The WRITE is somebody else's: `ui-meta-bridge.ts`
 *     notices the store and sends the app-wide section, which is what gives a
 *     registration ADR-0016's compare-and-swap and its offline behaviour for
 *     free. Nothing here talks to a gateway about a registration.
 *  2. **Keeping it fresh.** A push token is not permanent — a restore from
 *     backup, a reinstall of the OS, an Expo project rotation all change it —
 *     and a stale row is a device that has quietly stopped being notified with
 *     nothing on screen to say so. So the address is re-read on every
 *     foreground and the row re-stamped, which is also what tells the daemon
 *     this installation is still real.
 *  3. **The heartbeat.** `push.seen[<installation-id>]` while a chat is on
 *     screen, on a cadence rather than per render. ADR-0017 is explicit that
 *     this is a heuristic: the failure mode is a redundant notification for a
 *     chat somebody is already reading, and the cadence below is chosen to fail
 *     in that direction rather than to make the write cheap.
 *  4. **Taps.** Which is where the care is. See `actions.ts`: a notification
 *     selects a chat and nothing else, and an Allow or a Deny is re-checked
 *     against `approval.pending` before a single byte is sent.
 *
 * **What it deliberately does not do** is decide whether a notification should
 * have been sent. That is the daemon's, it runs next to the gateway, and the app
 * has no way to know what the other devices are doing.
 */
import { pushStampOf } from '@hermie/gateway-client/push'

import { usePushStore, type PushState } from '../../store/push'
import { pushTapOf, resolvePushTap, type OpenApproval } from './actions'
import type { PushPermission, PushPlatform, PushResponse } from './platform-contract'

/**
 * How often `seen` is re-stamped while a chat is on screen.
 *
 * Every stamp is a `profiles.configure` on the gateway, so this is a rate as
 * much as a freshness. A minute is well inside any suppression window the daemon
 * would sensibly pick and is one write a minute from a device somebody is
 * actively reading on, which is the cheapest moment to spend one.
 */
export const PUSH_HEARTBEAT_MS = 60_000

export type PushEnableOutcome = 'enabled' | 'denied' | 'unavailable'

/** The three things a tap needs from the rest of the app. */
export interface PushSyncPorts {
  /**
   * Bring that chat to the front, resuming it if it is not open.
   *
   * Every entry point resolves against the gateway before it shows anything —
   * the same rule the widgets and the deep link follow — so a bot that no longer
   * exists lands somewhere honest rather than on an empty screen.
   */
  showChat(bot: string): Promise<void>
  /** What `approval.pending` says is open for that bot, asked just now. */
  openApprovals(bot: string): Promise<OpenApproval[]>
  respondApproval(bot: string, requestId: string, choice: string): Promise<void>
}

export interface PushSyncOptions {
  platform: PushPlatform
  ports: PushSyncPorts
  /** `extra.eas.projectId`. Native only; a browser needs `vapidUrl` instead. */
  projectId?: string | null
  /** Where the daemon publishes its VAPID public key. Browser only. */
  vapidUrl?: string | null
  store?: { getState: () => PushState }
  now?: () => number
  heartbeatMs?: number
}

export class PushSync {
  private readonly platform: PushPlatform
  private readonly ports: PushSyncPorts
  private readonly projectId: string | null
  private readonly vapidUrl: string | null
  private readonly store: { getState: () => PushState }
  private readonly now: () => number
  private readonly heartbeatMs: number

  private timer: ReturnType<typeof setInterval> | undefined
  private stopResponses: (() => void) | undefined
  private running = false
  private foreground = true
  private openBot: string | null = null
  /** One tap at a time, so a double tap cannot answer the same request twice. */
  private handling: Promise<void> = Promise.resolve()

  constructor(options: PushSyncOptions) {
    this.platform = options.platform
    this.ports = options.ports
    this.projectId = options.projectId ?? null
    this.vapidUrl = options.vapidUrl ?? null
    this.store = options.store ?? usePushStore
    this.now = options.now ?? (() => Date.now())
    this.heartbeatMs = options.heartbeatMs ?? PUSH_HEARTBEAT_MS
  }

  /**
   * Hydrate, prepare the platform, and start listening. Returns its teardown.
   *
   * The listener is wired even when notifications are OFF, because a tap can
   * arrive from a registration made before they were turned off and from a
   * notification that was already on the lock screen. Dropping it would leave a
   * notification that does nothing when tapped, which is worse than one that
   * opens a chat.
   */
  start(): () => void {
    if (this.running) {
      return () => this.stop()
    }

    this.running = true

    void this.boot()

    return () => this.stop()
  }

  stop(): void {
    this.running = false
    this.stopResponses?.()
    this.stopResponses = undefined
    this.clearTimer()
  }

  private async boot(): Promise<void> {
    await this.store.getState().hydrate()

    /*
      A chat can come on screen before the disk read finishes — it always does
      when the app is launched straight onto one — and a beat before the store
      has an installation id stamps nothing, because the id is the key `seen` is
      written under. Measured on a simulator on 2026-09-21: the registration
      reached the gateway and `seen` stayed `{}` for a full period afterwards,
      with a chat open the whole time. So the beat is retried here, once, now
      that there is something to key it by.
    */
    this.syncHeartbeat()

    if (!this.running || !this.platform.available) {
      return
    }

    await this.platform.prepare()

    if (!this.running) {
      return
    }

    this.stopResponses = this.platform.onResponse(response => this.onResponse(response))

    const initial = await this.platform.consumeInitialResponse()

    if (initial && this.running) {
      this.onResponse(initial)
    }

    // A registration made on an earlier launch is confirmed rather than assumed:
    // see the note on freshness at the top.
    await this.refresh()
  }

  // ── the switch ─────────────────────────────────────────────────────────────

  /**
   * Turn notifications on for this device.
   *
   * The store is flipped FIRST, so the switch in Settings moves under the
   * finger and the reader is not looking at a control that appears stuck while
   * a permission dialog is up. If no address comes back, `enabled` stays true
   * and the row simply is not written — which is the honest state: the reader
   * asked, and the platform has not agreed yet.
   */
  async enable(): Promise<PushEnableOutcome> {
    if (!this.platform.available) {
      return 'unavailable'
    }

    this.store.getState().setEnabled(true)

    const permission = await this.platform.requestPermission()

    if (permission !== 'granted') {
      this.store.getState().setEnabled(false)

      return permission === 'denied' ? 'denied' : 'unavailable'
    }

    return (await this.obtain()) ? 'enabled' : 'unavailable'
  }

  /** Turn them off, and take the row out of the section on the next flush. */
  async disable(): Promise<void> {
    this.store.getState().setEnabled(false)
    await this.platform.dropAddress()
  }

  /** What the platform currently says, for a screen that wants to explain. */
  permission(): Promise<PushPermission> {
    return this.platform.available ? this.platform.permission() : Promise.resolve('denied')
  }

  /**
   * Re-read the address and re-stamp the row. Called on every foreground.
   *
   * A no-op while notifications are off, and — importantly — it does not ask for
   * permission. A reader who revoked it in system settings gets their row
   * removed rather than a dialog they did not open the app for.
   */
  async refresh(): Promise<void> {
    const state = this.store.getState()

    if (!state.loaded || !state.enabled || !this.platform.available) {
      return
    }

    if ((await this.platform.permission()) !== 'granted') {
      // Revoked outside the app. The switch follows the system, because a
      // switch that says ON while nothing can arrive is the one lie a settings
      // screen must not tell.
      this.store.getState().setEnabled(false)

      return
    }

    await this.obtain()
  }

  private async obtain(): Promise<boolean> {
    const address = await this.platform.obtainAddress({ projectId: this.projectId, vapidUrl: this.vapidUrl })

    if (!address) {
      return false
    }

    this.store.getState().setAddress(address, pushStampOf(this.now()))

    return true
  }

  /**
   * Take this device out of the section, for a sign-out or a change of gateway.
   *
   * The caller has to await this BEFORE the socket goes, which is why it is not
   * folded into the store's own reset: a registration is only meaningful for the
   * gateway it was made on, and the write that removes it needs that gateway.
   */
  async retire(): Promise<void> {
    this.store.getState().retire()
    await this.platform.dropAddress()
  }

  // ── the heartbeat ──────────────────────────────────────────────────────────

  /** Which chat is on screen, or `null`. Drives the heartbeat with `foreground`. */
  setOpenChat(bot: string | null): void {
    if (this.openBot === bot) {
      return
    }

    this.openBot = bot
    this.syncHeartbeat()
  }

  setForeground(foreground: boolean): void {
    if (this.foreground === foreground) {
      return
    }

    this.foreground = foreground
    this.syncHeartbeat()
  }

  /** Stamp now. Public so a test can drive the cadence without a clock. */
  beat(): void {
    this.store.getState().beat(pushStampOf(this.now()))
  }

  private syncHeartbeat(): void {
    const wanted = this.running && this.foreground && this.openBot !== null

    if (!wanted) {
      this.clearTimer()

      return
    }

    if (this.timer !== undefined) {
      // Already running. The one case worth acting on is a timer whose first
      // beat stamped nothing because the store had no id yet; see `boot`.
      if (!this.store.getState().seen[this.store.getState().installationId]) {
        this.beat()
      }

      return
    }

    // Immediately, then on the cadence: the interesting moment is the one where
    // a chat has just come on screen, and waiting a full period to say so is
    // exactly the window in which a redundant notification goes out.
    this.beat()
    this.timer = setInterval(() => this.beat(), this.heartbeatMs)
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  // ── taps ───────────────────────────────────────────────────────────────────

  private onResponse(response: PushResponse): void {
    this.handling = this.handling.then(() => this.handle(response)).catch(() => undefined)
  }

  private async handle(response: PushResponse): Promise<void> {
    const tap = pushTapOf(response)

    if (!tap) {
      return
    }

    // The chat first, always. It is what an Allow needs anyway — the gateway is
    // asked for that session's open requests — and it is the whole of what a
    // plain tap does.
    await this.ports.showChat(tap.bot)

    if (tap.action === 'open') {
      return
    }

    const intent = resolvePushTap({ tap, pending: await this.ports.openApprovals(tap.bot) })

    if (intent.kind === 'respond') {
      await this.ports.respondApproval(intent.bot, intent.requestId, intent.choice)
    }

    // `open-chat` needs nothing further: the chat is already in front, and what
    // the reader sees there is the request as it actually stands.
  }
}
