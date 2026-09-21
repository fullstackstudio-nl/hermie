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
  CronDeliveryItem,
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
  /**
   * The whole line accepting this row produces.
   *
   * The caller builds it, because only the caller knows what the gateway said
   * its answer replaces (`complete.slash`'s `replace_from`) — which is how the
   * same list completes a command name and then an argument to it. Absent means
   * "a bare command", and the composer writes `/name `.
   */
  insert?: string
}

/**
 * A completion call the gateway would not answer, as the popover prints it.
 *
 * Structurally the same two fields the controller produces
 * (`features/chats/chat-controller.ts`), declared here so the chat-ui layer
 * does not import from a feature to draw one of its own rows.
 */
export interface SlashFailure {
  /** The JSON-RPC method that refused, e.g. `commands.catalog`. */
  method: string
  /** The gateway's own words, with its code in front when it sent one. */
  reason: string
}

/**
 * A file or image staged in the composer's attachment tray.
 *
 * `kind` is not derived from `uri`: an image and a file leave by different roads
 * (bytes over the socket versus an HTTP upload the prompt then references), and a
 * file the platform happened to give a preview for would otherwise be drawn as a
 * thumbnail and sent as bytes.
 */
export interface ComposerAttachment {
  id: string
  name: string
  kind: 'image' | 'file'
  /** Local URI for the thumbnail; only an image has one. */
  uri?: string
  /** Bytes, when the picker reported a size. */
  size?: number
  /**
   * Where the upload is.
   *
   * `uploading` with no `progress` is the ordinary case rather than an omission:
   * React Native's `fetch` has no upload-progress event, so the chip shows an
   * indeterminate ring instead of inventing a curve that stalls at 90 %.
   */
  status?: 'staged' | 'uploading' | 'uploaded' | 'error'
  /** 0…1 on a platform that reports it. */
  progress?: number
  /** Why it will not be sent, already in the reader's words. */
  error?: string
}

/** One entry in the composer's `+` menu. */
export interface AttachChoice {
  id: 'photo' | 'file'
  label: string
  /** Shows a busy state until the system picker is actually up. */
  busy?: boolean
}

/** One entry in a picker sheet row (reasoning effort, model). */
export interface PickerOption {
  value: string
  label: string
  detail?: string
  /** Asks the caller to confirm before switching, per `confirm_expensive_model`. */
  expensive?: boolean
}
