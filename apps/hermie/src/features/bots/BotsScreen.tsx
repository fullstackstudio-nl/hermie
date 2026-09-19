/**
 * The chat list — the first thing the app shows.
 *
 * It is the design board's "01 / Chats": a large title, a search field, and one
 * row per bot carrying an avatar, the last thing said, a relative stamp and the
 * badges that decide whether you tap it now or later. Two of those badges are
 * not roster fields and cannot be:
 *
 *  - "working" comes from `session.active_list`, polled only while this list is
 *    mounted, because an unwatched roster has nothing to animate.
 *  - "needs your input" comes from the open approvals and clarifies the chat
 *    store already holds, so it survives a roster refresh and is true even for
 *    a question that arrived while this screen was not on top.
 *
 * The same component is the regular shell's sidebar (`variant="sidebar"`):
 * denser rows, no large title, no tab bar — the shell has its own footer.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { FlatList, Pressable, RefreshControl, TextInput, View } from 'react-native'

import { unreadBadgeLabel, unreadCountSince } from '@hermie/transcript'

import { Avatar, formatListTime, formatPreview } from '../../chat-ui'
import { useGateway } from '../../gateway'
import { strings } from '../../i18n/strings'
import { type Bot, isUnread, useBotsStore } from '../../store/bots'
import { useChatsStore } from '../../store/chats'
import { Screen, Text } from '../../ui/primitives'
import { useTheme } from '../../ui/theme'
import { CONTROL_MIN_HEIGHT } from '../../ui/tokens'
import { useChatRuntime } from '../chats/ChatRuntime'

export type BotsSection = 'activity' | 'cron' | 'settings'

export interface BotsScreenProps {
  /** Compact shell: navigate. Regular shell: select in place. */
  onOpenBot?: (bot: Bot) => void
  selectedBot?: string | undefined
  /** Compact shell only: the footer tabs. The sidebar has its own footer. */
  onOpenSection?: (section: BotsSection) => void
  variant?: 'screen' | 'sidebar'
}

const TABS: { key: BotsSection; label: string; glyph: string }[] = [
  { key: 'activity', label: strings.tabs.activity, glyph: '⇄' },
  { key: 'cron', label: strings.tabs.routines, glyph: '◷' },
  { key: 'settings', label: strings.tabs.settings, glyph: '⚙' }
]

/** Name or description, case-insensitively — what a reader would type. */
function matches(bot: Bot, query: string): boolean {
  if (!query) {
    return true
  }

  const needle = query.trim().toLowerCase()

  return (
    bot.displayName.toLowerCase().includes(needle) ||
    bot.name.toLowerCase().includes(needle) ||
    bot.description.toLowerCase().includes(needle)
  )
}

export function BotsScreen({ onOpenBot, selectedBot, onOpenSection, variant = 'screen' }: BotsScreenProps) {
  const theme = useTheme()
  const runtime = useChatRuntime()
  const { status } = useGateway()
  const bots = useBotsStore(state => state.bots)
  const loading = useBotsStore(state => state.loading)
  const error = useBotsStore(state => state.error)
  const refreshedAt = useBotsStore(state => state.refreshedAt)
  const [refreshing, setRefreshing] = useState(false)
  const [query, setQuery] = useState('')

  const sidebar = variant === 'sidebar'

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

  const visible = useMemo(() => bots.filter(bot => matches(bot, query)), [bots, query])

  return (
    <Screen edgeToEdgeTop={sidebar} padded={false}>
      <FlatList
        ListEmptyComponent={
          <EmptyState error={error} loading={loading} query={query} searching={Boolean(query.trim())} />
        }
        ListFooterComponent={
          sidebar || !visible.length ? null : (
            <Text
              color="textMuted"
              style={{ paddingHorizontal: theme.space.lg, paddingVertical: theme.space.xl, textAlign: 'center' }}
              variant="caption"
            >
              {strings.bots.footnote}
            </Text>
          )
        }
        ListHeaderComponent={
          <ListHeader
            count={visible.length}
            offline={status === 'offline' || (status !== 'ready' && refreshedAt === null)}
            onChangeQuery={setQuery}
            query={query}
            sidebar={sidebar}
            status={status}
          />
        }
        data={visible}
        keyExtractor={bot => bot.name}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl onRefresh={refresh} refreshing={refreshing} />}
        renderItem={({ item }) => (
          <BotRow bot={item} compact={sidebar} onPress={() => onOpenBot?.(item)} selected={item.name === selectedBot} />
        )}
        testID="bots-list"
      />

      {onOpenSection ? <TabBar onOpenSection={onOpenSection} /> : null}
    </Screen>
  )
}

