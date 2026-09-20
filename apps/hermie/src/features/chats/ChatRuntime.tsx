/**
 * Wires the chat layer to the app's one gateway connection.
 *
 * The controllers below are plain objects with no React in them; this component
 * exists only to give them a lifetime, hand them the live connection, and follow
 * the app between foreground and background. Everything a screen needs is read
 * from the stores, so nothing re-renders because a controller did something.
 */
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AppState } from 'react-native'

import { useGateway } from '../../gateway'
import { chatGatewayFor } from '../../gateway/link'
import { chatCache } from '../../platform/chat-cache'
import { RUNS_ON_MAC } from '../../platform/runs-on-mac'
import { useBotsStore } from '../../store/bots'
import { useChatLayoutStore } from '../../store/chat-layout'
import { useChatsStore } from '../../store/chats'
import { useSettingsStore } from '../../store/settings'
import { BotsController } from '../bots/bots-controller'
import { ChatController } from './chat-controller'

export interface ChatRuntimeValue {
  controller: ChatController
  bots: BotsController
}

const ChatRuntimeContext = createContext<ChatRuntimeValue | null>(null)

export function ChatRuntimeProvider({ children }: { children: ReactNode }) {
  const { config, connection, http, status } = useGateway()
  const [value, setValue] = useState<ChatRuntimeValue | null>(null)
  const valueRef = useRef<ChatRuntimeValue | null>(null)

  useEffect(() => {
    void useSettingsStore.getState().hydrate()
    void useBotsStore.getState().hydrateLastSeen()
  }, [])

  // The list's arrangement is stored per gateway, so it is read when the
  // gateway is known rather than at startup: "Change gateway" then starts with
  // an empty arrangement and "Sign out" keeps the one it had, with no clean-up
  // code on either path (ADR-0012).
  useEffect(() => {
    if (config?.baseUrl) {
      void useChatLayoutStore.getState().load(config.baseUrl)
    } else {
      useChatLayoutStore.getState().reset()
    }
  }, [config?.baseUrl])

  useEffect(() => {
    if (!connection) {
      useChatsStore.getState().reset()
      useBotsStore.getState().reset()
      setValue(null)
      valueRef.current = null

      return
    }

    const gateway = chatGatewayFor(connection)
    // The chat store is handed over read-only: `session.active_list` answers for
    // the whole gateway process and carries no profile, so the roster attributes
    // a busy session to a bot through the ids its chat is known under.
    const bots = new BotsController({ gateway, store: useBotsStore, cache: chatCache, chats: useChatsStore })
    const controller = new ChatController({
      gateway,
      chats: useChatsStore,
      bots: useBotsStore,
      botsController: bots,
      // The REST half, for file uploads. It is built with the connection and
      // replaced with it, which is why it is not a dependency of its own.
      http,
      cache: chatCache
    })

    controller.start()
    // Only the cache here. The roster itself is read once the connection is
    // READY; see below.
    void bots.paintFromCache()

    const next = { controller, bots }
    valueRef.current = next
    setValue(next)

    return () => {
      controller.stop()
      bots.dispose()
      valueRef.current = null
    }
    // `http` is built with the connection and handed out as a ref, like the
    // connection itself, so listing it costs no extra rebuild — and leaving it
    // out would hand the controller a stale one if that ever changed.
  }, [connection, http])

  /**
   * Read the roster when the connection becomes usable, and again after every
   * reconnect.
   *
   * A `GatewayConnection` exists from the moment a gateway is configured, long
   * before its socket is up, and `profiles.list` on one that is still dialling
   * fails with "gateway not connected". That failure was the whole story: it
   * happened once, right after onboarding, nothing asked again, and the chat
   * list sat on an error while the header two lines above it said Connected.
   */
  const wasReady = useRef(false)

  useEffect(() => {
    if (!value || status !== 'ready') {
      wasReady.current = false

      return
    }

    if (wasReady.current) {
      return
    }

    wasReady.current = true
    void value.bots.refresh().catch(() => undefined)
  }, [status, value])

  /**
   * The chat side of the app lifecycle, and the one place a Mac differs.
   *
   * `onBackground()` clears `foregrounded`, which stops the approval and
   * subagent polls — right on a phone, where a backgrounded app has no socket
   * either (see `attachLifecycle`). A Mac window keeps its socket, so stopping
   * the polls would leave an agent's question unanswered while the window sat
   * one Cmd+Tab away. The native macOS target ignored AppState outright for
   * this; `foregrounded` starts `true`, so simply not calling it keeps a Mac in
   * the state that target was always in.
   *
   * `persistAll()` runs either way. Writing the cache when the window is hidden
   * costs nothing and is the one moment worth writing at.
   */
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      const runtime = valueRef.current

      if (!runtime) {
        return
      }

      if (state === 'active') {
        void runtime.controller.onForeground()
      } else if (state === 'background') {
        if (!RUNS_ON_MAC) {
          runtime.controller.onBackground()
        }

        void runtime.controller.persistAll()
      }
    })

    return () => subscription.remove()
  }, [])

  const memo = useMemo(() => value, [value])

  return <ChatRuntimeContext.Provider value={memo}>{children}</ChatRuntimeContext.Provider>
}

/** The chat runtime, or `null` before the gateway connection exists. */
export function useChatRuntime(): ChatRuntimeValue | null {
  return useContext(ChatRuntimeContext)
}
