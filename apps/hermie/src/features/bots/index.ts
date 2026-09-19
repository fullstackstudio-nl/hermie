// The bot roster: who lives on this gateway, and which of them is busy.
export {
  ACTIVE_LIST_POLL_MS,
  BotsController,
  type BotsControllerOptions,
  CANONICAL_CHAT_TITLE,
  PROFILE_SESSION_LIST_LIMIT,
  SESSION_COLUMNS
} from './bots-controller'
export { BotsScreen, BotsScreenOrSignedOut, type BotsScreenProps } from './BotsScreen'
export {
  CHAT_FILTERS,
  matchesFilter,
  presenceOf,
  type ChatFilter,
  type Presence,
  type PresenceInput,
  type PresenceState
} from './presence'
export { ConnectionLine } from './ConnectionLine'
export { SidebarFooter, type BotsSection, type TabKey } from './SidebarFooter'
