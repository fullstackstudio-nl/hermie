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

import { requestOpenChat } from '../../app/open-chat-bus'
import { useGateway } from '../../gateway'
import { chatGatewayFor, type ChatGateway } from '../../gateway/link'
import { useConnectionStore } from '../../gateway/store'
import { chatCache } from '../../platform/chat-cache'
import { RUNS_ON_MAC } from '../../platform/runs-on-mac'
import { useBotsStore } from '../../store/bots'
import { useChatLayoutStore } from '../../store/chat-layout'
import { useChatsStore } from '../../store/chats'
import { usePushStore } from '../../store/push'
import { useSettingsStore } from '../../store/settings'
import { UiMetaBridge } from '../../store/ui-meta-bridge'
import { BotsController } from '../bots/bots-controller'
import { pushPlatform } from '../push/platform'
import { PushSync } from '../push/push-sync'
import { setPushRetire } from '../push/runtime'
import { pushProjectId, pushVapidUrl } from '../push/where'
import { WidgetSync } from '../widgets'
import { ChatController } from './chat-controller'

export interface ChatRuntimeValue {
  controller: ChatController
  bots: BotsController
  /** ADR-0016's settings sync. Local-only until a gateway takes a write. */
  uiMeta: UiMetaBridge
  /** Writes the file the home-screen widgets read. No-op where there is none. */
  widgets: WidgetSync
  /** ADR-0017: the registration, the heartbeat, and what a tap is allowed to do. */
  push: PushSync
  /** The connection, as the slice everything in here is written against. */
  gateway: ChatGateway
}

const ChatRuntimeContext = createContext<ChatRuntimeValue | null>(null)

