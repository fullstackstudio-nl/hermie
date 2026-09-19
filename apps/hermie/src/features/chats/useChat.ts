/**
 * The hook a chat screen talks to.
 *
 * It opens the chat on mount, keeps it live afterwards, and hands back the
 * transcript already filtered through the view settings. The actions are thin
 * bindings onto the controller — no logic lives here, so a screen can be
 * replaced wholesale without any of the protocol moving with it.
 */
import {
  isBusy,
  itemsVersion,
  openRequests,
  runningSubagents,
  type Subagent,
  type TranscriptItem,
  type VisibleItem,
  visibleItems
} from '@hermie/transcript'
import type { CompletionItem } from '@hermes/shared/gateway-contract'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { type Bot, useBotsStore } from '../../store/bots'
import { useChatsStore } from '../../store/chats'
import { useChatView } from '../../store/settings'
import type { AttachmentInput, ChatOptionKey, SetOptionResult } from './chat-controller'
import { useChatRuntime } from './ChatRuntime'

export interface UseChatResult {
  bot: Bot | undefined
  /** Undefined until the chat has been created; the screen shows a spinner. */
  botName: string
  items: VisibleItem[]
  draft: string
  busy: boolean
  hydration: 'cold' | 'cached' | 'hydrating' | 'live' | 'stale' | 'error'
  /** Approval and clarify cards still waiting on the user. */
  requests: TranscriptItem[]
  subagents: Subagent[]
  error: string | null
  setDraft: (draft: string) => void
  send: (text: string, attachments?: AttachmentInput[]) => Promise<void>
  stop: () => Promise<void>
  respondApproval: (requestId: string, choice: string, all?: boolean) => Promise<void>
  respondClarify: (requestId: string, answers: Record<string, string>) => Promise<void>
  lockClarify: (requestId: string, questionId: string, answer: string) => Promise<void>
  steerSubagent: (subagentId: string, text: string) => Promise<string>
  interruptSubagent: (subagentId: string) => Promise<boolean>
  tailSubagent: (subagentId: string) => Promise<string>
  querySlash: (prefix: string) => Promise<CompletionItem[]>
  runSlash: (command: string) => Promise<void>
  setOption: (
    key: ChatOptionKey,
    value: string,
    options?: { confirmExpensiveModel?: boolean }
  ) => Promise<SetOptionResult>
  refreshOptions: () => Promise<void>
  reload: () => Promise<void>
}

export function useChat(botName: string): UseChatResult {
  const runtime = useChatRuntime()
  const bot = useBotsStore(state => state.byName[botName])
  const chat = useChatsStore(state => state.chats[botName])
  const view = useChatView(botName)
  const [error, setError] = useState<string | null>(null)
  const openedRef = useRef<string | null>(null)

  const open = useCallback(async () => {
    if (!runtime || !bot) {
      return
    }

    try {
      setError(null)
      await runtime.controller.openChat(bot)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }, [bot, runtime])

  useEffect(() => {
    if (!runtime || !bot || openedRef.current === bot.name) {
      return
    }

    openedRef.current = bot.name
    void open()
  }, [bot, open, runtime])

  useEffect(() => {
    // Leaving the screen writes the cache and marks the chat read. It does NOT
    // detach: a teammate bot's message has to keep streaming in.
    return () => {
      if (openedRef.current) {
        void runtime?.controller.closeChat(openedRef.current)
      }
    }
  }, [runtime])

  // `visibleItems` does no caching of its own, by design; this is where the
  // memo it expects lives. `itemsVersion` changes whenever any item mutates.
  const version = chat ? itemsVersion(chat) : 0
  const items = useMemo(
    () => (chat ? visibleItems(chat, view) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version, chat?.botName, view.level, view.showBotToBot, view.showThinking]
  )

  const requests = useMemo(
    () => (chat ? openRequests(chat) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version, chat?.botName]
  )

  const subagents = useMemo(
    () => (chat ? runningSubagents(chat) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version, chat?.botName]
  )

  const controller = runtime?.controller

  const notReady = useCallback(() => Promise.reject(new Error('The chat is not connected yet.')), [])

  return {
    bot,
    botName,
    items,
    draft: chat?.draft ?? '',
    busy: chat ? isBusy(chat) : false,
    hydration: chat?.hydration ?? 'cold',
    requests,
    subagents,
    error,
    setDraft: useCallback((draft: string) => useChatsStore.getState().setDraft(botName, draft), [botName]),
    send: useCallback(
      (text: string, attachments?: AttachmentInput[]) =>
        controller ? controller.send(botName, text, attachments) : notReady(),
      [botName, controller, notReady]
    ),
    stop: useCallback(() => (controller ? controller.stopTurn(botName) : Promise.resolve()), [botName, controller]),
    respondApproval: useCallback(
      (requestId: string, choice: string, all?: boolean) =>
        controller ? controller.respondApproval(botName, requestId, choice, all) : notReady(),
      [botName, controller, notReady]
    ),
    respondClarify: useCallback(
      (requestId: string, answers: Record<string, string>) =>
        controller ? controller.respondClarify(botName, requestId, answers) : notReady(),
      [botName, controller, notReady]
    ),
    lockClarify: useCallback(
      (requestId: string, questionId: string, answer: string) =>
        controller ? controller.lockClarify(botName, requestId, questionId, answer) : notReady(),
      [botName, controller, notReady]
    ),
    steerSubagent: useCallback(
      (subagentId: string, text: string) =>
        controller ? controller.steerSubagent(botName, subagentId, text) : notReady(),
      [botName, controller, notReady]
    ),
    interruptSubagent: useCallback(
      (subagentId: string) => (controller ? controller.interruptSubagent(botName, subagentId) : notReady()),
      [botName, controller, notReady]
    ),
    tailSubagent: useCallback(
      (subagentId: string) => (controller ? controller.tailSubagent(botName, subagentId) : notReady()),
      [botName, controller, notReady]
    ),
    querySlash: useCallback(
      (prefix: string) => (controller ? controller.querySlash(botName, prefix) : Promise.resolve([])),
      [botName, controller]
    ),
    runSlash: useCallback(
      (command: string) => (controller ? controller.runSlash(botName, command) : notReady()),
      [botName, controller, notReady]
    ),
    setOption: useCallback(
      (key: ChatOptionKey, value: string, options?: { confirmExpensiveModel?: boolean }) =>
        controller ? controller.setOption(botName, key, value, options) : notReady(),
      [botName, controller, notReady]
    ),
    refreshOptions: useCallback(async () => {
      await controller?.refreshOptions(botName)
    }, [botName, controller]),
    reload: open
  }
}
