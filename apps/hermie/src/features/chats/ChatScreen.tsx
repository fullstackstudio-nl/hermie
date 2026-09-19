/**
 * One bot's chat.
 *
 * TEMPORARY RENDERING. Every item is one line of text and the agent's questions
 * are inline buttons; the real bubbles, tool cards, markdown and bottom sheets
 * belong to the chat UI kit and replace the body of this file. What is worth
 * keeping is the wiring: the screen reads `visibleItems` and calls the hook,
 * and knows nothing about the gateway.
 */
import type { VisibleItem } from '@hermie/transcript'
import { useCallback, useState } from 'react'
import { ActivityIndicator, FlatList, KeyboardAvoidingView, Platform, Pressable, TextInput, View } from 'react-native'

import { strings } from '../../i18n/strings'
import { Screen, Text } from '../../ui/primitives'
import { useTheme } from '../../ui/theme'
import { useChat } from './useChat'

export type ChatScreenProps = {
  /** The compact shell passes the bot through navigation params. */
  route?: { params?: { bot?: string } }
  /** The regular shell passes it directly. */
  bot?: string
}

export function ChatScreen({ route, bot }: ChatScreenProps) {
  const botName = bot ?? route?.params?.bot ?? ''

  if (!botName) {
    return <NoBotSelected />
  }

  return <Conversation botName={botName} />
}

function NoBotSelected() {
  const theme = useTheme()

  return (
    <Screen>
      <View style={{ flex: 1, justifyContent: 'center', gap: theme.space.sm }}>
        <Text color="textMuted">{strings.bots.empty}</Text>
      </View>
    </Screen>
  )
}

function Conversation({ botName }: { botName: string }) {
  const theme = useTheme()
  const chat = useChat(botName)
  const [sending, setSending] = useState(false)

  const submit = useCallback(async () => {
    const text = chat.draft.trim()

    if (!text || sending) {
      return
    }

    setSending(true)

    try {
      await chat.send(text)
    } catch {
      // The optimistic bubble stays and the composer comes back; the banner
      // above the list explains what the connection is doing.
    } finally {
      setSending(false)
    }
  }, [chat, sending])

  return (
    <Screen edgeToEdgeTop padded={false}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        // Without this the composer sits under the keyboard on a phone, which
        // makes Send unreachable the moment you have typed something.
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <Banner hydration={chat.hydration} error={chat.error} onRetry={chat.reload} />

        <FlatList
          style={{ flex: 1 }}
          data={chat.items}
          keyExtractor={entry => entry.item.id}
          renderItem={({ item }) => <Row entry={item} />}
          keyboardDismissMode="on-drag"
          ListEmptyComponent={
            chat.hydration === 'hydrating' ? null : (
              <View style={{ padding: theme.space.lg }}>
                <Text color="textMuted">{strings.chat.empty}</Text>
              </View>
            )
          }
        />

        {chat.requests.map(request => (
          <RequestCard
            key={request.id}
            request={request}
            onApprove={(requestId, choice) => void chat.respondApproval(requestId, choice)}
            onClarify={(requestId, answers) => void chat.respondClarify(requestId, answers)}
          />
        ))}

        {chat.subagents.length ? (
          <Text variant="caption" color="textMuted" style={{ paddingHorizontal: theme.space.lg }}>
            {strings.chat.subagents(chat.subagents.length)}
          </Text>
        ) : null}

        <View
          style={{
            flexDirection: 'row',
            alignItems: 'flex-end',
            gap: theme.space.sm,
            padding: theme.space.md,
            borderTopWidth: 1,
            borderTopColor: theme.colors.border
          }}
        >
          <TextInput
            accessibilityLabel={strings.chat.placeholder}
            placeholder={strings.chat.placeholder}
            placeholderTextColor={theme.colors.textMuted}
            value={chat.draft}
            onChangeText={chat.setDraft}
            multiline
            style={{
              flex: 1,
              minHeight: 40,
              maxHeight: 120,
              color: theme.colors.text,
              backgroundColor: theme.colors.surface,
              borderRadius: theme.radii.lg,
              paddingHorizontal: theme.space.md,
              paddingVertical: theme.space.sm
            }}
          />
          {chat.busy ? (
            <Pressable accessibilityRole="button" onPress={() => void chat.stop()} hitSlop={8}>
              <Text variant="callout" color="danger">
                {strings.chat.stop}
              </Text>
            </Pressable>
          ) : (
            <Pressable accessibilityRole="button" onPress={() => void submit()} hitSlop={8} disabled={sending}>
              <Text variant="callout" color="accent">
                {strings.chat.send}
              </Text>
            </Pressable>
          )}
        </View>
      </KeyboardAvoidingView>
    </Screen>
  )
}

