/**
 * Wires the chat layer to the app's one gateway connection.
 *
 * The controllers below are plain objects with no React in them; this component
 * exists only to give them a lifetime, hand them the live connection, and follow
 * the app between foreground and background. Everything a screen needs is read
 * from the stores, so nothing re-renders because a controller did something.
 */
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AppState, Platform } from 'react-native'

import { useGateway } from '../../gateway'
import { chatGatewayFor } from '../../gateway/link'
import { chatCache } from '../../platform/chat-cache'
import { useBotsStore } from '../../store/bots'
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
  const { connection, status } = useGateway()
  const [value, setValue] = useState<ChatRuntimeValue | null>(null)
  const valueRef = useRef<ChatRuntimeValue | null>(null)

  useEffect(() => {
    void useSettingsStore.getState().hydrate()
    void useBotsStore.getState().hydrateLastSeen()
  }, [])

  useEffect(() => {
    if (!connection) {
      useChatsStore.getState().reset()
      useBotsStore.getState().reset()
      setValue(null)
      valueRef.current = null

      return
    }

    const gateway = chatGatewayFor(connection)
    const bots = new BotsController({ gateway, store: useBotsStore, cache: chatCache })
    const controller = new ChatController({
      gateway,
      chats: useChatsStore,
      bots: useBotsStore,
      botsController: bots,
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
  }, [connection])

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

  useEffect(() => {
    // macOS windows are never backgrounded the way a phone app is, and its
    // AppState reports states this would misread.
    if (Platform.OS === 'macos') {
      return
    }

    const subscription = AppState.addEventListener('change', state => {
      const runtime = valueRef.current

      if (!runtime) {
        return
      }

      if (state === 'active') {
        void runtime.controller.onForeground()
      } else if (state === 'background') {
        runtime.controller.onBackground()
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
