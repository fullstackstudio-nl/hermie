/**
 * One bot's chat, drawn with the chat UI kit.
 *
 * The screen owns three things and nothing else: which sheet is open, what the
 * composer is holding, and how far the reader has scrolled. Everything else is
 * read from `useChat` — the transcript already filtered through the view
 * settings, the open questions, the running children — so the gateway, the
 * reducer and the navigator stay out of this file entirely.
 *
 * Two arrangements worth knowing about:
 *
 *  - `ChatHeader` is the header on BOTH shells. The compact stack hides its own
 *    native header for this route (`CompactShell`), because the design board's
 *    header carries an avatar and a live subtitle that a stack title bar cannot.
 *  - Only ONE agent question is on screen at a time, the oldest first. The
 *    gateway can have several open at once, and a stack of sheets is how a user
 *    ends up answering the wrong one.
 */
import {
  findDmCounterpart,
  normalizeAgentTarget,
  type ApprovalItem,
  type ClarifyItem,
  type TranscriptItem,
  type Verbosity
} from '@hermie/transcript'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, View } from 'react-native'

import {
  AgentsBar,
  AgentsSheet,
  ChatHeader,
  chatStrings,
  Composer,
  type ComposerAttachment,
  type PickerOption,
  type SlashSuggestion,
  type SubagentTranscript,
  TranscriptList,
  type TranscriptListHandle
} from '../../chat-ui'
import { useGateway } from '../../gateway'
import { strings } from '../../i18n/strings'
import { haptic } from '../../platform/haptics'
import { useBotsStore } from '../../store/bots'
import { useChatsStore } from '../../store/chats'
import { hasChatViewOverride, useChatView, useSettingsStore } from '../../store/settings'
import { ApprovalSheet, ChatOptionsSheet, ClarifySheet } from '../../ui/sheets'
import { Screen, Text } from '../../ui/primitives'
import { useTheme } from '../../ui/theme'
import { attachmentKind, attachmentsSupported, pickAttachment, type PickedAttachment } from './attachments'
import type { ModelChoice } from './chat-controller'
import { useChat } from './useChat'

export interface OpenChatOptions {
  /**
   * Land on this item instead of at the bottom.
   *
   * A tapped DM card should open the OTHER bot's chat on the message it is
   * about — the whole point of showing bot-to-bot traffic is that a reader can
   * follow it across chats without searching for where it went.
   */
  focusItemId?: string
}

export type ChatScreenProps = {
  /** The compact shell passes the bot through navigation params. */
  route?: { params?: { bot?: string; focusItemId?: string } }
  /** The regular shell passes it directly. */
  bot?: string
  /** Scroll here once the transcript is on screen. */
  focusItemId?: string
  /** Shown as the header's back chevron; absent on the regular shell. */
  onBack?: () => void
  /** Open another bot's chat — a tapped DM card or sender chip. */
  onOpenBot?: (botName: string, options?: OpenChatOptions) => void
}

