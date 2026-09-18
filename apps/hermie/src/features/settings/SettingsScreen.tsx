import { useState } from 'react'
import { ScrollView, View } from 'react-native'

import { useGateway } from '../../gateway'
import { strings } from '../../i18n/strings'
import { InsetButtonRow, InsetGroup, InsetValueRow, Screen, Text } from '../../ui/primitives'
import { useTheme } from '../../ui/theme'
import { FORM_MAX_WIDTH } from '../../ui/tokens'
import { DebugConnectionScreen } from './DebugConnectionScreen'

export function SettingsScreen() {
  const theme = useTheme()
  const { config, status, signOut, changeGateway } = useGateway()
  const [showConnectionTest, setShowConnectionTest] = useState(false)
  const [confirmingChange, setConfirmingChange] = useState(false)

  if (showConnectionTest) {
    return <DebugConnectionScreen onClose={() => setShowConnectionTest(false)} />
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

        <InsetGroup header={strings.settings.developer}>
          <InsetButtonRow title={strings.settings.connectionTest} onPress={() => setShowConnectionTest(true)} />
        </InsetGroup>

        <View style={{ height: theme.space.xxl }} />
      </ScrollView>
    </Screen>
  )
}
