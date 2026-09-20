import { useCallback, useState } from 'react'

import { saveGatewaySetup, type StoredGatewayConfig } from '../../gateway/config'
import { describeConnectionError } from '../../gateway/errors'
import { strings } from '../../i18n/strings'
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
import { OnboardingCard } from './OnboardingCard'
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
 *
 * **The chrome lives in `OnboardingCard`, and the heading with it.** Every step
 * used to draw its own title and lead, which is why the two were easy to get
 * out of step with each other — one step used `title`, another an inset group
 * header — and why the wizard read as five loosely related screens instead of
 * one. A step now contributes its body and nothing else; what it is called and
 * what moves it forward are decided here, in one place, where the order already
 * is.
 */
export function OnboardingNavigator({
  resumeConfig = null,
  onComplete,
  initialStep,
  initialDraft,
  probeDebounceMs
}: OnboardingNavigatorProps) {
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

  const authMode = authModeOf(draft.probe)

  const heading: { title: string; lead: string } =
    step === 'welcome'
      ? { title: strings.onboarding.welcome.title, lead: strings.onboarding.welcome.body }
      : step === 'address'
        ? { title: strings.onboarding.address.title, lead: strings.onboarding.address.subtitle }
        : step === 'signin'
          ? {
              title: strings.onboarding.signIn.title,
              lead:
                authMode === 'session_token'
                  ? strings.onboarding.signIn.subtitleToken
                  : strings.onboarding.signIn.subtitleNative
            }
          : step === 'test'
            ? { title: strings.onboarding.test.title, lead: strings.onboarding.test.subtitle }
            : { title: strings.onboarding.done.title, lead: strings.onboarding.done.subtitle }

  return (
    <OnboardingCard
      backDisabled={saving}
      cover={step === 'welcome'}
      lead={heading.lead}
      onBack={step === 'welcome' ? undefined : goBack}
      onPrimary={advance}
      primaryBusy={saving}
      primaryDisabled={!canAdvance()}
      primaryLabel={primaryLabel}
      stepCount={NUMBERED_STEPS.length}
      stepIndex={NUMBERED_STEPS.indexOf(step)}
      title={heading.title}
    >
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
    </OnboardingCard>
  )
}
