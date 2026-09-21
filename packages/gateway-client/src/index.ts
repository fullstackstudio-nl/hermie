export {
  AUTH_TIMELINE_SIZE,
  type AuthEvent,
  type AuthEventInput,
  type AuthEventName,
  AuthTimeline,
  type AuthTimelineOptions,
  type AuthTimelineSink,
  type AuthTimelineSnapshot,
  NULL_AUTH_TIMELINE,
  type SignOutReason
} from './auth-timeline'
export {
  assertDesktopContract,
  DEFAULT_RPC_TIMEOUT_MS,
  FIRST_SESSION_TIMEOUT_MS,
  GatewayConnection,
  type GatewayConnectionOptions,
  MIN_DESKTOP_CONTRACT,
  PROMPT_SUBMIT_TIMEOUT_MS,
  READY_TIMEOUT_MS,
  RECONNECT_CAP_MS,
  rpcTimeoutMs,
  type StatusHandler
} from './connection'
export {
  type AuthHeaderOptions,
  bearerFrom,
  CookieSessionCredentials,
  type CookieSessionCredentialsOptions,
  type CredentialProvider,
  GATEWAY_WS_PROTOCOL,
  GATEWAY_WS_TICKET_PREFIX,
  mintWsTicket,
  type MintWsTicketOptions,
  NativePkceCredentials,
  type NativePkceCredentialsOptions,
  SESSION_TOKEN_HEADER,
  SessionTokenCredentials,
  type SessionTokenCredentialsOptions
} from './credentials'
export {
  DEFAULT_HTTP_TIMEOUT_MS,
  type FetchLike,
  looksLikeCertificateFailure,
  looksLikeTlsFailure,
  parseJsonBody,
  parseJsonObject,
  requestText
} from './fetch-json'
export {
  classifyHost,
  type HostClassification,
  type HostPrivacy,
  hostOfAddress,
  isExposedCleartext
} from './host-privacy'
export {
  type AuthIdentity,
  DEFAULT_REST_TIMEOUT_MS,
  GatewayHttp,
  type GatewayHttpOptions,
  type RequestOptions,
  type WsTicket
} from './http'
export {
  AuthChangedError,
  type AccessTokenOptions,
  exchangeCode,
  type NativeAuthOptions,
  REFRESH_SKEW_SECONDS,
  refreshTokens,
  TokenCoordinator,
  type TokenCoordinatorOptions,
  type TokenSet,
  type TokenStore,
  tokenNeedsRefresh
} from './native-auth'
export {
  type AuthorizeParams,
  base64url,
  buildAuthorizeUrl,
  createPkce,
  isLoopbackRedirect,
  type LoopbackRedirect,
  parseLoopbackRedirect,
  type Pkce,
  type RandomBytes,
  REDIRECT_URI
} from './pkce'
export {
  type AuthProvider,
  NATIVE_PKCE_FLOW,
  PROBE_TIMEOUT_MS,
  probeGateway,
  type ProbeResult,
  resolveGatewayAddress,
  type ResolvedAddress
} from './probe'
export { DialPlanSocketFactory, type SocketCloseInfo, type WebSocketConstructorLike } from './socket-factory'
export {
  asGatewayError,
  type ConnectionStatus,
  type DialPlan,
  type GatewayAuthMode,
  type GatewayConfig,
  GatewayError,
  type GatewayErrorKind,
  type GatewayErrorOptions,
  isGatewayError
} from './types'
export {
  BOT_MARKER_KEY,
  HERMIE_APP_KEY,
  HERMIE_APP_SECTION_VERSION,
  HERMIE_KEY,
  HERMIE_SECTION_VERSION,
  type HermieAppSection,
  type HermieBotSection,
  readSection,
  UiMetaSync,
  type UiMetaGateway,
  type UiMetaMode,
  type UiMetaSnapshot,
  type UiMetaSyncOptions
} from './ui-meta'
export {
  apiUrl,
  BLOCKED_HEADER_NAMES,
  GATEWAY_WS_PATH,
  hasExplicitScheme,
  isBlockedHeaderName,
  normalizeBaseUrl,
  normalizeHeader,
  normalizeHeaders,
  wsUrlFor
} from './url'
