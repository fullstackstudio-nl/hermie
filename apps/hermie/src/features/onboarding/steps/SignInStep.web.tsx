/**
 * Signing in from a browser tab: the gateway's own cookie session.
 *
 * The whole step is a different shape from the native one, which is why it is a
 * platform file rather than a branch inside `SignInStep.tsx`. What differs is
 * not the wording but the mechanics:
 *
 *  - **The address is already known.** Hermie Web serves this page and proxies
 *    the gateway onto the same origin, so the step probes `window.location.origin`
 *    on mount instead of waiting for an address step that does not exist.
 *  - **There may already be a session.** A cookie survives the reload that ends
 *    the OAuth redirect chain, so the first thing the step does after the probe
 *    is ask `GET /api/auth/me`. When that answers, the user is signed in and
 *    never sees a button.
 *  - **The OAuth door is a full-page navigation.** The app is torn down and
 *    rebuilt when it returns; nothing the wizard is holding survives, which is
 *    exactly why the cookie is the state.
 *  - **The password door is not.** `POST /auth/password-login` sets the cookies
 *    on its own response, so a password provider stays inside the SPA.
 */
import { type AuthProvider, CookieSessionCredentials, GatewayHttp, probeGateway } from '@hermie/gateway-client'
import { useCallback, useEffect, useState } from 'react'
import { View } from 'react-native'

import { describeProbeError, describeSignInError } from '../../../gateway/errors'
import { loadHermieWebConfig } from '../../../gateway/web-config'
import { strings } from '../../../i18n/strings'
import { Button, InsetGroup, InsetRow, SecretField, Text, TextField } from '../../../ui/primitives'
import { useTheme } from '../../../ui/theme'
import { passwordLogin, startCookieSignIn } from '../cookie-sign-in'
import { authModeOf, type OnboardingDraft } from '../draft'
import { StatusLine } from '../StatusLine'

export interface SignInStepProps {
  draft: OnboardingDraft
  update: (patch: Partial<OnboardingDraft>) => void
}

type Phase = 'probing' | 'checking' | 'ready' | 'leaving' | 'failed'

