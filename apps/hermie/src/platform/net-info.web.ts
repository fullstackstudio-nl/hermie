/**
 * "Is there a network" in a browser.
 *
 * `navigator.onLine` is a much weaker claim than NetInfo's: it is false only
 * when the operating system says there is no interface at all, and it stays
 * true on a captive portal, on a dead VPN and on a Wi-Fi network with no route
 * out. That is fine for what the connection uses it for — it stops the dial
 * ladder from burning battery while a laptop is closed, and the ladder itself
 * is what actually discovers an unreachable gateway.
 *
 * The listener is deliberately two DOM events rather than a polling probe: a
 * request made to find out whether requests work is a request made to a gateway
 * the user may not want touched on a schedule.
 */
import type { NetworkWatcher } from './platform-contracts'

export type { NetworkWatcher } from './platform-contracts'

export const networkWatcher: NetworkWatcher = {
  subscribe(onChange) {
    if (typeof window === 'undefined') {
      return () => {}
    }

    const report = () => onChange(navigator.onLine !== false)

    window.addEventListener('online', report)
    window.addEventListener('offline', report)
    report()

    return () => {
      window.removeEventListener('online', report)
      window.removeEventListener('offline', report)
    }
  }
}
