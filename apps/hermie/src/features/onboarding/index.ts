// Gateway address, authentication and the mandatory connection test live here.
export {
  authModeOf,
  configFromDraft,
  connectionPayloadKey,
  type ConnectionTestOutcome,
  draftFromConfig,
  emptyDraft,
  hasCredential,
  type HeaderRow,
  headerError,
  headerRecord,
  isTestCurrent,
  newHeaderRow,
  NUMBERED_STEPS,
  type OnboardingDraft,
  type OnboardingStep
} from './draft'
export { inspectSignInNavigation, type SignInNavigation } from './loopback'
export { NativeSignInWebView, type NativeSignInWebViewProps, SIGN_IN_TIMEOUT_MS } from './NativeSignInWebView'
export { OnboardingNavigator, type OnboardingNavigatorProps } from './OnboardingNavigator'
export { CONNECTION_TEST_TIMEOUT_MS, runConnectionTest } from './test-connection'
