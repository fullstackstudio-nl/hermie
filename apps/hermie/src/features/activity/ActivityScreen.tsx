/**
 * Activity: one timeline of everything the bots said to each other.
 *
 * The design board's Activity screen, and the reason the app exists at all —
 * bot-to-bot traffic is invisible in any per-chat view, because it is by
 * definition spread across two chats. Rows read as sentences (`researcher →
 * writer: draft the announcement`) and each one is a door into the chat where
 * it happened.
 *
 * Two arrangements worth knowing about:
 *
 *  - Pull to refresh lives on the LIST, not on the screen. A refresh spinner
 *    that floats over the whole screen lands on top of the header it was
 *    supposed to sit under.
 *  - The counters at the top are the only thing here that is not derived from
 *    the transcripts. They are polled while this screen is mounted and dropped
 *    when it is not; a number nobody is looking at is not worth a round trip.
 */
import type { ActivityEntry } from '@hermie/transcript'
import { useMemo } from 'react'
import { RefreshControl, SectionList, Pressable, View } from 'react-native'

import { formatClock } from '../../chat-ui'
import { useGateway } from '../../gateway'
import { strings } from '../../i18n/strings'
import { useBotsStore } from '../../store/bots'
import { Screen, Text } from '../../ui/primitives'
import { useTheme } from '../../ui/theme'
import { useActivity } from './useActivity'

export interface ActivityScreenProps {
  /** Open the chat a row came from, scrolled to that row's item. */
  onOpenBot?: (botName: string, options?: { focusItemId?: string }) => void
}

interface DaySection {
  title: string
  data: ActivityEntry[]
}

const DAY_MS = 86_400_000

/** `Today`, `Yesterday`, `Tue 9 Sep` — the section heading over a day's rows. */
function dayLabel(atSeconds: number, now: number): string {
  const date = new Date(atSeconds * 1000)
  const midnight = new Date(now)

  midnight.setHours(0, 0, 0, 0)

  const start = midnight.getTime()

  if (date.getTime() >= start) {
    return strings.activity.today
  }

  if (date.getTime() >= start - DAY_MS) {
    return strings.activity.yesterday
  }

  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', weekday: 'short' })
}

/** Newest day first, and newest row first inside it: a timeline is read backwards. */
function groupByDay(entries: readonly ActivityEntry[], now: number): DaySection[] {
  const sections: DaySection[] = []

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]

    if (!entry) {
      continue
    }

    const title = dayLabel(entry.at, now)
    const last = sections[sections.length - 1]

    if (last?.title === title) {
      last.data.push(entry)
    } else {
      sections.push({ title, data: [entry] })
    }
  }

  return sections
}

export function ActivityScreen({ onOpenBot }: ActivityScreenProps) {
  const theme = useTheme()
  const { status } = useGateway()
  const { entries, counters, loading, refreshing, error, refresh } = useActivity()
  const byName = useBotsStore(state => state.byName)

  const sections = useMemo(() => groupByDay(entries, Date.now()), [entries])

  const label = (handle: string): string => {
    const bot = byName[handle] ?? Object.values(byName).find(entry => entry.name.toLowerCase() === handle)

    return bot?.displayName ?? handle
  }

  return (
    <Screen padded={false}>
      <SectionList
        ListEmptyComponent={
          <EmptyState
            error={error}
            loading={loading}
            offline={status !== 'ready' && entries.length === 0 && !loading}
          />
        }
        ListHeaderComponent={<Header counters={counters} />}
        keyExtractor={entry => entry.id}
        // On the list, not on the screen: a spinner floating over the whole
        // screen lands on top of the header it was supposed to sit under.
        refreshControl={<RefreshControl onRefresh={() => void refresh()} refreshing={refreshing} />}
        renderItem={({ item }) => (
          <Row entry={item} label={label} onPress={() => onOpenBot?.(item.botName, { focusItemId: item.itemId })} />
        )}
        renderSectionHeader={({ section }) => (
          <View style={{ backgroundColor: theme.elevation.e0, paddingHorizontal: theme.space.lg }}>
            <Text color="textMuted" style={{ fontWeight: '700', letterSpacing: 1.1 }} variant="meta">
              {section.title.toUpperCase()}
            </Text>
          </View>
        )}
        sections={sections}
        stickySectionHeadersEnabled
        testID="activity-list"
      />
    </Screen>
  )
}

