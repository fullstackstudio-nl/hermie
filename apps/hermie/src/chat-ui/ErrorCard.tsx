/**
 * A failed turn.
 *
 * Two different failures wear different clothes, and conflating them is the
 * bug this card exists to avoid:
 *   - `retryable` means the turn is gone and resubmitting is the user's call.
 *   - `recoverable` means the backend still holds the turn and a resume will
 *     replay it, so the card says "Reconnecting…" and offers no button —
 *     pressing Retry there would duplicate the turn.
 */
import { View } from 'react-native'

import { Button, Text } from '../ui/primitives'
import { useTheme } from '../ui/theme'
import { chatStrings } from './strings'

export interface ErrorCardProps {
  message: string
  retryable?: boolean
  recoverable?: boolean
  onRetry?: () => void
  testID?: string
}

export function ErrorCard({ message, retryable = false, recoverable = false, onRetry, testID }: ErrorCardProps) {
  const theme = useTheme()

  return (
    <View
      accessibilityRole="alert"
      style={{
        backgroundColor: theme.colors.surface,
        borderColor: theme.colors.danger,
        borderRadius: theme.radii.xl,
        borderWidth: 1,
        gap: theme.space.sm,
        marginVertical: theme.space.sm,
        padding: theme.space.md
      }}
      testID={testID}
    >
      <Text color="danger" variant="heading">
        {chatStrings.assistant.errorTitle}
      </Text>
      <Text color="text" selectable style={{ fontSize: 15, lineHeight: 21 }}>
        {message}
      </Text>

      {recoverable ? (
        <Text color="textMuted" variant="caption">
          {chatStrings.assistant.reconnecting}
        </Text>
      ) : null}

      {retryable && !recoverable && onRetry ? (
        <Button onPress={onRetry} testID={`${testID ?? 'error-card'}-retry`} title={chatStrings.assistant.retry} />
      ) : null}
    </View>
  )
}
