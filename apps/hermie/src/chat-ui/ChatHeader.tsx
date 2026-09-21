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
 *
 * ## The pill has ONE width, and the bot's name is what decides it
 *
 * The status line changes several times a second while a turn runs — `Thinking…`,
 * `Typing…`, `Running terminal…`, `Online` — and a pill that hugs its content is a
 * pill that resizes on every one of them, with the avatar and the name sliding
 * sideways underneath. The name is the only thing in there that does not change
 * while the reader is looking at it, so the name (and a floor, for a bot called
 * `Al`) is the measurement.
 *
 * The status line is therefore laid out in a row of its own that is exactly one
 * `meta` line tall, with the text ABSOLUTELY positioned inside it: an absolute
 * child is outside its parent's intrinsic width, so however long it is it can
 * neither widen the pill nor be measured by it — it is elided at the width the
 * name set. The one thing still trimmed before it gets here is an MCP tool's
 * namespace, which `shortToolName` does, because eliding
 * `Running mcp__terminal__run_…` tells a reader nothing at all.
 *
 * Changing it cross-fades rather than cutting, over `motion.press`, which is short
 * enough that a reader who is watching the words reads a change and a reader who is
 * not sees nothing flicker. Reduce Motion collapses it to a swap.
 */
import { useEffect, useRef, useState } from 'react'
import { Animated, View } from 'react-native'

import { GlassGroup, GlassSurface } from '../ui/glass'
import { durationFor, easing, NATIVE_DRIVER } from '../ui/motion'
import { PresenceBead } from '../ui/PresenceBead'
import { RoundIconButton, Text } from '../ui/primitives'
import { useTheme } from '../ui/theme'
import { AVATAR_SIZE, BEAD_SIZE, CONTROL_SIZE, type, type PresenceState } from '../ui/tokens'
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
 * The header's round buttons, which are the shared ones.
 *
 * `RoundIconButton` used to be a copy living here. It moved to `ui/primitives`
 * when the composer's `+` and send turned out to be the same control drawn a
 * fourth and a fifth way — with a CHARACTER in the middle instead of a path,
 * which is what put both of them visibly low in their circles in a browser.
 *
 * The alias stays so every call site in this file still reads as a header
 * button, and so the default ink is stated once: `colors.accentText` used to be
 * one blue per scheme whatever preset was on, so under Lime a chevron was the
 * only blue thing on the screen. It is derived from the theme's accent now.
 */
const RoundButton = RoundIconButton

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

/** The pill will not be narrower than this, whatever the bot is called. */
const PILL_MIN_TEXT_WIDTH = 96

/**
 * One line of status, faded out and back when the words change.
 *
 * The value shown is state rather than the prop, because the swap has to happen at
 * the bottom of the fade and not when the render arrives. Under Reduce Motion both
 * halves are zero-length and the completion still runs, so the words still change —
 * which is the rule `motion.ts` states about a skipped animation being a skipped
 * callback.
 */
function StatusLine({ line, reduceMotion }: { line: string; reduceMotion: boolean }) {
  const [shown, setShown] = useState(line)
  const fade = useRef(new Animated.Value(1)).current
  const latest = useRef(line)

  latest.current = line

  useEffect(() => {
    if (line === shown) {
      return
    }

    const duration = durationFor('press', reduceMotion) / 2

    Animated.timing(fade, { duration, easing: easing.exit, toValue: 0, useNativeDriver: NATIVE_DRIVER }).start(() => {
      setShown(latest.current)
      Animated.timing(fade, { duration, easing: easing.enter, toValue: 1, useNativeDriver: NATIVE_DRIVER }).start()
    })
  }, [fade, line, reduceMotion, shown])

  return (
    /*
      A row as tall as one `meta` line, holding a text that is absolutely
      positioned inside it. That is what keeps the status out of the pill's width:
      an absolutely positioned child does not contribute to its parent's intrinsic
      size, so the longest tool name in the world cannot widen this.
    */
    <View style={{ height: type.meta.lineHeight }} testID="chat-header-status">
      <Animated.View style={{ left: 0, opacity: fade, position: 'absolute', right: 0, top: 0 }}>
        <Text color="textFaint" numberOfLines={1} variant="meta">
          {shown}
        </Text>
      </Animated.View>
    </View>
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

          {/*
            The name is the only child that contributes a width here, which is the
            whole of the rule above. `minWidth` is the floor under a short one.
          */}
          <View style={{ flexShrink: 1, minWidth: PILL_MIN_TEXT_WIDTH }}>
            <Text accessibilityRole="header" aria-level={1} numberOfLines={1} variant="chatName">
              {name}
            </Text>
            <StatusLine line={line} reduceMotion={theme.reduceMotion} />
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
