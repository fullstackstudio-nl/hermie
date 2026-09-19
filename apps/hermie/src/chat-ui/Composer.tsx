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
import { Image, KeyboardAvoidingView, Platform, Pressable, ScrollView, TextInput, View } from 'react-native'

import { Text } from '../ui/primitives'
import { useTheme } from '../ui/theme'
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
  testID?: string
}

const SEND_SIZE = 38

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

  const submit = () => {
    if (running) {
      onStop?.()

      return
    }

    if (!canSend) {
      return
    }

    onSend(value)
  }

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
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
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
                onPress={() => onRemoveAttachment?.(attachment.id)}
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
            alignItems: 'flex-end',
            borderColor: theme.colors.textMuted,
            borderRadius: theme.radii.sheet,
            borderWidth: 1,
            flexDirection: 'row',
            gap: theme.space.xs,
            padding: 3
          }}
        >
          <Pressable
            accessibilityLabel={chatStrings.composer.attach}
            accessibilityRole="button"
            disabled={!onAttach}
            onPress={onAttach}
            style={({ pressed }) => ({
              alignItems: 'center',
              height: 40,
              justifyContent: 'center',
              opacity: onAttach ? (pressed ? 0.6 : 1) : 0.3,
              width: SEND_SIZE
            })}
            testID="composer-attach"
          >
            <Text color="textMuted" style={{ fontSize: 26, lineHeight: 30 }}>
              +
            </Text>
          </Pressable>

          <TextInput
            accessibilityLabel={botName ? `Message ${botName}` : chatStrings.composer.placeholder}
            multiline
            onChangeText={onChangeText}
            placeholder={placeholder ?? chatStrings.composer.placeholder}
            placeholderTextColor={theme.colors.textMuted}
            ref={inputRef}
            style={{
              color: theme.colors.text,
              flex: 1,
              fontSize: 17,
              maxHeight: 132,
              minHeight: 40,
              paddingHorizontal: theme.space.xs,
              paddingTop: Platform.OS === 'ios' ? 10 : 6,
              paddingBottom: Platform.OS === 'ios' ? 10 : 6
            }}
            testID="composer-input"
            value={value}
          />

          <Pressable
            accessibilityLabel={running ? chatStrings.composer.stop : chatStrings.composer.send}
            accessibilityRole="button"
            disabled={!running && !canSend}
            onPress={submit}
            style={({ pressed }) => ({
              alignItems: 'center',
              backgroundColor: running ? theme.colors.danger : theme.colors.bubbleBlue,
              borderRadius: SEND_SIZE / 2,
              height: SEND_SIZE,
              justifyContent: 'center',
              opacity: !running && !canSend ? 0.35 : pressed ? 0.85 : 1,
              width: SEND_SIZE
            })}
            testID={running ? 'composer-stop' : 'composer-send'}
          >
            {running ? (
              <View style={{ backgroundColor: theme.colors.onAccent, borderRadius: 2, height: 12, width: 12 }} />
            ) : (
              <Text color="onAccent" style={{ fontSize: 18, fontWeight: '700', lineHeight: 22 }}>
                {'↑'}
              </Text>
            )}
          </Pressable>
        </View>

        {queuedText ? <QueuedChip testID="composer-queued" text={queuedText} /> : null}
      </View>
    </KeyboardAvoidingView>
  )
}
