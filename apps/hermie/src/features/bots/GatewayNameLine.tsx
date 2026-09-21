/**
 * Which gateway this chat list belongs to — and only when that is a question.
 *
 * With one gateway configured there is no ambiguity to resolve and the line
 * would be a permanent label nobody reads, so it draws nothing. With two, the
 * list of bots on screen is a fact about ONE of them, and a reader who has just
 * switched has no other way to tell which.
 *
 * Its own component, not a line inside the header, so that `BotsScreen` gains
 * exactly one element and the condition lives with the thing it hides.
 */
import { useGateway } from '../../gateway'
import { Text } from '../../ui/primitives'

export function GatewayNameLine() {
  const { gateway, registry } = useGateway()

  // Read through `?.`, which is not defensiveness for its own sake: this line
  // hangs off the chat list's title, which is rendered by a dozen suites that
  // stand in for the gateway context with only the fields they care about. A
  // decoration is not worth a crash in any of them, and "nothing is known about
  // the list" and "there is one gateway" want the same answer anyway.
  if ((registry?.gateways.length ?? 0) < 2 || !gateway) {
    return null
  }

  return (
    <Text color="textMuted" numberOfLines={1} testID="bots-gateway-name" variant="meta">
      {gateway.name}
    </Text>
  )
}
