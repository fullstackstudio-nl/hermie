/**
 * One desktop shortcut, delivered to whoever registered it last.
 *
 * Deliberately the same shape as `useEscapeKey`, and for the same reason: the
 * event arrives from the keyboard seam with no notion of what is on screen, so
 * something has to decide who gets it. A stack per action does, with the rule a
 * reader already expects — the thing that opened last wins — so ⌘1 typed while a
 * sheet is up can be swallowed by that sheet without the chat list knowing.
 *
 * One native subscription is held for every action rather than one per caller,
 * because the event is global anyway and a listener per registration would make
 * the delivery order depend on the subscription order instead of on this.
 *
 * **`close` is not registrable.** ⌘W is defined as "one level, like Escape", so it
 * is delivered to the Escape stack and nothing else. Two stacks that both claim to
 * mean "close one level" would be two stacks to keep in agreement.
 */
import { useEffect, useRef } from 'react'

import { subscribeToShortcuts, type ShortcutAction } from '../platform/desktop-shortcuts'
import { closeTopmost } from './useEscapeKey'

/** Everything a screen may claim. `close` is handled by the Escape stack instead. */
export type RegistrableShortcut = Exclude<ShortcutAction, 'close'>

type Entry = { fire: () => void }

const stacks = new Map<RegistrableShortcut, Entry[]>()
let detach: (() => void) | null = null
let registrations = 0

function deliver(action: ShortcutAction): void {
  if (action === 'close') {
    closeTopmost()

    return
  }

  const stack = stacks.get(action)

  stack?.[stack.length - 1]?.fire()
}

/**
 * Take `action` while `enabled`.
 *
 * `enabled` is the visibility of whatever is registering. Flipping it is what
 * pushes and pops, so a caller never has to think about ordering.
 */
export function useShortcut(action: RegistrableShortcut, handler: () => void, enabled = true): void {
  // The handler is read through a ref so a new closure on every render does not
  // re-order the stack.
  const latest = useRef(handler)

  latest.current = handler

  useEffect(() => {
    if (!enabled) {
      return
    }

    const entry: Entry = { fire: () => latest.current() }
    const stack = stacks.get(action) ?? []

    stack.push(entry)
    stacks.set(action, stack)
    registrations += 1

    if (registrations === 1) {
      detach = subscribeToShortcuts(deliver)
    }

    return () => {
      const index = stack.lastIndexOf(entry)

      if (index >= 0) {
        stack.splice(index, 1)
        registrations -= 1
      }

      if (registrations === 0) {
        detach?.()
        detach = null
      }
    }
  }, [action, enabled])
}

/**
 * ⌘1…9, as one registration.
 *
 * The chat list is the only caller and it always wants all nine, so nine hooks at
 * the call site would be nine chances to get the index wrong. `index` is
 * zero-based, which is what a list wants; the shortcut is one-based, which is what
 * a keyboard has.
 */
export function useNumberedShortcuts(handler: (index: number) => void, enabled = true): void {
  const latest = useRef(handler)

  latest.current = handler

  useShortcut('chat1', () => latest.current(0), enabled)
  useShortcut('chat2', () => latest.current(1), enabled)
  useShortcut('chat3', () => latest.current(2), enabled)
  useShortcut('chat4', () => latest.current(3), enabled)
  useShortcut('chat5', () => latest.current(4), enabled)
  useShortcut('chat6', () => latest.current(5), enabled)
  useShortcut('chat7', () => latest.current(6), enabled)
  useShortcut('chat8', () => latest.current(7), enabled)
  useShortcut('chat9', () => latest.current(8), enabled)
}