function Banner({
  hydration,
  error,
  onRetry
}: {
  hydration: ReturnType<typeof useChat>['hydration']
  error: string | null
  onRetry: () => Promise<void>
}) {
  const theme = useTheme()

  if (error) {
    return (
      <View style={{ padding: theme.space.md, gap: theme.space.xs, backgroundColor: theme.colors.surfaceRaised }}>
        <Text variant="callout" color="danger">
          {strings.chat.failed(error)}
        </Text>
        <Pressable accessibilityRole="button" onPress={() => void onRetry()}>
          <Text variant="callout" color="accent">
            {strings.chat.retry}
          </Text>
        </Pressable>
      </View>
    )
  }

  if (hydration === 'hydrating') {
    return (
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: theme.space.sm,
          padding: theme.space.md
        }}
      >
        <ActivityIndicator />
        <Text variant="callout" color="textMuted">
          {strings.chat.hydrating}
        </Text>
      </View>
    )
  }

  if (hydration === 'cached' || hydration === 'stale') {
    return (
      <View style={{ padding: theme.space.md, backgroundColor: theme.colors.surfaceRaised }}>
        <Text variant="callout" color="textMuted">
          {hydration === 'cached' ? strings.chat.offlineCopy : strings.chat.stale}
        </Text>
      </View>
    )
  }

  return null
}

/** One transcript item as a single line. The UI kit replaces this entirely. */
function Row({ entry }: { entry: VisibleItem }) {
  const theme = useTheme()
  const { item, presentation } = entry
  const muted = presentation !== 'full'

  return (
    <View style={{ paddingHorizontal: theme.space.lg, paddingVertical: theme.space.xs }}>
      <Text variant="caption" color="textMuted">
        {label(entry)}
      </Text>
      <Text color={muted ? 'textMuted' : 'text'} numberOfLines={presentation === 'full' ? undefined : 2}>
        {body(entry)}
      </Text>
      {item.kind === 'assistant' && item.reasoning ? (
        <Text variant="caption" color="textMuted">
          {strings.chat.thinking}: {item.reasoning}
        </Text>
      ) : null}
    </View>
  )
}

function label({ item }: VisibleItem): string {
  switch (item.kind) {
    case 'user':
      return item.unknownAuthor ? strings.chat.unknownAuthor : 'You'
    case 'bot_dm_in':
      return `@${item.senderHandle ?? item.senderName} →`
    case 'assistant':
      return item.replyToBotHandle ? `Reply to @${item.replyToBotHandle}` : 'Bot'
    case 'tool':
      return `${item.name} · ${item.status === 'running' ? strings.chat.toolRunning : item.status}`
    case 'bot_dm_out':
      return `→ @${item.targetHandle} · ${item.dispatch.status}`
    case 'subagent_group':
      return `Delegation · ${item.status}`
    case 'status':
      return item.statusKind
    case 'notice':
      return item.noticeKind
    case 'approval':
      return strings.chat.approvalTitle
    case 'clarify':
      return strings.chat.clarifyTitle
  }
}

function body({ item }: VisibleItem): string {
  switch (item.kind) {
    case 'user':
    case 'bot_dm_in':
    case 'assistant':
      return item.text || (item.kind === 'assistant' && item.error ? item.error.message : '')
    case 'tool':
      return item.summary ?? item.context ?? ''
    case 'bot_dm_out':
      return item.reply ? `${item.message} ↩ ${item.reply.text}` : item.message
    case 'subagent_group':
      return item.goals.join(', ')
    case 'status':
      return item.text
    case 'notice':
      return item.body ? `${item.title} — ${item.body}` : item.title
    case 'approval':
      return item.command
    case 'clarify':
      return item.questions.map(question => question.question).join(' · ')
  }
}

/** Approval and clarify as inline buttons; the real ones are bottom sheets. */
function RequestCard({
  request,
  onApprove,
  onClarify
}: {
  request: VisibleItem['item']
  onApprove: (requestId: string, choice: string) => void
  onClarify: (requestId: string, answers: Record<string, string>) => void
}) {
  const theme = useTheme()

  if (request.kind !== 'approval' && request.kind !== 'clarify') {
    return null
  }

  const choices = request.kind === 'approval' ? request.choices : (request.questions[0]?.choices ?? ['yes', 'no'])

  return (
    <View
      style={{
        padding: theme.space.md,
        gap: theme.space.sm,
        borderTopWidth: 1,
        borderTopColor: theme.colors.border,
        backgroundColor: theme.colors.surface
      }}
    >
      <Text variant="caption" color="textMuted">
        {request.kind === 'approval' ? strings.chat.approvalTitle : strings.chat.clarifyTitle}
      </Text>
      <Text variant="mono">
        {request.kind === 'approval'
          ? request.command
          : request.questions.map(question => question.question).join('\n')}
      </Text>
      <View style={{ flexDirection: 'row', gap: theme.space.md, flexWrap: 'wrap' }}>
        {choices.map(choice => (
          <Pressable
            key={choice}
            accessibilityRole="button"
            onPress={() => {
              if (request.kind === 'approval') {
                onApprove(request.requestId, choice)

                return
              }

              const qid = request.questions.find(question => request.answers[question.qid] === undefined)?.qid

              if (qid) {
                onClarify(request.requestId, { ...request.answers, [qid]: choice })
              }
            }}
            hitSlop={8}
          >
            <Text variant="callout" color="accent">
              {choice}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  )
}
