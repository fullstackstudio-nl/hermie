/**
 * Waiting for the reply "Ask a bot" returns.
 *
 * Two races decide the shape of this, and both are in the tests below because
 * neither is obvious from the code:
 *
 *  - a gateway fast enough to finish the turn before the caller gets back;
 *  - a prompt parked behind a turn that was already running, so the first turn
 *    to END is not the one that was asked about.
 *
 * Both are handled by taking a marker of what the bot last said BEFORE the
 * prompt goes, which is why `watchReply` is called first and the send second.
 */
import type { ChatState } from '@hermie/transcript'

import { lastReplyOf, watchReply } from '../src/features/intents/await-reply'

type Listener = () => void

function chatWith(items: { id: string; kind: string; text?: string; interim?: boolean }[], active = false) {
  return {
    order: items.map(item => item.id),
    items: Object.fromEntries(items.map(item => [item.id, item])),
    turn: { active }
  } as unknown as ChatState
}

function storeWith(initial: ChatState) {
  const listeners = new Set<Listener>()
  let chat = initial

  return {
    store: {
      getState: () => ({ chats: { researcher: chat } }),
      subscribe: (listener: Listener) => {
        listeners.add(listener)

        return () => listeners.delete(listener)
      }
    },
    set(next: ChatState) {
      chat = next
      for (const listener of [...listeners]) {
        listener()
      }
    }
  }
}

describe('lastReplyOf', () => {
  it('takes the last thing the bot SAID, not the last row', () => {
    const chat = chatWith([
      { id: 'a', kind: 'assistant', text: 'the answer' },
      { id: 'b', kind: 'tool' },
      { id: 'c', kind: 'notice' }
    ])

    expect(lastReplyOf(chat)).toEqual({ id: 'a', text: 'the answer' })
  })

  /**
   * Mid-turn commentary the gateway seals before the real reply. Returning it
   * would hand a Shortcut "Let me look that up" as the answer.
   */
  it('skips an interim bubble', () => {
    const chat = chatWith([
      { id: 'a', kind: 'assistant', text: 'the answer' },
      { id: 'b', kind: 'assistant', text: 'let me look', interim: true }
    ])

    expect(lastReplyOf(chat)?.id).toBe('a')
  })

  it('answers nothing for a chat with nothing in it', () => {
    expect(lastReplyOf(undefined)).toBeNull()
    expect(lastReplyOf(chatWith([]))).toBeNull()
  })
})

describe('watchReply', () => {
  it('does not mistake the reply that was already there for the one it is waiting for', async () => {
    const { store } = storeWith(chatWith([{ id: 'a', kind: 'assistant', text: 'already here' }]))

    // The marker is taken at CALL time, so a reply that arrived before the
    // watch started is not the one it is waiting for — this is the marker
    // itself, and the watch keeps going.
    const settled = jest.fn()

    void watchReply({ chats: store, botName: 'researcher', timeoutMs: 10 }).then(settled)
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(settled).not.toHaveBeenCalled()
  })

  it('answers with the NEXT reply once the turn ends', async () => {
    const { set, store } = storeWith(chatWith([{ id: 'a', kind: 'assistant', text: 'old' }]))
    const waiting = watchReply({ chats: store, botName: 'researcher', timeoutMs: 1_000 })

    set(chatWith([{ id: 'a', kind: 'assistant', text: 'old' }], true))
    set(
      chatWith(
        [
          { id: 'a', kind: 'assistant', text: 'old' },
          { id: 'b', kind: 'assistant', text: 'new' }
        ],
        true
      )
    )
    set(
      chatWith([
        { id: 'a', kind: 'assistant', text: 'old' },
        { id: 'b', kind: 'assistant', text: 'new' }
      ])
    )

    await expect(waiting).resolves.toBe('new')
  })

  /**
   * The parked-prompt race. A turn was already running when the request was
   * made, so `ChatController.send` queues it — and the first turn to end is
   * somebody else's.
   */
  it('does not answer with the turn that was already running', async () => {
    const running = chatWith([{ id: 'a', kind: 'assistant', text: 'previous' }], true)
    const { set, store } = storeWith(running)
    const waiting = watchReply({ chats: store, botName: 'researcher', timeoutMs: 1_000 })

    // The previous turn ends. Its reply is the marker, so nothing is answered.
    set(chatWith([{ id: 'a', kind: 'assistant', text: 'previous' }]))
    await new Promise(resolve => setTimeout(resolve, 0))

    // Ours runs and ends.
    set(
      chatWith([
        { id: 'a', kind: 'assistant', text: 'previous' },
        { id: 'b', kind: 'assistant', text: 'ours' }
      ])
    )

    await expect(waiting).resolves.toBe('ours')
  })

  it('answers null when the budget runs out', async () => {
    const { store } = storeWith(chatWith([{ id: 'a', kind: 'assistant', text: 'old' }], true))

    await expect(watchReply({ chats: store, botName: 'researcher', timeoutMs: 5 })).resolves.toBeNull()
  })

  /**
   * An interruption, a tool-only turn, an error. A Shortcut that returned an
   * empty string for any of those would look like it had worked.
   */
  it('answers null for a turn that ended with nothing to say', async () => {
    const { set, store } = storeWith(chatWith([], true))
    const waiting = watchReply({ chats: store, botName: 'researcher', timeoutMs: 1_000 })

    set(chatWith([{ id: 'b', kind: 'assistant', text: '' }]))

    await expect(waiting).resolves.toBeNull()
  })

  it('stops listening once it has answered', async () => {
    const { set, store } = storeWith(chatWith([], true))
    const waiting = watchReply({ chats: store, botName: 'researcher', timeoutMs: 1_000 })

    set(chatWith([{ id: 'b', kind: 'assistant', text: 'first' }]))
    await expect(waiting).resolves.toBe('first')

    // A later turn must not be able to settle an already-settled promise, which
    // would be an unhandled state rather than a visible bug.
    expect(() => set(chatWith([{ id: 'c', kind: 'assistant', text: 'second' }]))).not.toThrow()
  })
})
