/**
 * The message composer: "+" on the left, a rounded multiline field, and one
 * round button on the right that is blue-send while idle and red-stop while a
 * turn runs.
 *
 * Three deliberate choices:
 *   - The draft is controlled from outside. A chat's draft belongs to the chat,
 *     survives navigating away, and is what the store persists.
 *   - Keyboard avoidance uses `KeyboardAvoidingView`, not a keyboard-controller
 *     library: ADR-0010 keeps every gesture library out of the chat surface.
 *   - The slash popover is fed by props. The composer asks (`onQuerySlash`) and
 *     paints what it is given; it never calls the gateway itself.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Image,
  KeyboardAvoidingView,
  type NativeSyntheticEvent,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  type TextInputKeyPressEventData,
  type TextInputSelectionChangeEventData,
  TextInput,
  View
} from 'react-native'

import { isShiftDown } from '../platform/keyboard-modifiers'
import { RUNS_ON_MAC } from '../platform/runs-on-mac'
import { GlassGroup, GlassSurface } from '../ui/glass'
import { KEYBOARD_AVOID_BEHAVIOR } from '../ui/keyboard'
import { Text } from '../ui/primitives'
import { useTheme } from '../ui/theme'
import { CONTROL_SIZE, TAP_SLOP } from '../ui/tokens'
import { useEscapeKey } from '../ui/useEscapeKey'
import { AttachMenu } from './AttachMenu'
import { FileChip } from './FileChip'
import { QueuedChip } from './QueuedChip'
import { shouldSend } from './send-key'
import { chatStrings } from './strings'
import type { AttachChoice, ComposerAttachment, SlashSuggestion } from './types'

export interface ComposerProps {
  /** Controlled draft. */
  value: string
  onChangeText: (text: string) => void
  onSend: (text: string) => void
  /** A turn is running: the send button becomes a stop square. */
  running?: boolean
  onStop?: () => void
  onAttach?: () => void
  /**
   * Attach an arbitrary FILE rather than an image.
   *
   * Reached from the `+` menu's second entry, not from a long press. A long press
   * was a placeholder and it was the wrong shape twice over: it is invisible, so
   * it had to be announced in an accessibility hint nobody hears, and it made the
   * two roads a file and an image travel by (an HTTP upload the prompt references
   * versus base64 over the socket) look like one control with a secret.
   */
  onAttachFile?: () => void
  /**
   * The system picker is being presented.
   *
   * The caller sets it around its own `await`, because only the caller knows when
   * the picker is actually up. The chosen menu entry stays busy until then — see
   * `AttachMenu` for the two seconds this exists to account for.
   */
  attachBusy?: 'photo' | 'file' | null
  attachments?: ComposerAttachment[]
  onRemoveAttachment?: (id: string) => void
  /** Slash candidates for the current prefix; the caller fetches them. */
  suggestions?: SlashSuggestion[]
  onQuerySlash?: (prefix: string) => void
  /** A prompt the backend parked behind the running turn. */
  queuedText?: string
  placeholder?: string
  botName?: string
  /**
   * A bare Return sends instead of inserting a newline.
   *
   * On by default only on a Mac, and deliberately not on an iPhone or iPad:
   * neither iOS nor iPadOS tells React Native whether a keyboard is physical,
   * and a bare Return that sends would leave a touch user with no way to type a
   * newline at all. A Mac window always has a real keyboard, which is the whole
   * reason `RUNS_ON_MAC` exists.
   */
  hardwareKeyboard?: boolean
  /**
   * Wrap the composer in its own `KeyboardAvoidingView`.
   *
   * Off by default. A chat screen already has one around the whole transcript,
   * and two nested avoiding views each add the keyboard's height, which lifted
   * the composer roughly twice as far as it needed to go. The gallery, where
   * the composer stands on its own, is the caller that wants one.
   */
  keyboardAvoiding?: boolean
  testID?: string
}

