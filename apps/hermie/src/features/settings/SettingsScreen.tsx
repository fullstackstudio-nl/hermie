import type { Verbosity } from '@hermie/transcript'
import { useState } from 'react'
import { ScrollView, View } from 'react-native'

import { chatStrings } from '../../chat-ui'
import { useGateway } from '../../gateway'
import { strings } from '../../i18n/strings'
import { type Appearance, useSettingsStore } from '../../store/settings'
import { InsetButtonRow, InsetGroup, InsetValueRow, Screen, Text } from '../../ui/primitives'
import { SegmentedRow, SwitchRow } from '../../ui/sheets'
import { useTheme } from '../../ui/theme'
import { FORM_MAX_WIDTH } from '../../ui/tokens'
import { DebugConnectionScreen } from './DebugConnectionScreen'
import { GALLERY_ROW_TITLE, GalleryScreen } from './GalleryScreen'

const VERBOSITY_OPTIONS: { value: Verbosity; label: string }[] = [
  { value: 'quiet', label: chatStrings.options.verbosityOptions.quiet },
  { value: 'normal', label: chatStrings.options.verbosityOptions.normal },
  { value: 'verbose', label: chatStrings.options.verbosityOptions.verbose }
]

const APPEARANCE_OPTIONS: { value: Appearance; label: string }[] = [
  { value: 'system', label: strings.settings.themeOptions.system },
  { value: 'light', label: strings.settings.themeOptions.light },
  { value: 'dark', label: strings.settings.themeOptions.dark }
]

export function SettingsScreen() {
  const theme = useTheme()
  const { config, status, signOut, changeGateway } = useGateway()
  const defaults = useSettingsStore(state => state.defaults)
  const appearance = useSettingsStore(state => state.appearance)
  const setDefaults = useSettingsStore(state => state.setDefaults)
  const setAppearance = useSettingsStore(state => state.setAppearance)
  const [showConnectionTest, setShowConnectionTest] = useState(false)
  const [showGallery, setShowGallery] = useState(false)
  const [confirmingChange, setConfirmingChange] = useState(false)

  if (showConnectionTest) {
    return <DebugConnectionScreen onClose={() => setShowConnectionTest(false)} />
  }

  if (showGallery) {
    return <GalleryScreen onClose={() => setShowGallery(false)} />
  }

  const token = config?.authMode === 'session_token'

  return (
    <Screen padded={false}>
      <ScrollView
        contentContainerStyle={{
          padding: theme.space.lg,
          gap: theme.space.xl,
          width: '100%',
          maxWidth: FORM_MAX_WIDTH,
          alignSelf: 'center'
        }}
      >
        <Text variant="display">{strings.settings.title}</Text>

        <InsetGroup header={strings.settings.gateway}>
          <InsetValueRow label={strings.settings.address} value={config?.baseUrl ?? strings.settings.unknown} />
          <InsetValueRow
            label={strings.settings.provider}
            value={
              token
                ? strings.settings.authModeToken
                : (config?.providerDisplayName ?? config?.provider ?? strings.settings.unknown)
            }
          />
          <InsetValueRow label={strings.settings.version} value={config?.version || strings.settings.unknown} />
          {config?.userDisplayName ? (
            <InsetValueRow label={strings.settings.user} value={config.userDisplayName} />
          ) : null}
          <InsetValueRow label={strings.settings.status} value={strings.connection.status[status]} />
        </InsetGroup>

        <InsetGroup header={strings.settings.account}>
          <InsetButtonRow
            title={strings.settings.signOut}
            detail={strings.settings.signOutHint}
            onPress={() => void signOut()}
          />
          {confirmingChange ? (
            <InsetButtonRow
              title={strings.settings.confirm}
              tone="danger"
              detail={strings.settings.changeGatewayConfirm}
              onPress={() => void changeGateway()}
            />
          ) : null}
          {confirmingChange ? (
            <InsetButtonRow title={strings.settings.keepIt} tone="text" onPress={() => setConfirmingChange(false)} />
          ) : (
            <InsetButtonRow
              title={strings.settings.changeGateway}
              tone="danger"
              detail={strings.settings.changeGatewayHint}
              onPress={() => setConfirmingChange(true)}
            />
          )}
        </InsetGroup>

        <InsetGroup header={strings.settings.chat} footer={strings.settings.defaultVerbosityHint}>
          <SegmentedRow
            label={strings.settings.defaultVerbosity}
            onChange={(level: Verbosity) => setDefaults({ level })}
            options={VERBOSITY_OPTIONS}
            testID="settings-verbosity"
            value={defaults.level}
          />
          <SwitchRow
            label={strings.settings.showBotToBot}
            onChange={showBotToBot => setDefaults({ showBotToBot })}
            testID="settings-bot-to-bot"
            value={defaults.showBotToBot}
          />
          <SwitchRow
            label={strings.settings.showThinking}
            onChange={showThinking => setDefaults({ showThinking })}
            testID="settings-thinking"
            value={defaults.showThinking}
          />
        </InsetGroup>

        <InsetGroup header={strings.settings.appearance}>
          <SegmentedRow
            label={strings.settings.theme}
            onChange={(value: Appearance) => setAppearance(value)}
            options={APPEARANCE_OPTIONS}
            testID="settings-appearance"
            value={appearance}
          />
        </InsetGroup>

        <InsetGroup header={strings.settings.developer}>
          <InsetButtonRow title={strings.settings.connectionTest} onPress={() => setShowConnectionTest(true)} />
          <InsetButtonRow title={GALLERY_ROW_TITLE} onPress={() => setShowGallery(true)} />
        </InsetGroup>

        <View style={{ height: theme.space.xxl }} />
      </ScrollView>
    </Screen>
  )
}
