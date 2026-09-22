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
 * **That was not enough, and the reason is worth writing down.** The owner
 * reported the pill still changing size while a bot thinks, after the status was
 * already out of the intrinsic width. "An absolute child cannot widen its
 * parent" is an argument about Yoga's box model, and this component renders on
 * four targets — one of which composites the pill as a native glass surface and
 * another of which draws the name as a line-clamped `-webkit-box`. An invariant
 * that has to be re-argued per platform is not one.
 *
 * So the column's width is no longer DERIVED. A ruler — the name at the same
 * type token, laid out with nothing around it — reports the name's own width
 * once, and the column is given that number as an explicit `width`
 * (`pillTextWidth`). After that the only thing in the world that can move the
 * pill is the bot being renamed. Not a status, not a font fallback, not a
 * native surface re-measuring itself between two frames.
 *
 * Changing it cross-fades rather than cutting, over `motion.press`, which is short
 * enough that a reader who is watching the words reads a change and a reader who is
 * not sees nothing flicker. Reduce Motion collapses it to a swap.
 */
import { useEffect, useRef, useState } from 'react'
import { Animated, Pressable, View } from 'react-native'

import { GlassGroup, GlassSurface } from '../ui/glass'
import { durationFor, easing, NATIVE_DRIVER } from '../ui/motion'
import { PresenceBead } from '../ui/PresenceBead'
import { RoundIconButton, Text } from '../ui/primitives'
import { useTheme } from '../ui/theme'
import { AVATAR_SIZE, BEAD_SIZE, CONTROL_SIZE, type PresenceState } from '../ui/tokens'
import { Avatar } from './primitives/Avatar'
import { formatClock } from './format'
import { chatStrings } from './strings'

