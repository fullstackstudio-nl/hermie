/**
 * The row context menu: archive, colour, and where the row sits.
 *
 * It opens on a long press, which is the only secondary gesture React Native
 * offers on every platform Hermie ships — `Pressable` has no secondary-click
 * event, so a right click on a Mac or an iPad trackpad does not reach the app at
 * all. A press and hold does, with a mouse as well as a finger.
 *
 * It is a `BottomSheet` rather than a floating popover on purpose: the sheet
 * already owns the Escape stack, the backdrop and the "one modal at a time"
 * rule, and a second presentation mechanism would be a second set of those
 * problems. Every action is an explicit button — nothing in here is answered by
 * a swipe (ADR-0010).
 */
import { View } from 'react-native'

import { strings } from '../../i18n/strings'
import { BottomSheet } from '../../ui/BottomSheet'
import { Text } from '../../ui/primitives'
import { useTheme } from '../../ui/theme'
import { ACCENT_ORDER, ACCENTS, CONTROL_MIN_HEIGHT, type AccentName } from '../../ui/tokens'
import { Row } from './menu-row'

export type RowMenuProps = {
  visible: boolean
  botName: string
  displayName: string
  accent: AccentName
  archived: boolean
  sections: { id: string | null; name: string }[]
  onClose: () => void
  onSetAccent: (accent: AccentName) => void
  onSetArchived: (archived: boolean) => void
  onMoveToSection: (dividerId: string | null) => void
}

export function RowMenu({
  accent,
  archived,
  botName,
  displayName,
  onClose,
  onMoveToSection,
  onSetAccent,
  onSetArchived,
  sections,
  visible
}: RowMenuProps) {
  const theme = useTheme()

  return (
    <BottomSheet
      accessibilityLabel={strings.layout.rowActions(displayName)}
      onRequestClose={onClose}
      testID="row-menu"
      visible={visible}
    >
      <View style={{ gap: theme.space.md }}>
        <Text variant="sheetTitle">{displayName}</Text>

        <View>
          <Text color="textFaint" style={{ marginBottom: theme.space.xs }} variant="micro">
            {strings.layout.colour.toUpperCase()}
          </Text>
          <Swatches accent={accent} botName={botName} onSelect={onSetAccent} />
        </View>

        <View style={{ gap: theme.space.xs }}>
          <Row
            onPress={() => {
              onSetArchived(!archived)
              onClose()
            }}
            testID="row-menu-archive"
            title={archived ? strings.layout.unarchive : strings.layout.archive}
          />

          {sections.map(section => (
            <Row
              key={section.id ?? 'top'}
              onPress={() => {
                onMoveToSection(section.id)
                onClose()
              }}
              testID={`row-menu-section-${section.id ?? 'top'}`}
              title={strings.layout.moveToSection(section.name || strings.layout.newDividerName)}
            />
          ))}
        </View>
      </View>
    </BottomSheet>
  )
}

/**
 * Eight curated colours and Default.
 *
 * Default is drawn as a ring rather than as a ninth colour, because it is the
 * absence of a choice: nothing is stored for it, and a chat that never had a
 * colour and a chat that was set back to Default are the same chat.
 */
function Swatches({
  accent,
  botName,
  onSelect
}: {
  accent: AccentName
  botName: string
  onSelect: (accent: AccentName) => void
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
            testID={`swatch-${botName}-${name}`}
          >
            {''}
          </Text>
        )
      })}
    </View>
  )
}
