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
import { ActivityIndicator, KeyboardAvoidingView, Pressable, View } from 'react-native'

import {
  AgentsBar,
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
import { KEYBOARD_AVOID_BEHAVIOR } from '../../ui/keyboard'
import { Screen, Text } from '../../ui/primitives'
import { useTheme } from '../../ui/theme'
import { CONTROL_MIN_HEIGHT, TAP_SLOP } from '../../ui/tokens'
import { openAppSettings, pickAttachment, type PickedAttachment } from './attachments'
import { pickFile } from './file-attachments'
import { FileUploadError } from './file-upload'
import { ChatSheetHost, type RequestItem } from './ChatSheetHost'
import type { AttachmentInput, ModelChoice } from './chat-controller'
import type { ManualSheet } from './sheet-host'
import { useChat, type UseChatResult } from './useChat'

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
  const { config, http, status } = useGateway()
  const view = useChatView(botName)
  const avatar = useBotsStore(state => state.avatars[botName])
  const byName = useBotsStore(state => state.byName)
  const overridden = useSettingsStore(state => hasChatViewOverride(state, botName))

  const [sheet, setSheet] = useState<ManualSheet>('none')
  const [attachments, setAttachments] = useState<PickedAttachment[]>([])
  /**
   * Files already uploaded and waiting to be named in the next prompt.
   *
   * Uploaded on pick rather than on send, because the upload is the slow part
   * and the send should not be: by the time the message goes out the bytes are
   * on the gateway and only the path travels with it.
   */
  const [uploaded, setUploaded] = useState<{ id: string; filename: string; path: string }[]>([])
  const [suggestions, setSuggestions] = useState<SlashSuggestion[]>([])
  const [models, setModels] = useState<ModelChoice[]>([])
  const [dismissedRequests, setDismissed] = useState<string[]>([])
  const [newCount, setNewCount] = useState(0)
  const [away, setAway] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [pendingModel, setPendingModel] = useState<{ value: string; message?: string } | null>(null)
  const [transcript, setTranscript] = useState<SubagentTranscript | null>(null)
  const [agentsNotice, setAgentsNotice] = useState<string | null>(null)
  const [imageHeaders, setImageHeaders] = useState<Record<string, string> | null>(null)
  const [needsPhotoAccess, setNeedsPhotoAccess] = useState(false)

  const listRef = useRef<TranscriptListHandle>(null)
  const focused = useRef<string | null>(null)
  const acknowledged = useRef<string | null>(null)
  const awayRef = useRef(false)

  /**
   * Only what a reader would call a message.
   *
   * The pill used to count `chat.items`, which is every row: a tool call, a
   * status chip, a notice. One `ls` behind a scrolled-up reader announced "4
   * new" and none of them were messages.
   */
  const messageCount = useMemo(
    () => chat.items.reduce((total, entry) => (MESSAGE_KINDS.has(entry.item.kind) ? total + 1 : total), 0),
    [chat.items]
  )
  const lastCount = useRef(messageCount)

  awayRef.current = away

  // Messages that landed while the reader was further up: the pill's count.
  //
  // The delta is taken BEFORE the watermark moves. React runs a functional
  // updater during the next render, long after this effect body has finished,
  // so reading `lastCount.current` from inside the updater read the value this
  // effect had already overwritten — every delta came out as zero and the pill
  // never showed a count at all.
  useEffect(() => {
    const arrived = messageCount - lastCount.current

    lastCount.current = messageCount

    if (arrived > 0 && awayRef.current) {
      setNewCount(current => current + arrived)
    }
  }, [messageCount])

  /**
   * What a Markdown image in a reply needs to load.
   *
   * An agent writes an attachment as `/api/files/…` — a path on the gateway,
   * behind whatever the rest of the API is behind. Resolved once per
   * connection and held in state, because this object ends up in the memo key
   * of every transcript row.
   */
  useEffect(() => {
    if (!http) {
      setImageHeaders(null)

      return
    }

    let cancelled = false

    void http
      .requestHeaders()
      .then(headers => {
        if (!cancelled) {
          setImageHeaders(headers)
        }
      })
      .catch(() => undefined)

    return () => {
      cancelled = true
    }
  }, [http])

  const images = useMemo(
    () => ({
      ...(config?.baseUrl ? { baseUrl: config.baseUrl } : {}),
      ...(imageHeaders ? { headers: imageHeaders } : {})
    }),
    [config?.baseUrl, imageHeaders]
  )

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
  const request = useMemo<RequestItem | undefined>(() => {
    for (const item of chat.requests) {
      if ((item.kind === 'approval' || item.kind === 'clarify') && !dismissedRequests.includes(item.id)) {
        return item
      }
    }

    return undefined
  }, [chat.requests, dismissedRequests])

  /**
   * Any question by id, answered or not.
   *
   * `chat.requests` is `openRequests`, so a question drops out of it the
   * instant it resolves. The sheet host holds the one it is showing by id and
   * reads it back through here, which is how an answered question can stay on
   * screen long enough to say what happened to it.
   */
  const findRequest = useCallback(
    (id: string): RequestItem | undefined => {
      for (const entry of chat.items) {
        if (entry.item.id === id && (entry.item.kind === 'approval' || entry.item.kind === 'clarify')) {
          return entry.item
        }
      }

      return undefined
    },
    [chat.items]
  )

  // `approval.received` tells the gateway's queue a human is looking at it, so
  // it stops counting down. It is sent once per request, on first show.
  const acknowledge = useCallback(
    (item: RequestItem) => {
      if (item.kind !== 'approval' || acknowledged.current === item.id) {
        return
      }

      acknowledged.current = item.id
      void chat.acknowledgeApproval(item.requestId).catch(() => undefined)
    },
    [chat]
  )

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
  // Every question the agent is still blocked on, including one the reader put
  // aside with "Later". The header must not go quiet while the agent waits.
  const needsInput = chat.requests.length > 0
  const subtitle = subtitleFor({
    status,
    hydration: chat.hydration,
    busy,
    queued: Boolean(chat.queuedText),
    needsInput
  })

  const send = useCallback(
    async (text: string) => {
      const body = text.trim()

      if (!body && attachments.length === 0 && uploaded.length === 0) {
        return
      }

      const files: AttachmentInput[] = [
        ...attachments.map(file => ({ filename: file.filename, base64: file.base64 })),
        ...uploaded.map(file => ({ kind: 'file' as const, filename: file.filename, path: file.path }))
      ]

      chat.setDraft('')
      setAttachments([])
      setUploaded([])
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
    [attachments, chat, uploaded]
  )

  const attach = useCallback(async () => {
    try {
      const picked = await pickAttachment()

      if (picked) {
        setAttachments(current => [...current, picked])
      }
    } catch (error) {
      const message = messageOf(error)

      // A refused picker is the one failure the user can do something about,
      // and the only place to do it is the system settings app.
      setNeedsPhotoAccess(message === strings.chat.attach.permission)
      setNotice(strings.chat.attach.failed(message))
    }
  }, [])

  /**
   * Pick a file, upload it, and stage the path.
   *
   * Nothing is staged unless the upload finished: a chip for a file the gateway
   * never received would produce a prompt referencing a path that is not there,
   * and the agent would report a missing file rather than the upload failing.
   */
  const attachFile = useCallback(async () => {
    let picked: Awaited<ReturnType<typeof pickFile>>

    try {
      picked = await pickFile()
    } catch (error) {
      setNotice(strings.chat.attach.failed(messageOf(error)))

      return
    }

    if (!picked) {
      return
    }

    try {
      const result = await chat.uploadFile(picked)

      setUploaded(current => [...current, { id: result.path, filename: result.filename, path: result.path }])
    } catch (error) {
      // A typed reason exists for exactly the failures a message can explain;
      // anything else is the transport, and its own words are the best available.
      setNotice(error instanceof FileUploadError ? strings.chat.attach.uploadFailed(error.message) : messageOf(error))
    }
  }, [chat])

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
    () => [
      ...attachments.map(file => ({ id: file.id, name: file.filename, ...(file.uri ? { uri: file.uri } : {}) })),
      // No `uri`, so the existing chip draws its name rather than a thumbnail —
      // which is right for an archive, and is the whole of the UI this needs.
      ...uploaded.map(file => ({ id: file.id, name: file.filename }))
    ],
    [attachments, uploaded]
  )

  const display = byName[botName]?.displayName ?? botName

  /**
   * Stable callbacks for the transcript.
   *
   * `TranscriptRow` is memoized on `(id, version, presentation, receipt,
   * context)`, and the context is rebuilt whenever any handler identity
   * changes. An inline arrow here therefore invalidated EVERY settled row on
   * every streaming delta — the one thing the memo exists to prevent.
   */
  const reopenRequest = useCallback((item: ApprovalItem | ClarifyItem) => {
    setDismissed(current => current.filter(id => id !== item.id))
  }, [])

  const openAgents = useCallback(() => setSheet('agents'), [])
  const openOptions = useCallback(() => setSheet('options'), [])

  const onScrolledAway = useCallback((next: boolean) => {
    setAway(next)

    if (!next) {
      setNewCount(0)
    }
  }, [])

  const closeManualSheet = useCallback(() => {
    setSheet('none')
    setTranscript(null)
  }, [])

  const dismissRequest = useCallback((item: ApprovalItem | ClarifyItem) => {
    setDismissed(current => (current.includes(item.id) ? current : [...current, item.id]))
  }, [])

  const respondApproval = useCallback(
    (item: ApprovalItem, choice: string) => {
      haptic('choice')
      void chat.respondApproval(item.requestId, choice).catch(error => setNotice(messageOf(error)))
    },
    [chat]
  )

  const submitClarify = useCallback(
    (item: ClarifyItem, answers: Record<string, string>) => {
      haptic('choice')
      void chat.respondClarify(item.requestId, answers).catch(error => setNotice(messageOf(error)))
    },
    [chat]
  )

  const lockClarify = useCallback(
    (item: ClarifyItem, qid: string, answer: string) => {
      void chat.lockClarify(item.requestId, qid, answer).catch(error => setNotice(messageOf(error)))
    },
    [chat]
  )

  return (
    <Screen edgeToEdgeTop={false} padded={false}>
      <ChatHeader
        avatarUri={avatar}
        handle={botName}
        name={display}
        needsInput={needsInput}
        onBack={onBack}
        onOpenOptions={openOptions}
        running={busy}
        subtitle={subtitle}
      />

      <KeyboardAvoidingView
        behavior={KEYBOARD_AVOID_BEHAVIOR}
        // The chat header is inside this screen (the stack's own header is
        // hidden for this route), so there is no external bar to offset past.
        keyboardVerticalOffset={0}
        style={{ flex: 1 }}
      >
        <Banner
          // The connection's own account of a terminal refusal beats the RPC
          // message it produced, which only ever says "gateway not connected".
          error={chat.connectionError ?? chat.error ?? notice}
          hydration={chat.hydration}
          waitingForConnection={chat.waitingForConnection}
          onDismiss={() => {
            setNotice(null)
            setNeedsPhotoAccess(false)
            chat.clearError()
          }}
          onRetry={chat.reload}
          {...(needsPhotoAccess ? { onOpenSettings: openAppSettings } : {})}
        />

        <TranscriptList
          header={
            chat.subagents.length ? (
              <AgentsBar count={chat.subagents.length} onPress={openAgents} startedAtMs={oldestStart(chat.subagents)} />
            ) : null
          }
          images={images}
          items={chat.items}
          newMessageCount={newCount}
          onEndReached={noop}
          onOpenBot={openBot}
          onOpenRequest={reopenRequest}
          onOpenTranscript={openTranscript}
          onScrolledAwayFromBottom={onScrolledAway}
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
          onAttach={() => void attach()}
          // A long press picks a file instead. Both pickers exist on every
          // target this builds for, so neither is conditional.
          onAttachFile={() => void attachFile()}
          onChangeText={chat.setDraft}
          onQuerySlash={querySlash}
          onRemoveAttachment={id => {
            setAttachments(current => current.filter(file => file.id !== id))
            // An uploaded file is left on the gateway: deleting it would need a
            // second round trip to undo something the user only unstaged.
            setUploaded(current => current.filter(file => file.id !== id))
          }}
          onSend={text => void send(text)}
          onStop={() => void chat.stop()}
          running={busy}
          suggestions={suggestions}
          value={chat.draft}
          {...(chat.queuedText ? { queuedText: chat.queuedText } : {})}
        />
      </KeyboardAvoidingView>

      {/* One sheet, never four. `ChatSheetHost` decides which, and closes the
          one on screen before it opens the next. */}
      <ChatSheetHost
        agents={{
          notice: agentsNotice,
          onCloseTranscript: () => setTranscript(null),
          onInterrupt: id => void stopChild(id),
          onOpenTranscript: openTranscript,
          onSteer: (id, text) => void steerChild(id, text),
          transcript,
          tree: chat.subagentTree
        }}
        botHandle={botName}
        findRequest={findRequest}
        manual={sheet}
        onCloseManual={closeManualSheet}
        onCloseRequest={dismissRequest}
        onLockClarify={lockClarify}
        onRespondApproval={respondApproval}
        onShowRequest={acknowledge}
        onSubmitClarify={submitClarify}
        options={{
          botName: display,
          confirmMessage: pendingModel?.message ?? '',
          fast: chat.info?.fast === true,
          model: chat.info?.model ?? '',
          modelOptions,
          onCancelExpensiveModel: () => setPendingModel(null),
          onChangeFast: value => void setOption('fast', value ? 'true' : 'false'),
          onChangeModel: value => void setOption('model', value),
          onChangeReasoningEffort: value => void setOption('reasoning', value),
          onChangeShowBotToBot: value => useSettingsStore.getState().setChatView(botName, { showBotToBot: value }),
          onChangeShowThinking: value => useSettingsStore.getState().setChatView(botName, { showThinking: value }),
          onChangeVerbosity: (value: Verbosity) => useSettingsStore.getState().setChatView(botName, { level: value }),
          onChangeYolo: value => void setOption('yolo', value ? 'true' : 'false'),
          onConfirmExpensiveModel: () => {
            if (pendingModel) {
              void setOption('model', pendingModel.value, true)
            }
          },
          onResetView: () => useSettingsStore.getState().resetChatView(botName),
          pendingExpensiveModel: pendingModel?.value ?? null,
          reasoningEffort: chat.info?.reasoning_effort ?? '',
          reasoningOptions: REASONING_OPTIONS,
          showBotToBot: view.showBotToBot,
          showThinking: view.showThinking,
          verbosity: view.level,
          viewOverridden: overridden,
          yolo: chat.info?.yolo === true
        }}
        {...(request ? { request } : {})}
      />
    </Screen>
  )
}

