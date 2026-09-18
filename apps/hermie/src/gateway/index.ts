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
export { describeConnectionError, describeProbeError, describeSignInError, hostOf } from './errors'
export { GatewayProvider, type GatewayContextValue, type GatewayPhase, useGateway } from './GatewayProvider'
export { ReauthBanner } from './ReauthBanner'
export { type ConnectionStoreState, useConnectionStore } from './store'
