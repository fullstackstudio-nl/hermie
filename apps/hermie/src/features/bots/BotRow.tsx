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
import { memo, useMemo, useState } from 'react'
import { Pressable, View, type PanResponderInstance } from 'react-native'

import { unreadBadgeLabel } from '@hermie/transcript'

import { Avatar, formatListTime, formatPreview } from '../../chat-ui'
import { strings } from '../../i18n/strings'
import { ContextMenuHost, HAS_NATIVE_CONTEXT_MENU } from '../../platform/context-menu'
import { secondaryClick } from '../../platform/secondary-click'
import type { Bot } from '../../store/bots'
import { GlassSurface } from '../../ui/glass'
import { PresenceBead } from '../../ui/PresenceBead'
import { Text } from '../../ui/primitives'
import { useTheme } from '../../ui/theme'
import { AVATAR_SIZE, ROW_HEIGHT, TAP_SLOP, type AccentName } from '../../ui/tokens'
import type { Presence } from './presence'
import { rowMenuItems } from './row-menu-items'

export type BotRowProps = {
  bot: Bot
  accent: AccentName
  archived: boolean
  avatarUri?: string | undefined
  compact: boolean
  editing: boolean
  presence: Presence
  selected: boolean
  unread: boolean
  unreadCount: number
  /**
   * Every section the row can move to, `null` first for the unsectioned top
   * group. Must be a stable array — it is part of the memo's key, and a fresh one
   * per render re-renders forty rows because one of them changed.
   */
  menuSections: readonly { id: string | null; name: string }[]
  /**
   * Every callback takes what it acts on rather than closing over it. That is
   * what lets the list hand down ONE identity per handler, which is the only
   * way the memo above survives a roster refresh.
   */
  onPress: (bot: Bot) => void
  /** A selection from either menu, by the id `rowMenuItems` gave it. */
  onMenuSelect: (botName: string, id: string) => void
  /** The fallback sheet's opener. Used where there is no native menu. */
  onOpenMenu: (botName: string) => void
  /** Edit mode only: one position up or down, across dividers included. */
  onMove?: (botName: string, offset: number) => void
  /** Long press armed the drag; the wrapper's pan responder claims it on the first move. */
  onArm?: (botName: string) => void
  onDisarm?: () => void
  /** Edit mode's grab handle, which drags with no long press first. */
  handleHandlers?: PanResponderInstance['panHandlers']
}

function stampOf(presence: Presence, bot: Bot): string {
  return presence.state === 'offline' && presence.lastSeenAt
    ? formatListTime(presence.lastSeenAt)
    : formatListTime(bot.canonical?.lastActive)
}

export const BotRow = memo(function BotRow({
  accent,
  archived,
  avatarUri,
  bot,
  compact,
  editing,
  handleHandlers,
  menuSections,
  onArm,
  onDisarm,
  onMenuSelect,
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

  /**
   * Built here rather than by the list, so the list can keep handing every row the
   * same handler identities. The dependencies are the row's own state, which is
   * exactly what the menu's ticks and its Archive/Unarchive wording read.
   */
  const menu = useMemo(
    () =>
      rowMenuItems({
        accent,
        archived,
        botName: bot.name,
        displayName: bot.displayName,
        movable: !archived,
        sections: menuSections,
        unread
      }),
    [accent, archived, bot.displayName, bot.name, menuSections, unread]
  )

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
        <View
          // The grab handle drags immediately: in edit mode a press on this column
          // cannot mean anything else, so there is nothing for a long press to
          // disambiguate. It is `View` and not `Pressable` on purpose — a pressable
          // would claim the touch before the pan responder saw it.
          accessibilityLabel={strings.layout.dragHint}
          style={{ alignItems: 'center', gap: 2, width: 26 }}
          testID={`bot-drag-handle-${bot.name}`}
          {...(handleHandlers ?? {})}
        >
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

  const pressable = (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      aria-selected={selected}
      // 300ms, not the default 500: a lift the reader has to wait half a second for
      // reads as a list that did not notice them.
      delayLongPress={300}
      /*
       * One gesture, two meanings, split by platform — and the split is not a
       * preference, it is what each platform has.
       *
       * Where the native menu exists, a long press already opens it (UIKit's own
       * interaction, see `platform/context-menu`), so this one arms the drag and the
       * two separate by themselves: holding still gets the menu, holding and then
       * moving gets the drag. Where it does not, a long press is the ONLY way to
       * reach a row's options at all, so it opens the fallback sheet and the drag is
       * reached through edit mode's handle instead.
       */
      onLongPress={() => (HAS_NATIVE_CONTEXT_MENU ? onArm?.(bot.name) : onOpenMenu(bot.name))}
      /*
       * And the desktop gesture for the same menu, where the platform has one.
       * A long press is what a finger does; a right click is what a mouse does,
       * and until this the browser build answered it with nothing at all.
       */
      {...secondaryClick(() => onOpenMenu(bot.name))}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onPress={() => onPress(bot)}
      onPressOut={onDisarm}
      // A row is a thing you click, and on a Mac the pointer has to say so.
      //
      // The radius is here as well as on the surface inside, and it paints
      // nothing: the two boxes are identical, and a browser draws a focus ring
      // around the FOCUSABLE element's radius. Without it the keyboard ring is a
      // rectangle around a pill.
      style={{ borderRadius: theme.radii.card, cursor: 'pointer', marginHorizontal: theme.space.sm }}
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

  // The host draws nothing and lays its child out as a `View` would, so on a build
  // without the native menu this is the same tree with one wrapper fewer.
  return (
    <ContextMenuHost
      // The same radius the row's own selected surface is drawn with, so the
      // platform's pointer highlight is a rounded pill rather than the square
      // block UIKit defaults to. Our own hover background below already used it;
      // the one that did not was the system's, drawn over the top.
      cornerRadius={theme.radii.card}
      items={menu}
      menuTitle={bot.displayName}
      onSelect={id => onMenuSelect(bot.name, id)}
      testID={`bot-row-menu-${bot.name}`}
    >
      {pressable}
    </ContextMenuHost>
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
        // `aria-hidden` is the web's spelling of the two props around it; react-native-web
        // honours neither of those. See `ui/Icon.tsx`.
        aria-hidden
        importantForAccessibility="no-hide-descendants"
        style={{ backgroundColor: accent, borderRadius: 5, height: 10, width: 10 }}
        testID="bot-unread"
      />
    )
  }

  return (
    <View
      accessibilityElementsHidden
      // `aria-hidden` is the web's spelling of the two props around it; react-native-web
      // honours neither of those. See `ui/Icon.tsx`.
      aria-hidden
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
