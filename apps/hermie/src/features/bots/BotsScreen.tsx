/**
 * The bot list.
 *
 * TEMPORARY RENDERING. The chat UI kit owns the real cards — avatars, preview
 * formatting, the running spinner; this paints the same data as plain rows so
 * the data layer can be driven end to end before those components land. Every
 * marker below reads from a store, so swapping the presentation is a swap of
 * this file alone.
 */
import { useCallback, useEffect, useState } from 'react'
import { FlatList, Pressable, RefreshControl, View } from 'react-native'

import { strings } from '../../i18n/strings'
import { type Bot, isUnread, useBotsStore } from '../../store/bots'
import { useChatsStore } from '../../store/chats'
import { Screen, Text } from '../../ui/primitives'
import { useTheme } from '../../ui/theme'
import { useChatRuntime } from '../chats/ChatRuntime'

export interface BotsScreenProps {
  /** Compact shell: navigate. Regular shell: select in place. */
  onOpenBot?: (bot: Bot) => void
  selectedBot?: string | undefined
}

export function BotsScreen({ onOpenBot, selectedBot }: BotsScreenProps) {
  const runtime = useChatRuntime()
  const bots = useBotsStore(state => state.bots)
  const loading = useBotsStore(state => state.loading)
  const error = useBotsStore(state => state.error)
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => {
    // Running state is polled only while this list is mounted; an unwatched
    // roster has nothing to animate.
    return runtime?.bots.watchRunning()
  }, [runtime])

  const refresh = useCallback(async () => {
    setRefreshing(true)

    try {
      await runtime?.bots.refresh()
    } catch {
      // The store already holds the message; the list keeps what it had.
    } finally {
      setRefreshing(false)
    }
  }, [runtime])

  return (
    <Screen edgeToEdgeTop padded={false}>
      <FlatList
        data={bots}
        keyExtractor={bot => bot.name}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
        ListEmptyComponent={<EmptyState loading={loading} error={error} />}
        renderItem={({ item }) => (
          <BotRow bot={item} selected={item.name === selectedBot} onPress={() => onOpenBot?.(item)} />
        )}
      />
    </Screen>
  )
}

function EmptyState({ loading, error }: { loading: boolean; error: string | null }) {
  const theme = useTheme()

  return (
    <View style={{ padding: theme.space.lg, gap: theme.space.sm }}>
      <Text color="textMuted">
        {error ? strings.bots.failed(error) : loading ? strings.bots.loading : strings.bots.empty}
      </Text>
    </View>
  )
}

function BotRow({ bot, selected, onPress }: { bot: Bot; selected: boolean; onPress: () => void }) {
  const theme = useTheme()
  const running = useBotsStore(state => Boolean(state.running[bot.name]))
  const unread = useBotsStore(state => isUnread(state, bot.name))
  // "Needs input" is not a roster field: it is an open approval or clarify in
  // the chat this app already holds, which is why it survives a roster refresh.
  const needsInput = useChatsStore(state => {
    const chat = state.chats[bot.name]

    if (!chat) {
      return false
    }

    return chat.order.some(id => {
      const item = chat.items[id]

      return (item?.kind === 'approval' || item?.kind === 'clarify') && item.state === 'open'
    })
  })

  const markers: string[] = []

  if (needsInput) {
    markers.push(strings.bots.needsInput)
  }

  if (running) {
    markers.push(strings.bots.running)
  }

  if (unread) {
    markers.push(strings.bots.unread)
  }

  if (bot.isDefault) {
    markers.push(strings.bots.defaultBot)
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={bot.displayName}
      onPress={onPress}
      style={{
        paddingVertical: theme.space.md,
        paddingHorizontal: theme.space.lg,
        gap: theme.space.xs,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
        backgroundColor: selected ? theme.colors.surfaceRaised : 'transparent'
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space.sm }}>
        <Text variant="heading">{bot.displayName}</Text>
        {markers.map(marker => (
          <Text key={marker} variant="caption" color="accent">
            {marker}
          </Text>
        ))}
      </View>
      <Text color="textMuted" numberOfLines={1}>
        {bot.canonical?.preview || bot.description || strings.bots.noPreview}
      </Text>
    </Pressable>
  )
}