function Header({ counters }: { counters: ReturnType<typeof useActivity>['counters'] }) {
  const theme = useTheme()

  return (
    <View style={{ paddingHorizontal: theme.space.lg, paddingTop: theme.space.sm }}>
      <Text variant="title">{strings.activity.title}</Text>
      <Text color="textMuted" style={{ marginTop: theme.space.xs }} variant="preview">
        {strings.activity.subtitle}
      </Text>

      <View
        style={{
          borderBottomColor: theme.hairline,
          borderBottomWidth: 1,
          flexDirection: 'row',
          gap: theme.space.lg,
          marginTop: theme.space.md,
          paddingBottom: theme.space.md
        }}
      >
        <Counter
          label={strings.activity.counters.working}
          testID="activity-count-working"
          value={counters.botsWorking}
        />
        <Counter
          label={strings.activity.counters.subagents}
          testID="activity-count-subagents"
          value={counters.activeSubagents}
        />
        <Counter
          label={strings.activity.counters.deliveries}
          testID="activity-count-deliveries"
          value={counters.inFlightDeliveries}
        />
      </View>
    </View>
  )
}

function Counter({ label, value, testID }: { label: string; value: number; testID: string }) {
  return (
    <View style={{ gap: 2 }}>
      <Text color={value > 0 ? 'accent' : 'textMuted'} style={{ fontSize: 22, fontWeight: '700' }} testID={testID}>
        {String(value)}
      </Text>
      <Text color="textMuted" style={{ fontSize: 11 }}>
        {label}
      </Text>
    </View>
  )
}

/**
 * One line of traffic.
 *
 * The heading is the sentence (`researcher → writer`), the body is what was
 * actually said, and the right edge carries the clock. A delegation has no
 * recipient, so it reads `researcher spawned 3 agents` instead.
 */
function Row({
  entry,
  label,
  onPress
}: {
  entry: ActivityEntry
  label: (handle: string) => string
  onPress: () => void
}) {
  const theme = useTheme()

  const heading =
    entry.kind === 'delegation'
      ? strings.activity.spawned(label(entry.fromHandle), entry.agentCount ?? 0)
      : entry.kind === 'dm_reply'
        ? strings.activity.reply(label(entry.fromHandle), label(entry.toHandle ?? ''))
        : strings.activity.to(label(entry.fromHandle), label(entry.toHandle ?? ''))

  const status =
    entry.kind === 'delegation' ? (strings.activity.groupStatus[entry.status ?? ''] ?? entry.status) : entry.status

  return (
    <Pressable
      accessibilityHint={strings.activity.openChat(label(entry.botName))}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => ({
        backgroundColor: pressed ? theme.elevation.e2 : 'transparent',
        gap: 2,
        paddingHorizontal: theme.space.lg,
        paddingVertical: theme.space.md
      })}
      testID={`activity-row-${entry.id}`}
    >
      <View style={{ alignItems: 'baseline', flexDirection: 'row', gap: theme.space.sm }}>
        <Text numberOfLines={1} style={{ color: theme.colors.text, flex: 1, fontSize: 15, fontWeight: '600' }}>
          {heading}
        </Text>
        {entry.at ? (
          <Text color="textMuted" variant="meta">
            {formatClock(entry.at)}
          </Text>
        ) : null}
      </View>

      {entry.text ? (
        <Text color="textMuted" numberOfLines={2} style={{ fontSize: 14, lineHeight: 19 }}>
          {entry.text}
        </Text>
      ) : null}

      {status ? (
        <Text
          color={entry.failed ? 'dangerText' : entry.pending ? 'accent' : 'textMuted'}
          style={{ fontSize: 11 }}
          testID={`activity-status-${entry.id}`}
        >
          {status}
        </Text>
      ) : null}
    </Pressable>
  )
}

function EmptyState({ loading, error, offline }: { loading: boolean; error: string | null; offline: boolean }) {
  const theme = useTheme()

  const message = error
    ? strings.activity.failed(error)
    : loading
      ? strings.activity.loading
      : offline
        ? strings.activity.emptyOffline
        : strings.activity.empty

  return (
    <View style={{ padding: theme.space.lg }}>
      <Text color={error ? 'dangerText' : 'textMuted'} testID="activity-empty">
        {message}
      </Text>
    </View>
  )
}
