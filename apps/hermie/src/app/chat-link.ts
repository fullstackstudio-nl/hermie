/**
 * `hermie://chat/<bot>?gateway=<key>`, resolved against the list of gateways.
 *
 * `useHermieLink` in `platform/deep-link.ts` is deliberately ignorant of
 * gateways: it parses a URL and hands over what it found, which keeps every way
 * a link can be malformed a table in a test. This is the half that knows what
 * the app should DO about the key, and it is a hook of its own rather than a
 * line in each shell so that the two shells cannot drift apart on the question.
 *
 * The rule is the same one a push tap follows: a key can only SELECT a gateway
 * the owner has already configured. A link with no key, a key this device does
 * not recognise, or the key of the gateway that is already live all open the
 * chat where the reader already is — which is also what every build before this
 * one did with every link.
 */
import { gatewayForKey, useGateway } from '../gateway'
import { useHermieLink } from '../platform/deep-link'

/**
 * Open the chat a link names, switching gateway first where it names one.
 *
 * `open` is called AFTER the switch, and on the far side of a teardown: the
 * shell that receives it is the one mounted over the new connection. A switch
 * that fails leaves the app where it was and the chat is opened there, which is
 * the honest outcome — the reader asked for a conversation, and the one on
 * screen is the only one this app can currently show them.
 */
export function useChatLink(open: (bot: string) => void): void {
  const { gatewayId, registry, switchGateway } = useGateway()

  useHermieLink(link => {
    const target = gatewayForKey(registry, link.gatewayKey)

    if (!target || target.id === gatewayId) {
      open(link.bot)

      return
    }

    void switchGateway(target.id).then(() => open(link.bot))
  })
}
