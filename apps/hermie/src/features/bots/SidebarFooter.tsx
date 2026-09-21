/**
 * The bottom of the chat list: a four-tab glass strip, and nothing else, on
 * every layout.
 *
 * The compose button the mockup does not have is deliberate — there is one
 * canonical chat per bot and you never create a conversation (ADR-0007), so the
 * place a compose button would take is occupied by the one thing you DO create
 * from this screen, a cron.
 *
 * A gateway card used to sit under the strip on the wide layout, carrying the
 * host and the connection state. It is gone: the state it showed is the global
 * connection, which now speaks from ONE component on every layout
 * (`ConnectionLine`, under the title) and says nothing at all while the
 * connection is healthy. The host belongs in Settings → Gateway, where it is
 * looked up rather than glanced at.
 */
import { Pressable, View } from 'react-native'

import { strings } from '../../i18n/strings'
import { Icon, ICON_SIZE, type IconName } from '../../ui/Icon'
import { Text } from '../../ui/primitives'
import { useTheme } from '../../ui/theme'

export type BotsSection = 'activity' | 'cron' | 'settings'

/** `chats` is where the strip already is; the other three open a destination. */
export type TabKey = 'chats' | BotsSection

/**
 * Four drawn icons at one size, which four Unicode glyphs could not be.
 *
 * The strip used to carry a filled circle, a pair of exchange arrows, a clock and
 * a gear as CHARACTERS, and the owner reported the obvious consequence: chats and
 * crons drew visibly smaller than activity and settings. Nothing was wrong with
 * the `fontSize` — the four characters come from four different fonts that
 * disagree about how much of the em box a mark should fill, and no font metric
 * reconciles that. There was a second cost in the same place: one of them needed
 * a trailing U+FE0E to stop iOS drawing it as a colourful emoji sticker in the
 * middle of a monochrome strip. `src/ui/Icon.tsx` carries the full reasoning.
 *
 * Exported so a test can walk the same four entries the strip renders, rather
 * than repeating the list and then agreeing with itself.
 */
export const TABS: { key: TabKey; label: string; icon: IconName }[] = [
  { key: 'chats', label: strings.tabs.chats, icon: 'chats' },
  { key: 'activity', label: strings.tabs.activity, icon: 'activity' },
  { key: 'cron', label: strings.tabs.routines, icon: 'crons' },
  { key: 'settings', label: strings.tabs.settings, icon: 'settings' }
]

export function SidebarFooter({
  current = 'chats',
  onOpenSection
}: {
  current?: TabKey
  onOpenSection: (section: BotsSection) => void
}) {
  return (
    <View>
      <TabStrip current={current} onOpenSection={onOpenSection} />
    </View>
  )
}

function TabStrip({ current, onOpenSection }: { current: TabKey; onOpenSection: (section: BotsSection) => void }) {
  const theme = useTheme()

  return (
    <View
      // A sunk track with a raised slot for the current tab. Level 3: a tint and
      // a hairline, never a blur of its own.
      style={{
        backgroundColor: theme.tintSunk,
        borderColor: theme.hairlineSoft,
        borderRadius: theme.radii.inset,
        borderWidth: 1,
        flexDirection: 'row',
        marginHorizontal: theme.space.md,
        marginVertical: theme.space.sm,
        padding: 3
      }}
    >
      {TABS.map(tab => {
        const selected = tab.key === current

        return (
          <Pressable
            // Named explicitly, although the label is right there under the mark.
            // Name-from-content is allowed for `tab` and Chrome does compute it,
            // and a second reader on the same page returned four tabs with no
            // name at all. The label is the visible text, character for
            // character, so the two can never drift apart.
            accessibilityLabel={tab.label}
            accessibilityRole="tab"
            aria-selected={selected}
            key={tab.key}
            onPress={() => (tab.key === 'chats' ? undefined : onOpenSection(tab.key))}
            style={{
              alignItems: 'center',
              backgroundColor: selected ? theme.elevation.e3 : 'transparent',
              borderRadius: 9,
              flex: 1,
              gap: 2,
              paddingHorizontal: 2,
              paddingVertical: 6
            }}
            testID={`tab-${tab.key}`}
          >
            {/*
              One drawn size for all four marks, and one SLOT around each of them
              so the labels sit on one line whatever the mark's own weight wants.
              The icon is decorative and `Icon` hides itself from the tree — with
              `aria-hidden` as well as the two native props, which is what makes
              that true in a browser — so the tab is not announced twice.
            */}
            <Icon
              color={selected ? theme.colors.text : theme.colors.textMuted}
              name={tab.icon}
              size={ICON_SIZE.tab}
              slot={ICON_SIZE.tabSlot}
              testID={`tab-icon-${tab.key}`}
            />
            <Text color={selected ? 'text' : 'textMuted'} numberOfLines={1} variant="micro">
              {tab.label}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}
