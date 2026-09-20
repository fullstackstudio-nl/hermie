/**
 * One conversation in the list.
 *
 * Everything the row shows about state is derived rather than stored twice:
 * `working` comes from the roster's running poll, `needs input` from the open
 * requests the chat store already holds, unread from the canonical chat's
 * `last_active` against a per-bot watermark. `presenceOf` turns all of it into
 * one of four beads, and it is a pure function so the row and (in Part 2) the
 * chat header cannot disagree about what a bot is doing.
 */
import { memo, useState } from 'react'
import { Pressable, View } from 'react-native'

import { unreadBadgeLabel } from '@hermie/transcript'

import { Avatar, formatListTime, formatPreview } from '../../chat-ui'
import { strings } from '../../i18n/strings'
import type { Bot } from '../../store/bots'
import { GlassSurface } from '../../ui/glass'
import { PresenceBead } from '../../ui/PresenceBead'
import { Text } from '../../ui/primitives'
import { useTheme } from '../../ui/theme'
import { AVATAR_SIZE, ROW_HEIGHT, TAP_SLOP, type AccentName } from '../../ui/tokens'
import type { Presence } from './presence'

export type BotRowProps = {
  bot: Bot
  accent: AccentName
  avatarUri?: string | undefined
  compact: boolean
  editing: boolean
  presence: Presence
  selected: boolean
  unread: boolean
  unreadCount: number
  /**
   * Every callback takes what it acts on rather than closing over it. That is
   * what lets the list hand down ONE identity per handler, which is the only
   * way the memo above survives a roster refresh.
   */
  onPress: (bot: Bot) => void
  onOpenMenu: (botName: string) => void
  /** Edit mode only: one position up or down, across dividers included. */
  onMove?: (botName: string, offset: number) => void
}

function stampOf(presence: Presence, bot: Bot): string {
  return presence.state === 'offline' && presence.lastSeenAt
    ? formatListTime(presence.lastSeenAt)
    : formatListTime(bot.canonical?.lastActive)
}

