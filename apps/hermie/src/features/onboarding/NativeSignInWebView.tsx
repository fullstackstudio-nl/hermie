import { buildAuthorizeUrl, createPkce, exchangeCode, type Pkce, type TokenSet } from '@hermie/gateway-client'
import { Component, type ErrorInfo, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, Linking, Modal, Platform, Pressable, ScrollView, View } from 'react-native'
import { WebView } from 'react-native-webview'

import { describeSignInError } from '../../gateway/errors'
import { strings } from '../../i18n/strings'
import { randomBytes } from '../../platform/random'
import { Button, InsetGroup, InsetRow, Screen, Text, TextField } from '../../ui/primitives'
import { useTheme } from '../../ui/theme'
import { FORM_MAX_WIDTH } from '../../ui/tokens'
import { inspectSignInNavigation } from './loopback'

/** The provider's page gets ten minutes; after that the pending code is stale anyway. */
export const SIGN_IN_TIMEOUT_MS = 10 * 60 * 1000

/**
 * Whether this platform may be handed the gateway's extra headers.
 *
 * `source.headers` is applied per load, and Android's WebView re-sends them on
 * cross-origin redirects rather than dropping them at the origin boundary. A
 * sign-in redirects to the identity provider by design, so a Cloudflare Access
 * client secret set for the gateway would travel to the IdP's domain. iOS and
 * macOS do not re-send them, so only Android refuses the in-app page — the
 * system browser plus the pasted redirect signs in without ever seeing them.
 */
export function webViewMayCarryHeaders(platform: string = Platform.OS): boolean {
  return platform !== 'android'
}

export interface NativeSignInWebViewProps {
  visible: boolean
  baseUrl: string
  /** Provider name from the probe; omitted lets the gateway pick its default. */
  provider?: string
  extraHeaders?: Record<string, string>
  onCancel: () => void
  onSuccess: (tokens: TokenSet) => void
}

type Phase = 'signing-in' | 'exchanging' | 'failed' | 'fallback'

/**
 * Renders the sign-in page inside the app and intercepts the loopback redirect.
 *
 * The web view is configured to be forgetful on purpose: `incognito`, no shared
 * cookies and no third-party cookies, so signing in never picks up an existing
 * browser session and never leaves one behind. JavaScript is on because a
 * password provider's own `/login` form needs it, and that form ends at the same
 * loopback redirect as a redirect-based provider — there is only one code path.
 */
