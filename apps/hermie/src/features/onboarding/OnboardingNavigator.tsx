import { useCallback, useState } from 'react'
import { KeyboardAvoidingView, ScrollView, View } from 'react-native'

import { saveGatewaySetup, type StoredGatewayConfig } from '../../gateway/config'
import { describeConnectionError } from '../../gateway/errors'
import { strings } from '../../i18n/strings'
import { KEYBOARD_AVOID_BEHAVIOR } from '../../ui/keyboard'
import { Button, Screen, Text } from '../../ui/primitives'
import { useTheme } from '../../ui/theme'
import { FORM_MAX_WIDTH } from '../../ui/tokens'
import {
  authModeOf,
  configFromDraft,
  draftFromConfig,
  emptyDraft,
  hasCredential,
  headerRecord,
  isTestCurrent,
  NUMBERED_STEPS,
  type OnboardingDraft,
  type OnboardingStep
} from './draft'
import { DoneStep } from './steps/DoneStep'
import { GatewayAddressStep } from './steps/GatewayAddressStep'
import { SignInStep } from './steps/SignInStep'
import { TestConnectionStep } from './steps/TestConnectionStep'
import { WelcomeStep } from './steps/WelcomeStep'

const ORDER: OnboardingStep[] = ['welcome', 'address', 'signin', 'test', 'done']

export interface OnboardingNavigatorProps {
  /** Resuming after a sign-out: the address survives, the credentials do not. */
  resumeConfig?: StoredGatewayConfig | null
  onComplete: () => void | Promise<void>
  initialStep?: OnboardingStep
  initialDraft?: OnboardingDraft
  /** Passed through to the address step; tests drive it to zero. */
  probeDebounceMs?: number
}

/**
 * Welcome → Gateway address → Sign in → Test connection → Done.
 *
 * The wizard is one screen with steps rather than a navigator: it owns a single
 * draft that every step reads and writes, the steps are strictly ordered, and
 * nothing about it wants a back stack with its own history.
 */
export function OnboardingNavigator({
  resumeConfig = null,
  onComplete,
  initialStep,
  initialDraft,
  probeDebounceMs
}: OnboardingNavigatorProps) {
  const theme = useTheme()
  const [draft, setDraft] = useState<OnboardingDraft>(
    () => initialDraft ?? (resumeConfig ? draftFromConfig(resumeConfig) : emptyDraft())
  )
  const [step, setStep] = useState<OnboardingStep>(() => initialStep ?? (resumeConfig ? 'signin' : 'welcome'))
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const update = useCallback((patch: Partial<OnboardingDraft>) => {
    setDraft(current => {
      // Moving to a different gateway invalidates who you are on the old one.
      // The test result invalidates itself through the payload key, but a
      // token minted by another gateway has to be dropped outright.
      const movedGateway =
        patch.baseUrl !== undefined &&
        patch.baseUrl !== null &&
        current.baseUrl !== null &&
        patch.baseUrl !== current.baseUrl

      return movedGateway
        ? { ...current, ...patch, tokens: null, provider: null, sessionToken: '', test: null }
        : { ...current, ...patch }
    })
  }, [])

  const canAdvance = (): boolean => {
    switch (step) {
      case 'welcome':
        return true
      case 'address':
        return draft.probe !== null && draft.baseUrl !== null
      case 'signin':
        return (
          hasCredential(draft) &&
          (authModeOf(draft.probe) === 'session_token' || draft.probe?.supportsNativePkce === true)
        )
      case 'test':
        return isTestCurrent(draft)
      case 'done':
        return true
    }
  }

  const finish = useCallback(async () => {
    setSaving(true)
    setSaveError(null)

    try {
      await saveGatewaySetup({
        config: configFromDraft(draft),
        extraHeaders: headerRecord(draft.headers),
        tokens: draft.tokens,
        sessionToken: draft.sessionToken.trim() || null
      })
      await onComplete()
    } catch (error) {
      setSaveError(strings.onboarding.done.saveFailed(describeConnectionError(error, draft.baseUrl ?? '')))
      setSaving(false)
    }
  }, [draft, onComplete])

  const advance = () => {
    if (step === 'done') {
      void finish()

      return
    }

    const next = ORDER[ORDER.indexOf(step) + 1]

    if (next) {
      setStep(next)
    }
  }

  const goBack = () => {
    const previous = ORDER[ORDER.indexOf(step) - 1]

    if (previous) {
      setStep(previous)
    }
  }

  const primaryLabel =
    step === 'welcome'
      ? strings.onboarding.welcome.action
      : step === 'done'
        ? saving
          ? strings.onboarding.done.saving
          : strings.onboarding.done.finish
        : strings.common.continue

  const counter = NUMBERED_STEPS.indexOf(step)

  return (
    <Screen padded={false}>
      {/* The wizard is a form with a pinned footer, and the footer holds the
          only way forward. Without this the soft keyboard covered "Continue"
          on every step that has a field — the session token, the gateway
          address, a proxy header — and the way out was to dismiss the keyboard
          first, which nothing on screen said. */}
      <KeyboardAvoidingView behavior={KEYBOARD_AVOID_BEHAVIOR} style={{ flex: 1 }}>
        <ScrollView
          contentContainerStyle={{
            padding: theme.space.lg,
            gap: theme.space.lg,
            width: '100%',
            maxWidth: FORM_MAX_WIDTH,
            alignSelf: 'center'
          }}
          keyboardShouldPersistTaps="handled"
        >
          {counter >= 0 ? (
            <Text variant="caption" color="textMuted" testID="step-counter">
              {strings.onboarding.stepCounter(counter + 1, NUMBERED_STEPS.length)}
            </Text>
          ) : null}

          {step === 'welcome' ? <WelcomeStep /> : null}
          {step === 'address' ? (
            <GatewayAddressStep
              draft={draft}
              update={update}
              {...(probeDebounceMs === undefined ? {} : { debounceMs: probeDebounceMs })}
            />
          ) : null}
          {step === 'signin' ? <SignInStep draft={draft} update={update} /> : null}
          {step === 'test' ? <TestConnectionStep draft={draft} update={update} /> : null}
          {step === 'done' ? <DoneStep draft={draft} error={saveError} /> : null}
        </ScrollView>

        <View
          style={{
            padding: theme.space.lg,
            gap: theme.space.sm,
            width: '100%',
            maxWidth: FORM_MAX_WIDTH,
            alignSelf: 'center',
            borderTopWidth: 1,
            borderTopColor: theme.colors.border
          }}
        >
          <Button title={primaryLabel} onPress={advance} disabled={!canAdvance()} busy={saving} />
          {step === 'welcome' ? null : (
            <Button title={strings.common.back} variant="secondary" onPress={goBack} disabled={saving} />
          )}
        </View>
      </KeyboardAvoidingView>
    </Screen>
  )
}