const REASONING_OPTIONS: PickerOption[] = [
  { value: 'none', label: 'Off', detail: 'No extra thinking' },
  { value: 'minimal', label: 'Minimal' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high' },
  { value: 'max', label: 'Max' },
  { value: 'ultra', label: 'Ultra' }
]

export function ChatScreen({ route, bot, focusItemId, onBack, onOpenBot }: ChatScreenProps) {
  const botName = bot ?? route?.params?.bot ?? ''
  const focus = focusItemId ?? route?.params?.focusItemId

  if (!botName) {
    return <NoBotSelected />
  }

  // Keyed on the bot so that switching conversations in the regular shell
  // starts from a clean composer and closed sheets rather than inheriting the
  // previous chat's.
  return <Conversation botName={botName} focusItemId={focus} key={botName} onBack={onBack} onOpenBot={onOpenBot} />
}

function NoBotSelected() {
  const theme = useTheme()

  return (
    <Screen>
      <View style={{ alignItems: 'center', flex: 1, gap: theme.space.sm, justifyContent: 'center' }}>
        <Text color="textMuted">{strings.chat.pickBot}</Text>
      </View>
    </Screen>
  )
}

type SheetKind = 'none' | 'options' | 'agents'

function Conversation({
  botName,
  focusItemId,
  onBack,
  onOpenBot
}: {
  botName: string
  focusItemId?: string
  onBack?: () => void
  onOpenBot?: (botName: string, options?: OpenChatOptions) => void
}) {
  const chat = useChat(botName)
  const { status } = useGateway()
  const view = useChatView(botName)
  const avatar = useBotsStore(state => state.avatars[botName])
  const byName = useBotsStore(state => state.byName)
  const overridden = useSettingsStore(state => hasChatViewOverride(state, botName))

  const [sheet, setSheet] = useState<SheetKind>('none')
  const [attachments, setAttachments] = useState<PickedAttachment[]>([])
  const [suggestions, setSuggestions] = useState<SlashSuggestion[]>([])
  const [models, setModels] = useState<ModelChoice[]>([])
  const [dismissedRequests, setDismissed] = useState<string[]>([])
  const [newCount, setNewCount] = useState(0)
  const [away, setAway] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [pendingModel, setPendingModel] = useState<{ value: string; message?: string } | null>(null)
  const [transcript, setTranscript] = useState<SubagentTranscript | null>(null)
  const [agentsNotice, setAgentsNotice] = useState<string | null>(null)

  const listRef = useRef<TranscriptListHandle>(null)
  const focused = useRef<string | null>(null)
  const acknowledged = useRef<string | null>(null)
  const awayRef = useRef(false)
  const itemCount = chat.items.length
  const lastCount = useRef(itemCount)

  awayRef.current = away

  // Messages that landed while the reader was further up: the pill's count.
  useEffect(() => {
    if (itemCount > lastCount.current && awayRef.current) {
      setNewCount(current => current + (itemCount - lastCount.current))
    }

    lastCount.current = itemCount
  }, [itemCount])

  useEffect(() => {
    let cancelled = false

    void chat.modelOptions().then(options => {
      if (!cancelled) {
        setModels(options)
      }
    })

    return () => {
      cancelled = true
    }
  }, [chat])

  // ── the one question on screen ──────────────────────────────────────────
  //
  // Oldest first, and a question the user closed after it was resolved is not
  // re-opened. `dismissedRequests` is keyed by item id, so a NEW request with
  // the same shape still shows.
  const request = useMemo(() => {
    for (const item of chat.requests) {
      if ((item.kind === 'approval' || item.kind === 'clarify') && !dismissedRequests.includes(item.id)) {
        return item
      }
    }

    return undefined
  }, [chat.requests, dismissedRequests])

  const approval = request?.kind === 'approval' ? (request as ApprovalItem) : undefined
  const clarify = request?.kind === 'clarify' ? (request as ClarifyItem) : undefined

  // `approval.received` tells the gateway's queue a human is looking at it, so
  // it stops counting down. It is sent once per request, on first show.
  useEffect(() => {
    if (!approval || acknowledged.current === approval.id) {
      return
    }

    acknowledged.current = approval.id
    void chat.acknowledgeApproval(approval.requestId).catch(() => undefined)
  }, [approval, chat])

  // A reply landing is worth one buzz, and only while the chat is on screen:
  // this effect is unmounted the moment the user leaves, so a bot answering in
  // a chat nobody is looking at stays silent.
  const wasRunning = useRef(false)

  useEffect(() => {
    if (chat.turnActive) {
      wasRunning.current = true

      return
    }

    if (wasRunning.current) {
      wasRunning.current = false
      haptic('complete')
    }
  }, [chat.turnActive])

  // Land on the item the caller asked for, once it is actually in the list.
  // Hydration is asynchronous, so this retries as items arrive and gives up
  // silently rather than scrolling somewhere plausible-looking.
  useEffect(() => {
    if (!focusItemId || focused.current === focusItemId || !chat.items.length) {
      return
    }

    if (listRef.current?.scrollToItem(focusItemId)) {
      focused.current = focusItemId
    }
  }, [chat.items, focusItemId])

  /**
   * Handles whose chat is live and mid-turn.
   *
   * This is what lets a pending dispatch say "@writer is writing…": the
   * recipient's chat is resumed (every opened chat stays live) and its turn is
   * running, which together mean the DM landed and is being answered.
   */
  const typingHandles = useChatsStore(
    useCallback(
      state =>
        Object.keys(state.live)
          .filter(name => name !== botName && state.chats[name]?.turn.active)
          .map(name => normalizeAgentTarget(name) || name.toLowerCase())
          .sort()
          .join(','),
      [botName]
    )
  )

  const typing = useMemo(() => (typingHandles ? typingHandles.split(',') : []), [typingHandles])

  /**
   * Open another bot's chat on the message this one is about.
   *
   * The two rows are the same delivery seen from opposite sides and the gateway
   * keys them by nothing in common, so the match is handle plus nearest stamp
   * (`findDmCounterpart`). It refuses rather than guesses, and a refusal just
   * means the chat opens at the bottom the way it always did.
   */
  const openBot = useCallback(
    (handle: string, from?: { kind: 'bot_dm_in' | 'bot_dm_out'; at?: number; text?: string }) => {
      const names = Object.keys(useBotsStore.getState().byName)
      const target = resolveBot(handle, names)
      const targetChat = useChatsStore.getState().chats[target]
      const counterpart = from
        ? findDmCounterpart(targetChat, {
            kind: from.kind,
            handle: botName,
            ...(from.at === undefined ? {} : { at: from.at }),
            ...(from.text === undefined ? {} : { text: from.text })
          })
        : undefined

      onOpenBot?.(target, counterpart ? { focusItemId: counterpart } : undefined)
    },
    [botName, onOpenBot]
  )

  const subagents = useChatsStore(useCallback(state => state.chats[botName]?.subagents ?? EMPTY_SUBAGENTS, [botName]))

  /**
   * Open one child's transcript.
   *
   * While it is RUNNING, `subagent.tail` is the only live view and it is polled
   * (see below). Once it has finished, the tail is gone but the child's own
   * stored session is not — so a finished child is read through
   * `session.history` instead, which is the difference between a button that
   * works afterwards and one that shows an empty box.
   */
  const openTranscript = useCallback(
    (subagentId: string) => {
      const child = subagents[subagentId]

      if (!child) {
        return
      }

      const live = child.status === 'running' || child.status === 'queued'

      setSheet('agents')
      setTranscript({
        subagentId,
        goal: child.goal,
        text: '',
        source: live || !child.childSessionId ? 'tail' : 'stored',
        loading: true
      })
    },
    [subagents]
  )

  const steerChild = useCallback(
    async (subagentId: string, text: string) => {
      try {
        const status = await chat.steerSubagent(subagentId, text)

        setAgentsNotice(status === 'rejected' ? chatStrings.subagents.steerRejected : chatStrings.subagents.steerQueued)
      } catch (error) {
        setAgentsNotice(messageOf(error))
      }
    },
    [chat]
  )

  const stopChild = useCallback(
    async (subagentId: string) => {
      try {
        const found = await chat.interruptSubagent(subagentId)

        setAgentsNotice(found ? chatStrings.subagents.stopped : chatStrings.subagents.status.completed)
      } catch (error) {
        setAgentsNotice(messageOf(error))
      }
    },
    [chat]
  )

  /**
   * Keep the open transcript fresh.
   *
   * `subagent.tail` is a tail, not a subscription, so a live child's output
   * only moves if something asks. Three seconds is the plan's cadence; the poll
   * stops the moment the child finishes, and then the STORED transcript is read
   * once and left alone, because a finished session does not change.
   */
  useEffect(() => {
    const open = transcript

    if (!open) {
      return
    }

    let cancelled = false
    const child = subagents[open.subagentId]
    const live = child?.status === 'running' || child?.status === 'queued'

    const read = async () => {
      try {
        const text =
          open.source === 'stored' && child?.childSessionId
            ? (await chat.childTranscript(child.childSessionId)).map(transcriptLine).filter(Boolean).join('\n')
            : await chat.tailSubagent(open.subagentId)

        if (!cancelled) {
          setTranscript(current =>
            current && current.subagentId === open.subagentId ? { ...current, text, loading: false } : current
          )
        }
      } catch (error) {
        if (!cancelled) {
          setTranscript(current =>
            current && current.subagentId === open.subagentId
              ? { ...current, loading: false, error: messageOf(error) }
              : current
          )
        }
      }
    }

    void read()

    if (!live || open.source === 'stored') {
      return () => {
        cancelled = true
      }
    }

    const timer = setInterval(() => void read(), SUBAGENT_TAIL_POLL_MS)

    return () => {
      cancelled = true
      clearInterval(timer)
    }
    // Only the identity of the open transcript and the child's status may
    // restart the poll; the text this effect writes must not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat, subagents, transcript?.subagentId, transcript?.source])

  const busy = chat.busy
  const subtitle = subtitleFor({
    status,
    busy,
    queued: Boolean(chat.queuedText),
    needsInput: Boolean(request)
  })

  const send = useCallback(
    async (text: string) => {
      const body = text.trim()

      if (!body && attachments.length === 0) {
        return
      }

      const files = attachments.map(file => ({ filename: file.filename, base64: file.base64 }))

      chat.setDraft('')
      setAttachments([])
      setSuggestions([])

      haptic('send')

      try {
        await chat.send(body, files)
      } catch (error) {
        // The optimistic bubble stays — the words were the user's — and the
        // draft comes back so the message is not lost with it.
        chat.setDraft(body)
        setNotice(messageOf(error))
      }
    },
    [attachments, chat]
  )

  const attach = useCallback(async () => {
    try {
      const picked = await pickAttachment()

      if (picked) {
        setAttachments(current => [...current, picked])
      }
    } catch (error) {
      setNotice(strings.chat.attach.failed(messageOf(error)))
    }
  }, [])

  const querySlash = useCallback(
    (prefix: string) => {
      void chat
        .querySlash(prefix)
        .then(items =>
          setSuggestions(
            items.slice(0, 6).map(item => ({
              name: (item.display ?? item.text).replace(/^\//, ''),
              description: item.meta ?? ''
            }))
          )
        )
        .catch(() => setSuggestions([]))
    },
    [chat]
  )

  const setOption = useCallback(
    async (key: 'yolo' | 'fast' | 'reasoning' | 'model', value: string, confirmExpensiveModel = false) => {
      try {
        const result = await chat.setOption(key, value, { confirmExpensiveModel })

        if (result.confirmRequired) {
          setPendingModel({ value, ...(result.confirmMessage ? { message: result.confirmMessage } : {}) })

          return
        }

        setPendingModel(null)
      } catch (error) {
        setNotice(messageOf(error))
      }
    },
    [chat]
  )

  const modelOptions = useMemo<PickerOption[]>(() => {
    const options = models.map(model => ({ value: model.id, label: model.label, detail: model.provider }))
    const current = chat.info?.model

    // The chat's own model always appears, even when the inventory is empty or
    // does not list it: a picker that cannot show what you are on is a lie.
    if (current && !options.some(option => option.value === current)) {
      return [{ value: current, label: current }, ...options]
    }

    return options
  }, [chat.info?.model, models])

  const composerAttachments = useMemo<ComposerAttachment[]>(
    () => attachments.map(file => ({ id: file.id, name: file.filename, ...(file.uri ? { uri: file.uri } : {}) })),
    [attachments]
  )

  const display = byName[botName]?.displayName ?? botName

  return (
    <Screen edgeToEdgeTop={false} padded={false}>
      <ChatHeader
        avatarUri={avatar}
        handle={botName}
        name={display}
        needsInput={Boolean(request)}
        onBack={onBack}
        onOpenOptions={() => setSheet('options')}
        running={busy}
        subtitle={subtitle}
      />

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        // The chat header is inside this screen (the stack's own header is
        // hidden for this route), so there is no external bar to offset past.
        keyboardVerticalOffset={0}
        style={{ flex: 1 }}
      >
        <Banner
          error={chat.error ?? notice}
          hydration={chat.hydration}
          onDismiss={() => setNotice(null)}
          onRetry={chat.reload}
        />

        <TranscriptList
          header={
            chat.subagents.length ? (
              <AgentsBar
                count={chat.subagents.length}
                onPress={() => setSheet('agents')}
                startedAt={oldestStart(chat.subagents)}
              />
            ) : null
          }
          items={chat.items}
          newMessageCount={newCount}
          onEndReached={noop}
          onOpenBot={openBot}
          onOpenRequest={item => setDismissed(current => current.filter(id => id !== item.id))}
          onOpenTranscript={openTranscript}
          onScrolledAwayFromBottom={next => {
            setAway(next)

            if (!next) {
              setNewCount(0)
            }
          }}
          ref={listRef}
          selfHandle={botName}
          subagents={subagents}
          // The TURN is running and nothing has been said yet: three dots. Not
          // `busy` — that also covers a tool or a child still working, and dots
          // under a finished reply promise a sentence that is not coming.
          typing={chat.turnActive && !hasStreamingText(chat.items)}
          typingHandles={typing}
        />

        <Composer
          attachments={composerAttachments}
          botName={display}
          // Omitted where no picker exists (macOS without the document picker):
          // the composer then renders its "+" disabled instead of offering a
          // button whose only outcome is an error.
          {...(attachmentsSupported ? { onAttach: () => void attach() } : {})}
          onChangeText={chat.setDraft}
          onQuerySlash={querySlash}
          onRemoveAttachment={id => setAttachments(current => current.filter(file => file.id !== id))}
          onSend={text => void send(text)}
          onStop={() => void chat.stop()}
          placeholder={attachmentKind === 'file' ? strings.chat.placeholder : undefined}
          running={busy}
          suggestions={suggestions}
          value={chat.draft}
          {...(chat.queuedText ? { queuedText: chat.queuedText } : {})}
        />
      </KeyboardAvoidingView>

      {approval ? (
        <ApprovalSheet
          botHandle={botName}
          item={approval}
          onClose={() => setDismissed(current => [...current, approval.id])}
          onRespond={choice => {
            haptic('choice')
            void chat.respondApproval(approval.requestId, choice).catch(error => setNotice(messageOf(error)))
          }}
          visible
        />
      ) : null}

      {clarify ? (
        <ClarifySheet
          item={clarify}
          onClose={() => setDismissed(current => [...current, clarify.id])}
          onLock={(qid, answer) => {
            void chat.lockClarify(clarify.requestId, qid, answer).catch(error => setNotice(messageOf(error)))
          }}
          onSkip={() => setDismissed(current => [...current, clarify.id])}
          onSubmit={answers => {
            haptic('choice')
            void chat.respondClarify(clarify.requestId, answers).catch(error => setNotice(messageOf(error)))
          }}
          visible
        />
      ) : null}

      <AgentsSheet
        notice={agentsNotice}
        onClose={() => {
          setSheet('none')
          setTranscript(null)
        }}
        onCloseTranscript={() => setTranscript(null)}
        onInterrupt={id => void stopChild(id)}
        onOpenTranscript={openTranscript}
        onSteer={(id, text) => void steerChild(id, text)}
        transcript={transcript}
        tree={chat.subagentTree}
        visible={sheet === 'agents'}
      />

      <ChatOptionsSheet
        botName={display}
        confirmMessage={pendingModel?.message ?? ''}
        fast={chat.info?.fast === true}
        model={chat.info?.model ?? ''}
        modelOptions={modelOptions}
        onCancelExpensiveModel={() => setPendingModel(null)}
        onChangeFast={value => void setOption('fast', value ? 'true' : 'false')}
        onChangeModel={value => void setOption('model', value)}
        onChangeReasoningEffort={value => void setOption('reasoning', value)}
        onChangeShowBotToBot={value => useSettingsStore.getState().setChatView(botName, { showBotToBot: value })}
        onChangeShowThinking={value => useSettingsStore.getState().setChatView(botName, { showThinking: value })}
        onChangeVerbosity={(value: Verbosity) => useSettingsStore.getState().setChatView(botName, { level: value })}
        onChangeYolo={value => void setOption('yolo', value ? 'true' : 'false')}
        onClose={() => setSheet('none')}
        onConfirmExpensiveModel={() => {
          if (pendingModel) {
            void setOption('model', pendingModel.value, true)
          }
        }}
        onResetView={() => useSettingsStore.getState().resetChatView(botName)}
        pendingExpensiveModel={pendingModel?.value ?? null}
        reasoningEffort={chat.info?.reasoning_effort ?? ''}
        reasoningOptions={REASONING_OPTIONS}
        showBotToBot={view.showBotToBot}
        showThinking={view.showThinking}
        verbosity={view.level}
        viewOverridden={overridden}
        visible={sheet === 'options'}
        yolo={chat.info?.yolo === true}
      />
    </Screen>
  )
}

/** `onEndReached`: the controller has no older-history page to fetch (yet). */
const noop = () => undefined

/** A stable empty map, so a chat without children does not churn the memo. */
const EMPTY_SUBAGENTS: Record<string, never> = {}

/** The plan's cadence for `subagent.tail` while a child is running. */
const SUBAGENT_TAIL_POLL_MS = 3_000

/** One stored transcript row as a plain line, for the read-only child view. */
function transcriptLine(item: TranscriptItem): string {
  switch (item.kind) {
    case 'user':
      return item.text ? `> ${item.text}` : ''
    case 'assistant':
      return item.text ?? ''
    case 'tool':
      return `· ${item.context || item.summary || item.name}`
    default:
      return ''
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function oldestStart(children: readonly { startedAt: number }[]): number | undefined {
  const starts = children.map(child => child.startedAt).filter(value => value > 0)

  return starts.length ? Math.min(...starts) : undefined
}

/** True once the running turn has said anything; the typing dots stop there. */
function hasStreamingText(items: readonly { item: { kind: string } }[]): boolean {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]?.item as { kind: string; streaming?: boolean; text?: string } | undefined

    if (item?.kind === 'assistant') {
      return Boolean(item.streaming && item.text?.trim())
    }
  }

  return false
}

/**
 * A DM card carries the routing handle, which is usually but not always the
 * profile name. Matching case-insensitively against the roster keeps a tap on
 * "@Writer" opening Writer's chat.
 */
function resolveBot(handle: string, names: readonly string[]): string {
  const needle = handle.replace(/^@/, '').toLowerCase()

  return names.find(name => name.toLowerCase() === needle) ?? needle
}

function subtitleFor(state: { status: string; busy: boolean; queued: boolean; needsInput: boolean }): string {
  if (state.needsInput) {
    return strings.bots.needsInput
  }

  if (state.busy) {
    return strings.chat.subtitle.working
  }

  if (state.queued) {
    return strings.chat.subtitle.queued
  }

  switch (state.status) {
    case 'ready':
      return strings.chat.subtitle.connected
    case 'offline':
      return strings.chat.subtitle.offline
    case 'reconnecting':
      return strings.chat.subtitle.reconnecting
    case 'needs_signin':
      return strings.chat.subtitle.signedOut
    case 'connecting':
    case 'authenticating':
    case 'probing':
      return strings.chat.subtitle.connecting
    default:
      return strings.connection.status.disconnected
  }
}

function Banner({
  hydration,
  error,
  onRetry,
  onDismiss
}: {
  hydration: ReturnType<typeof useChat>['hydration']
  error: string | null
  onRetry: () => Promise<void>
  onDismiss: () => void
}) {
  const theme = useTheme()

  if (error) {
    return (
      <View style={{ backgroundColor: theme.colors.surfaceRaised, gap: theme.space.xs, padding: theme.space.md }}>
        <Text color="danger" variant="callout">
          {strings.chat.failed(error)}
        </Text>
        <View style={{ flexDirection: 'row', gap: theme.space.lg }}>
          <Pressable accessibilityRole="button" onPress={() => void onRetry()}>
            <Text color="accent" variant="callout">
              {strings.chat.retry}
            </Text>
          </Pressable>
          <Pressable accessibilityRole="button" onPress={onDismiss}>
            <Text color="textMuted" variant="callout">
              {strings.common.done}
            </Text>
          </Pressable>
        </View>
      </View>
    )
  }

  if (hydration === 'hydrating') {
    return (
      <View
        style={{
          alignItems: 'center',
          flexDirection: 'row',
          gap: theme.space.sm,
          padding: theme.space.md
        }}
      >
        <ActivityIndicator />
        <Text color="textMuted" variant="callout">
          {strings.chat.hydrating}
        </Text>
      </View>
    )
  }

  if (hydration === 'cached' || hydration === 'stale') {
    return (
      <View style={{ backgroundColor: theme.colors.surfaceRaised, padding: theme.space.md }}>
        <Text color="textMuted" variant="callout">
          {hydration === 'cached' ? strings.chat.offlineCopy : strings.chat.stale}
        </Text>
      </View>
    )
  }

  return null
}
