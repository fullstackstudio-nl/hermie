/**
 * The item model the chat kit renders.
 *
 * Every type is re-exported from `@hermie/transcript` as a TYPE ONLY, so the
 * kit carries no runtime dependency on the engine: a component takes the item
 * the engine produced and paints it, and the gallery can hand it a literal.
 */
export type {
  ApprovalItem,
  AssistantFailure,
  AssistantItem,
  BotDmInItem,
  BotDmOutItem,
  ClarifyItem,
  ClarifyQuestionItem,
  DispatchStatus,
  NoticeItem,
  NoticeKind,
  Presentation,
  RequestState,
  StatusItem,
  Subagent,
  SubagentGroupItem,
  SubagentNode,
  SubagentStatus,
  SubagentStreamEntry,
  ToolItem,
  ToolOutputRisk,
  ToolStatus,
  TranscriptItem,
  TranscriptItemKind,
  UserItem,
  Verbosity,
  VisibleItem
} from '@hermie/transcript'

/** Delivery state under the last own bubble, the way a messenger shows it. */
export type Receipt = 'sending' | 'sent' | 'delivered' | 'read'

/** One slash command offered by the composer's autocomplete. */
export interface SlashSuggestion {
  name: string
  description: string
}

/** A file or image staged in the composer's attachment tray. */
export interface ComposerAttachment {
  id: string
  name: string
  /** Local URI for the thumbnail; absent for a non-image attachment. */
  uri?: string
}

/** One entry in a picker sheet row (reasoning effort, model). */
export interface PickerOption {
  value: string
  label: string
  detail?: string
  /** Asks the caller to confirm before switching, per `confirm_expensive_model`. */
  expensive?: boolean
}
