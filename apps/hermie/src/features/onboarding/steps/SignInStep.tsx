import type { AuthProvider, TokenSet } from '@hermie/gateway-client'
import { useEffect, useState } from 'react'
import { Pressable, View } from 'react-native'

import { strings } from '../../../i18n/strings'
import { Button, InsetGroup, InsetRow, SecretField, Text } from '../../../ui/primitives'
import { useTheme } from '../../../ui/theme'
import { authModeOf, headerRecord, type OnboardingDraft } from '../draft'
import { NativeSignInWebView } from '../NativeSignInWebView'

export interface SignInStepProps {
  draft: OnboardingDraft
  update: (patch: Partial<OnboardingDraft>) => void
}

export function SignInStep({ draft, update }: SignInStepProps) {
  const theme = useTheme()
  const [signingIn, setSigningIn] = useState(false)
  const probe = draft.probe
  const authMode = authModeOf(probe)
  const providers = probe?.providers ?? []

  // With exactly one provider there is nothing to choose, so the step should
  // read as a single "Sign in with …" button rather than as a list of one.
  const onlyProvider = providers.length === 1 ? providers[0] : undefined
  const selected = draft.provider ?? onlyProvider ?? null

  useEffect(() => {
    if (!draft.provider && onlyProvider) {
      update({ provider: onlyProvider })
    }
  }, [draft.provider, onlyProvider, update])

  const onSuccess = (tokens: TokenSet) => {
    setSigningIn(false)
    update({ tokens, ...(selected ? { provider: selected } : {}) })
  }

  return (
    <View style={{ gap: theme.space.xl }}>
      <View style={{ gap: theme.space.sm }}>
        <Text variant="title">{strings.onboarding.signIn.title}</Text>
        <Text color="textMuted">
          {authMode === 'session_token'
            ? strings.onboarding.signIn.subtitleToken
            : strings.onboarding.signIn.subtitleNative}
        </Text>
      </View>

      {authMode === 'session_token' ? (
        <InsetGroup header={strings.onboarding.signIn.tokenLabel} footer={strings.onboarding.signIn.tokenHelp}>
          <InsetRow>
            <SecretField
              testID="session-token"
              value={draft.sessionToken}
              onChangeText={sessionToken => update({ sessionToken })}
              autoCapitalize="none"
              autoCorrect={false}
              concealLabel={strings.onboarding.signIn.hideToken}
              revealLabel={strings.onboarding.signIn.showToken}
              placeholder={strings.onboarding.signIn.tokenPlaceholder}
              accessibilityLabel={strings.onboarding.signIn.tokenLabel}
            />
          </InsetRow>
        </InsetGroup>
      ) : !probe?.supportsNativePkce ? (
        <InsetGroup>
          <InsetRow>
            <Text variant="heading" color="danger" testID="signin-blocked">
              {strings.onboarding.signIn.blockedTitle}
            </Text>
            <Text color="textMuted">{strings.onboarding.signIn.blockedBody}</Text>
          </InsetRow>
        </InsetGroup>
      ) : providers.length === 0 ? (
        <Text color="danger" testID="signin-blocked">
          {strings.errors.providersUnavailable}
        </Text>
      ) : (
        <View style={{ gap: theme.space.lg }}>
          {providers.length > 1 ? (
            <InsetGroup header={strings.onboarding.signIn.chooseProvider}>
              {providers.map(provider => (
                <ProviderRow
                  key={provider.name}
                  provider={provider}
                  selected={selected?.name === provider.name}
                  onPress={() => update({ provider, tokens: null })}
                />
              ))}
            </InsetGroup>
          ) : null}

          {draft.tokens ? (
            <View style={{ gap: theme.space.sm }}>
              <Text color="success" testID="signin-result">
                {draft.tokens.userId
                  ? strings.onboarding.signIn.signedInAs(draft.tokens.userId)
                  : strings.onboarding.signIn.signedIn}
              </Text>
              <Button
                title={strings.onboarding.signIn.signOutAndRetry}
                variant="secondary"
                onPress={() => setSigningIn(true)}
              />
            </View>
          ) : (
            <Button
              title={strings.onboarding.signIn.signInWith(selected?.displayName ?? '')}
              onPress={() => setSigningIn(true)}
              disabled={!selected}
            />
          )}
        </View>
      )}

      {draft.baseUrl && selected ? (
        <NativeSignInWebView
          visible={signingIn}
          baseUrl={draft.baseUrl}
          provider={selected.name}
          extraHeaders={headerRecord(draft.headers)}
          onCancel={() => setSigningIn(false)}
          onSuccess={onSuccess}
        />
      ) : null}
    </View>
  )
}

function ProviderRow({
  provider,
  selected,
  onPress
}: {
  provider: AuthProvider
  selected: boolean
  onPress: () => void
}) {
  const theme = useTheme()

  return (
    <Pressable accessibilityRole="radio" accessibilityState={{ selected }} onPress={onPress}>
      <InsetRow style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text variant="body">{provider.displayName}</Text>
        {selected ? (
          <Text variant="body" color="accent" style={{ marginLeft: theme.space.md }}>
            ✓
          </Text>
        ) : null}
      </InsetRow>
    </Pressable>
  )
}