/**
 * The geometry, and how it stopped being fragile.
 *
 * The first version put all three controls INSIDE one bordered pill: a circle, a
 * "+" and the input, each sized independently under a 28pt corner radius, so the
 * circle sat in the corner's curve and visibly crossed the border. The fix then was
 * to make all three agree on one line box and assert the arithmetic.
 *
 * The mockup's answer is better than the arithmetic: **the buttons are not inside
 * the field at all.** A separate round `+`, a pill field, a separate round send
 * (§6.7 and §4's "round glass controls 38 on the wide layout, 40 on phone"). A
 * button that is not inside the field cannot overflow it, in any theme, at any
 * text size — so the invariant is structural rather than checked.
 *
 * What is left to get right is the FIELD: `COMPOSER_LINE_HEIGHT` is one line of
 * input, and the radius is half the single-line height so the field is a true pill
 * at one line and keeps those same caps as it grows. Not `radii.pill`: a 999pt
 * radius on a four-line field makes both ends full semicircles.
 */
export const COMPOSER_FIELD_INSET = 4
export const COMPOSER_LINE_HEIGHT = 32

/**
 * The leading the field's own text takes.
 *
 * 22, not the body's 25. 25 is a READING leading — chosen so that paragraphs of a
 * reply breathe — and a composer is one line at a time; 22 is the leading a control
 * gets. It is also the number that makes the vertical padding below a WHOLE point,
 * `(32 − 22) / 2`, which matters more than it sounds: the Mac renders this build
 * scaled, so a half-point more space above a line of text than below it is a
 * visibly off-centre placeholder rather than a rounding detail.
 *
 * Stating it at all is the point. Without an explicit leading the field's line box
 * is whatever the platform's font metrics produce — about 20.3pt for 17pt San
 * Francisco, and something else on Android — so the padding that was supposed to
 * centre one line was centring a box nobody had measured.
 */
export const COMPOSER_TEXT_LINE_HEIGHT = 22

/**
 * What iOS adds at the TOP of a MULTILINE field, over and above the padding asked
 * for.
 *
 * A multiline `TextInput` is a `UITextView`, and a `UITextView` lays its text out
 * from the top of its container rather than centring it in the box — so on a field
 * with a `minHeight` the platform's own container inset lands entirely above the
 * first line and the single-line placeholder sits low in the pill. That is the
 * owner's report, and it is why the vertical padding here is not symmetric in the
 * STYLE: the visible gaps are what have to match, and the style has to compensate
 * for the inset to make them.
 *
 * Measured on the iOS 27 simulator during the 2026-09-20 pass — see
 * `docs/platform-notes.md`. A number rather than a guess, and zero would be a
 * perfectly good answer for a platform that adds nothing.
 */
export const COMPOSER_IOS_TOP_INSET = 2

/**
 * Symmetric vertical padding for ONE line in the field.
 *
 * `(field height − line height) / 2` on both sides, with the platform's own top
 * inset taken off the top so that what a reader SEES is even. The field still grows:
 * these are paddings, not a height, so a second line makes the pill taller by
 * exactly one leading and the buttons beside it stay on its bottom edge
 * (`alignItems: 'flex-end'`).
 *
 * A pure function because the assertion is arithmetic — `paddingTop + inset ===
 * paddingBottom` — and arithmetic asserted against a rendered style is the version
 * of this test that passed while the placeholder was visibly low.
 */
export function composerFieldPadding(iosTopInset: number): { paddingBottom: number; paddingTop: number } {
  const even = (COMPOSER_LINE_HEIGHT - COMPOSER_TEXT_LINE_HEIGHT) / 2

  return { paddingBottom: even, paddingTop: Math.max(0, even - iosTopInset) }
}

/**
 * The round controls flanking the field.
 *
 * A Mac window is the wide layout, so it takes the 38pt control; everything else
 * gets the 40pt one, because a phone's primary controls are 44pt targets and 40
 * plus the slop is how the kit reaches that.
 */
export const COMPOSER_ROUND_SIZE = RUNS_ON_MAC ? CONTROL_SIZE.regular : CONTROL_SIZE.compact

