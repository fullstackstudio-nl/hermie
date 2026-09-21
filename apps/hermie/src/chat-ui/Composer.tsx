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
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
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

import { hasHardwareKeyboard, isShiftDown } from '../platform/keyboard-modifiers'
import { RUNS_ON_MAC } from '../platform/runs-on-mac'
import { growToContent, ONE_ROW } from '../platform/text-field-web'
import { GlassGroup, GlassSurface } from '../ui/glass'
import { Appear } from '../ui/Appear'
import { KEYBOARD_AVOID_BEHAVIOR } from '../ui/keyboard'
import { RoundIconButton, Text } from '../ui/primitives'
import { useTheme } from '../ui/theme'
import { CONTROL_SIZE, TAP_SLOP } from '../ui/tokens'
import { useEscapeKey } from '../ui/useEscapeKey'
import { useFocusRing } from '../ui/useFocusRing'
import { useShortcut } from '../ui/useShortcut'
import { AttachMenu } from './AttachMenu'
import { FileChip } from './FileChip'
import { QueuedChip } from './QueuedChip'
import { shouldSend } from './send-key'
import { chatStrings } from './strings'
import type { AttachChoice, ComposerAttachment, SlashFailure, SlashSuggestion } from './types'

export interface ComposerProps {
  /** Controlled draft. */
  value: string
  onChangeText: (text: string) => void
  onSend: (text: string) => void
  /** A turn is running: the send button becomes a stop square. */
  running?: boolean
  /**
   * The gateway cannot carry a send yet, so the round button is dimmed.
   *
   * Everything ELSE stays live: the field takes text, the draft is kept, the
   * slash list still answers. That asymmetry is the point — a reconnect is a
   * good moment to write the next message and a bad moment to try to send it,
   * and a composer that refuses the keyboard as well says "come back later" to
   * somebody who is already here.
   *
   * It does not disable STOP. A turn that was running when the socket went is
   * still the reader's to interrupt the moment it comes back.
   */
  sendBlocked?: boolean
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
  /**
   * The completion call that would not answer, when the last one did not.
   *
   * The popover used to open only on `suggestions.length > 0`, so a gateway
   * that refused `commands.catalog` and `complete.slash` drew NOTHING: the
   * owner typed `/` on his phone, saw an empty composer, and the same build
   * showed the list on the web and on the simulator. An empty list and a
   * refused call look identical from the outside and they are not the same
   * thing, so the refused one says so.
   */
  slashFailure?: SlashFailure | null
  /**
   * A first catalogue fetch is still in the air.
   *
   * Only the FIRST: every later keystroke is answered from a catalogue that is
   * already in memory, and a row that blinked on each of them would be noise.
   * The composer waits `SLASH_SLOW_MS` before drawing anything, so a gateway
   * that answers promptly never shows it at all — which is what makes the row
   * mean "this one is slow" rather than "this one is loading".
   */
  slashLoading?: boolean
  /** A prompt the backend parked behind the running turn. */
  queuedText?: string
  placeholder?: string
  botName?: string
  /**
   * A bare Return sends instead of inserting a newline.
   *
   * Defaults to "a Mac window, OR a keyboard is actually attached". It used to be
   * the Mac alone, and the owner's report is what that costs: on an iPad in a
   * keyboard case Enter did nothing useful, while the same build on a Mac sent.
   *
   * The OS is the wrong question and only ever was — it is a proxy for "is there
   * a keyboard". `RUNS_ON_MAC` stays as the first half because a Mac window
   * always has one whether or not GameController has noticed it yet; the second
   * half is the honest question, asked of the HID state (see
   * `src/platform/keyboard-modifiers.ts`). A phone with nothing attached answers
   * false to both and keeps a Return that breaks the line, which is the only way
   * a touch user can write a second one.
   *
   * Evaluated per render rather than once, so a keyboard connected mid-session is
   * picked up on the composer's next render — which is the next keystroke, the
   * next focus or the next turn.
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
 * How tall the field is allowed to grow before it scrolls: six lines.
 *
 * A number rather than a `style` literal because the web has to be TOLD it —
 * a `<textarea>` does not size itself to its content, so the same cap that is a
 * `maxHeight` natively is also the clamp `growToContent` measures against.
 */
export const COMPOSER_MAX_HEIGHT = 132

/**
 * How much composer the attach POPOVER needs before it stops being the right shape.
 *
 * Two round buttons, their labels, the popover's own padding and the gap between
 * them, plus enough composer left over that the popover reads as anchored to one end
 * of it rather than as filling it. Below this the stacked list is the honest answer —
 * which is the owner's own allowance for the phone.
 */
export const ATTACH_POPOVER_MIN_WIDTH = 260

/**
 * How far above the composer the `+` menu's tap catcher reaches.
 *
 * A number rather than `flex: 1` because the catcher is an absolutely
 * positioned child of the composer, which is only as tall as the composer: it
 * has to be told how much of the screen above it to cover. Taller than any
 * phone or tablet in portrait, and off the top of the screen costs nothing
 * because nothing is drawn in it.
 */
export const MENU_BACKDROP_REACH = 4000

/**
 * How long a first catalogue fetch may take before the popover says so.
 *
 * Long enough that a gateway on the same machine — which answers in single
 * milliseconds — never draws the row at all, and short enough that a reader who
 * typed `/` and is staring at nothing gets an answer before they conclude the
 * feature is broken. The report this serves is exactly that conclusion: the
 * same build showed the list on the web and on the simulator and nothing on the
 * owner's phone, and a silent composer gives a reader no way to tell a slow
 * gateway from a refusing one.
 */
export const SLASH_SLOW_MS = 400

/**
 * The line the completion list is for, or `null` while there is no list.
 *
 * A LEADING slash and nothing else: `/` in the middle of a sentence is a slash,
 * and `run /clean` is prose. It is the whole typed line rather than the command
 * name, because `complete.slash` completes the ARGUMENT as well once there is
 * one — `/model exa` has to reach the gateway intact for it to answer with the
 * models. A newline ends it: a multi-line draft is a message.
 */
export function slashQuery(text: string): string | null {
  if (!text.startsWith('/') || text.includes('\n')) {
    return null
  }

  return text
}

export function Composer({
  value,
  onChangeText,
  onSend,
  running = false,
  sendBlocked = false,
  onStop,
  onAttach,
  onAttachFile,
  attachBusy = null,
  attachments = [],
  onRemoveAttachment,
  suggestions = [],
  onQuerySlash,
  slashFailure = null,
  slashLoading = false,
  queuedText,
  placeholder,
  botName,
  hardwareKeyboard = RUNS_ON_MAC || hasHardwareKeyboard(),
  keyboardAvoiding = false,
  testID = 'composer'
}: ComposerProps) {
  const theme = useTheme()
  const inputRef = useRef<TextInput>(null)
  /*
    The pill draws the focus ring, not the field inside it.

    Same report as the chat list's search box: a browser rings the `<textarea>`,
    which is the text line rather than the control, so the indicator was a
    square-cornered rectangle inside a rounded pill in the system's accent. Both
    halves are no-ops on iOS and Android.
  */
  const fieldFocus = useFocusRing()

  /*
    The field grows with what is in it, on the platform that will not do it.

    A `<textarea>` keeps the height it was given and scrolls; a native
    `TextInput` re-measures itself. So this drives the height from the content
    on every change of the value, and is a no-op everywhere else — see
    `platform/text-field-web.ts`. `useLayoutEffect` rather than `useEffect`
    because the alternative is one painted frame at the old height per keystroke
    that wraps, which is the flicker this is supposed to remove.
  */
  useLayoutEffect(() => {
    growToContent(inputRef.current, COMPOSER_MAX_HEIGHT)
  }, [attachments.length, value])
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

  const prefix = useMemo(() => slashQuery(value), [value])
  const [popoverDismissed, setPopoverDismissed] = useState(false)

  /**
   * Which row the keyboard is on.
   *
   * Back to the first whenever the candidates change, which is on every
   * keystroke that narrows them: keeping an index across two different lists
   * would move the highlight to whatever happened to land in that position.
   */
  const [active, setActive] = useState(0)

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
   * The composer row's height, which is where the popover's bottom edge goes.
   *
   * The menu used to be an ordinary child ABOVE the row, so opening it added its
   * own height to the composer — and a composer that grows pushes the transcript
   * up, which is the reader's place moving because they tapped `+`. It floats
   * over the transcript now, and floating needs one number: how far up from the
   * composer's bottom edge its own top edge is.
   */
  const [rowHeight, setRowHeight] = useState(0)

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

  /**
   * A slow first fetch, which is a different fact from an empty list.
   *
   * The timer runs only while a query is genuinely outstanding, and it is torn
   * down on every change of either input — so a gateway that answers inside the
   * window never sets the flag, and one that answers just after it clears it on
   * the same render that fills the list.
   */
  const [slashSlow, setSlashSlow] = useState(false)

  useEffect(() => {
    if (!slashLoading || prefix === null) {
      setSlashSlow(false)

      return
    }

    const timer = setTimeout(() => setSlashSlow(true), SLASH_SLOW_MS)

    return () => clearTimeout(timer)
  }, [prefix, slashLoading])

  /*
    Three reasons to open, and only the first of them is selectable.

    A failure and a slow fetch both open a popover with nothing to accept in it,
    which is why `submit()` and the arrow keys below all read `suggestions`
    rather than this flag: an open popover with no rows must not swallow the
    Return that would have sent the line.
  */
  const slashNotice = prefix !== null && !popoverDismissed && (Boolean(slashFailure) || slashSlow)
  const showSuggestions = prefix !== null && suggestions.length > 0 && !popoverDismissed
  const showPopover = showSuggestions || slashNotice

  useEffect(() => setActive(0), [suggestions])

  const activeIndex = Math.min(active, Math.max(0, suggestions.length - 1))

  // The caller decides where the candidates come from (`commands.catalog`,
  // `complete.slash`, a cache); the composer only says which prefix it is on.
  useEffect(() => {
    if (prefix !== null) {
      query.current?.(prefix)
    }
  }, [prefix])

  /**
   * Is there something to send, AND somewhere to send it?
   *
   * Both halves in one value on purpose: `canSend` is already what dims the
   * button, what `press` checks and what the Return key checks, so a blocked
   * connection folded in here reaches all three and cannot be forgotten in one
   * of them.
   */
  const canSend = (Boolean(value.trim()) || attachments.length > 0) && !sendBlocked

  /**
   * Put the highlighted candidate in the field.
   *
   * `insert` is the whole line the caller worked out from the gateway's
   * `replace_from`; the fallback is a bare command, which is all that can be
   * assumed without one.
   */
  const accept = (suggestion: SlashSuggestion) => {
    onChangeText(suggestion.insert ?? `/${suggestion.name} `)
    inputRef.current?.focus()
  }

  /**
   * What Enter does: take the highlighted suggestion, or send, or nothing.
   *
   * The list first, and only while it is open — which is the rule every editor
   * has and the one thing that makes a list navigable by keyboard worth having.
   *
   * It deliberately does NOT stop a running turn. On a Mac a bare Return is the
   * send key, and while a reply streamed that same key cancelled the turn — so
   * typing the next message and pressing Return killed the answer being written
   * instead of queueing the message. Sending mid-turn parks the message in the
   * queue; only the red button, and Escape, stop anything.
   */
  const submit = () => {
    if (showSuggestions) {
      const suggestion = suggestions[activeIndex]

      if (suggestion) {
        accept(suggestion)

        return
      }
    }

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

  /**
   * The round button: send whenever there is something to send, stop otherwise.
   *
   * It used to stop the turn whenever one was running, whatever was in the
   * field — so the only way to say something mid-turn was the Return key, and
   * the button under the words you had just typed threw away the reply instead.
   * Sending is always possible; the message is parked behind the running turn
   * (see `QueuedStrip`) and the stop square is what an EMPTY field offers.
   */
  const press = () => {
    if (running && !canSend) {
      onStop?.()

      return
    }

    /*
      SEND, not `submit()`.

      `submit()` puts the slash list first, which is right for a Return — the key
      is ambiguous and the list is what is in front of the caret. A tap on this
      button is not ambiguous: it is the one control in the composer whose only
      meaning is "send this".

      It used to call `submit()`, and on a touch device that was a dead end. Type
      `/model` in full and the list stays open on the exact match, so the button
      re-accepted a suggestion that was already accepted and the message never
      went — with no way out, because the only thing that dismisses the popover is
      Escape and a phone has no Escape. Watched on an iPhone simulator.
    */
    if (!canSend) {
      return
    }

    onSend(value)
  }

  /** Stop, rather than send: a running turn and nothing typed. */
  const stopping = running && !canSend

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
  /*
    `showPopover`, not `showSuggestions`: a popover holding only the failure row
    is still a popover in front of the caret, and on a Mac Escape is the only
    thing that puts it away. The ORDER is unchanged — the list still outranks
    the running turn — and so is what the key means at each level.
  */
  useEscapeKey(() => setPopoverDismissed(true), showPopover)

  /*
    ↑, ↓ and Tab, from the keyboard seam rather than from the field.

    A `TextInput` only reports keys that insert text — React Native builds its
    `onKeyPress` payload from the text a `UITextView` is about to insert — so an
    arrow key never reaches it at all. These three come down the same road as
    Escape and the desktop shortcuts, and they are registered only while the
    list is open, so nothing else in the app loses an arrow key to them.
  */
  useShortcut('suggestionDown', () => setActive(index => Math.min(index + 1, suggestions.length - 1)), showSuggestions)
  useShortcut('suggestionUp', () => setActive(index => Math.max(index - 1, 0)), showSuggestions)
  useShortcut(
    'suggestionAccept',
    () => {
      const suggestion = suggestions[activeIndex]

      if (suggestion) {
        accept(suggestion)
      }
    },
    showSuggestions
  )
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
   *
   * ## And while the slash list is open, on ANY keyboard
   *
   * `submit()` has always put the list first — take the highlighted suggestion,
   * then send — and on a phone it was never reached: `submitBehavior` was
   * `'newline'`, so Return inserted one and `onKeyPress` declined it, and the
   * only way to take a suggestion without a hardware keyboard was to tap it.
   * Watched on an iPhone simulator: `/mo` narrowed to `/model`, Return put a
   * line break in the field.
   *
   * The list is the thing in front of the caret while it is open, which is why
   * every editor gives it the key. Nothing is taken away from a touch reader:
   * the list only opens on a leading `/`, Escape dismisses it (registered above)
   * and the Return after that breaks the line as it always did.
   */
  const submitBehavior = hardwareKeyboard || showSuggestions ? 'submit' : 'newline'

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
      {/*
        It drops DOWN onto the field it belongs to — a negative rise — because it
        is anchored above the composer and a list that rose from below would
        appear to come out of the wrong control.
      */}
      <Appear exit="cut" rise={-8} visible={showPopover}>
        <GlassSurface
          contentStyle={{ maxHeight: 220 }}
          radius={theme.radii.card}
          shadow="float"
          style={{ marginBottom: theme.space.sm, marginHorizontal: theme.space.md }}
          testID="composer-slash-popover"
          variant="float"
        >
          <ScrollView keyboardShouldPersistTaps="handled">
            {/*
              Not a `Pressable`, and deliberately so: there is nothing to accept
              here, and a row that highlighted under a finger would be offering
              one. It is a plain `View` with the danger tint's readable ink, which
              is the same hierarchy decision §3 makes about a danger TINT versus
              the saturated fill — this is a sentence, not a status mark.
            */}
            {slashFailure ? (
              <View
                style={{ paddingHorizontal: theme.space.lg, paddingVertical: theme.space.sm + 2 }}
                testID="slash-failure"
              >
                <Text color="dangerText" variant="name">
                  {chatStrings.composer.slashUnavailable(slashFailure.method)}
                </Text>
                <Text color="textFaint" variant="meta">
                  {slashFailure.reason}
                </Text>
              </View>
            ) : null}

            {/*
              Only while nothing has arrived. A failure is the more specific
              answer to the same question, so the two never draw together.
            */}
            {!slashFailure && slashSlow ? (
              <View
                style={{ paddingHorizontal: theme.space.lg, paddingVertical: theme.space.sm + 2 }}
                testID="slash-loading"
              >
                <Text color="textMuted" variant="name">
                  {chatStrings.composer.slashLoading}
                </Text>
              </View>
            ) : null}

            {suggestions.map((suggestion, index) => (
              <Pressable
                accessibilityRole="button"
                // The keyboard's own place in the list, announced rather than
                // only drawn: the row is selected in the same sense a picker's
                // row is.
                aria-selected={index === activeIndex}
                key={suggestion.name}
                onPress={() => accept(suggestion)}
                style={({ pressed }) => ({
                  backgroundColor: pressed || index === activeIndex ? theme.tintSunk : 'transparent',
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
      </Appear>

      {/*
        A tap anywhere else puts the menu away, and "anywhere else" is mostly the
        transcript — which is not this component's to listen to. So the catcher
        is a transparent sheet of this component's own, parked above the composer
        and reaching further up than any phone is tall.

        It is rendered BEFORE the popover and behind it, so the popover's own
        buttons are still the ones that get the tap.
      */}
      {menuVisible ? (
        <Pressable
          accessibilityElementsHidden
          // `aria-hidden` is the web's spelling of the two props around it; react-native-web
          // honours neither of those. See `ui/Icon.tsx`.
          aria-hidden
          importantForAccessibility="no-hide-descendants"
          onPress={() => setMenuOpen(false)}
          style={{ bottom: rowHeight, height: MENU_BACKDROP_REACH, left: 0, position: 'absolute', right: 0 }}
          testID="composer-attach-backdrop"
        />
      ) : null}

      {/*
        Absolute, so it is drawn over the transcript rather than laid out above
        it. `bottom` is the row's measured height, which puts the popover's lower
        edge — and the pointer hanging off it — exactly on the row's top edge,
        over the `+`.

        `box-none` on the wrapper: it spans the whole width and would otherwise
        swallow the taps the backdrop underneath it exists to catch.
      */}
      <View
        pointerEvents="box-none"
        style={{ bottom: rowHeight, left: 0, paddingHorizontal: theme.space.md, position: 'absolute', right: 0 }}
        testID="composer-attach-layer"
      >
        {/*
          It comes UP out of the button it belongs to, and it sinks back into it.

          The travel is the whole of what says where this menu came from, now that
          the popover has no tail — so unlike the slash list, which `cut`s because
          its reason has resolved, this one animates BOTH ways. A menu that vanishes
          on the frame it is dismissed leaves the reader's eye with nowhere to go
          back to, which is the same complaint the tail was there to answer.

          `exit` is therefore the default `fade`, which keeps the surface mounted
          for one exit and forces its `pointerEvents` to `none` while it leaves, so
          the tap that dismissed it cannot be taken twice. Under Reduce Motion the
          duration is zero on both sides (`usePresence`), which puts the hard cut
          back for the reader who asked for one.
        */}
        <Appear rise={8} testID="composer-attach-appear" visible={menuVisible}>
          <AttachMenu choices={choices} layout={menuLayout} onChoose={choose} />
        </Appear>
      </View>

      <View
        onLayout={event => {
          setRowWidth(event.nativeEvent.layout.width)
          setRowHeight(event.nativeEvent.layout.height)
        }}
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
          {/*
            The `+` is a drawn path now, and the button is the shared one.

            It was a `Text` holding the character, centred by its LINE BOX —
            which is not where the ink is: a font places a glyph by its ascent
            and descent, so `+` sat about two points low in a 40pt circle. In a
            browser that is plainly visible. `src/ui/Icon.tsx` opens with the
            same argument about the tab strip.
          */}
          <RoundIconButton
            disabled={choices.length === 0}
            expanded={menuVisible}
            icon="plus"
            label={chatStrings.composer.attach}
            onPress={() => setMenuOpen(current => !current)}
            size={round}
            testID="composer-attach"
            tint={theme.colors.textMuted}
          />

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
            style={{ flex: 1, ...fieldFocus.ringStyle }}
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
              /*
                "Not sent yet".

                The tray's cards are deliberately the SAME cards a sent message
                shows, which is what made the state ambiguous: the owner could
                not tell an attached file from one already on its way. So the
                tray says which it is, in words, and carries an accent rule down
                its left edge — a state marker, not a container. It stays inside
                the field: the tray belongs to the message being written, and
                lifting it back out into a strip of its own is the shape this
                composer deliberately moved away from.
              */
              <View
                style={{
                  borderLeftColor: theme.colors.accentText,
                  borderLeftWidth: 2,
                  gap: theme.space.xs,
                  marginBottom: theme.space.xs,
                  paddingLeft: theme.space.sm
                }}
                testID="composer-attachments-pending"
              >
                <View style={{ alignItems: 'center', flexDirection: 'row', gap: theme.space.xs }}>
                  <Text style={{ color: theme.colors.accentText, fontSize: 12, lineHeight: 14 }}>{'📎'}</Text>
                  <Text style={{ color: theme.colors.accentText, fontWeight: '600' }} variant="micro">
                    {chatStrings.composer.notSentYet}
                  </Text>
                  <Text color="textFaint" variant="micro">
                    {`· ${chatStrings.composer.pendingCount(attachments.length)}`}
                  </Text>
                </View>

                <ScrollView
                  // No horizontal padding of its own: the field's inset already places
                  // it, and a second one would step the thumbnails in from the caret
                  // below them.
                  contentContainerStyle={{ alignItems: 'flex-end', gap: theme.space.sm }}
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  // A horizontal ScrollView defaults to `flexGrow: 1`, which inside a
                  // column makes it as tall as the viewport. Learned on the gallery.
                  style={{ flexGrow: 0, maxHeight: 76 }}
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
              </View>
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
                onBlur={fieldFocus.fieldProps.onBlur}
                onFocus={fieldFocus.fieldProps.onFocus}
                /*
                  One row, for the one platform that has a default.

                  A `<textarea>` with no `rows` is two lines tall, which is why
                  the field was 54pt in a tab and 32 on a phone with the same
                  one line of text in it. `undefined` everywhere else, where a
                  multiline field measures its own content.
                */
                {...ONE_ROW}
                style={[
                  {
                    color: theme.colors.text,
                    flex: 1,
                    fontSize: theme.type.body.fontSize,
                    // An explicit leading, so the box the padding centres is a box
                    // this app chose rather than one the platform's font metrics
                    // happened to produce. See `COMPOSER_TEXT_LINE_HEIGHT`.
                    lineHeight: COMPOSER_TEXT_LINE_HEIGHT,
                    maxHeight: COMPOSER_MAX_HEIGHT,
                    // No `minHeight`: the padding below already makes one line exactly
                    // `COMPOSER_LINE_HEIGHT` tall, and a minimum ON TOP of that is a box
                    // taller than its content — which on iOS a multiline field fills
                    // from the top, leaving the placeholder high and the gap below it.
                    ...composerFieldPadding(Platform.OS === 'ios' ? COMPOSER_IOS_TOP_INSET : 0)
                  },
                  fieldFocus.fieldProps.style
                ]}
                submitBehavior={submitBehavior}
                testID="composer-input"
                value={value}
              />
            </View>
          </GlassSurface>

          {/*
            Accent while it sends, a red stop SQUARE while a turn runs.

            The colour is the accent's BUBBLE, not its `fill`. White sits on this
            circle, and `bubble` is the half of the swatch that
            `npm run contrast:check` measures white against — `fill` is the ring
            colour and may be brilliant, which on the studio's lime left a white
            arrow at about 1.3 : 1.

            The stop stays a drawn square rather than an icon: it is a shape, not
            a mark, and it is the one child here that was never a glyph. The
            arrow was, and it sat low in the circle for the same reason the `+`
            did.
          */}
          {stopping ? (
            <Pressable
              accessibilityLabel={chatStrings.composer.stop}
              accessibilityRole="button"
              hitSlop={TAP_SLOP}
              onPress={press}
              style={({ pressed }) => ({
                alignItems: 'center',
                backgroundColor: theme.colors.danger,
                borderRadius: round / 2,
                height: round,
                justifyContent: 'center',
                opacity: pressed ? 0.85 : 1,
                width: round,
                ...theme.shadows.card
              })}
              testID="composer-stop"
            >
              <View style={{ backgroundColor: theme.colors.onAccent, borderRadius: 2, height: 12, width: 12 }} />
            </Pressable>
          ) : (
            <View>
              <RoundIconButton
                color={theme.accent().bubble}
                disabled={!running && !canSend}
                fill="solid"
                icon="arrowUp"
                // The label names the attachments, because this button is the
                // last thing between a staged file and a sent one, and a screen
                // reader has no other way to hear it is carrying anything.
                label={
                  attachments.length
                    ? chatStrings.composer.sendWithAttachments(attachments.length)
                    : chatStrings.composer.send
                }
                onPress={press}
                size={round}
                testID="composer-send"
              />

              {/* A count on the button as well as in the tray. The tray scrolls
                  out of reach on a short screen with the keyboard up; the
                  button never does, and it is the control about to send them. */}
              {attachments.length ? (
                <View
                  pointerEvents="none"
                  style={{
                    alignItems: 'center',
                    backgroundColor: theme.colors.accentText,
                    borderRadius: 999,
                    height: 16,
                    justifyContent: 'center',
                    minWidth: 16,
                    paddingHorizontal: 3,
                    position: 'absolute',
                    right: -3,
                    top: -3
                  }}
                  testID="composer-send-badge"
                >
                  <Text color="onAccent" style={{ fontSize: 10, fontWeight: '700', lineHeight: 12 }}>
                    {String(attachments.length)}
                  </Text>
                </View>
              ) : null}
            </View>
          )}
        </GlassGroup>

        {/*
          The Mac only, and not merely "wherever a bare Return sends".

          On an iPad with a keyboard case the two chords are true — `Enter` does
          send there, which is what `hardwareKeyboard` is for — but the line has
          nowhere to be: iPadOS keeps its own keyboard bar along the bottom of
          the window, and the hint was drawn straight through it with the
          system's keyboard button sitting on top of the words. A Mac window has
          no such bar, so the line sits under the composer as it was meant to.

          The chords still work on the iPad. They are just not announced there,
          which is the ordinary state of a keyboard shortcut.
        */}
        {RUNS_ON_MAC ? (
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
