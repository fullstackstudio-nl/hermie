/**
 * `Thought for 4s` — one quiet ledger line above a reply.
 *
 * §6.4: thinking is a single muted line that expands to a short summary. It is
 * collapsed by default on purpose — reasoning is context for the answer, not the
 * answer, and the default verbosity hides it altogether.
 *
 * The expanded state is keyed on the item's id and held above the list, so
 * scrolling an opened summary out of the window and back does not close it.
 */
import { Text } from '../ui/primitives'
import { useExpanded } from './expanded'
import { LedgerRow } from './primitives/LedgerRow'
import { chatStrings } from './strings'

export interface ReasoningDisclosureProps {
  text: string
  /**
   * The transcript item this belongs to.
   *
   * Reasoning is drawn by the assistant bubble rather than being an item of its
   * own, so it borrows the bubble's id with a suffix — two disclosures on one
   * item would otherwise share one flag.
   */
  id?: string
  /** Wall-clock seconds the model spent thinking, when the gateway sent one. */
  durationS?: number
  /** Still arriving: the row says "Thinking" and shows no duration. */
  streaming?: boolean
  testID?: string
}

export function ReasoningDisclosure({ text, id, durationS, streaming = false, testID }: ReasoningDisclosureProps) {
  const [expanded, toggle] = useExpanded(`reasoning:${id ?? testID ?? ''}`)

  if (!text.trim() && !streaming) {
    return null
  }

  const label = streaming
    ? chatStrings.assistant.thinking
    : chatStrings.assistant.thoughtFor(Math.max(1, Math.round(durationS ?? 0)))

  return (
    <LedgerRow expanded={expanded} glyph="◌" onToggle={text.trim() ? toggle : undefined} testID={testID} title={label}>
      <Text color="textMuted" selectable variant="preview">
        {text}
      </Text>
    </LedgerRow>
  )
}
