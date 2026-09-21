/**
 * The chat's chrome: round glass buttons, and a pill carrying the avatar, the name
 * and what the bot is doing.
 *
 * One rule decides the subtitle and it is the owner's: **it must never say
 * "Connecting…" while the chat is live.** The header therefore takes a resolved
 * `Presence` — Part 1's own function, the same one the chat list uses — rather than
 * a pair of booleans it would have to guess a precedence order for. A row that says
 * "Working…" above a header that says "Online" is two bugs that look like one.
 *
 * ## It is not a bar
 *
 * It was one glass surface spanning the column, and the owner replaced that with a
 * reference: iPadOS 26 Messages, where the buttons and the contact pill are
 * SEPARATE rounded glass elements floating over the conversation, with the messages
 * scrolling underneath and blurring through them. So this component draws no
 * background of its own. It is a transparent row of three floating things — the
 * leading button, the pill, the trailing button — and the chat screen lays it over
 * the transcript rather than above it.
 *
 * Two consequences:
 *
 *  - The row is `pointerEvents="box-none"`, so the gaps between the three elements
 *    pass drags and taps through to the transcript underneath. A transparent view
 *    that swallows touches is worse than an opaque one, because the reader cannot
 *    see what stopped them.
 *  - Nothing here reserves space. `CHAT_CHROME_HEIGHT` is what the transcript pads
 *    its own content by, so the padding and the thing it clears cannot drift apart.
 *
 * The agents bar pins under it (§6.8), which is why the two are siblings in the
 * chat screen rather than one component.
 */
import { Pressable, View } from 'react-native'

import { GlassGroup, GlassSurface } from '../ui/glass'
import { Icon, ICON_SIZE, type IconName } from '../ui/Icon'
import { PresenceBead } from '../ui/PresenceBead'
import { Text } from '../ui/primitives'
import { useTheme } from '../ui/theme'
import { AVATAR_SIZE, BEAD_SIZE, CONTROL_SIZE, TAP_SLOP, type PresenceState } from '../ui/tokens'
import { Avatar } from './primitives/Avatar'
import { formatClock } from './format'
import { chatStrings } from './strings'

export interface ChatHeaderProps {
  name: string
  handle?: string
  /** The profile's picture, when the roster has loaded one. */
  avatarUri?: string
  /**
   * The bot's presence, already resolved.
   *
   * Not the gateway's. A chat that is open and streaming is `working`, whatever the
   * socket is doing between frames — which is the whole of the owner's rule about
   * "Connecting…".
   */
  presence?: PresenceState
  /** Only while offline, and only when the roster gave us one. */
  lastSeenAt?: number
  /** Overrides the derived line entirely. */
  subtitle?: string
  /** The chat's colour, for the avatar ring. */
  accentFill?: string
  onBack?: () => void
  onOpenOptions: () => void
  /**
   * Hide the wide layout's chat list.
   *
   * Absent on the compact shell, which has no sidebar — the leading group there
   * carries Back instead — and absent on the wide one while the list is ALREADY
   * hidden, because the rail that replaces it carries the control to bring it
   * back. Measured on an iPad: with a button in both places, a collapsed window
   * drew two identical sidebar icons about 90pt apart doing the same thing. So
   * this only ever hides, which is why it needs no state to name.
   */
  onToggleSidebar?: () => void
  testID?: string
}

/** The state, in words, next to the bead that shows it as a shape. */
function stateLabel(presence: PresenceState, lastSeenAt?: number): string {
  if (presence === 'offline') {
    const at = formatClock(lastSeenAt)

    return at ? chatStrings.header.offlineAt(at) : chatStrings.header.offline
  }

  if (presence === 'needsInput') {
    return chatStrings.header.needsInput
  }

  return presence === 'working' ? chatStrings.header.running : chatStrings.header.idle
}

/**
 * A round glass button. The header has up to three and they merge where they touch.
 *
 * The mark is a drawn icon rather than a character, for the reason the tab strip's
 * are: `‹` and `•••` come from different fonts with different ideas about how much
 * of the em box to fill, so at one `fontSize` they were two different weights
 * inside two identical circles. `src/ui/Icon.tsx` has the rest of it.
 */
function RoundButton({
  label,
  icon,
  onPress,
  size,
  testID
}: {
  label: string
  icon: IconName
  onPress: () => void
  size: number
  testID: string
}) {
  const theme = useTheme()

  return (
    <GlassSurface interactive radius={size / 2} shadow="card" style={{ height: size, width: size }} variant="control">
      <Pressable
        accessibilityLabel={label}
        accessibilityRole="button"
        hitSlop={TAP_SLOP}
        onPress={onPress}
        style={({ pressed }) => ({
          alignItems: 'center',
          height: size,
          justifyContent: 'center',
          opacity: pressed ? 0.6 : 1,
          width: size
        })}
        testID={testID}
      >
        {/*
          The THEME's accent, not the scheme's. `colors.accentText` is one blue per
          scheme and does not follow a preset, so under Lime this chevron was the
          only blue thing left on the screen — a navigation control tinted with an
          accent the window no longer has.
        */}
        <Icon color={theme.accent().text} name={icon} size={ICON_SIZE.control} />
      </Pressable>
    </GlassSurface>
  )
}

