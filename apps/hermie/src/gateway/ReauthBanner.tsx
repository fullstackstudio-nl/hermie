import type { TokenSet } from '@hermie/gateway-client'
import { useState } from 'react'
import { Pressable, View } from 'react-native'

import { NativeSignInWebView } from '../features/onboarding/NativeSignInWebView'
import { strings } from '../i18n/strings'
import { Text } from '../ui/primitives'
import { useTheme } from '../ui/theme'
import { useGateway } from './GatewayProvider'

/**
 * A refresh token can expire while the app is simply sitting there, and the
 * connection lands in `needs_signin` with nothing else wrong. Sending the user
 * back through the whole wizard for that would be rude, so the banner signs in
 * where they are: the same web view, the same interception, and on success the
 * tokens go to the coordinator and the dial loop picks up where it stopped.
 */
export function ReauthBanner() {
  const theme = useTheme()
  const { status, config, extraHeaders, adoptTokens, signOut } = useGateway()
  const [signingIn, setSigningIn] = useState(false)
  const [busy, setBusy] = useState(false)

  if (status !== 'needs_signin' || !config) {
    return null
  }

  const native = config.authMode === 'native_pkce'

  const onSuccess = (tokens: TokenSet) => {
    setSigningIn(false)
    setBusy(true)
    void adoptTokens(tokens).finally(() => setBusy(false))
  }

  return (
    <View
      accessibilityRole="alert"
      testID="reauth-banner"
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: theme.space.md,
        paddingHorizontal: theme.space.lg,
        paddingVertical: theme.space.md,
        backgroundColor: theme.colors.surfaceRaised,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border
      }}
    >
      <Text variant="callout" style={{ flex: 1 }}>
        {strings.connection.reauth.message}
      </Text>

      <Pressable
        accessibilityRole="button"
        disabled={busy}
        onPress={() => (native ? setSigningIn(true) : void signOut())}
        hitSlop={8}
      >
        <Text variant="callout" color="accent">
          {busy
            ? strings.connection.reauth.saving
            : native
              ? strings.connection.reauth.action
              : strings.connection.reauth.tokenAction}
        </Text>
      </Pressable>

      {native ? (
        <NativeSignInWebView
          visible={signingIn}
          baseUrl={config.baseUrl}
          {...(config.provider ? { provider: config.provider } : {})}
          extraHeaders={extraHeaders}
          onCancel={() => setSigningIn(false)}
          onSuccess={onSuccess}
        />
      ) : null}
    </View>
  )
}