export const BotRow = memo(function BotRow({
  accent,
  avatarUri,
  bot,
  compact,
  editing,
  onMove,
  onOpenMenu,
  onPress,
  presence,
  selected,
  unread,
  unreadCount
}: BotRowProps) {
  const theme = useTheme()
  const [hovered, setHovered] = useState(false)
  const swatch = theme.accent(accent)

  // Offline replaces the preview with when the bot was last heard from: a stale
  // last message under a dead connection reads as if it just arrived.
  const preview =
    presence.state === 'offline' && presence.lastSeenAt
      ? strings.presence.offlineSince(formatListTime(presence.lastSeenAt))
      : bot.canonical?.preview
        ? formatPreview(bot.canonical.preview)
        : bot.description || strings.bots.noPreview

  const stamp = stampOf(presence, bot)

  const label = [
    bot.displayName,
    strings.presence[presence.state],
    unreadCount > 0 ? strings.bots.unreadLabel(unreadCount) : unread ? strings.bots.unread : ''
  ]
    .filter(Boolean)
    .join(', ')

  const body = (
    <View
      style={{
        alignItems: 'center',
        flexDirection: 'row',
        gap: theme.space.md,
        minHeight: compact ? ROW_HEIGHT.compact : ROW_HEIGHT.regular,
        paddingHorizontal: theme.space.md,
        paddingVertical: theme.space.sm
      }}
    >
      {editing ? (
        <View style={{ alignItems: 'center', gap: 2, width: 26 }}>
          <MoveButton
            direction="up"
            label={`${strings.layout.moveUp}: ${bot.displayName}`}
            onPress={() => onMove?.(bot.name, -1)}
            testID={`bot-move-up-${bot.name}`}
          />
          <MoveButton
            direction="down"
            label={`${strings.layout.moveDown}: ${bot.displayName}`}
            onPress={() => onMove?.(bot.name, 1)}
            testID={`bot-move-down-${bot.name}`}
          />
        </View>
      ) : null}

      <View>
        <Avatar
          name={bot.displayName}
          size={AVATAR_SIZE.list}
          // The accent ring is how a per-chat colour shows up in the list. A
          // chat on Default gets no ring at all rather than a blue one, so the
          // ring means "this one was given a colour".
          //
          // §1.3 is the authority: Default is not one of the eight curated
          // colours, and the four things a colour tints start with "the avatar
          // ring in the list and the header". So a ringless Default row is
          // correct and is NOT the cause of a washed-out avatar — that was the
          // tint's separation from the panel, fixed in `Avatar`. Keyed on the
          // accent alone, never on whether the bot has a picture: a ring that
          // came and went with an asset would make the colour mean two things.
          style={
            accent === 'default'
              ? undefined
              : { borderColor: swatch.fill, borderWidth: 2.5, height: AVATAR_SIZE.list, width: AVATAR_SIZE.list }
          }
          {...(avatarUri ? { uri: avatarUri } : {})}
        />
        <View style={{ bottom: -1, position: 'absolute', right: -1 }}>
          <PresenceBead
            ringColor={selected ? theme.elevation.e2s : theme.elevation.e1}
            state={presence.state}
            testID={`bot-presence-${bot.name}`}
          />
        </View>
      </View>

      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={{ alignItems: 'baseline', flexDirection: 'row', gap: theme.space.sm }}>
          <Text numberOfLines={1} style={{ flex: 1, fontWeight: unread ? '700' : '600' }} variant="name">
            {bot.displayName}
          </Text>
          {stamp ? (
            <Text color="textFaint" variant="meta">
              {stamp}
            </Text>
          ) : null}
        </View>

        <Text
          color={unread ? 'text' : 'textMuted'}
          numberOfLines={1}
          style={{ marginTop: 2 }}
          testID={`bot-preview-${bot.name}`}
          variant="preview"
        >
          {preview}
        </Text>
      </View>

      {unread || unreadCount > 0 ? <UnreadBadge accent={swatch.fill} count={unreadCount} /> : null}
    </View>
  )

  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onLongPress={() => onOpenMenu(bot.name)}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onPress={() => onPress(bot)}
      style={{ marginHorizontal: theme.space.sm }}
      testID={`bot-row-${bot.name}`}
    >
      {selected ? (
        // The selected row is a lighter glass pill tinted with the chat's own
        // colour — level 3, so a tint and no blur of its own.
        <GlassSurface tint={swatch.soft} variant="rowSelected">
          {body}
        </GlassSurface>
      ) : (
        <View
          style={{
            backgroundColor: hovered ? theme.glass.row.solid : 'transparent',
            borderRadius: theme.radii.card
          }}
        >
          {body}
        </View>
      )}
    </Pressable>
  )
})

function MoveButton({
  direction,
  label,
  onPress,
  testID
}: {
  direction: 'up' | 'down'
  label: string
  onPress: () => void
  testID: string
}) {
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      hitSlop={TAP_SLOP}
      onPress={onPress}
      testID={testID}
    >
      <Text color="textMuted" style={{ fontSize: 15, lineHeight: 17 }}>
        {direction === 'up' ? '↑' : '↓'}
      </Text>
    </Pressable>
  )
}

/**
 * A number when the app can count, a dot when it cannot.
 *
 * The gateway reports `last_active` for a canonical chat and nothing more, so a
 * chat this app has never read can only be shown as "it moved". A chat it HAS
 * read is counted from the transcript itself and capped, because a badge wider
 * than the row's stamp stops being a badge.
 */
function UnreadBadge({ accent, count }: { accent: string; count: number }) {
  const label = unreadBadgeLabel(count)

  if (!label) {
    return (
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{ backgroundColor: accent, borderRadius: 5, height: 10, width: 10 }}
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
        backgroundColor: accent,
        borderRadius: 11,
        justifyContent: 'center',
        minWidth: 22,
        paddingHorizontal: 6,
        paddingVertical: 2
      }}
      testID="bot-unread"
    >
      <Text color="onAccent" style={{ fontSize: 12, fontWeight: '700' }}>
        {label}
      </Text>
    </View>
  )
}