export function SignInStep({ draft, update }: SignInStepProps) {
  const theme = useTheme()
  const baseUrl = draft.baseUrl ?? ''
  const [phase, setPhase] = useState<Phase>(draft.probe ? 'ready' : 'probing')
  const [error, setError] = useState<string | null>(null)
  const [host, setHost] = useState<string>('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    void loadHermieWebConfig().then(config => setHost(config?.gatewayHost ?? ''))
  }, [])

  /**
   * Probe, then ask who we are — in that order and only once.
   *
   * The identity check is not skipped when the probe says the gateway is
   * ungated: `authModeOf` answers `session_token` there, and this component is
   * only rendered for the cookie case, so the branch simply does not arise. It
   * IS skipped when a session was already found, because a second `/api/auth/me`
   * would tell us the same thing.
   */
  const discover = useCallback(async () => {
    if (!baseUrl) {
      return
    }

    setError(null)
    setPhase('probing')

    try {
      const probe = draft.probe ?? (await probeGateway(baseUrl))
      update({ probe })
      setPhase('checking')

      if (!probe.authRequired || !probe.authFlows.includes('cookie')) {
        setPhase('ready')

        return
      }

      const http = new GatewayHttp({ baseUrl, credentials: new CookieSessionCredentials({ baseUrl }) })

      try {
        const identity = await http.authMe()
        update({
          cookieIdentity: {
            userId: identity.userId,
            displayName: identity.displayName || identity.email || identity.userId
          },
          ...(probe.providers.length === 1 && probe.providers[0] ? { provider: probe.providers[0] } : {})
        })
      } catch {
        // No session yet — the ordinary first visit. Not an error to report.
      }

      setPhase('ready')
    } catch (probeError) {
      setError(describeProbeError(probeError, baseUrl))
      setPhase('failed')
    }
  }, [baseUrl, draft.probe, update])

  useEffect(() => {
    if (phase === 'probing') {
      void discover()
    }
  }, [discover, phase])

  const probe = draft.probe
  const providers = probe?.providers ?? []
  const onlyProvider = providers.length === 1 ? providers[0] : undefined
  const selected = draft.provider ?? onlyProvider ?? null

  const submitPassword = async (provider: AuthProvider) => {
    setSubmitting(true)
    setError(null)

    try {
      await passwordLogin({ baseUrl, provider: provider.name, username, password })
      // The password never lives longer than the request that used it.
      setPassword('')

      const http = new GatewayHttp({ baseUrl, credentials: new CookieSessionCredentials({ baseUrl }) })
      const identity = await http.authMe()

      update({
        provider,
        cookieIdentity: {
          userId: identity.userId,
          displayName: identity.displayName || identity.email || identity.userId
        }
      })
    } catch (loginError) {
      setError(describeSignInError(loginError, baseUrl))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <View style={{ gap: theme.space.lg }}>
      <Text color="textFaint" variant="meta">
        {host ? strings.onboarding.signIn.servedFrom(host) : strings.onboarding.signIn.servedFromUnknown}
      </Text>

      {phase === 'probing' ? <StatusLine tone="checking">{strings.onboarding.signIn.probingGateway}</StatusLine> : null}
      {phase === 'checking' ? (
        <StatusLine tone="checking">{strings.onboarding.signIn.checkingSession}</StatusLine>
      ) : null}
      {phase === 'leaving' ? (
        <StatusLine tone="checking">{strings.onboarding.signIn.leavingForProvider}</StatusLine>
      ) : null}
      {error ? (
        <StatusLine testID="signin-error" tone="error">
          {error}
        </StatusLine>
      ) : null}

      {phase === 'ready' && probe && authModeOf(probe) !== 'cookie' ? (
        <View style={{ gap: theme.space.xs }}>
          <StatusLine testID="signin-blocked" tone="error">
            {strings.onboarding.signIn.cookieBlockedTitle}
          </StatusLine>
          <Text color="textMuted" variant="preview">
            {strings.onboarding.signIn.cookieBlockedBody}
          </Text>
        </View>
      ) : null}

      {draft.cookieIdentity ? (
        <StatusLine testID="signin-result" tone="ok">
          {strings.onboarding.signIn.signedInAs(draft.cookieIdentity.displayName)}
        </StatusLine>
      ) : phase === 'ready' && probe && authModeOf(probe) === 'cookie' ? (
        providers.length === 0 ? (
          <StatusLine testID="signin-blocked" tone="error">
            {strings.errors.providersUnavailable}
          </StatusLine>
        ) : (
          <View style={{ gap: theme.space.md }}>
            {providers.length > 1 ? (
              <InsetGroup header={strings.onboarding.signIn.chooseProvider}>
                {providers.map(provider => (
                  <InsetRow key={provider.name}>
                    <Button
                      onPress={() => update({ provider })}
                      title={provider.displayName}
                      variant={selected?.name === provider.name ? 'primary' : 'secondary'}
                    />
                  </InsetRow>
                ))}
              </InsetGroup>
            ) : null}

            {selected?.supportsPassword ? (
              <View style={{ gap: theme.space.sm }}>
                <Text color="textMuted" variant="micro">
                  {strings.onboarding.signIn.passwordUser}
                </Text>
                <TextField
                  accessibilityLabel={strings.onboarding.signIn.passwordUser}
                  autoCapitalize="none"
                  autoCorrect={false}
                  onChangeText={setUsername}
                  testID="cookie-username"
                  value={username}
                />
                <Text color="textMuted" variant="micro">
                  {strings.onboarding.signIn.passwordSecret}
                </Text>
                <SecretField
                  accessibilityLabel={strings.onboarding.signIn.passwordSecret}
                  autoCapitalize="none"
                  autoCorrect={false}
                  concealLabel={strings.onboarding.signIn.hidePassword}
                  onChangeText={setPassword}
                  returnKeyType="done"
                  revealLabel={strings.onboarding.signIn.showPassword}
                  testID="cookie-password"
                  value={password}
                />
                <Button
                  busy={submitting}
                  disabled={submitting || !username || !password}
                  onPress={() => void submitPassword(selected)}
                  testID="cookie-password-submit"
                  title={strings.onboarding.signIn.passwordSubmit}
                />
              </View>
            ) : (
              <Button
                disabled={!selected}
                onPress={() => {
                  setPhase('leaving')
                  startCookieSignIn(baseUrl, selected?.name)
                }}
                testID="cookie-sign-in"
                title={strings.onboarding.signIn.signInWith(selected?.displayName ?? '')}
              />
            )}
          </View>
        )
      ) : null}
    </View>
  )
}