export function ChatRuntimeProvider({ children }: { children: ReactNode }) {
  const { config, connection, http, status } = useGateway()
  const [value, setValue] = useState<ChatRuntimeValue | null>(null)
  const valueRef = useRef<ChatRuntimeValue | null>(null)

  useEffect(() => {
    void useSettingsStore.getState().hydrate()
    void useBotsStore.getState().hydrateLastSeen()
    // Before any gateway exists, because the installation id it mints is what
    // every later write of the push section is addressed by.
    void usePushStore.getState().hydrate()
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
    // ADR-0016. It is built here rather than in a store because it needs the
    // live connection and has to die with it: a sync holding a socket that has
    // been replaced would write this gateway's arrangement to the next one.
    const uiMeta = new UiMetaBridge({
      // `ChatGateway.request` is typed against the generated contract, which is
      // stricter than the two methods `UiMetaSync` names by string. The cast is
      // at the seam rather than inside the sync, so the sync stays testable with
      // two hand-written functions.
      gateway: { request: (method, params) => gateway.request(method as 'profiles.list', params) }
    })
    const stopWatching = uiMeta.start()
    // Built with the connection for the same reason the bridge above is: the
    // roster and the open chats are emptied when a connection goes, and a sync
    // that outlived one would keep writing the previous gateway's bots onto the
    // home screen. It reads stores rather than the socket, so it needs no
    // gateway of its own — only to be told when that socket is usable.
    const widgets = new WidgetSync()
    const stopWidgets = widgets.start()

    const controller = new ChatController({
      gateway,
      chats: useChatsStore,
      bots: useBotsStore,
      botsController: bots,
      // The REST half, for file uploads. It is built with the connection and
      // replaced with it, which is why it is not a dependency of its own.
      http,
      cache: chatCache,
      // Every gateway refusal the controller absorbs goes here, and the debug
      // screen reads it. The alternative is what shipped: `catch {}`.
      onRpcFailure: failure => useConnectionStore.getState().noteRpcFailure(failure)
    })

    /*
      ADR-0017's three ports, all of them resolved against the gateway rather
      than against anything the notification said. `showChat` deliberately does
      BOTH halves: the controller resumes the session — which is what gives
      `approval.pending` a `session_id` to ask about — and the bus tells
      whichever shell is mounted to navigate. A bot the roster does not have is
      not an error; the navigation still happens and the shell says what it
      finds.
    */
    const push = new PushSync({
      platform: pushPlatform,
      projectId: pushProjectId(),
      vapidUrl: pushVapidUrl(),
      // A registration that never happened lands in the same ring the
      // controller's absorbed gateway refusals do, so it outlives the settings
      // screen and the debug screen can read it.
      onFailure: failure => useConnectionStore.getState().noteRpcFailure(failure),
      ports: {
        showChat: async name => {
          requestOpenChat(name)

          const bot = useBotsStore.getState().byName[name]

          if (bot) {
            await controller.openChat(bot).catch(() => undefined)
          }
        },
        openApprovals: name => controller.openApprovals(name),
        respondApproval: (name, requestId, choice) => controller.respondApproval(name, requestId, choice)
      }
    })
    const stopPush = push.start()

    /*
      The one thing that has to happen BEFORE this connection goes away. See
      `features/push/runtime.ts`: `GatewayProvider` tears the socket down first
      and this component is unmounted by the same change, so the removal is
      registered as a callback the provider can await rather than run from here.
    */
    setPushRetire(async () => {
      await push.retire()
      await uiMeta.sync.flush()
    })

    controller.start()
    // Only the cache here. The roster itself is read once the connection is
    // READY; see below.
    void bots.paintFromCache()

    const next = { controller, bots, uiMeta, widgets, push, gateway }
    valueRef.current = next
    setValue(next)

    return () => {
      controller.stop()
      bots.dispose()
      stopWatching()
      stopWidgets()
      stopPush()
      setPushRetire(null)
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
    // The settings reconcile rides on the same edge, and deliberately AFTER the
    // roster: `hermie-app` lives on the default profile, and which profile that
    // is comes out of `profiles.list`.
    void value.uiMeta.reconcile().catch(() => undefined)
  }, [status, value])

  /**
   * Tell the widget sync whether the socket is usable.
   *
   * Its own effect rather than a line in the one above, because that one fires
   * on the RISING edge only — it guards on `wasReady` so a reconnect does not
   * re-read the roster twice — and a widget has to hear about the falling edge
   * as well. `presenceOf` turns an unusable gateway into `offline` for every
   * bot, and four green dots for a gateway the phone cannot reach is the one
   * lie a surface nobody can tap through is not allowed to tell.
   */
  useEffect(() => {
    value?.widgets.setGatewayReady(status === 'ready')
  }, [status, value])

  /**
   * Reconcile again when the gateway says a profile changed.
   *
   * `ui_meta` is on the profile row, so another client writing its own section
   * is a profile change and nothing else — there is no event that means "the
   * settings moved". Reading the roster again is cheap and it is the only signal
   * there is.
   */
  useEffect(() => {
    if (!value) {
      return
    }

    return value.gateway.on('sessions.changed', () => {
      void value.uiMeta.reconcile().catch(() => undefined)
    })
  }, [value])

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
        // The reader has just come back from the home screen they were looking
        // at, so the next thing worth doing is making what they saw there true.
        runtime.widgets.resume()
        // ADR-0017's freshness pass, and the heartbeat's other half: a token
        // that changed while the app was away is re-read here, and `seen` only
        // means anything while somebody is actually looking.
        runtime.push.setForeground(true)
        void runtime.push.refresh().catch(() => undefined)
      } else if (state === 'background') {
        // FIRST in this branch, before anything that could tear a socket down:
        // this writes the widget file while the gateway is still the
        // foreground's, and then stops writing. See `WidgetSync.pause` for the
        // four grey beads that cost.
        runtime.widgets.pause()

        if (!RUNS_ON_MAC) {
          runtime.controller.onBackground()
        }

        // Unconditionally, Mac included: `seen` says "somebody is reading this
        // right now", and a window behind another window is not that.
        runtime.push.setForeground(false)

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
