/**
 * A system notice: a model switch, an auto-continue, a background process that
 * finished.
 *
 * §6.4 puts these in the ledger with everything else the machine says. An `error`
 * notice is the exception and keeps a danger tint, because it is the one kind that
 * survives every verbosity level and the one a reader must not skim past.
 *
 * Its open/closed state is keyed on the item's id and held above the list, so a
 * notice the reader opened does not close itself when the row is virtualised out.
 */
import { Text } from '../ui/primitives'
import { useExpanded } from './expanded'
import { LedgerRow } from './primitives/LedgerRow'
import { Chip } from './primitives/Chip'
import type { NoticeItem, Presentation } from './types'

export interface NoticePillProps {
  item: NoticeItem
  presentation?: Presentation
}

/** One glyph per family, so the eye can tell them apart without reading. */
function glyphFor(kind: NoticeItem['noticeKind']): string {
  switch (kind) {
    case 'error':
      return '!'
    case 'model_switch':
    case 'personality_switch':
      return '⇄'
    case 'auto_continue':
      return '↻'
    case 'process_complete':
    case 'async_delegation_complete':
      return '✓'
    default:
      return 'i'
  }
}

export function NoticePill({ item, presentation = 'collapsed' }: NoticePillProps) {
  const [expanded, toggle] = useExpanded(item.id)

  if (presentation === 'hidden-placeholder') {
    return null
  }

  const error = item.noticeKind === 'error'
  const hasBody = Boolean(item.body?.trim())

  if (!error && presentation === 'chip') {
    return <Chip centered label={item.title} testID={`notice-${item.id}`} />
  }

  return (
    <LedgerRow
      expanded={expanded}
      glyph={glyphFor(item.noticeKind)}
      onToggle={hasBody ? toggle : undefined}
      testID={`notice-${item.id}`}
      title={item.title}
      tone={error ? 'danger' : 'neutral'}
    >
      <Text color="textMuted" selectable testID={`notice-body-${item.id}`} variant="preview">
        {item.body}
      </Text>
    </LedgerRow>
  )
}
