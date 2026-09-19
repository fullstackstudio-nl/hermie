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
import type { ApprovalItem, ClarifyItem, Verbosity } from '@hermie/transcript'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, View } from 'react-native'

import {
  AgentsBar,
  AgentsSheet,
  ChatHeader,
  Composer,
  type ComposerAttachment,
  type PickerOption,
  type SlashSuggestion,
  TranscriptList
} from '../../chat-ui'
import { useGateway } from '../../gateway'
import { strings } from '../../i18n/strings'
import { useBotsStore } from '../../store/bots'
import { useChatsStore } from '../../store/chats'
import { hasChatViewOverride, useChatView, useSettingsStore } from '../../store/settings'
import { ApprovalSheet, ChatOptionsSheet, ClarifySheet } from '../../ui/sheets'
import { Screen, Text } from '../../ui/primitives'
import { useTheme } from '../../ui/theme'
import { attachmentKind, attachmentsSupported, pickAttachment, type PickedAttachment } from './attachments'
import type { ModelChoice } from './chat-controller'
import { useChat } from './useChat'

export type ChatScreenProps = {
  /** The compact shell passes the bot through navigation params. */
  route?: { params?: { bot?: string } }
  /** The regular shell passes it directly. */
  bot?: string
  /** Shown as the header's back chevron; absent on the regular shell. */
  onBack?: () => void
  /** Open another bot's chat — a tapped DM card or sender chip. */
  onOpenBot?: (botName: string) => void
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

export function ChatScreen({ route, bot, onBack, onOpenBot }: ChatScreenProps) {
  const botName = bot ?? route?.params?.bot ?? ''

  if (!botName) {
    return <NoBotSelected />
  }

  // Keyed on the bot so that switching conversations in the regular shell
  // starts from a clean composer and closed sheets rather than inheriting the
  // previous chat's.
  return <Conversation botName={botName} key={botName} onBack={onBack} onOpenBot={onOpenBot} />
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
  onBack,
  onOpenBot
}: {
  botName: string
  onBack?: () => void
  onOpenBot?: (botName: string) => void
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
          onOpenBot={handle => onOpenBot?.(resolveBot(handle, Object.keys(byName)))}
          onOpenRequest={item => setDismissed(current => current.filter(id => id !== item.id))}
          onOpenTranscript={id => void chat.tailSubagent(id).catch(() => undefined)}
          onScrolledAwayFromBottom={next => {
            setAway(next)

            if (!next) {
              setNewCount(0)
            }
          }}
          selfHandle={botName}
          subagents={useChatsStore.getState().chats[botName]?.subagents ?? {}}
          // A turn is running and nothing has been said yet: three dots.
          typing={busy && !hasStreamingText(chat.items)}
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
            void chat.respondClarify(clarify.requestId, answers).catch(error => setNotice(messageOf(error)))
          }}
          visible
        />
      ) : null}

      <AgentsSheet
        onClose={() => setSheet('none')}
        onInterrupt={id => void chat.interruptSubagent(id).catch(() => undefined)}
        onOpenTranscript={id => void chat.tailSubagent(id).catch(() => undefined)}
        onSteer={(id, text) => void chat.steerSubagent(id, text).catch(error => setNotice(messageOf(error)))}
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