function ListHeader({
  count,
  offline,
  onChangeQuery,
  query,
  sidebar,
  status
}: {
  count: number
  offline: boolean
  onChangeQuery: (value: string) => void
  query: string
  sidebar: boolean
  status: string
}) {
  const theme = useTheme()

  return (
    <View style={{ paddingHorizontal: theme.space.lg, paddingTop: sidebar ? theme.space.md : theme.space.sm }}>
      {sidebar ? (
        <Text color="textMuted" style={{ marginBottom: theme.space.sm }} variant="caption">
          {strings.bots.sidebarHeader}
        </Text>
      ) : (
        <Text style={{ marginBottom: theme.space.md }} variant="display">
          {strings.bots.title}
        </Text>
      )}

      {sidebar ? null : (
        <View
          style={{
            alignItems: 'center',
            borderBottomColor: theme.colors.border,
            borderBottomWidth: 1,
            flexDirection: 'row',
            justifyContent: 'space-between',
            paddingBottom: theme.space.md
          }}
        >
          <Text color={status === 'ready' ? 'success' : 'textMuted'} variant="caption">
            {`● ${strings.connection.status[status as keyof typeof strings.connection.status] ?? status}`}
          </Text>
        </View>
      )}

      <SearchField onChangeText={onChangeQuery} value={query} />

      {offline ? (
        <Text color="textMuted" style={{ paddingBottom: theme.space.sm }} variant="caption">
          {strings.bots.offline}
        </Text>
      ) : null}

      {sidebar ? null : (
        <View
          style={{
            alignItems: 'center',
            flexDirection: 'row',
            justifyContent: 'space-between',
            paddingBottom: theme.space.xs,
            paddingTop: theme.space.sm
          }}
        >
          <Text color="textMuted" style={{ fontWeight: '700', letterSpacing: 1.1 }} variant="caption">
            {strings.bots.section}
          </Text>
          <Text color="textMuted" variant="caption">
            {strings.bots.conversations(count)}
          </Text>
        </View>
      )}
    </View>
  )
}

function SearchField({ onChangeText, value }: { onChangeText: (value: string) => void; value: string }) {
  const theme = useTheme()

  return (
    <View
      style={{
        alignItems: 'center',
        backgroundColor: theme.colors.surfaceRaised,
        borderRadius: theme.radii.lg,
        flexDirection: 'row',
        gap: theme.space.sm,
        marginVertical: theme.space.sm,
        paddingHorizontal: theme.space.md
      }}
    >
      <Text color="textMuted">{'⌕'}</Text>
      <TextInput
        accessibilityLabel={strings.bots.search}
        autoCapitalize="none"
        autoCorrect={false}
        clearButtonMode="while-editing"
        onChangeText={onChangeText}
        placeholder={strings.bots.search}
        placeholderTextColor={theme.colors.textMuted}
        style={{
          color: theme.colors.text,
          flex: 1,
          fontSize: 17,
          minHeight: CONTROL_MIN_HEIGHT,
          paddingVertical: theme.space.sm
        }}
        testID="bots-search"
        value={value}
      />
    </View>
  )
}

function EmptyState({
  loading,
  error,
  query,
  searching
}: {
  loading: boolean
  error: string | null
  query: string
  searching: boolean
}) {
  const theme = useTheme()

  const message = error
    ? strings.bots.failed(error)
    : searching
      ? strings.bots.noMatches(query.trim())
      : loading
        ? strings.bots.loading
        : strings.bots.empty

  return (
    <View style={{ gap: theme.space.sm, padding: theme.space.lg }}>
      <Text color={error ? 'danger' : 'textMuted'} testID="bots-empty">
        {message}
      </Text>
    </View>
  )
}

