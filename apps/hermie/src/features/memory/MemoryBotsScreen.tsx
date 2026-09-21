/**
 * Settings → Memory: which bot's memory do you want to read?
 *
 * The page is a list and then one bot's page, in the shape `CronScreen` uses —
 * a discriminated view held in state with an early return — rather than a
 * navigator, because the compact and regular shells own their own navigation
 * and disagree about what "push" means. A feature carrying its own two-deep
 * stack works identically in both.
 *
 * A bot is listed by the name this reader has chosen to see and is OPENED by
 * its profile name, which is the only thing the plugin's `profile` parameter
 * will accept. Those are routinely different in case alone, which is exactly
 * the difference nobody notices until a route answers 400.
 */
import { useState } from 'react'
import { ScrollView } from 'react-native'

import { strings } from '../../i18n/strings'
import { botNames, useNameOrder } from '../../store/bot-names'
import { useBotsStore } from '../../store/bots'
import { InsetButtonRow, InsetGroup, Screen, Text } from '../../ui/primitives'
import { useEscapeKey } from '../../ui/useEscapeKey'
import { useHardwareBack } from '../../ui/useHardwareBack'
import { useTheme } from '../../ui/theme'
import { MemoryScreen } from './MemoryScreen'
import { MemoryScreenHeader } from './MemoryScreenHeader'
import { memoryStrings } from './strings'

export interface MemoryBotsScreenProps {
  onClose: () => void
  /** Open straight onto one bot — the profile sheet's row does this. */
  initialProfile?: string
  testID?: string
}

export function MemoryBotsScreen({ onClose, initialProfile, testID = 'memory-bots' }: MemoryBotsScreenProps) {
  const theme = useTheme()
  const bots = useBotsStore(state => state.bots)
  const order = useNameOrder()
  const [open, setOpen] = useState<string | null>(initialProfile ?? null)

  /*
    Mounted-order scoped, and only while the list is showing: the bot's own page
    installs the same two hooks, and both firing on one Escape would close the
    page and this list in a single keystroke.
  */
  useEscapeKey(onClose, open === null)
  useHardwareBack(onClose, open === null)

  if (open) {
    const bot = bots.find(row => row.name === open)

    return (
      <MemoryScreen
        onClose={() => (initialProfile ? onClose() : setOpen(null))}
        profile={open}
        {...(bot ? { title: botNames(bot, order).primary } : {})}
      />
    )
  }

  return (
    <Screen padded={false}>
      <MemoryScreenHeader
        back={strings.common.back}
        onBack={onClose}
        subtitle={memoryStrings.botsHint}
        title={memoryStrings.botsTitle}
        testID={`${testID}-header`}
      />

      <ScrollView contentContainerStyle={{ gap: theme.space.lg, padding: theme.space.lg }}>
        {bots.length === 0 ? (
          <Text color="textMuted" testID={`${testID}-empty`} variant="meta">
            {memoryStrings.botsEmpty}
          </Text>
        ) : (
          <InsetGroup>
            {bots.map(bot => {
              const names = botNames(bot, order)

              return (
                <InsetButtonRow
                  detail={names.secondary}
                  key={bot.name}
                  onPress={() => setOpen(bot.name)}
                  testID={`${testID}-row-${bot.name}`}
                  title={names.primary}
                />
              )
            })}
          </InsetGroup>
        )}
      </ScrollView>
    </Screen>
  )
}
