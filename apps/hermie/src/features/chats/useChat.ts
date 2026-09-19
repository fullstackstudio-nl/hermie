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
  type SubagentNode,
  subagentTree,
  type TranscriptItem,
  type VisibleItem,
  visibleItems
} from '@hermie/transcript'
import type { CompletionItem, SessionLiveInfo } from '@hermes/shared/gateway-contract'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { type Bot, useBotsStore } from '../../store/bots'
import { useChatsStore } from '../../store/chats'
import { useChatView } from '../../store/settings'
import type { AttachmentInput, ChatOptionKey, ModelChoice, SetOptionResult } from './chat-controller'
import { type ChatRuntimeValue, useChatRuntime } from './ChatRuntime'

export interface UseChatResult {
  bot: Bot | undefined
  /** Undefined until the chat has been created; the screen shows a spinner. */
  botName: string
  items: VisibleItem[]
  draft: string
  /** Anything running: the turn, a tool, a child. Drives the header and composer. */
  busy: boolean
  /**
   * The TURN specifically. Narrower than `busy` on purpose: the typing dots
   * mean "a reply is coming", and a chat whose turn ended while a sub-agent
   * keeps working is not about to say anything.
   */
  turnActive: boolean
  hydration: 'cold' | 'cached' | 'hydrating' | 'live' | 'stale' | 'error'
  /** Approval and clarify cards still waiting on the user. */
  requests: TranscriptItem[]
  subagents: Subagent[]
  /** The same children as a tree, for the agents sheet. */
  subagentTree: SubagentNode[]
  /** A prompt the backend parked behind the running turn. */
  queuedText: string | undefined
  /** The gateway's view of this session: yolo, fast, reasoning effort, model. */
  info: SessionLiveInfo | undefined
  error: string | null
  setDraft: (draft: string) => void
  send: (text: string, attachments?: AttachmentInput[]) => Promise<void>
  stop: () => Promise<void>
  /** Tell the queue the sheet is on screen; safe to call more than once. */
  acknowledgeApproval: (requestId: string) => Promise<void>
  respondApproval: (requestId: string, choice: string, all?: boolean) => Promise<void>
  respondClarify: (requestId: string, answers: Record<string, string>) => Promise<void>
  lockClarify: (requestId: string, questionId: string, answer: string) => Promise<void>
  steerSubagent: (subagentId: string, text: string) => Promise<string>
  interruptSubagent: (subagentId: string) => Promise<boolean>
  tailSubagent: (subagentId: string) => Promise<string>
  /** The child's own stored transcript, for the full read-only view. */
  childTranscript: (childSessionId: string) => Promise<TranscriptItem[]>
  querySlash: (prefix: string) => Promise<CompletionItem[]>
  runSlash: (command: string) => Promise<void>
  setOption: (
    key: ChatOptionKey,
    value: string,
    options?: { confirmExpensiveModel?: boolean }
  ) => Promise<SetOptionResult>
  refreshOptions: () => Promise<void>
  /** The gateway's model inventory; empty when it cannot answer. */
  modelOptions: () => Promise<ModelChoice[]>
  reload: () => Promise<void>
}

export function useChat(botName: string): UseChatResult {
  const runtime = useChatRuntime()
  const bot = useBotsStore(state => state.byName[botName])
  const chat = useChatsStore(state => state.chats[botName])
  const view = useChatView(botName)
  const [error, setError] = useState<string | null>(null)
  // The bot AND the runtime that opened it. A new gateway connection builds a
  // new controller with empty stores, so remembering only the name leaves the
  // screen bound to a chat the live controller has never opened.
  const openedRef = useRef<{ botName: string; runtime: ChatRuntimeValue } | null>(null)

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
    if (!runtime || !bot) {
      return
    }

    const opened = openedRef.current

    if (opened?.botName === bot.name && opened.runtime === runtime) {
      return
    }

    openedRef.current = { botName: bot.name, runtime }
    void open()
  }, [bot, open, runtime])

  useEffect(() => {
    // Leaving the screen writes the cache and marks the chat read. It does NOT
    // detach: a teammate bot's message has to keep streaming in.
    return () => {
      const opened = openedRef.current

      if (opened) {
        void opened.runtime.controller.closeChat(opened.botName)
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

  const tree = useMemo(
    () => (chat ? subagentTree(chat) : []),
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
    turnActive: chat?.turn.active ?? false,
    hydration: chat?.hydration ?? 'cold',
    requests,
    subagents,
    subagentTree: tree,
    queuedText: chat?.queued?.text,
    info: chat?.info,
    error,
    setDraft: useCallback((draft: string) => useChatsStore.getState().setDraft(botName, draft), [botName]),
    send: useCallback(
      (text: string, attachments?: AttachmentInput[]) =>
        controller ? controller.send(botName, text, attachments) : notReady(),
      [botName, controller, notReady]
    ),
    stop: useCallback(() => (controller ? controller.stopTurn(botName) : Promise.resolve()), [botName, controller]),
    acknowledgeApproval: useCallback(
      (requestId: string) => (controller ? controller.acknowledgeApproval(botName, requestId) : Promise.resolve()),
      [botName, controller]
    ),
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
    childTranscript: useCallback(
      (childSessionId: string) => (controller ? controller.childTranscript(botName, childSessionId) : notReady()),
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
    modelOptions: useCallback(() => (controller ? controller.modelOptions() : Promise.resolve([])), [controller]),
    reload: open
  }
}
