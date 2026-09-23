/**
 * Who this device is signed in as, at the top of the Settings sidebar: a round
 * avatar, the name, and the gateway under it.
 *
 * ## It is a shortcut, not a home
 *
 * It opens the Account category, which is still a row in the list below. Nothing
 * moved: the same page answers "who am I signed in as" either way, and this is
 * the reference's own top row — the one thing a reader opening Settings looks at
 * before they look for anything.
 *
 * ## Two lines, two different facts
 *
 * The bold line is the person; the quiet one is the GATEWAY, because "signed in"
 * on this app is always signed in to somewhere, and a name with no host beside it
 * is half an answer on a device that knows more than one. Where there is no name
 * to show — a session token, a gateway whose provider reports nothing — the
 * provider takes the bold line and the round mark falls back to a person glyph
 * rather than inventing an initial out of a sentence.
 *
 * Read through `?.` for the reason `GatewayTitle` gives: Settings is rendered by
 * suites that stand in for the gateway context with the two or three fields they
 * care about, and a row at the top of the sidebar is not worth a crash in any of
 * them.
 */
import { Pressable, View } from 'react-native'

import { Avatar } from '../../../chat-ui'
import { useGateway } from '../../../gateway'
import { describeGatewayAddress } from '../../../gateway/gateway-stop'
import { strings } from '../../../i18n/strings'
import { Icon, ICON_SIZE } from '../../../ui/Icon'
import { Text } from '../../../ui/primitives'
import { useTheme } from '../../../ui/theme'
import { AVATAR_SIZE, CONTROL_MIN_HEIGHT } from '../../../ui/tokens'

export interface AccountRowProps {
  onPress: () => void
}

export function AccountRow({ onPress }: AccountRowProps) {
  const theme = useTheme()
  const { config } = useGateway()
  const summary = strings.settings.categories.summary
  const name =
    config?.userDisplayName ||
    (config?.authMode === 'session_token'
      ? strings.settings.authModeToken
      : config?.providerDisplayName || config?.provider || summary.signedOut)
  // Empty rather than `describeGatewayAddress`'s own "Unknown" where there is no
  // address at all: a device that has never been set up has no gateway to name,
  // and "Unknown" under a name reads as a fault rather than as an absence.
  const host = config?.baseUrl ? describeGatewayAddress(config.baseUrl).host : ''
  const size = AVATAR_SIZE.header

  return (
    <Pressable
      accessibilityLabel={name}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => ({
        borderRadius: theme.radii.card,
        cursor: 'pointer',
        marginHorizontal: theme.space.sm,
        opacity: pressed ? 0.7 : 1
      })}
      testID="settings-account-row"
    >
      <View
        style={{
          alignItems: 'center',
          flexDirection: 'row',
          gap: theme.space.md,
          minHeight: CONTROL_MIN_HEIGHT,
          paddingHorizontal: theme.space.md,
          paddingVertical: theme.space.sm
        }}
      >
        {config?.userDisplayName ? (
          <Avatar name={config.userDisplayName} size={size} />
        ) : (
          <View
            style={{
              alignItems: 'center',
              backgroundColor: theme.tintSunk,
              borderColor: theme.hairline,
              borderRadius: size / 2,
              borderWidth: 1,
              height: size,
              justifyContent: 'center',
              width: size
            }}
          >
            <Icon color={theme.colors.textMuted} name="person" size={ICON_SIZE.control} slot={size} />
          </View>
        )}

        <View style={{ flex: 1, gap: theme.space.xxs, minWidth: 0 }}>
          <Text numberOfLines={1} style={{ fontWeight: '600' }} testID="settings-account-name" variant="body">
            {name}
          </Text>
          <Text color="textMuted" numberOfLines={1} variant="meta">
            {host || summary.signedOut}
          </Text>
        </View>

        <Icon color={theme.colors.textMuted} name="chevronRight" size={ICON_SIZE.inline} />
      </View>
    </Pressable>
  )
}