export function NativeSignInWebView({
  visible,
  baseUrl,
  provider,
  extraHeaders = {},
  onCancel,
  onSuccess
}: NativeSignInWebViewProps) {
  const theme = useTheme()
  const [attempt, setAttempt] = useState<{ pkce: Pkce; url: string } | null>(null)
  const [phase, setPhase] = useState<Phase>('signing-in')
  const [error, setError] = useState<string | null>(null)
  const [pastedUrl, setPastedUrl] = useState('')
  const exchangingRef = useRef(false)
  const headersWithheld = Object.keys(extraHeaders).length > 0 && !webViewMayCarryHeaders()

  useEffect(() => {
    if (!visible) {
      setAttempt(null)
      setPhase('signing-in')
      setError(null)
      setPastedUrl('')
      exchangingRef.current = false

      return
    }

    // The headers this gateway needs cannot ride in the in-app page here, and a
    // sign-in page loaded WITHOUT them would simply be refused by the proxy in
    // front of the gateway. So the browser does it instead, from the start.
    setPhase(headersWithheld ? 'fallback' : 'signing-in')

    try {
      // A fresh verifier, challenge and state per attempt: reusing any of them
      // across attempts is what PKCE exists to prevent.
      const pkce = createPkce(randomBytes)
      setAttempt({
        pkce,
        url: buildAuthorizeUrl(baseUrl, {
          ...(provider ? { provider } : {}),
          challenge: pkce.challenge,
          state: pkce.state
        })
      })
    } catch (creationError) {
      setPhase('failed')
      setError(describeSignInError(creationError, baseUrl))
    }
  }, [baseUrl, headersWithheld, provider, visible])

  useEffect(() => {
    if (!visible || !attempt || phase !== 'signing-in') {
      return
    }

    const timer = setTimeout(() => {
      setPhase('failed')
      setError(strings.onboarding.signIn.webview.timeout)
    }, SIGN_IN_TIMEOUT_MS)

    return () => clearTimeout(timer)
  }, [attempt, phase, visible])

  const exchange = useCallback(
    async (code: string, verifier: string) => {
      if (exchangingRef.current) {
        return
      }

      exchangingRef.current = true
      setPhase('exchanging')

      try {
        const tokens = await exchangeCode(baseUrl, { code, verifier }, { extraHeaders })
        onSuccess(tokens)
      } catch (exchangeError) {
        setPhase('failed')
        setError(describeSignInError(exchangeError, baseUrl))
      } finally {
        exchangingRef.current = false
      }
    },
    [baseUrl, extraHeaders, onSuccess]
  )

  const handleNavigation = useCallback(
    (url: string): boolean => {
      const verdict = inspectSignInNavigation(url, attempt?.pkce.state ?? '')

      if (verdict.kind === 'continue') {
        return true
      }

      if (verdict.kind === 'failed') {
        setPhase('failed')
        setError(verdict.message)

        return false
      }

      void exchange(verdict.code, attempt?.pkce.verifier ?? '')

      return false
    },
    [attempt, exchange]
  )

  const openInBrowser = useCallback(() => {
    if (!attempt) {
      return
    }

    setPhase('fallback')
    setError(null)
    void Linking.openURL(attempt.url).catch(openError => {
      setError(describeSignInError(openError, baseUrl))
    })
  }, [attempt, baseUrl])

  const header = useMemo(
    () => (
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingHorizontal: theme.space.lg,
          paddingVertical: theme.space.md,
          borderBottomWidth: 1,
          borderBottomColor: theme.colors.border,
          backgroundColor: theme.colors.surface
        }}
      >
        <Text variant="heading">{strings.onboarding.signIn.webview.title}</Text>
        <Pressable accessibilityRole="button" onPress={onCancel} hitSlop={12}>
          <Text variant="body" color="accent">
            {strings.common.cancel}
          </Text>
        </Pressable>
      </View>
    ),
    [onCancel, theme]
  )

  const body = () => {
    if (!attempt) {
      return <Centred>{error ? <Text color="danger">{error}</Text> : <ActivityIndicator />}</Centred>
    }

    if (phase === 'exchanging') {
      return (
        <Centred>
          <ActivityIndicator />
          <Text color="textMuted">{strings.onboarding.signIn.webview.exchanging}</Text>
        </Centred>
      )
    }

    if (phase === 'failed') {
      return (
        <Centred>
          <Text color="danger" style={{ textAlign: 'center' }}>
            {error}
          </Text>
          <Button title={strings.common.openInBrowser} variant="secondary" onPress={openInBrowser} />
        </Centred>
      )
    }

    if (phase === 'fallback') {
      return (
        <FallbackForm
          url={pastedUrl}
          onChange={setPastedUrl}
          error={error}
          reason={
            headersWithheld
              ? strings.onboarding.signIn.webview.headersWithheld
              : strings.onboarding.signIn.webview.unavailable
          }
          onOpen={openInBrowser}
          onSubmit={() => handleNavigation(pastedUrl.trim())}
        />
      )
    }

    return (
      <WebViewBoundary onFailure={openInBrowser}>
        <WebView
          testID="sign-in-webview"
          // Belt and braces: this branch is unreachable while the headers are
          // withheld, and the source must not carry them even if that changes.
          source={{ uri: attempt.url, ...(headersWithheld ? {} : { headers: extraHeaders }) }}
          incognito
          sharedCookiesEnabled={false}
          thirdPartyCookiesEnabled={false}
          setSupportMultipleWindows={false}
          javaScriptEnabled
          originWhitelist={['https://*', 'http://*']}
          startInLoadingState
          onShouldStartLoadWithRequest={request => handleNavigation(request.url)}
          onHttpError={event => {
            const status = event.nativeEvent.statusCode

            // Only the page we asked for matters; a sub-resource 404 on the
            // provider's own page is not our problem to report.
            if (event.nativeEvent.url === attempt.url) {
              setPhase('failed')
              setError(strings.onboarding.signIn.webview.httpError(status))
            }
          }}
          onError={event => {
            setPhase('failed')
            setError(strings.onboarding.signIn.webview.loadError(event.nativeEvent.description))
          }}
        />
      </WebViewBoundary>
    )
  }

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onCancel} transparent={false}>
      <Screen padded={false}>
        {header}
        <View style={{ flex: 1 }}>{body()}</View>
        {phase === 'signing-in' && attempt ? (
          <View style={{ padding: theme.space.lg }}>
            <Pressable accessibilityRole="button" onPress={openInBrowser} hitSlop={8}>
              <Text variant="caption" color="accent" style={{ textAlign: 'center' }}>
                {strings.common.openInBrowser}
              </Text>
            </Pressable>
          </View>
        ) : null}
      </Screen>
    </Modal>
  )
}

function Centred({ children }: { children: ReactNode }) {
  const theme = useTheme()

  return (
    <View
      style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: theme.space.md, padding: theme.space.xl }}
    >
      {children}
    </View>
  )
}

function FallbackForm({
  url,
  onChange,
  error,
  reason,
  onOpen,
  onSubmit
}: {
  url: string
  onChange: (next: string) => void
  error: string | null
  reason: string
  onOpen?: () => void
  onSubmit: () => void
}) {
  const theme = useTheme()

  return (
    <ScrollView
      contentContainerStyle={{
        padding: theme.space.lg,
        gap: theme.space.lg,
        maxWidth: FORM_MAX_WIDTH,
        width: '100%',
        alignSelf: 'center'
      }}
    >
      <Text color="textMuted">{reason}</Text>
      {onOpen ? <Button title={strings.common.openInBrowser} variant="secondary" onPress={onOpen} /> : null}
      <InsetGroup
        header={strings.onboarding.signIn.webview.fallbackLabel}
        footer={strings.onboarding.signIn.webview.fallbackHelp}
      >
        <InsetRow>
          <TextField
            value={url}
            onChangeText={onChange}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            placeholder={strings.onboarding.signIn.webview.fallbackPlaceholder}
            {...(error ? { error } : {})}
          />
        </InsetRow>
      </InsetGroup>
      <Button
        title={strings.onboarding.signIn.webview.fallbackSubmit}
        onPress={onSubmit}
        disabled={url.trim().length === 0}
      />
    </ScrollView>
  )
}

/**
 * react-native-webview links on macOS, but "links" is not "renders". A render
 * failure there would otherwise take the whole app down, so the fallback — the
 * system browser plus a pasted redirect — is one caught error away rather than
 * a platform check somebody has to remember to update.
 */
class WebViewBoundary extends Component<{ children: ReactNode; onFailure: () => void }, { failed: boolean }> {
  override state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  override componentDidCatch(_error: Error, _info: ErrorInfo) {
    this.props.onFailure()
  }

  override render() {
    return this.state.failed ? null : this.props.children
  }
}
