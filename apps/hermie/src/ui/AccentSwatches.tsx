/**
 * The per-chat colour, as nine swatches.
 *
 * Shared by the row's long-press menu and by the chat options sheet, because a
 * colour picked in one place has to be the same picker as the colour picked in
 * the other — two implementations of nine circles is two chances for the
 * selected ring to drift.
 *
 * Default is drawn as an OUTLINE rather than as a blue circle. A chat on the
 * default colour has no colour of its own, and painting the app's accent into
 * the swatch would say it does; the list's avatar ring makes the same
 * distinction, and the two have to agree.
 */
import { View } from 'react-native'

import { strings } from '../i18n/strings'
import { Text } from './primitives'
import { useTheme } from './theme'
import { ACCENT_ORDER, ACCENTS, CONTROL_MIN_HEIGHT, type AccentName } from './tokens'

export function AccentSwatches({
  accent,
  onSelect,
  testIDPrefix
}: {
  accent: AccentName
  onSelect: (accent: AccentName) => void
  /** `swatch-<prefix>-<name>`; the bot's name where there is one. */
  testIDPrefix: string
}) {
  const theme = useTheme()

  // Wrapped rather than scrolled: nine swatches that scroll hide the last two
  // behind a gesture nobody knows is there, and a colour you cannot see is a
  // colour you will not pick.
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.sm, paddingVertical: theme.space.xs }}>
      {ACCENT_ORDER.map(name => {
        const selected = name === accent

        return (
          <Text
            accessibilityLabel={strings.layout.accents[name]}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            key={name}
            onPress={() => onSelect(name)}
            style={{
              backgroundColor: name === 'default' ? 'transparent' : ACCENTS[name].fill,
              borderColor: selected ? theme.colors.text : theme.hairline,
              borderRadius: CONTROL_MIN_HEIGHT / 2,
              borderWidth: name === 'default' ? 2 : selected ? 3 : 1,
              height: CONTROL_MIN_HEIGHT,
              width: CONTROL_MIN_HEIGHT
            }}
            testID={`swatch-${testIDPrefix}-${name}`}
          >
            {''}
          </Text>
        )
      })}
    </View>
  )
}