function BotRow({
  bot,
  selected,
  compact,
  onPress
}: {
  bot: Bot
  selected: boolean
  compact: boolean
  onPress: () => void
}) {
  const theme = useTheme()
  const running = useBotsStore(state => Boolean(state.running[bot.name]))
  const unread = useBotsStore(state => isUnread(state, bot.name))
  const lastSeen = useBotsStore(state => state.lastSeen[bot.name] ?? 0)
  const avatar = useBotsStore(state => state.avatars[bot.name])
  /**
   * How many messages arrived since the user last looked.
   *
   * Only countable when the chat is actually loaded — opened once, or pulled in
   * by the Activity screen's background load. The gateway reports `last_active`
   * and nothing else, so a chat this app has never read can only say THAT it
   * moved, and the badge stays a dot rather than inventing a number.
   */
  const unreadCount = useChatsStore(state => {
    const chat = state.chats[bot.name]

    return chat ? unreadCountSince(chat, lastSeen) : 0
  })
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

  // The gateway reports `last_active`, not a count, so the badge is a dot
  // unless the roster gave us something countable to show.
  const preview = bot.canonical?.preview ? formatPreview(bot.canonical.preview) : bot.description
  const stamp = formatListTime(bot.canonical?.lastActive)

  const label = [
    bot.displayName,
    unreadCount > 0 ? strings.bots.unreadLabel(unreadCount) : unread ? strings.bots.unread : '',
    needsInput ? strings.bots.needsInput : '',
    running ? strings.bots.running : ''
  ]
    .filter(Boolean)
    .join(', ')

  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => ({
        backgroundColor: selected || pressed ? theme.colors.surfaceRaised : 'transparent',
        flexDirection: 'row',
        gap: theme.space.md,
        paddingHorizontal: theme.space.lg,
        paddingVertical: compact ? theme.space.sm : theme.space.md
      })}
      testID={`bot-row-${bot.name}`}
    >
      <Avatar name={bot.displayName} size={compact ? 40 : 52} uri={avatar} />

      <View
        style={{
          borderBottomColor: theme.colors.border,
          borderBottomWidth: compact ? 0 : 1,
          flex: 1,
          gap: 2,
          paddingBottom: compact ? 0 : theme.space.sm
        }}
      >
        <View style={{ alignItems: 'baseline', flexDirection: 'row', gap: theme.space.sm }}>
          <Text numberOfLines={1} style={{ flex: 1, fontSize: compact ? 16 : 17, fontWeight: '600' }}>
            {bot.displayName}
          </Text>
          {stamp ? (
            <Text color="textMuted" variant="caption">
              {stamp}
            </Text>
          ) : null}
          {unread || unreadCount > 0 ? <UnreadBadge count={unreadCount} /> : null}
        </View>

        <Text color="textMuted" numberOfLines={compact ? 1 : 2} style={{ fontSize: compact ? 13 : 15 }}>
          {preview || strings.bots.noPreview}
        </Text>

        {needsInput || running ? (
          <View style={{ alignItems: 'center', flexDirection: 'row', gap: theme.space.sm }}>
            {needsInput ? (
              <Text
                color="accent"
                style={{ fontWeight: '600' }}
                testID={`bot-needs-input-${bot.name}`}
                variant="caption"
              >
                {strings.bots.needsInput}
              </Text>
            ) : null}
            {running ? (
              <Text color="success" testID={`bot-running-${bot.name}`} variant="caption">
                {`● ${strings.bots.running}`}
              </Text>
            ) : null}
          </View>
        ) : null}
      </View>
    </Pressable>
  )
}

/**
 * A number when the app can count, a dot when it cannot.
 *
 * The gateway reports `last_active` for a canonical chat and nothing more, so a
 * chat this app has never read can only be shown as "it moved". A chat it HAS
 * read is counted from the transcript itself — replies and inbound teammate
 * messages since the watermark — and capped, because a badge wider than the
 * row's stamp stops being a badge.
 */
function UnreadBadge({ count }: { count: number }) {
  const theme = useTheme()
  const label = unreadBadgeLabel(count)

  if (!label) {
    return (
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{
          backgroundColor: theme.colors.bubbleBlue,
          borderRadius: 5,
          height: 10,
          width: 10
        }}
        testID="bot-unread"
      />
    )
  }

  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        alignItems: 'center',
        backgroundColor: theme.colors.bubbleBlue,
        borderRadius: 10,
        justifyContent: 'center',
        minWidth: 20,
        paddingHorizontal: 6,
        paddingVertical: 1
      }}
      testID="bot-unread"
    >
      <Text color="onAccent" style={{ fontSize: 12, fontWeight: '700' }}>
        {label}
      </Text>
    </View>
  )
}

function TabBar({ onOpenSection }: { onOpenSection: (section: BotsSection) => void }) {
  const theme = useTheme()

  return (
    <View
      style={{
        backgroundColor: theme.colors.surface,
        borderTopColor: theme.colors.border,
        borderTopWidth: 1,
        flexDirection: 'row',
        justifyContent: 'space-around',
        paddingTop: theme.space.sm
      }}
    >
      <Tab glyph="◉" label={strings.tabs.chats} selected />
      {TABS.map(tab => (
        <Tab glyph={tab.glyph} key={tab.key} label={tab.label} onPress={() => onOpenSection(tab.key)} />
      ))}
    </View>
  )
}

function Tab({
  glyph,
  label,
  onPress,
  selected = false
}: {
  glyph: string
  label: string
  onPress?: () => void
  selected?: boolean
}) {
  const theme = useTheme()

  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected }}
      disabled={!onPress}
      onPress={onPress}
      style={({ pressed }) => ({
        alignItems: 'center',
        minWidth: 70,
        opacity: pressed ? 0.6 : 1,
        paddingBottom: theme.space.sm,
        paddingTop: theme.space.xs
      })}
      testID={`tab-${label.toLowerCase()}`}
    >
      <Text color={selected ? 'accent' : 'textMuted'} style={{ fontSize: 21, lineHeight: 26 }}>
        {glyph}
      </Text>
      <Text color={selected ? 'accent' : 'textMuted'} style={{ fontSize: 11, fontWeight: selected ? '700' : '500' }}>
        {label}
      </Text>
    </Pressable>
  )
}
