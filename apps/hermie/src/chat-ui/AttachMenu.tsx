/**
 * The `+` menu: _Photo library_, _Choose file_.
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
 */
import { Pressable, View } from 'react-native'

import { GlassSurface } from '../ui/glass'
import { Text } from '../ui/primitives'
import { useTheme } from '../ui/theme'
import { CONTROL_MIN_HEIGHT } from '../ui/tokens'
import type { AttachChoice } from './types'

export interface AttachMenuProps {
  choices: readonly AttachChoice[]
  onChoose: (id: AttachChoice['id']) => void
  testID?: string
}

export function AttachMenu({ choices, onChoose, testID = 'composer-attach-menu' }: AttachMenuProps) {
  const theme = useTheme()

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

          {choice.busy ? (
            // A still, hollow mark rather than a spinner: §5 reserves motion, and
            // the one thing this state has to communicate is "the tap landed".
            <View
              style={{ borderColor: theme.colors.textFaint, borderRadius: 7, borderWidth: 2, height: 14, width: 14 }}
              testID={`${testID}-${choice.id}-busy`}
            />
          ) : null}
        </Pressable>
      ))}
    </GlassSurface>
  )
}
