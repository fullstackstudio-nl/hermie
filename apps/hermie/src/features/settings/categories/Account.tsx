/**
 * Settings → Account: who this device is signed in as, and the three ways of
 * leaving — sign out, change gateway, forget it.
 */
import { useState } from 'react'

import { useGateway } from '../../../gateway'
import { WEB_GATEWAY_BASE_URL } from '../../../gateway/web-config'
import { strings } from '../../../i18n/strings'
import { InsetButtonRow, InsetGroup, InsetValueRow } from '../../../ui/primitives'
import { SettingsPage } from '../navigation/SettingsPage'

export function useSummary(): string {
  const { config } = useGateway()

  return (
    config?.userDisplayName ||
    (config?.authMode === 'session_token'
      ? strings.settings.authModeToken
      : (config?.providerDisplayName ?? config?.provider ?? strings.settings.categories.summary.signedOut))
  )
}

export function Page() {
  const { config, signOut, changeGateway, forgetGateway } = useGateway()
  const [confirmingForget, setConfirmingForget] = useState(false)

  return (
    <SettingsPage route="Account">
      {config?.userDisplayName ? (
        <InsetGroup>
          <InsetValueRow label={strings.settings.user} value={config.userDisplayName} />
        </InsetGroup>
      ) : null}

      <InsetGroup>
        <InsetButtonRow
          detail={strings.settings.signOutHint}
          onPress={() => void signOut()}
          testID="settings-sign-out"
          title={strings.settings.signOut}
        />
        {/*
          Two rows where there was one, because they were one thing with two
          meanings. Changing gateway is the ordinary, reversible act — setup
          reopens on the address step with this address in it and nothing is
          dropped until a different one is saved — and forgetting is the
          destructive one that still asks.

          In a browser neither applies: Hermie Web fixes the gateway, and the
          wizard there has no address step to open.
        */}
        {WEB_GATEWAY_BASE_URL ? null : (
          <InsetButtonRow
            detail={strings.settings.changeGatewayHint}
            onPress={() => void changeGateway()}
            testID="settings-change-gateway"
            title={strings.settings.changeGateway}
          />
        )}
        {confirmingForget ? (
          <InsetButtonRow
            detail={strings.settings.changeGatewayConfirm}
            onPress={() => void forgetGateway()}
            testID="settings-forget-confirm"
            title={strings.settings.confirm}
            tone="danger"
          />
        ) : null}
        {confirmingForget ? (
          <InsetButtonRow onPress={() => setConfirmingForget(false)} title={strings.settings.keepIt} tone="text" />
        ) : (
          <InsetButtonRow
            detail={strings.settings.forgetGatewayHint}
            onPress={() => setConfirmingForget(true)}
            testID="settings-forget-gateway"
            title={strings.settings.forgetGateway}
            tone="danger"
          />
        )}
      </InsetGroup>
    </SettingsPage>
  )
}
