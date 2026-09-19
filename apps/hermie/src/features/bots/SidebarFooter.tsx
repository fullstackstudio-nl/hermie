/**
 * The bottom of the chat list: a four-tab glass strip, and on the WIDE layout
 * the gateway card under it.
 *
 * The compose button the mockup does not have is deliberate — there is one
 * canonical chat per bot and you never create a conversation (ADR-0007), so the
 * place a compose button would take is occupied by the one thing you DO create
 * from this screen, a cron.
 *
 * The gateway card carries the GLOBAL connection state, which is not a bot
 * state: a bot's bead says whether that bot can be talked to, and this says
 * whether anything can. **It is the wide layout's only.** A phone has no room
 * to spend a permanent row on a green dot that says what the green dots beside
 * every bot already say, so on the compact layout the connection speaks only
 * when it needs something: `ConnectionLine` appears under the title while the
 * status is anything but ready, and the host, the state and the latency live in
 * Settings → Gateway, where they are looked up rather than glanced at.
 */
import { Pressable, View } from 'react-native'

import { hostOf, useGateway } from '../../gateway'
import { useReauth } from '../../gateway/SignedOutPanel'
import { strings } from '../../i18n/strings'
import { GlassSurface } from '../../ui/glass'
import { PresenceBead } from '../../ui/PresenceBead'
import { Text } from '../../ui/primitives'
import { useTheme } from '../../ui/theme'
import { BEAD_SIZE, TAP_SLOP } from '../../ui/tokens'

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
  gatewayCard = true,
  onOpenSection
}: {
  current?: TabKey
  /** The wide layout's sidebar shows it; a phone does not. */
  gatewayCard?: boolean
  onOpenSection: (section: BotsSection) => void
}) {
  return (
    <View>
      <TabStrip current={current} onOpenSection={onOpenSection} />
      {gatewayCard ? <GatewayCard onOpenSettings={() => onOpenSection('settings')} /> : null}
    </View>
  )
}

/**
 * The phone's connection state, shown only when it wants something.
 *
 * Connected is silent on purpose. A row that says "Connected" every second of
 * every day is a row nobody reads, and the presence bead on each row already
 * carries it — this line exists for the states a reader has to know about,
 * because a message that will not send is not obvious from a list that looks
 * exactly the same as it did a second ago.
 */
export function ConnectionLine() {
  const theme = useTheme()
  const { status } = useGateway()

  // `needs_signin` is not here: it takes the whole screen on a phone rather
  // than a line, because it is the one connection state a reader has to act on.
  if (status === 'ready' || status === 'needs_signin') {
    return null
  }

  return (
    <View
      style={{
        alignItems: 'center',
        backgroundColor: theme.tintSunk,
        borderColor: theme.hairlineSoft,
        borderRadius: theme.radii.pill,
        borderWidth: 1,
        flexDirection: 'row',
        gap: theme.space.sm,
        marginBottom: theme.space.md,
        marginHorizontal: theme.space.lg,
        paddingHorizontal: theme.space.md,
        paddingVertical: 6
      }}
      testID="connection-line"
    >
      <PresenceBead size={BEAD_SIZE.inline} state="offline" />
      <Text color="textMuted" variant="meta">
        {strings.connection.status[status as keyof typeof strings.connection.status] ?? status}
      </Text>
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

/**
 * Host, connection state, and a way into connection settings.
 *
 * When the connection is signed out this card says so in amber and IS the
 * action, because the sidebar stays usable in that state and it is the only
 * part of the shell a reader is looking at while the content column explains
 * itself.
 */
export function GatewayCard({ onOpenSettings }: { onOpenSettings: () => void }) {
  const theme = useTheme()
  const { config, status } = useGateway()
  const reauth = useReauth()
  const host = config ? hostOf(config.baseUrl) : strings.gateway.noHost

  const signedOut = status === 'needs_signin'
  const bead = signedOut ? 'needsInput' : status === 'ready' ? 'online' : 'offline'
  const label = signedOut
    ? strings.signedOut.title
    : (strings.connection.status[status as keyof typeof strings.connection.status] ?? status)

  // Signed out, this card IS the action. The sidebar stays usable in that state
  // and it is the half of the shell a reader is looking at while the content
  // column explains itself, so the amber state has to be reachable from here.
  const act = signedOut ? reauth.signIn : onOpenSettings

  return (
    <GlassSurface
      contentStyle={{
        alignItems: 'center',
        flexDirection: 'row',
        gap: theme.space.md,
        padding: theme.space.md
      }}
      style={{ marginBottom: theme.space.md, marginHorizontal: theme.space.md }}
      variant="chip"
      radius={theme.radii.card}
    >
      <View
        style={{
          alignItems: 'center',
          backgroundColor: theme.accent().soft,
          borderRadius: 10,
          height: 34,
          justifyContent: 'center',
          width: 34
        }}
      >
        <Text style={{ color: theme.colors.accentText, fontSize: 17 }}>{'◍'}</Text>
      </View>

      <Pressable
        accessibilityLabel={`${host}, ${label}`}
        accessibilityRole="button"
        onPress={act}
        style={{ flex: 1, minWidth: 0 }}
        testID="gateway-card"
      >
        <Text numberOfLines={1} style={{ fontSize: 14, fontWeight: '600', lineHeight: 18 }}>
          {host}
        </Text>
        <View style={{ alignItems: 'center', flexDirection: 'row', gap: 5, marginTop: 1 }}>
          <PresenceBead size={BEAD_SIZE.inline} state={bead} testID="gateway-bead" />
          <Text color={signedOut ? 'warnText' : 'textMuted'} testID="gateway-state" variant="meta">
            {label}
          </Text>
        </View>
      </Pressable>

      <Pressable
        accessibilityLabel={signedOut ? strings.signedOut.signIn : strings.gateway.connectionSettings}
        accessibilityRole="button"
        hitSlop={TAP_SLOP}
        onPress={act}
        testID="gateway-settings"
      >
        <Text color="textMuted" style={{ fontSize: 17 }}>
          {'⋯'}
        </Text>
      </Pressable>

      {reauth.webView}
    </GlassSurface>
  )
}
