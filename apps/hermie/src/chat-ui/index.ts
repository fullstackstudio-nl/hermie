/**
 * The chat UI kit: every surface a Hermes bot chat draws.
 *
 * Components take transcript items and callbacks — no store, no gateway, no
 * navigation. That is what lets the developer gallery render all of them from
 * literals, and what keeps the data layer free to change shape underneath.
 */
export { AgentsBar, type AgentsBarProps } from './AgentsBar'
export { AgentsSheet, type AgentsSheetProps, type SubagentTranscript } from './AgentsSheet'
export { AssistantBubble, type AssistantBubbleProps } from './AssistantBubble'
export { BotDmInBubble, type BotDmInBubbleProps } from './BotDmInBubble'
export { BotDmOutCard, type BotDmOutCardProps } from './BotDmOutCard'
export { ChatHeader, type ChatHeaderProps } from './ChatHeader'
export { Composer, type ComposerProps } from './Composer'
export { DiffView, type DiffViewProps } from './DiffView'
export { ErrorCard, type ErrorCardProps } from './ErrorCard'
export { JumpToLatestPill, type JumpToLatestPillProps } from './JumpToLatestPill'
export { NoticePill, type NoticePillProps } from './NoticePill'
export { QueuedChip, type QueuedChipProps } from './QueuedChip'
export { ReasoningDisclosure, type ReasoningDisclosureProps } from './ReasoningDisclosure'
export { StatusRow, type StatusRowProps } from './StatusRow'
export { SubagentGroupCard, type SubagentGroupCardProps } from './SubagentGroupCard'
export { ToolCard, type ToolCardProps } from './ToolCard'
export {
  TranscriptList,
  type TranscriptContext,
  type TranscriptListHandle,
  type TranscriptListProps
} from './TranscriptList'
export { TypingIndicator, type TypingIndicatorProps } from './TypingIndicator'
export { UserBubble, type UserBubbleProps } from './UserBubble'

export { Avatar, type AvatarProps } from './primitives/Avatar'
export { Bubble, type BubbleProps } from './primitives/Bubble'
export { Chip, type ChipProps } from './primitives/Chip'

export { parseUnifiedDiff, summarizeDiff, type DiffLine, type DiffLineKind } from './diff'
export {
  clipInline,
  formatClock,
  formatCount,
  formatDuration,
  formatListTime,
  formatPreview,
  initialFor,
  tintIndex
} from './format'
export { chatStrings } from './strings'
export { argumentRows, extractToolErrorMessage, formatToolResultSummary } from './tool-result-summary'
export { isCardTool, isFileEditTool, isSilentTool, toolFamily, toolGlyph, type ToolFamily } from './tool-render-class'
export type * from './types'
