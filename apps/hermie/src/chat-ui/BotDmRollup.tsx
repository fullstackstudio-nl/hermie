/**
 * `5 messages to @writer · 4 replies` — the roll-up more than three consecutive
 * outgoing DMs collapse into (§6.6).
 *
 * It expands IN PLACE, which here means: the roll-up row stops rendering the
 * summary and the individual lines start rendering themselves. The rows are still
 * their own list items, so nothing is re-parented and the list does not have to
 * re-measure a block that grew from one line to eight — which is what keeps
 * expanding a run from yanking the viewport.
 *
 * Which rows belong to a run is `dm-rollup.ts`'s answer. This component only
 * paints the summary.
 */
import { Pressable, View } from 'react-native'

import { Text } from '../ui/primitives'
import { useTheme } from '../ui/theme'
import { TAP_SLOP } from '../ui/tokens'
import { useExpanded } from './expanded'
import { chatStrings } from './strings'
import type { DmRun } from './dm-rollup'

export interface BotDmRollupProps {
  run: DmRun
  testID?: string
}

export function BotDmRollup({ run, testID }: BotDmRollupProps) {
  const theme = useTheme()
  const [expanded, toggle] = useExpanded(`rollup:${run.id}`)

  // Expanded: the member lines draw themselves, so the summary gets out of the
  // way rather than sitting above a list of what it summarises.
  const label = expanded
    ? chatStrings.fold.less
    : run.handle
      ? chatStrings.botDm.rollup(run.items.length, run.handle, run.replies)
      : chatStrings.botDm.rollupMixed(run.items.length, run.replies)

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded }}
      hitSlop={TAP_SLOP}
      onPress={toggle}
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
      testID={testID ?? `bot-dm-rollup-${run.id}`}
    >
      <View style={{ alignItems: 'center', flexDirection: 'row', gap: theme.space.sm, minHeight: 24 }}>
        <Text color="textFaint" style={{ fontSize: 12, lineHeight: 16 }}>
          {'→'}
        </Text>

        <Text color="textMuted" variant="meta">
          {label}
        </Text>

        <Text color="textFaint" variant="meta">
          {expanded ? '⌄' : '›'}
        </Text>
      </View>
    </Pressable>
  )
}

/**
 * Is this run currently open?
 *
 * Exported so the list can decide whether a `rollupMember` row renders its line
 * or nothing at all. Reading the same key from the same store is what keeps the
 * two halves in step.
 */
export function useRollupExpanded(runId: string): boolean {
  const [expanded] = useExpanded(`rollup:${runId}`)

  return expanded
}
