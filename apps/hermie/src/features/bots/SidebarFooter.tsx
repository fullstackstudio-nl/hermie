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
import { Text } from '../../ui/primitives'
import { useTheme } from '../../ui/theme'

export type BotsSection = 'activity' | 'cron' | 'settings'

/** `chats` is where the strip already is; the other three open a destination. */
export type TabKey = 'chats' | BotsSection

/**
 * The trailing U+FE0E is load-bearing on the gear.
 *
 * iOS gives several of these characters their EMOJI presentation by default, so
 * `⚙` comes out as a colourful sticker in the middle of a monochrome tab strip.
 * The text variation selector is what asks for the glyph instead — the same
 * thing the Activity timeline needs for its return arrow.
 */
const TABS: { key: TabKey; label: string; glyph: string }[] = [
  { key: 'chats', label: strings.tabs.chats, glyph: '◉' },
  { key: 'activity', label: strings.tabs.activity, glyph: '\u21c4' },
  { key: 'cron', label: strings.tabs.routines, glyph: '\u25f7' },
  { key: 'settings', label: strings.tabs.settings, glyph: '\u2699\ufe0e' }
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
            accessibilityRole="tab"
            accessibilityState={{ selected }}
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
            <Text
              color={selected ? 'text' : 'textMuted'}
              style={{ fontSize: 17, lineHeight: 20 }}
              // The glyph repeats the label, so a screen reader would read every
              // tab twice.
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
            >
              {tab.glyph}
            </Text>
            <Text color={selected ? 'text' : 'textMuted'} numberOfLines={1} variant="micro">
              {tab.label}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}
