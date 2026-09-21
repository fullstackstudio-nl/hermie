/**
 * The conversations beside the canonical chat: the model, the page, the viewer.
 *
 * New screens for this round go here rather than into `features/chats`, which is
 * about the ONE chat a bot has (ADR-0007). This is about the fact that the one
 * chat has a past and can be branched — a neighbouring idea, not the same one.
 */
export { ConversationsScreen, type ConversationsScreenProps } from './ConversationsScreen'
export { ConversationViewScreen, type ConversationViewScreenProps } from './ConversationViewScreen'
export {
  botOfConversationKey,
  branchCountFor,
  branchTitle,
  classifyConversations,
  conversationActions,
  conversationKey,
  isBranchTitle,
  isCanonicalKey,
  isRetiredTitle,
  sortConversations,
  storedIdOfConversationKey,
  type Conversation,
  type ConversationAction,
  type ConversationGroups,
  type ConversationKind
} from './session-model'
