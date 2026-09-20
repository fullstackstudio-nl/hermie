/**
 * The chat UI kit: every surface a Hermes bot chat draws.
 *
 * Components take transcript items and callbacks — no store, no gateway, no
 * navigation. That is what lets the developer gallery render all of them from
 * literals, and what keeps the data layer free to change shape underneath.
 */
export { AgentsBar, type AgentsBarProps } from './AgentsBar'
export { AttachMenu, type AttachMenuProps } from './AttachMenu'
export { AgentsSheet, type AgentsSheetProps, type SubagentTranscript } from './AgentsSheet'
export { AssistantBubble, type AssistantBubbleProps } from './AssistantBubble'
export { BotDmInBubble, type BotDmInBubbleProps } from './BotDmInBubble'
export { BotDmOutLine, markerFor, type BotDmOutLineProps } from './BotDmOutLine'
export { BotDmRollup, useRollupExpanded, type BotDmRollupProps } from './BotDmRollup'
export { ChatHeader, SidebarToggleButton, type ChatHeaderProps } from './ChatHeader'
export { Composer, type ComposerProps } from './Composer'
export { CronDeliveryCard, type CronDeliveryCardProps } from './CronDeliveryCard'
export { DateSeparator, type DateSeparatorProps } from './DateSeparator'
export { DiffView, type DiffViewProps } from './DiffView'
export { FileChip, fileGlyph, type FileChipProps } from './FileChip'
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
export { TypingDots, TypingIndicator, type TypingIndicatorProps } from './TypingIndicator'
export { attachmentName, UserBubble, type UserBubbleProps } from './UserBubble'

export { Avatar, type AvatarProps } from './primitives/Avatar'
export { Bubble, resolveBubbleWidth, useBubbleWidth, useLedgerWidth, type BubbleProps } from './primitives/Bubble'
export { BubbleColumn, useBubbleColumnWidth } from './primitives/BubbleColumn'
export { Chip, type ChipProps } from './primitives/Chip'
export { Fold, useFoldHeight, type FoldProps } from './primitives/Fold'
export { LedgerRow, type LedgerRowProps } from './primitives/LedgerRow'
export { MetaLine, type MetaLineProps } from './primitives/MetaLine'
export { Ticks, type TicksProps } from './primitives/Ticks'

export { ExpandedProvider, useExpanded, useExpandedApi, type ExpandedApi } from './expanded'
export { hasReply, isDmOut, rollupDmRuns, ROLLUP_THRESHOLD, type DmRowRole, type DmRun } from './dm-rollup'
export { dateStampFor, GROUP_WINDOW_SECONDS, layoutRows, speakerKey, type RowLayout } from './grouping'

export { parseUnifiedDiff, summarizeDiff, type DiffLine, type DiffLineKind } from './diff'
export {
  clipInline,
  formatBytes,
  formatClock,
  formatCount,
  formatDuration,
  formatListTime,
  formatPreview,
  initialFor,
  middleTruncate,
  needsReadingTreatment,
  previewLine,
  tintIndex
} from './format'
export { chatStrings } from './strings'
export { argumentRows, extractToolErrorMessage, formatToolResultSummary } from './tool-result-summary'
export { isCardTool, isFileEditTool, isSilentTool, toolFamily, toolGlyph, type ToolFamily } from './tool-render-class'
export type * from './types'