/** What the jump-to-latest pill counts: messages, not rows. */
const MESSAGE_KINDS = new Set<string>(['assistant', 'bot_dm_in', 'bot_dm_out', 'user'])

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

/** The earliest start among the running children, in epoch milliseconds. */
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

function subtitleFor(state: {
  status: string
  hydration: UseChatResult['hydration']
  busy: boolean
  queued: boolean
  needsInput: boolean
}): string {
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
      // A live chat is one the gateway answered `session.resume` for and is
      // streaming events into. Coming back from the background walks the whole
      // pre-dial ladder again while that session keeps working, and
      // "Connecting…" over a conversation the reader can see updating describes
      // the socket's bookkeeping rather than this chat.
      return state.hydration === 'live' ? strings.chat.subtitle.connected : strings.chat.subtitle.connecting
    default:
      return strings.connection.status.disconnected
  }
}

function Banner({
  hydration,
  error,
  waitingForConnection,
  onRetry,
  onDismiss,
  onOpenSettings
}: {
  hydration: UseChatResult['hydration']
  error: string | null
  /** The socket is not up yet. Quiet, and with nothing to press: see `useChat`. */
  waitingForConnection: boolean
  onRetry: () => Promise<void>
  onDismiss: () => void
  /** Only for a refused photo picker: the one failure with a way out. */
  onOpenSettings?: () => void
}) {
  const theme = useTheme()

  if (error) {
    return (
      <View style={{ backgroundColor: theme.colors.surfaceRaised, gap: theme.space.xs, padding: theme.space.md }}>
        <Text color="danger" variant="callout">
          {strings.chat.failed(error)}
        </Text>
        <View style={{ alignItems: 'center', flexDirection: 'row', gap: theme.space.lg }}>
          <Pressable
            accessibilityRole="button"
            hitSlop={TAP_SLOP}
            onPress={() => void onRetry()}
            style={{ justifyContent: 'center', minHeight: CONTROL_MIN_HEIGHT }}
          >
            <Text color="accent" variant="callout">
              {strings.chat.retry}
            </Text>
          </Pressable>
          {onOpenSettings ? (
            <Pressable
              accessibilityRole="button"
              hitSlop={TAP_SLOP}
              onPress={onOpenSettings}
              style={{ justifyContent: 'center', minHeight: CONTROL_MIN_HEIGHT }}
              testID="chat-open-settings"
            >
              <Text color="accent" variant="callout">
                {strings.chat.attach.openSettings}
              </Text>
            </Pressable>
          ) : null}
          <Pressable
            accessibilityRole="button"
            hitSlop={TAP_SLOP}
            onPress={onDismiss}
            style={{ justifyContent: 'center', minHeight: CONTROL_MIN_HEIGHT }}
            testID="chat-error-dismiss"
          >
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

  // Last, because a cache paint already explains itself and says more: this is
  // the empty-screen case, where otherwise nothing at all would be on it.
  if (waitingForConnection) {
    return (
      <View
        style={{
          alignItems: 'center',
          flexDirection: 'row',
          gap: theme.space.sm,
          padding: theme.space.md
        }}
        testID="chat-waiting-for-connection"
      >
        <ActivityIndicator />
        <Text color="textMuted" variant="callout">
          {strings.chat.waitingForConnection}
        </Text>
      </View>
    )
  }

  return null
}
