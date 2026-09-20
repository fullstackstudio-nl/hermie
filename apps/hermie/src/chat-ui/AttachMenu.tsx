/**
 * The `+` menu: _Photo library_, _Choose file_ — as a popover anchored above the
 * button, the way WhatsApp desktop draws it.
 *
 * §6.7 calls it a small glass menu, and the owner measured why it has to be one.
 * The `+` used to open the system photo picker directly, and on the Mac there were
 * **1.5–2 seconds of nothing** between the tap and the picker appearing — long
 * enough that the tap read as ignored. Nothing here can fix how long UIKit takes
 * to present a picker, so the fix is to stop pretending the tap was the picker: the
 * menu is local state with no async in it at all, so it paints in the same frame
 * as the tap, and the entry the reader chooses shows a busy state for as long as
 * the system takes.
 *
 * `busy` is therefore not a nicety. It is the only honest thing on screen during
 * those two seconds.
 *
 * On a Mac the order is reversed: `Choose file` first. A Mac window has a
 * filesystem in front of it and a photo library somewhere behind it, which is the
 * opposite of a phone.
 *
 * ## What changed this round, and why the pointer matters
 *
 * It was a list: two full-width rows of text in a card sitting above the composer.
 * A list of two things is a list for the sake of being one, and — more to the point
 * — nothing in it said which control had opened it. WhatsApp's answer is a small
 * popover with a POINTER at the button it belongs to, and choices as round icon
 * buttons with their labels underneath, so two choices read as two objects rather
 * than as a truncated menu.
 *
 * The pointer is the load-bearing part. It is one SVG path, drawn at the bottom edge
 * and positioned so its tip is over the centre of the `+` — `pointerOffset`, which
 * the composer computes from its own geometry rather than this component guessing at
 * it. A popover whose pointer is a few points off its anchor looks like a rendering
 * fault; a popover with no pointer at all just looks like a card.
 *
 * ## The narrow case
 *
 * `layout="list"` keeps the old stacked rows. Two round buttons with labels under
 * them need about 180pt of width, and the phone's composer can be narrower than that
 * with the tray open — so the caller picks, and the list is still the honest
 * fallback rather than a squeezed popover.
 */
import { Pressable, View } from 'react-native'
import Svg, { Path } from 'react-native-svg'

import { GlassSurface } from '../ui/glass'
import { Icon, ICON_SIZE, type IconName } from '../ui/Icon'
import { Text } from '../ui/primitives'
import { useTheme } from '../ui/theme'
import { CONTROL_MIN_HEIGHT, CONTROL_SIZE, TAP_SLOP } from '../ui/tokens'
import type { AttachChoice } from './types'

/**
 * The pointer, as ONE path — the same rule the bubble's tail follows.
 *
 * 16 wide and 9 tall, a soft-shouldered triangle rather than a bare one: a
 * geometric spike on a 16pt-radius card reads as a different object stuck to it,
 * and the curve is what makes it flow out of the edge instead. Drawn pointing DOWN,
 * because the popover is always above its button.
 */
const POINTER = {
  width: 16,
  height: 9,
  path: 'M0 0H16C13.4 0 11.4 1.2 9.6 4.2C8.8 5.6 7.2 5.6 6.4 4.2C4.6 1.2 2.6 0 0 0Z'
}

/** The round glass button a choice is drawn as. Matches §4's wide-layout control. */
const CHOICE_SIZE = CONTROL_SIZE.regular + 6

const GLYPH_FOR: Record<AttachChoice['id'], IconName> = { file: 'file', photo: 'photo' }

export interface AttachMenuProps {
  choices: readonly AttachChoice[]
  onChoose: (id: AttachChoice['id']) => void
  /**
   * `popover` is the default. `list` is the narrow fallback — see the note above.
   */
  layout?: 'popover' | 'list'
  /**
   * How far the pointer's tip sits from the popover's leading edge, in points.
   *
   * The caller's number, because only the caller knows where its `+` is. Ignored by
   * the list layout, which has no pointer.
   */
  pointerOffset?: number
  testID?: string
}

