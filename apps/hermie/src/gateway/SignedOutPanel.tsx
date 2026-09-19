/**
 * The signed-out state, said out loud.
 *
 * This used to be a one-line banner and a small "Sign in" in a corner, and the
 * result was reported from a real Mac session: the content area showed a chat
 * error, the corner showed a link, and it was not clear at all that the thing to
 * do was sign in again. A dead connection is not a chat problem and must not
 * read as one, so it takes the whole content column: one card, one sentence that
 * names the gateway, and the two things that can actually be done about it.
 *
 * The sign-in itself is the same in-place flow the reauth banner uses — the same
 * web view, the same interception, and on success the tokens go to the
 * coordinator and the dial loop picks up where it stopped. Nobody is sent back
 * through the wizard for an expired refresh token.
 */
import type { TokenSet } from '@hermie/gateway-client'
import { useState } from 'react'
import { View } from 'react-native'

import { NativeSignInWebView } from '../features/onboarding/NativeSignInWebView'
import { strings } from '../i18n/strings'
import { GlassSurface } from '../ui/glass'
import { Button, Text } from '../ui/primitives'
import { useTheme } from '../ui/theme'
import { hostOf } from './errors'
import { useGateway } from './GatewayProvider'

/**
 * Everything the signed-out state needs, in one hook, so the content panel and
 * the sidebar's gateway card offer the identical action rather than two that
 * drift.
 */
export function useReauth() {
  const { status, config, extraHeaders, adoptTokens, signOut, changeGateway } = useGateway()
  const [signingIn, setSigningIn] = useState(false)
  const [busy, setBusy] = useState(false)

  const native = config?.authMode === 'native_pkce'

  return {
    /** True when the connection is signed out and there is a gateway to sign in to. */
    signedOut: status === 'needs_signin' && Boolean(config),
    busy,
    host: config ? hostOf(config.baseUrl) : '',
    /**
     * Start signing in. A native gateway opens the in-app page; a session-token
     * gateway has no page to open, so it goes back to the token step instead.
     */
    signIn: () => (native ? setSigningIn(true) : void signOut()),
    changeGateway,
    /** Render inside whichever component owns the action, once. */
    webView:
      native && config ? (
        <NativeSignInWebView
          baseUrl={config.baseUrl}
          extraHeaders={extraHeaders}
          onCancel={() => setSigningIn(false)}
          onSuccess={(tokens: TokenSet) => {
            setSigningIn(false)
            setBusy(true)
            void adoptTokens(tokens).finally(() => setBusy(false))
          }}
          visible={signingIn}
          {...(config.provider ? { provider: config.provider } : {})}
        />
      ) : null
  }
}

/** The card itself: the content column on the wide layout, full width on phone. */
export function SignedOutPanel() {
  const theme = useTheme()
  const { busy, changeGateway, host, signIn, webView } = useReauth()

  return (
    <View
      style={{
        alignItems: 'center',
        flex: 1,
        justifyContent: 'center',
        padding: theme.space.xl
      }}
      testID="signed-out-panel"
    >
      <GlassSurface style={{ maxWidth: 420, width: '100%' }} variant="card">
        <View style={{ gap: theme.space.md, padding: theme.space.panel }}>
          <Text variant="sheetTitle">{strings.signedOut.title}</Text>

          <Text color="textMuted" variant="preview">
            {host ? strings.signedOut.body(host) : strings.signedOut.bodyNoHost}
          </Text>

          <View style={{ gap: theme.space.sm, paddingTop: theme.space.xs }}>
            <Button
              disabled={busy}
              onPress={signIn}
              testID="signed-out-sign-in"
              title={busy ? strings.connection.reauth.saving : strings.signedOut.signIn}
            />
            <Button
              onPress={() => void changeGateway()}
              testID="signed-out-change-gateway"
              title={strings.signedOut.changeGateway}
              variant="secondary"
            />
          </View>
        </View>
      </GlassSurface>

      {webView}
    </View>
  )
}
