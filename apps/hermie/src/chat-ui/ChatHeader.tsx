/**
 * The chat's title bar: an avatar with the chat's accent ring and a presence bead,
 * the name, a subtitle that says the state in words, and round glass buttons.
 *
 * One rule decides the subtitle and it is the owner's: **it must never say
 * "Connecting…" while the chat is live.** The header therefore takes a resolved
 * `Presence` — Part 1's own function, the same one the chat list uses — rather than
 * a pair of booleans it would have to guess a precedence order for. A row that says
 * "Working…" above a header that says "Online" is two bugs that look like one.
 *
 * The header itself is a floating glass surface, not a bar with a bottom hairline.
 * The agents bar pins under it (§6.8), which is why the two are siblings in the
 * chat screen rather than one component.
 */
import { Pressable, View } from 'react-native'

import { GlassGroup, GlassSurface } from '../ui/glass'
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

/** A round glass button. The header has two and they merge where they touch. */
function RoundButton({
  label,
  glyph,
  onPress,
  size,
  testID
}: {
  label: string
  glyph: string
  onPress: () => void
  size: number
  testID: string
}) {
  return (
    <GlassSurface radius={size / 2} shadow="card" style={{ height: size, width: size }} variant="control">
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
        <Text color="accentText" style={{ fontSize: 17, lineHeight: 20 }}>
          {glyph}
        </Text>
      </Pressable>
    </GlassSurface>
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
  testID = 'chat-header'
}: ChatHeaderProps) {
  const theme = useTheme()
  const ring = accentFill ?? theme.accent().fill
  const size = CONTROL_SIZE.regular
  const state = stateLabel(presence, lastSeenAt)
  const line = subtitle ?? (handle ? `@${handle} · ${state}` : state)

  return (
    <GlassSurface
      contentStyle={{
        alignItems: 'center',
        flexDirection: 'row',
        gap: theme.space.sm + 2,
        minHeight: 60,
        paddingHorizontal: theme.space.md,
        paddingVertical: theme.space.sm
      }}
      radius={theme.radii.sheet}
      shadow="float"
      testID={testID}
      variant="float"
    >
      {onBack ? (
        <RoundButton glyph="‹" label={chatStrings.header.back} onPress={onBack} size={size} testID="chat-header-back" />
      ) : null}

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
          <PresenceBead ringColor={theme.glass.float.solid} size={BEAD_SIZE.inline} state={presence} />
        </View>
      </View>

      <View style={{ flex: 1 }}>
        <Text numberOfLines={1} variant="chatName">
          {name}
        </Text>
        <Text color="textFaint" numberOfLines={1} variant="meta">
          {line}
        </Text>
      </View>

      <GlassGroup spacing={theme.space.sm} style={{ flexDirection: 'row', gap: theme.space.sm }}>
        <RoundButton
          glyph="•••"
          label={chatStrings.header.options}
          onPress={onOpenOptions}
          size={size}
          testID="chat-header-options"
        />
      </GlassGroup>
    </GlassSurface>
  )
}
