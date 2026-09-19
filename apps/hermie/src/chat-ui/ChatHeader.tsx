/**
 * The chat's title bar: avatar, name, a status subtitle, and the options
 * button on the right.
 */
import { Pressable, View } from 'react-native'

import { Text } from '../ui/primitives'
import { useTheme } from '../ui/theme'
import { Avatar } from './primitives/Avatar'
import { chatStrings } from './strings'

export interface ChatHeaderProps {
  name: string
  handle?: string
  /** The profile's picture, when the roster has loaded one. */
  avatarUri?: string
  /** Overrides the derived Running/Idle line. */
  subtitle?: string
  running?: boolean
  needsInput?: boolean
  onBack?: () => void
  onOpenOptions: () => void
  testID?: string
}

export function ChatHeader({
  name,
  handle,
  avatarUri,
  subtitle,
  running = false,
  needsInput = false,
  onBack,
  onOpenOptions,
  testID = 'chat-header'
}: ChatHeaderProps) {
  const theme = useTheme()

  const state = needsInput
    ? chatStrings.header.needsInput
    : running
      ? chatStrings.header.running
      : chatStrings.header.idle

  const line = subtitle ?? (handle ? `@${handle} · ${state}` : state)

  return (
    <View
      style={{
        alignItems: 'center',
        backgroundColor: theme.colors.surface,
        borderBottomColor: theme.colors.border,
        borderBottomWidth: 1,
        flexDirection: 'row',
        gap: theme.space.sm,
        minHeight: 64,
        paddingHorizontal: theme.space.md,
        paddingVertical: theme.space.sm
      }}
      testID={testID}
    >
      {onBack ? (
        <Pressable
          accessibilityLabel={chatStrings.header.back}
          accessibilityRole="button"
          onPress={onBack}
          style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1, paddingHorizontal: theme.space.xs })}
          testID="chat-header-back"
        >
          <Text color="accent" style={{ fontSize: 24, lineHeight: 28 }}>
            {'‹'}
          </Text>
        </Pressable>
      ) : null}

      <Avatar name={name} size={40} uri={avatarUri} />

      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 17, fontWeight: '600' }}>{name}</Text>
        <Text color={needsInput ? 'danger' : running ? 'success' : 'textMuted'} style={{ fontSize: 12 }}>
          {line}
        </Text>
      </View>

      <Pressable
        accessibilityLabel={chatStrings.header.options}
        accessibilityRole="button"
        onPress={onOpenOptions}
        style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1, paddingHorizontal: theme.space.sm })}
        testID="chat-header-options"
      >
        <Text color="accent" style={{ fontSize: 18, letterSpacing: 1 }}>
          {'•••'}
        </Text>
      </Pressable>
    </View>
  )
}