/**
 * The sidebar control on its own, for a column that has no header to put it in.
 *
 * The wide layout's empty state — before a chat has been picked — is the case: no
 * chat means no `ChatHeader`, which would leave hiding the list reachable only from
 * a keyboard. It is the same `RoundButton` and the same label rather than a second
 * button that looks like this one, so the two cannot drift apart.
 */
export function SidebarToggleButton({ onPress }: { onPress: () => void }) {
  return (
    <RoundButton
      icon="sidebar"
      label={chatStrings.header.hideSidebar}
      onPress={onPress}
      size={CONTROL_SIZE.regular}
      testID="chat-header-sidebar"
    />
  )
}

export function ChatHeader({
  name,
  handle,
  avatarUri,
  presence = 'online',
  lastSeenAt,
  subtitle,
  accentFill,
  onBack,
  onOpenOptions,
  onToggleSidebar,
  testID = 'chat-header'
}: ChatHeaderProps) {
  const theme = useTheme()
  const ring = accentFill ?? theme.accent().fill
  const size = CONTROL_SIZE.regular
  const state = stateLabel(presence, lastSeenAt)
  const line = subtitle ?? (handle ? `@${handle} · ${state}` : state)

  return (
    <View
      pointerEvents="box-none"
      style={{
        alignItems: 'center',
        flexDirection: 'row',
        gap: theme.space.sm,
        paddingHorizontal: theme.space.md,
        paddingVertical: theme.space.sm
      }}
      testID={testID}
    >
      {/*
        The leading group. Back belongs to a stack and the sidebar control belongs
        to a window, so the two are never both here: the compact shell passes
        `onBack` and no `onToggleSidebar`, and the wide shell the other way round.
      */}
      {onBack ? (
        <RoundButton
          icon="chevronLeft"
          label={chatStrings.header.back}
          onPress={onBack}
          size={size}
          testID="chat-header-back"
        />
      ) : null}

      {onToggleSidebar ? (
        <RoundButton
          icon="sidebar"
          label={chatStrings.header.hideSidebar}
          onPress={onToggleSidebar}
          size={size}
          testID="chat-header-sidebar"
        />
      ) : null}

      {/*
        The pill. It floats CENTRED between the two buttons rather than filling the
        row, which is what makes the gaps on either side of it real gaps that the
        transcript shows through — the whole point of the reference.

        The air around its contents is deliberate and is the other half of what the
        owner asked for: the avatar, the name and the buttons were crowded together
        in the old bar. `space.sm` between the buttons and the pill, `space.sm`
        inside it, and the pill's own horizontal padding is a full `space.md` on the
        trailing side so the name is not against the rim.
      */}
      <View pointerEvents="box-none" style={{ alignItems: 'center', flex: 1 }}>
        <GlassSurface
          contentStyle={{
            alignItems: 'center',
            flexDirection: 'row',
            gap: theme.space.sm,
            paddingLeft: theme.space.xs,
            paddingRight: theme.space.md,
            paddingVertical: theme.space.xs
          }}
          radius={theme.radii.pill}
          shadow="float"
          style={{ maxWidth: '100%' }}
          testID={`${testID}-pill`}
          variant="control"
        >
          {/* The ring is the chat's colour; the bead is the bot's state. Two facts,
              two marks, so neither has to carry the other. */}
          <View>
            <Avatar
              name={name}
              size={AVATAR_SIZE.header}
              style={{ borderColor: ring, borderWidth: 2 }}
              {...(avatarUri ? { uri: avatarUri } : {})}
            />
            <View style={{ bottom: -1, position: 'absolute', right: -1 }}>
              <PresenceBead ringColor={theme.glass.control.solid} size={BEAD_SIZE.inline} state={presence} />
            </View>
          </View>

          <View style={{ flexShrink: 1 }}>
            <Text numberOfLines={1} variant="chatName">
              {name}
            </Text>
            <Text color="textFaint" numberOfLines={1} variant="meta">
              {line}
            </Text>
          </View>
        </GlassSurface>
      </View>

      <GlassGroup spacing={theme.space.sm} style={{ flexDirection: 'row', gap: theme.space.sm }}>
        <RoundButton
          icon="ellipsis"
          label={chatStrings.header.options}
          onPress={onOpenOptions}
          size={size}
          testID="chat-header-options"
        />
      </GlassGroup>
    </View>
  )
}
