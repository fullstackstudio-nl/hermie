export {
  attachLifecycle,
  createGatewayConnection,
  createMemoryTokenStore,
  createSecretTokenStore,
  createTokenCoordinator,
  type CreateConnectionOptions,
  type CreateTokenCoordinatorOptions
} from './client'
export {
  clearCredentials,
  clearGateway,
  CONFIG_KEY,
  type GatewaySetup,
  loadGatewaySetup,
  saveGatewaySetup,
  type SaveGatewaySetupInput,
  SECRET_KEYS,
  type StoredGatewayConfig
} from './config'
export { AUTH_TIMELINE_KEY, createPersistentAuthTimeline } from './auth-timeline'
export { describeConnectionError, describeProbeError, describeSignInError, hostOf } from './errors'
export { GatewayProvider, type GatewayContextValue, type GatewayPhase, useGateway } from './GatewayProvider'
export { describeSignOutReason, SignedOutPanel, useReauth } from './SignedOutPanel'
export { type ConnectionStoreState, useConnectionStore } from './store'
export { TransportNotice, type TransportNoticeProps } from './TransportNotice'
export { chatGatewayFor, type ChatGateway, type RestMessagesOptions } from './link'