/** Half the single-line field height. See the note above. */
export const COMPOSER_FIELD_RADIUS = (COMPOSER_LINE_HEIGHT + 2 * COMPOSER_FIELD_INSET) / 2

/**
 * How much composer the attach POPOVER needs before it stops being the right shape.
 *
 * Two round buttons, their labels, the popover's own padding and the gap between
 * them, plus enough composer left over that the popover reads as anchored to one end
 * of it rather than as filling it. Below this the stacked list is the honest answer —
 * which is the owner's own allowance for the phone.
 */
export const ATTACH_POPOVER_MIN_WIDTH = 260

function slashPrefix(text: string): string | null {
  // Only a leading slash opens the popover — `/` in the middle of a sentence is
  // a slash, not a command.
  const match = text.match(/^\/([\w:-]*)$/)

  return match ? (match[1] ?? '') : null
}

export function Composer({
  value,
  onChangeText,
  onSend,
  running = false,
  onStop,
  onAttach,
  onAttachFile,
  attachBusy = null,
  attachments = [],
  onRemoveAttachment,
  suggestions = [],
  onQuerySlash,
  queuedText,
  placeholder,
  botName,
  hardwareKeyboard = RUNS_ON_MAC,
  keyboardAvoiding = false,
  testID = 'composer'
}: ComposerProps) {
  const theme = useTheme()
  const inputRef = useRef<TextInput>(null)
  const query = useRef(onQuerySlash)

  query.current = onQuerySlash

  /**
   * Where the caret is, so a newline can be inserted at it rather than appended.
   *
   * A ref and not state: it changes on every keystroke and nothing renders from
   * it. It starts at the end of the draft, which is where a field opens.
   */
  const selection = useRef({ start: value.length, end: value.length })

  /**
   * A caret position to hand back to the field, until the field has taken it.
   *
   * Setting `value` programmatically moves the caret to the end on iOS, which is
   * wrong for a newline inserted mid-sentence, so `selection` is controlled just
   * long enough to put it where it belongs. It is released on the next
   * `onSelectionChange` — which the field fires BECAUSE the selection changed —
   * so control lasts one round trip rather than for good. A permanently
   * controlled selection fights the caret on every keystroke.
   */
  const [caret, setCaret] = useState<{ start: number; end: number } | undefined>(undefined)

  const prefix = useMemo(() => slashPrefix(value), [value])
  const [popoverDismissed, setPopoverDismissed] = useState(false)

  /**
   * The `+` menu, as local state and nothing else.
   *
   * No await, no layout measurement, no animation to wait on: opening it is one
   * `setState`, so it paints in the same frame as the tap. That is the whole
   * requirement — the owner measured 1.5–2 s between tapping `+` and the system
   * picker appearing on the Mac, and a menu that took any of that time would just
   * move the dead air.
   */
  const [menuOpen, setMenuOpen] = useState(false)
  /**
   * The composer's own width, for the popover-or-list decision.
   *
   * Measured rather than read off the window: on the wide layout the composer IS the
   * chat column, whose width a collapsed sidebar and an open sheet both change, and
   * a popover that fits the window can still not fit the column. Nothing depends on
   * it before the first layout pass, because the menu only exists after a tap.
   */
  const [rowWidth, setRowWidth] = useState(0)

  /**
   * Close the menu once the picker has been and gone.
   *
   * It deliberately stays open WHILE `attachBusy` is set — the busy mark on the
   * entry is the only feedback during the second or two UIKit takes to present a
   * picker. It is the falling edge that closes it, so a cancelled picker does not
   * leave the menu standing over the composer.
   */
  const wasBusy = useRef(false)

  useEffect(() => {
    if (attachBusy) {
      wasBusy.current = true

      return
    }

    if (wasBusy.current) {
      wasBusy.current = false
      setMenuOpen(false)
    }
  }, [attachBusy])

  // A dismissed popover stays dismissed only for the prefix it was dismissed on;
  // typing on re-opens it.
  useEffect(() => {
    setPopoverDismissed(false)
  }, [prefix])

  const showSuggestions = prefix !== null && suggestions.length > 0 && !popoverDismissed

  // The caller decides where the candidates come from (`commands.catalog`,
  // `complete.slash`, a cache); the composer only says which prefix it is on.
  useEffect(() => {
    if (prefix !== null) {
      query.current?.(prefix)
    }
  }, [prefix])

  const canSend = Boolean(value.trim()) || attachments.length > 0

  /**
   * What Enter does: send, or nothing.
   *
   * It deliberately does NOT stop a running turn. On a Mac a bare Return is the
   * send key, and while a reply streamed that same key cancelled the turn — so
   * typing the next message and pressing Return killed the answer being written
   * instead of queueing the message. A prompt sent mid-turn is parked by the
   * gateway, which is what the queued chip reports; only the red button, and
   * Escape, stop anything.
   */
  const submit = () => {
    if (!canSend) {
      return
    }

    onSend(value)
  }

  /**
   * Shift+Return: put a newline where the caret is, by hand.
   *
   * It has to be by hand because the platform was told not to insert one — see
   * `submitBehavior` below — and because iOS cannot tell us which Return this
   * was until we ask the keyboard directly. A selected range is replaced rather
   * than kept, which is what typing any other character would do.
   */
  const insertNewline = () => {
    const start = Math.max(0, Math.min(selection.current.start, value.length))
    const end = Math.max(start, Math.min(selection.current.end, value.length))
    const next = `${value.slice(0, start)}\n${value.slice(end)}`

    onChangeText(next)
    selection.current = { start: start + 1, end: start + 1 }
    setCaret({ start: start + 1, end: start + 1 })
  }

  /**
   * The one Return handler, and the only place the two chords are told apart.
   *
   * Cmd+Return sends: nothing here special-cases it, which is the point — the
   * only branch is Shift, so a Return arriving with any other modifier falls
   * through to the send. Whether macOS delivers Cmd+Return to a text view as a
   * Return at all is unverified; if it does, it sends.
   *
   * The decision itself is `shouldSend`, shared with `onKeyPress` below. Only
   * the ACTION differs: here `submitBehavior: 'submit'` already suppressed the
   * insertion, so a newline has to be put in by hand.
   */
  const onSubmitEditing = () => {
    const decision = shouldSend('Enter', {
      // Reaching this handler at all IS the platform having decided to submit
      // (`submitBehavior`), so the hardware-keyboard half of the table is
      // already answered here and only the modifier is open. Passing the prop
      // through instead would turn a software keyboard's Return — which has
      // ALREADY inserted its newline — into a second one.
      hardwareKeyboard: true,
      shift: hardwareKeyboard && isShiftDown()
    })

    if (decision === 'newline') {
      insertNewline()

      return
    }

    submit()
  }

  const onSelectionChange = (event: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => {
    selection.current = event.nativeEvent.selection
    // The field has reported a position of its own, so stop overriding it.
    setCaret(undefined)
  }

  /** The round button: stop while a turn runs, send otherwise. */
  const press = () => {
    if (running) {
      onStop?.()

      return
    }

    submit()
  }

  /**
   * Modifier chords, for any platform that reports them.
   *
   * Read this together with `submitBehavior` below, because "Enter sends" is
   * spread over three places and none of them is obvious on its own.
   *
   * `onKeyPress` cannot carry a bare Return on iOS. React Native derives its
   * `key` from the text a `UITextView` is about to insert, and the payload it
   * builds (`TextInputEventEmitter::keyPressMetricsPayload`) is exactly
   * `{ key, eventCount }` — **no `shiftKey`, `metaKey` or `ctrlKey`**. Those
   * flags only ever arrived from react-native-macos, so on the platforms Hermie
   * ships the branches below are a contract rather than a live path: correct if a
   * modifier ever shows up, inert while it does not. `preventDefault` is not what
   * stops a Return landing either — by the time this fires the insertion has been
   * accepted.
   *
   * Escape is NOT handled here. It inserts no text, so it never reaches a text
   * field's delegate on iOS at all; it comes from the keyboard seam instead, via
   * `useEscapeKey` below.
   */
  const onKeyPress = (event: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
    const native = event.nativeEvent as TextInputKeyPressEventData & {
      shiftKey?: boolean
      metaKey?: boolean
      ctrlKey?: boolean
    }

    // The same table `onSubmitEditing` uses. Where it says `newline` this site
    // does NOTHING: the insertion has already been accepted, so letting it land
    // IS the newline — which is the one difference between the two callers.
    if (
      shouldSend(native.key, {
        ctrl: native.ctrlKey === true,
        hardwareKeyboard,
        meta: native.metaKey === true,
        shift: native.shiftKey === true
      }) !== 'send'
    ) {
      return
    }

    event.preventDefault?.()
    submit()
  }

  /**
   * Escape, in priority order.
   *
   * The popover is registered second, so while it is open it takes the key and
   * the running turn does not. That ordering is the whole reason `useEscapeKey`
   * is a stack rather than one handler per screen: a sheet opened over this
   * composer registers later still and outranks both.
   */
  useEscapeKey(() => onStop?.(), running)
  useEscapeKey(() => setPopoverDismissed(true), showSuggestions)
  // Registered last, so while the attach menu is open Escape closes IT and
  // neither the popover nor the running turn sees the key. Esc goes back exactly
  // one level.
  useEscapeKey(() => setMenuOpen(false), menuOpen)

  /**
   * What a bare Return does, decided one layer below `onKeyPress`.
   *
   * `submitBehavior` is a real native prop, and on a multiline iOS field it is
   * the ONLY thing that can stop a Return from becoming a newline.
   * `RCTBackedTextInputDelegateAdapter` intercepts a replacement text of exactly
   * `"\n"`, asks the delegate whether to submit, and on `'submit'` fires
   * `onSubmitEditing` and returns `NO` — no newline, no `onKeyPress`, and no
   * blur (only `'blurAndSubmit'` blurs). On `'newline'`, the multiline default,
   * it falls through and the newline lands.
   *
   * So the two modes are mutually exclusive by construction, which is what
   * makes a double send impossible: where Return submits it never reaches
   * `onKeyPress`, and where it inserts a newline `hardwareKeyboard` is false.
   *
   * Shift+Return is what this cannot answer on its own: it inserts the same
   * `"\n"` as Return, so both arrive here identically. `onSubmitEditing` asks the
   * keyboard which one it was — see `insertNewline` above.
   */
  const submitBehavior = hardwareKeyboard ? 'submit' : 'newline'

  const pick = (name: string) => {
    onChangeText(`/${name} `)
    inputRef.current?.focus()
  }

  /**
   * The two entries, in the order this platform wants them.
   *
   * `Choose file` first on a Mac: a Mac window has a filesystem in front of it and
   * a photo library somewhere behind it, which is the opposite of a phone.
   */
  const choices: AttachChoice[] = (
    RUNS_ON_MAC
      ? ([
          { id: 'file', label: chatStrings.composer.chooseFile },
          { id: 'photo', label: chatStrings.composer.photoLibrary }
        ] as const)
      : ([
          { id: 'photo', label: chatStrings.composer.photoLibrary },
          { id: 'file', label: chatStrings.composer.chooseFile }
        ] as const)
  )
    .filter(choice => (choice.id === 'photo' ? Boolean(onAttach) : Boolean(onAttachFile)))
    .map(choice => ({ ...choice, ...(attachBusy === choice.id ? { busy: true } : {}) }))

  const choose = (id: AttachChoice['id']) => {
    // The menu stays OPEN while the picker is being presented, because the busy
    // mark on the entry is the only feedback there is during those two seconds.
    // It closes when the caller reports the picker is no longer coming up.
    if (id === 'photo') {
      onAttach?.()

      return
    }

    onAttachFile?.()
  }

  // The picker is up or it failed; either way the menu has said all it can.
  const menuVisible = menuOpen && choices.length > 0

  const round = COMPOSER_ROUND_SIZE

  /**
   * Popover or list.
   *
   * Two round buttons with a label under each need about `ATTACH_POPOVER_MIN_WIDTH`
   * of composer to sit in without the labels having to shrink. Below that the old
   * stacked rows are the honest answer rather than a squeezed popover — the owner's
   * own allowance for the phone. It is the COMPOSER's width that decides, not the
   * window's: on the wide layout the composer is the chat column, which a collapsed
   * sidebar and an open sheet both change.
   */
  const menuLayout = rowWidth > 0 && rowWidth < ATTACH_POPOVER_MIN_WIDTH ? 'list' : 'popover'

  return (
    // Without `behavior` a `KeyboardAvoidingView` is a plain `View`, which is
    // exactly what the composer wants inside a screen that already has one.
    // Declaring the component conditionally instead would give React a new
    // type on every render and remount the text field under the caret.
    <KeyboardAvoidingView behavior={keyboardAvoiding ? KEYBOARD_AVOID_BEHAVIOR : undefined} testID={testID}>
      {showSuggestions ? (
        <GlassSurface
          contentStyle={{ maxHeight: 220 }}
          radius={theme.radii.card}
          shadow="float"
          style={{ marginBottom: theme.space.sm, marginHorizontal: theme.space.md }}
          testID="composer-slash-popover"
          variant="float"
        >
          <ScrollView keyboardShouldPersistTaps="handled">
            {suggestions.map(suggestion => (
              <Pressable
                accessibilityRole="button"
                key={suggestion.name}
                onPress={() => pick(suggestion.name)}
                style={({ pressed }) => ({
                  backgroundColor: pressed ? theme.tintSunk : 'transparent',
                  gap: 1,
                  paddingHorizontal: theme.space.lg,
                  paddingVertical: theme.space.sm + 2
                })}
                testID={`slash-option-${suggestion.name}`}
              >
                <Text variant="name">{`/${suggestion.name}`}</Text>
                <Text color="textFaint" variant="meta">
                  {suggestion.description}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        </GlassSurface>
      ) : null}

      {menuVisible ? (
        <View style={{ paddingHorizontal: theme.space.md }}>
          <AttachMenu
            choices={choices}
            layout={menuLayout}
            onChoose={choose}
            /*
              The popover's leading edge and the row's leading edge are the same
              (both are inside this padding), so the `+`'s centre is half its own
              width in — which makes the pointer's tip land on the button rather
              than near it. The composer owns this number because the composer owns
              the button; the popover would have to guess.
            */
            pointerOffset={round / 2}
          />
        </View>
      ) : null}

      <View
        onLayout={event => setRowWidth(event.nativeEvent.layout.width)}
        style={{ paddingBottom: theme.space.sm, paddingHorizontal: theme.space.md, paddingTop: theme.space.sm }}
        testID="composer-row"
      >
        {/*
          Three separate controls, not one box: a round `+`, the pill field, and
          the round send. `GlassGroup` is what lets iOS 26 merge them where they
          are close enough, the way its own toolbars do.
        */}
        <GlassGroup
          spacing={theme.space.sm}
          style={{ alignItems: 'flex-end', flexDirection: 'row', gap: theme.space.sm }}
        >
          <GlassSurface
            interactive
            radius={round / 2}
            shadow="card"
            style={{ height: round, width: round }}
            variant="control"
          >
            <Pressable
              accessibilityLabel={chatStrings.composer.attach}
              accessibilityRole="button"
              accessibilityState={{ disabled: choices.length === 0, expanded: menuVisible }}
              disabled={choices.length === 0}
              onPress={() => setMenuOpen(current => !current)}
              style={({ pressed }) => ({
                alignItems: 'center',
                height: round,
                justifyContent: 'center',
                opacity: choices.length === 0 ? 0.3 : pressed ? 0.6 : 1,
                width: round
              })}
              testID="composer-attach"
            >
              <Text color="textMuted" style={{ fontSize: 22, lineHeight: 26 }}>
                +
              </Text>
            </Pressable>
          </GlassSurface>

          <GlassSurface
            contentStyle={{
              // A COLUMN now, not a row: whatever is attached sits above the
              // caret inside the same pill. The row that used to be here is the
              // inner one below, so the field's own geometry is unchanged for a
              // message with no attachments.
              paddingHorizontal: COMPOSER_FIELD_INSET + 6,
              paddingVertical: COMPOSER_FIELD_INSET
            }}
            radius={COMPOSER_FIELD_RADIUS}
            shadow="float"
            style={{ flex: 1 }}
            testID={`${testID}-field`}
            variant="float"
          >
            {/*
              The tray, INSIDE the field.

              It used to sit above the composer row, as a strip of its own. The owner's
              reference is iMessage: what is attached is attached to the MESSAGE, and a
              message is the pill you are typing in — so a thumbnail or a chip sits at
              the top of the field with the caret under it, and the whole thing grows
              and shrinks as one control. A tray floating above the pill reads as a
              staging area beside the message rather than as part of it.

              Images are thumbnails, files are chips, and they sit side by side —
              §6.7. A chip carries its own upload state, which is how a rejected file
              says "Too large · 100 MB max" instead of vanishing.
            */}
            {attachments.length ? (
              <ScrollView
                // No horizontal padding of its own: the field's inset already places
                // it, and a second one would step the thumbnails in from the caret
                // below them.
                contentContainerStyle={{ alignItems: 'flex-end', gap: theme.space.sm }}
                horizontal
                showsHorizontalScrollIndicator={false}
                // A horizontal ScrollView defaults to `flexGrow: 1`, which inside a
                // column makes it as tall as the viewport. Learned on the gallery.
                style={{ flexGrow: 0, marginBottom: theme.space.xs, maxHeight: 76 }}
                testID="composer-attachments"
              >
                {attachments.map(attachment =>
                  attachment.kind === 'image' && attachment.uri ? (
                    <View key={attachment.id} style={{ height: 64, width: 64 }}>
                      <Image
                        source={{ uri: attachment.uri }}
                        style={{ borderRadius: theme.radii.thumb, height: 64, width: 64 }}
                      />

                      <Pressable
                        accessibilityLabel={chatStrings.composer.removeAttachment}
                        accessibilityRole="button"
                        hitSlop={TAP_SLOP}
                        onPress={() => onRemoveAttachment?.(attachment.id)}
                        style={{
                          alignItems: 'center',
                          backgroundColor: 'rgba(8,20,44,0.62)',
                          borderRadius: 11,
                          height: 22,
                          justifyContent: 'center',
                          position: 'absolute',
                          right: 2,
                          top: 2,
                          width: 22
                        }}
                        testID={`composer-attachment-remove-${attachment.id}`}
                      >
                        <Text color="onAccent" style={{ fontSize: 14, lineHeight: 16 }}>
                          {'×'}
                        </Text>
                      </Pressable>
                    </View>
                  ) : (
                    <FileChip
                      key={attachment.id}
                      name={attachment.name}
                      {...(attachment.error ? { error: attachment.error } : {})}
                      onRemove={() => onRemoveAttachment?.(attachment.id)}
                      {...(attachment.progress !== undefined ? { progress: attachment.progress } : {})}
                      {...(attachment.size !== undefined ? { size: attachment.size } : {})}
                      {...(attachment.status ? { status: attachment.status } : {})}
                      testID={`composer-attachment-${attachment.id}`}
                    />
                  )
                )}
              </ScrollView>
            ) : null}

            <View style={{ alignItems: 'flex-end', flexDirection: 'row' }}>
              <TextInput
                accessibilityLabel={
                  botName ? chatStrings.composer.messageTo(botName) : chatStrings.composer.placeholder
                }
                multiline
                onChangeText={onChangeText}
                onKeyPress={onKeyPress}
                onSelectionChange={onSelectionChange}
                // Only reached where `submitBehavior` is 'submit', i.e. on a Mac.
                onSubmitEditing={onSubmitEditing}
                placeholder={placeholder ?? chatStrings.composer.placeholder}
                placeholderTextColor={theme.colors.textFaint}
                ref={inputRef}
                selection={caret}
                style={{
                  color: theme.colors.text,
                  flex: 1,
                  fontSize: theme.type.body.fontSize,
                  // An explicit leading, so the box the padding centres is a box
                  // this app chose rather than one the platform's font metrics
                  // happened to produce. See `COMPOSER_TEXT_LINE_HEIGHT`.
                  lineHeight: COMPOSER_TEXT_LINE_HEIGHT,
                  maxHeight: 132,
                  // No `minHeight`: the padding below already makes one line exactly
                  // `COMPOSER_LINE_HEIGHT` tall, and a minimum ON TOP of that is a box
                  // taller than its content — which on iOS a multiline field fills
                  // from the top, leaving the placeholder high and the gap below it.
                  ...composerFieldPadding(Platform.OS === 'ios' ? COMPOSER_IOS_TOP_INSET : 0)
                }}
                submitBehavior={submitBehavior}
                testID="composer-input"
                value={value}
              />
            </View>
          </GlassSurface>

          {/* Accent while it sends, a red stop SQUARE while a turn runs. */}
          <Pressable
            accessibilityLabel={running ? chatStrings.composer.stop : chatStrings.composer.send}
            accessibilityRole="button"
            disabled={!running && !canSend}
            onPress={press}
            style={({ pressed }) => ({
              alignItems: 'center',
              height: round,
              justifyContent: 'center',
              opacity: !running && !canSend ? 0.35 : pressed ? 0.85 : 1,
              width: round
            })}
            testID={running ? 'composer-stop' : 'composer-send'}
          >
            <View
              style={{
                alignItems: 'center',
                backgroundColor: running ? theme.colors.danger : theme.accent().fill,
                borderRadius: round / 2,
                height: round,
                justifyContent: 'center',
                width: round,
                // No shadow while the button is dimmed. Android draws an
                // elevation shadow BEHIND the view and clips nothing, so at
                // opacity 0.35 the fill stops hiding it and the shadow's own
                // outline — an octagon, which is how the platform approximates
                // a circle at this size — reads straight through the circle.
                // iOS clips a shadow to outside the view's path and never
                // showed it. A disabled control has nothing to float above
                // either way, so the shadow goes with the dimming.
                ...(!running && !canSend ? {} : theme.shadows.card)
              }}
              testID="composer-send-circle"
            >
              {running ? (
                <View style={{ backgroundColor: theme.colors.onAccent, borderRadius: 2, height: 12, width: 12 }} />
              ) : (
                <Text color="onAccent" style={{ fontSize: 18, fontWeight: '700', lineHeight: 21 }}>
                  {'\u2191'}
                </Text>
              )}
            </View>
          </Pressable>
        </GlassGroup>

        {/* Only where a bare Return sends, which is the only place the two
            chords mean anything. */}
        {hardwareKeyboard ? (
          <Text
            color="textFaint"
            style={{ marginTop: theme.space.xs, textAlign: 'center' }}
            testID="composer-key-hint"
            variant="micro"
          >
            {chatStrings.composer.keyHint}
          </Text>
        ) : null}

        {queuedText ? <QueuedChip testID="composer-queued" text={queuedText} /> : null}

        {/*
          Outside tap.

          A popover is dismissed by a tap that is not on it, and the taps that reach
          this composer are the field, the tray and the three controls — so the
          catcher covers the row the popover stands on, the popover itself being
          above it. The first tap dismisses and does nothing else, which is what a
          popover does everywhere.

          It does NOT reach the transcript above: the menu is the composer's own
          state and a screen-wide catcher would mean lifting it to `ChatScreen`. The
          three dismissals that DO work — this, Escape (registered last, so it beats
          the panel's), and the `+` again — are what the reader has; `design/README.md`
          records the gap.
        */}
        {menuVisible ? (
          <Pressable
            accessibilityLabel={chatStrings.composer.dismissAttach}
            accessibilityRole="button"
            onPress={() => setMenuOpen(false)}
            style={StyleSheet.absoluteFill}
            testID="composer-attach-dismiss"
          />
        ) : null}
      </View>
    </KeyboardAvoidingView>
  )
}
