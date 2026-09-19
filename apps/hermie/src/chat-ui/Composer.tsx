/**
 * The message composer: "+" on the left, a rounded multiline field, and one
 * round button on the right that is blue-send while idle and red-stop while a
 * turn runs.
 *
 * Three deliberate choices:
 *   - The draft is controlled from outside. A chat's draft belongs to the chat,
 *     survives navigating away, and is what the store persists.
 *   - Keyboard avoidance uses `KeyboardAvoidingView`, not a keyboard-controller
 *     library: those are new-architecture only, and macOS runs the old one.
 *   - The slash popover is fed by props. The composer asks (`onQuerySlash`) and
 *     paints what it is given; it never calls the gateway itself.
 */
import { useEffect, useMemo, useRef } from 'react'
import {
  Image,
  KeyboardAvoidingView,
  type NativeSyntheticEvent,
  Platform,
  Pressable,
  ScrollView,
  type TextInputKeyPressEventData,
  TextInput,
  View
} from 'react-native'

import { KEYBOARD_AVOID_BEHAVIOR } from '../ui/keyboard'
import { Text } from '../ui/primitives'
import { useTheme } from '../ui/theme'
import { TAP_SLOP } from '../ui/tokens'
import { QueuedChip } from './QueuedChip'
import { chatStrings } from './strings'
import type { ComposerAttachment, SlashSuggestion } from './types'

