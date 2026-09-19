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
import { AccentSwatches } from '../../ui/AccentSwatches'
import { type AccentName } from '../../ui/tokens'
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
          <AccentSwatches accent={accent} onSelect={onSetAccent} testIDPrefix={botName} />
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