export interface ChatHeaderProps {
  /**
   * The large line: whichever of the bot's two names this reader put first.
   *
   * Resolved by the caller (`store/bot-names.ts`), because the choice is one
   * app-wide setting and a header that read it for itself would be a second
   * place the rule lives.
   */
  name: string
  /**
   * The bot's OTHER name, for the line under it. Empty when it has only one.
   *
   * It used to be the handle specifically, drawn as `@handle` and only when no
   * subtitle existed — which `subtitleFor` always produces, so in the real app
   * it was never drawn at all and only the gallery ever saw it. It is now
   * whichever name did not win the top line, plain: the `@` was doing the work
   * of saying "this is the addressable one", and that is no longer reliably
   * true of the name on this line.
   */
  secondaryName?: string
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
   * Open this bot's profile. Absent on a surface that has nowhere to put a
   * sheet — the gallery — and the pill is then inert rather than a button that
   * does nothing.
   */
  onOpenProfile?: () => void
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
export const PILL_MIN_TEXT_WIDTH = 96

/**
 * The pill's text column, as a NUMBER rather than as whatever Yoga makes of it.
 *
 * The status line has been out of the pill's intrinsic width since it was made
 * absolute, and the owner still reported the pill changing size while a bot
 * thinks. Reasoning about why is the wrong move at that point: "the status
 * cannot widen the pill" is an argument about Yoga's box model, and it has to
 * hold on four targets, one of which composites the surface natively and
 * another of which draws it as a line-clamped `-webkit-box`. An argument that
 * has to be re-made per platform is not an invariant.
 *
 * So the width stops being derived at all. The name is measured once, off a
 * copy nothing constrains, and the column is given that measurement as an
 * EXPLICIT width. From then on the only thing that can change it is the bot
 * being renamed — not a status, not a font fallback, not a native surface
 * re-measuring itself between frames.
 *
 * `floor` is the minimum a pill may be, for a bot called `Al`. Before the
 * measurement lands the answer is the floor, which is what the column already
 * did.
 */
export function pillTextWidth(measuredName: number, floor: number = PILL_MIN_TEXT_WIDTH): number {
  return Math.max(Math.ceil(measuredName), floor)
}

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
  const theme = useTheme()
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
    <View style={{ height: theme.type.meta.lineHeight }} testID="chat-header-status">
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
  secondaryName,
  avatarUri,
  presence = 'online',
  lastSeenAt,
  subtitle,
  accentFill,
  onBack,
  onOpenOptions,
  onOpenProfile,
  onToggleSidebar,
  testID = 'chat-header'
}: ChatHeaderProps) {
  const theme = useTheme()
  const ring = accentFill ?? theme.accent().fill
  const size = CONTROL_SIZE.regular
  /*
    The name's own width, measured off a copy nothing constrains.

    It is reset to 0 when the NAME changes, which is the one thing that may
    move the pill: a roster that arrives late renames `researcher` to
    `Researcher`, and a width measured for the old one would clip the new.
    Nothing else resets it, which is the whole point — see `pillTextWidth`.
  */
  const [nameWidth, setNameWidth] = useState(0)
  const measuredFor = useRef(name)

  if (measuredFor.current !== name) {
    measuredFor.current = name
  }
  const state = stateLabel(presence, lastSeenAt)
  /*
    The other name AND what the bot is doing, on one line.

    `subtitle` used to replace this line wholesale, and since `subtitleFor`
    answers for every connection state it always did — so the second name was
    unreachable in the app. The override now replaces only the STATE half, which
    is what it was always describing, and the name in front of it survives.
  */
  const status = subtitle ?? state
  const line = secondaryName ? `${secondaryName} · ${status}` : status

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
        {/*
          The ruler: the name at the same type token, laid out with nothing
          around it and nothing to shrink against, so what it reports is the
          name's OWN width rather than the width it was given.

          Absolutely positioned inside the centring column and not inside the
          pill, because a measurement taken inside the box it decides the size
          of is a measurement that measures itself. Invisible, inert and hidden
          from assistive technology: the real name two lines down is the one
          that gets read out.
        */}
        <View
          accessibilityElementsHidden
          aria-hidden
          importantForAccessibility="no-hide-descendants"
          key={name}
          onLayout={event => setNameWidth(event.nativeEvent.layout.width)}
          pointerEvents="none"
          style={{ left: 0, opacity: 0, position: 'absolute', top: 0 }}
          testID={`${testID}-ruler`}
        >
          <Text variant="chatName">{name}</Text>
        </View>

        {/*
          The pill is the way into the bot's profile, which is why the whole of
          it is the target rather than the avatar alone: the avatar is 38pt, the
          name beside it is the thing a reader points at, and two adjacent
          targets that do the same thing is one target drawn twice.

          `Pressable` OUTSIDE the glass rather than an `onPress` through it: the
          surface draws the blur and the shadow and has no press state of its
          own, and wrapping is what keeps the pressed opacity on everything the
          reader sees move.
        */}
        <Pressable
          accessibilityLabel={chatStrings.header.profile(name)}
          accessibilityRole="button"
          disabled={!onOpenProfile}
          onPress={onOpenProfile}
          style={({ pressed }) => ({ maxWidth: '100%', opacity: pressed ? 0.7 : 1 })}
          testID={`${testID}-profile`}
        >
          {/*
            `opaque`, for the reason `AttachMenu` gives.

            The pill floats over the transcript rather than beside it: the chat
            column scrolls UNDER the header, so whatever bubble is passing
            behind it is the pill's backdrop. At the control wash's own alpha
            that backdrop reaches the ink, and a long reply read through the
            bot's name — two strings of text at the same weight in the same
            place, which is exactly the failure the attach menu had. The solid
            rung under the wash makes the pill's contrast a fixed number
            instead of a function of what happens to be scrolling past.

            The bead already assumed this: its ring is `glass.control.solid`,
            which only matches the surface it sits on once the surface takes
            that rung.
          */}
          <GlassSurface
            contentStyle={{
              alignItems: 'center',
              flexDirection: 'row',
              gap: theme.space.sm,
              paddingLeft: theme.space.xs,
              paddingRight: theme.space.md,
              paddingVertical: theme.space.xs
            }}
            contentTestID={`${testID}-pill-surface`}
            opaque
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
            <View
              style={{
                flexShrink: 1,
                minWidth: PILL_MIN_TEXT_WIDTH,
                // Once the ruler has answered, the column stops being sized by
                // its contents at all. A status can no longer reach the width
                // by any route on any platform.
                ...(nameWidth > 0 ? { width: pillTextWidth(nameWidth) } : {})
              }}
              testID={`${testID}-text`}
            >
              <Text accessibilityRole="header" aria-level={1} numberOfLines={1} variant="chatName">
                {name}
              </Text>
              <StatusLine line={line} reduceMotion={theme.reduceMotion} />
            </View>
          </GlassSurface>
        </Pressable>
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