export function AttachMenu({
  choices,
  onChoose,
  layout = 'popover',
  pointerOffset = 0,
  testID = 'composer-attach-menu'
}: AttachMenuProps) {
  const theme = useTheme()

  if (layout === 'list') {
    return (
      <GlassSurface
        contentStyle={{ paddingVertical: theme.space.xs }}
        radius={theme.radii.card}
        shadow="float"
        style={{ alignSelf: 'flex-start', marginBottom: theme.space.sm, minWidth: 220 }}
        testID={testID}
        variant="float"
      >
        {choices.map(choice => (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ busy: choice.busy ?? false }}
            disabled={choice.busy}
            key={choice.id}
            onPress={() => onChoose(choice.id)}
            style={({ pressed }) => ({
              alignItems: 'center',
              flexDirection: 'row',
              gap: theme.space.sm,
              justifyContent: 'space-between',
              minHeight: CONTROL_MIN_HEIGHT,
              opacity: pressed ? 0.6 : 1,
              paddingHorizontal: theme.space.lg
            })}
            testID={`${testID}-${choice.id}`}
          >
            <Text variant="preview">{choice.label}</Text>
            {choice.busy ? <BusyMark testID={`${testID}-${choice.id}-busy`} /> : null}
          </Pressable>
        ))}
      </GlassSurface>
    )
  }

  return (
    <View style={{ alignSelf: 'flex-start', marginBottom: theme.space.sm }} testID={`${testID}-anchor`}>
      <GlassSurface
        contentStyle={{
          flexDirection: 'row',
          gap: theme.space.md,
          paddingHorizontal: theme.space.lg,
          paddingVertical: theme.space.md
        }}
        radius={theme.radii.xl}
        shadow="float"
        testID={testID}
        variant="float"
      >
        {choices.map(choice => (
          <Pressable
            accessibilityLabel={choice.label}
            accessibilityRole="button"
            accessibilityState={{ busy: choice.busy ?? false }}
            disabled={choice.busy}
            hitSlop={TAP_SLOP}
            key={choice.id}
            onPress={() => onChoose(choice.id)}
            style={({ pressed }) => ({ alignItems: 'center', gap: theme.space.xs, opacity: pressed ? 0.6 : 1 })}
            testID={`${testID}-${choice.id}`}
          >
            <GlassSurface
              contentStyle={{
                alignItems: 'center',
                height: CHOICE_SIZE,
                justifyContent: 'center',
                width: CHOICE_SIZE
              }}
              variant="control"
            >
              {choice.busy ? (
                <BusyMark testID={`${testID}-${choice.id}-busy`} />
              ) : (
                <Icon color={theme.colors.text} name={GLYPH_FOR[choice.id]} size={ICON_SIZE.control} />
              )}
            </GlassSurface>

            {/*
              The label UNDER the button, not beside it: two labelled columns are
              two objects, and a label beside a round button in a row of two is a
              list again.

              It carries no width limit and no line clamp, so the COLUMN is as wide
              as its label. Clamping it to the button's width was tried and
              photographed on an iPad: "Photo library" came out as "Photo libr…",
              which is a label that has stopped being one. The popover is two short
              words wide either way, and a translation that is longer simply makes
              it wider — which is the correct outcome for a thing that floats.
            */}
            <Text color="textMuted" variant="micro">
              {choice.label}
            </Text>
          </Pressable>
        ))}
      </GlassSurface>

      {/*
        The pointer, BELOW the card and outside it: it is the shape that escapes the
        popover, exactly as the bubble's tail escapes the bubble. `left` is the
        caller's offset less half the pointer, so the number the caller passes is the
        TIP's position and not the shape's corner — the only version of that
        arithmetic a caller can reason about.
      */}
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        pointerEvents="none"
        style={{
          bottom: -POINTER.height + 1,
          height: POINTER.height,
          left: Math.max(theme.space.sm, pointerOffset - POINTER.width / 2),
          position: 'absolute',
          width: POINTER.width
        }}
        testID={`${testID}-pointer`}
      >
        <Svg height={POINTER.height} viewBox={`0 0 ${POINTER.width} ${POINTER.height}`} width={POINTER.width}>
          {/*
            Filled with the surface's own solid rung rather than with a gradient
            stop: the pointer sits at the card's lower edge, where a vertical
            gradient has arrived at its last stop, so one flat colour matches — the
            same reason the bubble's tail is flat.
          */}
          <Path d={POINTER.path} fill={theme.glass.float.solid} />
        </Svg>
      </View>
    </View>
  )
}

/**
 * The busy mark: a still, hollow ring.
 *
 * Not a spinner. §5 reserves motion for things that need the reader, and the one
 * thing this state has to say is "the tap landed".
 */
function BusyMark({ testID }: { testID: string }) {
  const theme = useTheme()

  return (
    <View
      style={{ borderColor: theme.colors.textFaint, borderRadius: 7, borderWidth: 2, height: 14, width: 14 }}
      testID={testID}
    />
  )
}