export interface ComposerProps {
  /** Controlled draft. */
  value: string
  onChangeText: (text: string) => void
  onSend: (text: string) => void
  /** A turn is running: the send button becomes a stop square. */
  running?: boolean
  onStop?: () => void
  onAttach?: () => void
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
   * A bare Enter sends instead of inserting a newline.
   *
   * Only on macOS by default, and deliberately not on iPad: neither iOS nor
   * iPadOS tells React Native whether a keyboard is physical, and a bare Enter
   * that sends would leave a touch user with no way to type a newline at all.
   * Cmd/Ctrl+Enter and Escape work everywhere regardless — a software keyboard
   * cannot produce either.
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
 * The geometry of the rounded field, and the one rule it has to keep.
 *
 * The field is a single pill holding three things: "+", the growing input, and
 * the send/stop button. Those three used to be sized independently — a 38pt
 * circle, a 44pt "+" and a 40pt input inside 3pt of padding, under a 28pt
 * corner radius — so the circle sat in the corner's curve and visibly crossed
 * the border, and the row was as tall as the tallest of the three rather than
 * as tall as one line of text.
 *
 * Now there is one line box. `COMPOSER_LINE_HEIGHT` is a single line of input;
 * both buttons occupy a slot exactly that tall and draw a
 * `COMPOSER_BUTTON_SIZE` circle centred in it. At one line the circle is
 * centred in the field; once the input grows, the slot stays one line tall and
 * the row aligns to `flex-end`, so the buttons ride the bottom line the way
 * iMessage does.
 *
 * The invariant `COMPOSER_BUTTON_SIZE + 2 * COMPOSER_FIELD_INSET <=
 * COMPOSER_LINE_HEIGHT + 2 * COMPOSER_FIELD_INSET` — i.e. the button is never
 * taller than the line box — is what makes overflow impossible in either
 * theme, and it is asserted in `__tests__/chat-ui/composer.test.tsx`.
 */
export const COMPOSER_FIELD_INSET = 4
export const COMPOSER_LINE_HEIGHT = 32
export const COMPOSER_BUTTON_SIZE = 30

/**
 * Half the SINGLE-LINE field height, so the field is a true pill at one line
 * and keeps those same caps as it grows.
 *
 * Not `radii.pill`: a 999pt radius on a four-line field makes both ends full
 * semicircles, and the "+" on the bottom line then sits inside the left one.
 * Not `radii.sheet` either — 28pt on a 40pt box was the original bug. This is
 * the one radius that is correct at every height.
 */
export const COMPOSER_FIELD_RADIUS = (COMPOSER_LINE_HEIGHT + 2 * COMPOSER_FIELD_INSET) / 2

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
  attachments = [],
  onRemoveAttachment,
  suggestions = [],
  onQuerySlash,
  queuedText,
  placeholder,
  botName,
  hardwareKeyboard = Platform.OS === 'macos',
  keyboardAvoiding = false,
  testID = 'composer'
}: ComposerProps) {
  const theme = useTheme()
  const inputRef = useRef<TextInput>(null)
  const query = useRef(onQuerySlash)

  query.current = onQuerySlash

  const prefix = useMemo(() => slashPrefix(value), [value])
  const showSuggestions = prefix !== null && suggestions.length > 0

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
   * It deliberately does NOT stop a running turn. On macOS a bare Enter is the
   * send key, and while a reply streamed that same key cancelled the turn — so
   * typing the next message and pressing Enter killed the answer being written
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

  /** The round button: stop while a turn runs, send otherwise. */
  const press = () => {
    if (running) {
      onStop?.()

      return
    }

    submit()
  }

  /**
   * Hardware-keyboard shortcuts.
   *
   * `onKeyPress` is the only hook RN gives a `TextInput` that fires BEFORE the
   * character lands, which is what makes swallowing Enter possible at all. The
   * modifier flags are on the native event on macOS; on iPadOS they are not, so
   * Shift+Enter there is recognised by the newline the field has already
   * accepted rather than by the flag — hence the `preventDefault` guard rather
   * than an unconditional send.
   */
  const onKeyPress = (event: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
    const native = event.nativeEvent as TextInputKeyPressEventData & {
      shiftKey?: boolean
      metaKey?: boolean
      ctrlKey?: boolean
    }

    if (native.key === 'Escape') {
      if (running) {
        event.preventDefault?.()
        onStop?.()
      }

      return
    }

    if (native.key !== 'Enter') {
      return
    }

    // Cmd/Ctrl+Enter sends everywhere: only a physical keyboard can produce a
    // modifier, so this is safe on a phone too.
    if (native.metaKey || native.ctrlKey) {
      event.preventDefault?.()
      submit()

      return
    }

    // Shift+Enter is always the newline. A bare Enter only sends where a
    // hardware keyboard is certain.
    if (!hardwareKeyboard || native.shiftKey) {
      return
    }

    event.preventDefault?.()
    submit()
  }

  /**
   * react-native-macos hands a key to JS only when the field was told to pass
   * it up; without `keyDownEvents` AppKit swallows Return and Escape and
   * `onKeyPress` never fires. The prop does not exist on the other platforms,
   * so it is spread in rather than written inline.
   */
  const keyEvents =
    Platform.OS === 'macos' ? ({ keyDownEvents: [{ key: 'Enter' }, { key: 'Escape' }] } as Record<string, unknown>) : {}

  const pick = (name: string) => {
    onChangeText(`/${name} `)

    // Not on macOS. A programmatic focus dispatches a native command, and
    // `-[RCTTextInputComponentView focus]` was observed aborting the app inside
    // AppKit's `_realMakeFirstResponder:` (see `docs/platform-notes.md`). The
    // command runs on the main thread, so a JS try/catch would not save it.
    // The draft is already updated; the user taps the field to carry on.
    if (Platform.OS !== 'macos') {
      inputRef.current?.focus()
    }
  }

  return (
    // Without `behavior` a `KeyboardAvoidingView` is a plain `View`, which is
    // exactly what the composer wants inside a screen that already has one.
    // Declaring the component conditionally instead would give React a new
    // type on every render and remount the text field under the caret.
    <KeyboardAvoidingView
      behavior={keyboardAvoiding ? KEYBOARD_AVOID_BEHAVIOR : undefined}
      // macOS has no soft keyboard to avoid; the view is inert there.
      testID={testID}
    >
      {showSuggestions ? (
        <View
          style={{
            backgroundColor: theme.colors.surface,
            borderColor: theme.colors.border,
            borderRadius: theme.radii.lg,
            borderWidth: 1,
            marginBottom: theme.space.sm,
            marginHorizontal: theme.space.md,
            maxHeight: 220,
            overflow: 'hidden'
          }}
          testID="composer-slash-popover"
        >
          <ScrollView keyboardShouldPersistTaps="handled">
            {suggestions.map(suggestion => (
              <Pressable
                accessibilityRole="button"
                key={suggestion.name}
                onPress={() => pick(suggestion.name)}
                style={({ pressed }) => ({
                  backgroundColor: pressed ? theme.colors.surfaceRaised : 'transparent',
                  padding: theme.space.md
                })}
                testID={`slash-option-${suggestion.name}`}
              >
                <Text style={{ fontWeight: '600' }}>{`/${suggestion.name}`}</Text>
                <Text color="textMuted" variant="caption">
                  {suggestion.description}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      ) : null}

      {attachments.length ? (
        <ScrollView
          contentContainerStyle={{ gap: theme.space.sm, paddingHorizontal: theme.space.md }}
          horizontal
          showsHorizontalScrollIndicator={false}
          style={{ flexGrow: 0, marginBottom: theme.space.sm }}
          testID="composer-attachments"
        >
          {attachments.map(attachment => (
            <View key={attachment.id} style={{ width: 64 }}>
              <View
                style={{
                  backgroundColor: theme.colors.surfaceRaised,
                  borderRadius: theme.radii.md,
                  height: 64,
                  overflow: 'hidden',
                  width: 64
                }}
              >
                {attachment.uri ? (
                  <Image source={{ uri: attachment.uri }} style={{ height: 64, width: 64 }} />
                ) : (
                  <View style={{ alignItems: 'center', flex: 1, justifyContent: 'center' }}>
                    <Text color="textMuted" style={{ fontSize: 20 }}>
                      {'▤'}
                    </Text>
                  </View>
                )}
              </View>

              <Pressable
                accessibilityLabel={chatStrings.composer.removeAttachment}
                accessibilityRole="button"
                hitSlop={TAP_SLOP}
                onPress={() => onRemoveAttachment?.(attachment.id)}
                style={{ justifyContent: 'center', minHeight: 24 }}
                testID={`composer-attachment-remove-${attachment.id}`}
              >
                <Text color="accent" numberOfLines={1} variant="caption">
                  {attachment.name}
                </Text>
              </Pressable>
            </View>
          ))}
        </ScrollView>
      ) : null}

      <View
        style={{
          backgroundColor: theme.colors.surface,
          borderTopColor: theme.colors.border,
          borderTopWidth: 1,
          paddingHorizontal: theme.space.md,
          paddingTop: theme.space.sm
        }}
      >
        <View
          style={{
            // The buttons ride the BOTTOM line as the input grows upward.
            alignItems: 'flex-end',
            borderColor: theme.colors.textMuted,
            borderRadius: COMPOSER_FIELD_RADIUS,
            borderWidth: 1,
            flexDirection: 'row',
            gap: theme.space.xxs,
            padding: COMPOSER_FIELD_INSET
          }}
          testID={`${testID}-field`}
        >
          <Pressable
            accessibilityLabel={chatStrings.composer.attach}
            accessibilityRole="button"
            // Greyed out is not the same as announced as unavailable: on macOS
            // there is no document picker, and a screen reader has no other way
            // to learn that.
            accessibilityState={{ disabled: !onAttach }}
            disabled={!onAttach}
            // The slot is one line tall; the 44pt touch target comes from the
            // slop, the way every other small control in the kit gets one.
            hitSlop={TAP_SLOP}
            onPress={onAttach}
            style={({ pressed }) => ({
              alignItems: 'center',
              height: COMPOSER_LINE_HEIGHT,
              justifyContent: 'center',
              opacity: onAttach ? (pressed ? 0.6 : 1) : 0.3,
              width: COMPOSER_BUTTON_SIZE
            })}
            testID="composer-attach"
          >
            <Text color="textMuted" style={{ fontSize: 24, lineHeight: 28 }}>
              +
            </Text>
          </Pressable>

          <TextInput
            accessibilityLabel={botName ? chatStrings.composer.messageTo(botName) : chatStrings.composer.placeholder}
            multiline
            onChangeText={onChangeText}
            onKeyPress={onKeyPress}
            placeholder={placeholder ?? chatStrings.composer.placeholder}
            {...keyEvents}
            placeholderTextColor={theme.colors.textMuted}
            ref={inputRef}
            style={{
              color: theme.colors.text,
              flex: 1,
              fontSize: 17,
              maxHeight: 132,
              minHeight: COMPOSER_LINE_HEIGHT,
              paddingHorizontal: theme.space.xs,
              // Centres one line of 17pt text in the 32pt line box. iOS adds
              // its own inset to a multiline field, which is why the two
              // numbers differ.
              paddingTop: Platform.OS === 'ios' ? 7 : 4,
              paddingBottom: Platform.OS === 'ios' ? 7 : 4
            }}
            testID="composer-input"
            value={value}
          />

          {/* The Pressable is the LINE BOX; the circle inside it is the
              button. Sizing the Pressable itself as the circle would either
              float it off the bottom line or stretch it as the input grew. */}
          <Pressable
            accessibilityLabel={running ? chatStrings.composer.stop : chatStrings.composer.send}
            accessibilityRole="button"
            disabled={!running && !canSend}
            onPress={press}
            style={({ pressed }) => ({
              alignItems: 'center',
              height: COMPOSER_LINE_HEIGHT,
              justifyContent: 'center',
              opacity: !running && !canSend ? 0.35 : pressed ? 0.85 : 1,
              width: COMPOSER_BUTTON_SIZE
            })}
            testID={running ? 'composer-stop' : 'composer-send'}
          >
            <View
              style={{
                alignItems: 'center',
                backgroundColor: running ? theme.colors.danger : theme.colors.bubbleBlue,
                borderRadius: COMPOSER_BUTTON_SIZE / 2,
                height: COMPOSER_BUTTON_SIZE,
                justifyContent: 'center',
                width: COMPOSER_BUTTON_SIZE
              }}
              testID="composer-send-circle"
            >
              {running ? (
                <View style={{ backgroundColor: theme.colors.onAccent, borderRadius: 2, height: 11, width: 11 }} />
              ) : (
                <Text color="onAccent" style={{ fontSize: 17, fontWeight: '700', lineHeight: 20 }}>
                  {'↑'}
                </Text>
              )}
            </View>
          </Pressable>
        </View>

        {queuedText ? <QueuedChip testID="composer-queued" text={queuedText} /> : null}
      </View>
    </KeyboardAvoidingView>
  )
}
