/**
 * Which of a bot's two chats this reader is in, and where the private one is.
 *
 * `user-chat.ts` holds the rules; this holds the state that makes them cheap.
 * Three jobs, and the third is the one worth reading:
 *
 *  1. **Who is asking.** The identity comes from a function rather than a
 *     store import, so the roster and the chat controller can both be driven
 *     from a test with two lines and no React.
 *  2. **What they chose**, per bot, read the same way.
 *  3. **One resolution per bot, ever.** `resolve` memoises the answer and
 *     shares an in-flight lookup, exactly as `BotsController.resolveCanonical`
 *     does — for exactly the same reason. Two taps that both miss the registry
 *     are two `session.create` calls, and two private chats under one title is a
 *     conversation split in half with no way to put it back.
 *
 * The memo is dropped when the identity changes, because a chat resolved for
 * one person is not the other person's chat. That happens on a sign-out, on a
 * gateway switch, and nowhere else.
 */
import type { ChatGateway } from '../../gateway/link'
import type { Bot, BotCanonicalSession } from '../../store/bots'
import { type ChatChoice, type ChatIdentity, resolveUserChat, userChatTitle } from './user-chat'

export interface UserChatDirectoryOptions {
  gateway: ChatGateway
  /** Who the gateway says this is, or null while it has not said. */
  identity: () => ChatIdentity | null
  /** Which chat the reader asked for on this bot. */
  choice: (botName: string) => ChatChoice
}

export class UserChatDirectory {
  private readonly gateway: ChatGateway
  private readonly identity: () => ChatIdentity | null
  private readonly choice: (botName: string) => ChatChoice
  private readonly known = new Map<string, BotCanonicalSession>()
  private readonly running = new Map<string, Promise<BotCanonicalSession>>()
  /** The title the memo above belongs to, so a new person starts empty. */
  private memoTitle = ''

  constructor(options: UserChatDirectoryOptions) {
    this.gateway = options.gateway
    this.identity = options.identity
    this.choice = options.choice
  }

  /** The title this reader's chats carry, or '' when nobody has been named. */
  get title(): string {
    const title = userChatTitle(this.identity())

    if (title !== this.memoTitle) {
      // A different person (or none). Everything below was resolved for
      // somebody else and none of it is theirs.
      this.known.clear()
      this.running.clear()
      this.memoTitle = title
    }

    return title
  }

  /** Whether this gateway can offer a private chat at all. */
  get available(): boolean {
    return this.title.length > 0
  }

  /** Is this bot's chosen chat the reader's own? */
  chose(botName: string): boolean {
    return this.available && this.choice(botName) === 'mine'
  }

  /** What was resolved for this bot already, if anything. */
  cached(botName: string): BotCanonicalSession | null {
    return this.available ? (this.known.get(botName) ?? null) : null
  }

  /**
   * This reader's chat on this bot, resolving it if this is the first ask.
   *
   * `bot.canonical` is handed on as the parent, which is right exactly while it
   * still names the SHARED chat — the state a bot is in until its private chat
   * has been resolved once. After that the parent is only read on a mint, and a
   * mint only happens when the chat is missing, which is the case where the
   * parent no longer matters.
   */
  resolve(bot: Bot): Promise<BotCanonicalSession> {
    const title = this.title

    if (!title) {
      return Promise.reject(new Error('This gateway has not said who you are, so there is no private chat to open.'))
    }

    const cached = this.known.get(bot.name)

    if (cached) {
      return Promise.resolve(cached)
    }

    const existing = this.running.get(bot.name)

    if (existing) {
      return existing
    }

    const run = resolveUserChat({
      gateway: this.gateway,
      profile: bot.name,
      title,
      ...(bot.canonical?.id ? { parentSessionId: bot.canonical.id } : {})
    })
      .then(session => {
        // Only remember it if this is still the same person's directory: a
        // sign-out that landed mid-flight has already cleared the memo, and
        // writing into it now would hand the next reader somebody else's chat.
        if (this.memoTitle === title) {
          this.known.set(bot.name, session)
        }

        return session
      })
      .finally(() => {
        this.running.delete(bot.name)
      })

    this.running.set(bot.name, run)

    return run
  }

  /** Forget one bot's private chat — it was deleted, or the bot was. */
  forget(botName: string): void {
    this.known.delete(botName)
    this.running.delete(botName)
  }
}
