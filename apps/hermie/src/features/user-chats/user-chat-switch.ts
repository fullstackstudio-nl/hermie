/**
 * The switch itself: "Shared Bot Chat" or "My chat", per bot.
 *
 * Two halves that have no business knowing about each other — the directory,
 * which resolves sessions over a socket, and the arrangement store, which
 * remembers what the reader asked for — joined here into the one object the
 * chat controller takes. Neither half imports the other, and a test can hand
 * the controller a literal instead of either.
 */
import type { Bot, BotCanonicalSession } from '../../store/bots'
import type { UserChatSource } from '../bots/bots-controller'
import type { ChatChoice } from './user-chat'

export interface UserChatSwitch extends UserChatSource {
  /** Whether this gateway named somebody, and therefore has a switch at all. */
  readonly available: boolean
  /** The title this reader's chats carry, or '' when nobody has been named. */
  readonly title: string
  /** Remember the reader's choice, so the roster and the next launch agree. */
  remember(botName: string, choice: ChatChoice): void
}

export interface UserChatSwitchParts {
  available: () => boolean
  title: () => string
  chose: (botName: string) => boolean
  cached: (botName: string) => BotCanonicalSession | null
  resolve: (bot: Bot) => Promise<BotCanonicalSession>
  remember: (botName: string, choice: ChatChoice) => void
}

export function userChatSwitch(parts: UserChatSwitchParts): UserChatSwitch {
  return {
    get available() {
      return parts.available()
    },
    get title() {
      return parts.title()
    },
    chose: parts.chose,
    cached: parts.cached,
    resolve: parts.resolve,
    remember: parts.remember
  }
}
