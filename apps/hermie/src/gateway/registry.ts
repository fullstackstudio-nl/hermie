/**
 * Every gateway this device knows about, and which one is live.
 *
 * [ADR-0006](../../../../docs/adr/0006-single-gateway-no-relay.md) said one
 * gateway per install, and the reason it gave was about the RELAY — a phone
 * cannot be the router between two gateways, because a backgrounded app
 * delivers some messages and silently drops the rest. That reason has not
 * changed and nothing here changes it: Hermie still holds exactly one live
 * connection, still runs no relay loop, and bots still talk to each other only
 * inside the gateway they live on. What this file adds is the thing the ADR
 * folded in with it and did not have to: that CHANGING gateway meant running
 * setup again and throwing the local cache away.
 *
 * So a gateway is a record rather than a single stored config, and the app
 * keeps a list of them with one marked active.
 *
 * **It is not synced, and that is a decision rather than an omission.** A list
 * of gateways is per device by nature: which machines this phone can reach is a
 * fact about this phone and the networks it is on, not about whoever is signed
 * in. It also cannot be synced without choosing a gateway to sync it TO, which
 * is the question this list exists to answer. `ui_meta` therefore never carries
 * it; the key-value store does.
 *
 * **The id is random and it is not the address.** Two entries may legitimately
 * hold the same address — the same host reached under two accounts — and an
 * address is a thing a reader edits. Everything else in the app keys off the
 * id, so the whole of what an edited address costs is one row redrawing.
 */
import type { GatewayAuthMode } from '@hermie/gateway-client'

import { keyValueStore } from '../platform/key-value-store'
import { randomBytes } from '../platform/random'
import { CONFIG_KEY, type StoredGatewayConfig } from './config'

/** The registry itself. Device-level: never namespaced, never synced. */
export const GATEWAY_REGISTRY_KEY = 'hermie.gateways'

/**
 * Bumped when a field changes meaning. A reader that meets a version it does
 * not know keeps its own copy rather than guessing at a shape — the same rule
 * ADR-0016 applies to a `ui_meta` section.
 */
export const GATEWAY_REGISTRY_VERSION = 1

export interface GatewayRecord {
  /** Random, minted once, never derived from the address. See the note above. */
  id: string
  /** The wizard's default is the address's host; the reader may rename it. */
  name: string
  /** The base URL, exactly as the wizard settled on it. */
  address: string
  authKind: GatewayAuthMode
  /** Who the gateway said this is, when it ever named anybody. */
  signedInUser?: string
  /** Epoch milliseconds. Only used to keep the list in a stable order. */
  addedAt: number
}

export interface GatewayRegistry {
  v: number
  gateways: GatewayRecord[]
  /** `null` only while the list is empty, which is a device with no setup yet. */
  activeGatewayId: string | null
}

export const EMPTY_REGISTRY: GatewayRegistry = { v: GATEWAY_REGISTRY_VERSION, gateways: [], activeGatewayId: null }

/**
 * An id for one gateway entry.
 *
 * The same shape as the push installation id and for the same reason: it does
 * not have to be unguessable, but it does have to not collide with the entry
 * added ten seconds later, and a counter or a timestamp would. It is also what
 * every namespaced storage key is suffixed with, so it is deliberately limited
 * to hex — a separator that can appear inside an id is a key that can be read
 * two ways.
 */
export function newGatewayId(): string {
  return `g${[...randomBytes(8)].map(byte => byte.toString(16).padStart(2, '0')).join('')}`
}

/** True for a string this build minted, or could have. Ids reach us from disk. */
export const isGatewayId = (value: unknown): value is string =>
  typeof value === 'string' && /^g[0-9a-f]{2,64}$/u.test(value)

/**
 * What a new entry is called before anybody renames it.
 *
 * The host, because that is the word the owner used when they typed the
 * address, and it is the one part of a URL that is a name rather than a route.
 * An address that will not parse keeps its whole string: it is still what the
 * reader typed, and "Unknown" in a list of gateways names nothing.
 */
export function defaultGatewayName(address: string): string {
  const trimmed = address.trim()

  try {
    return new URL(trimmed).hostname || trimmed
  } catch {
    return trimmed
  }
}

/** The active entry, or `null` when the list is empty or the pointer is stale. */
export function activeGatewayOf(registry: GatewayRegistry): GatewayRecord | null {
  return registry.gateways.find(gateway => gateway.id === registry.activeGatewayId) ?? null
}

export function gatewayById(registry: GatewayRegistry, id: string | null | undefined): GatewayRecord | null {
  return id ? (registry.gateways.find(gateway => gateway.id === id) ?? null) : null
}

/**
 * Add an entry. The first one added is active; a later one is not.
 *
 * That asymmetry is the whole of "Add gateway" in Settings: a reader adding a
 * second gateway is describing a machine, not asking to be moved onto it, and
 * an add that switched would tear down a live connection somebody was using.
 * The first entry is different only because there is nothing to tear down and
 * nowhere else to point.
 */
export function addGateway(registry: GatewayRegistry, record: GatewayRecord): GatewayRegistry {
  const gateways = [...registry.gateways.filter(gateway => gateway.id !== record.id), record]

  return {
    ...registry,
    gateways,
    activeGatewayId: registry.activeGatewayId ?? record.id
  }
}

/** Replace one entry's fields, leaving every other entry alone. */
export function updateGateway(
  registry: GatewayRegistry,
  id: string,
  patch: Partial<Omit<GatewayRecord, 'id'>>
): GatewayRegistry {
  return {
    ...registry,
    gateways: registry.gateways.map(gateway => (gateway.id === id ? { ...gateway, ...patch } : gateway))
  }
}

export function renameGateway(registry: GatewayRegistry, id: string, name: string): GatewayRegistry {
  const trimmed = name.trim()
  const current = gatewayById(registry, id)

  // An empty name would leave a row with nothing on it, so it falls back to
  // what the wizard would have called it rather than being refused: the reader
  // cleared the field, which reads as "use the default", not as an error.
  return updateGateway(registry, id, { name: trimmed || defaultGatewayName(current?.address ?? '') })
}

/**
 * Take one out, and leave a list that still points somewhere.
 *
 * Removing the ACTIVE entry moves the pointer to whatever is left, oldest
 * first, so that the app lands on a gateway rather than on the wizard whenever
 * it still has one. An empty list points at nothing, which is the state a fresh
 * install is in and the one the wizard already owns.
 */
export function removeGateway(registry: GatewayRegistry, id: string): GatewayRegistry {
  const gateways = registry.gateways.filter(gateway => gateway.id !== id)

  if (registry.activeGatewayId !== id) {
    return { ...registry, gateways }
  }

  return { ...registry, gateways, activeGatewayId: gateways[0]?.id ?? null }
}

/** Point at another entry. An id that is not in the list is ignored. */
export function setActiveGateway(registry: GatewayRegistry, id: string): GatewayRegistry {
  return registry.gateways.some(gateway => gateway.id === id) ? { ...registry, activeGatewayId: id } : registry
}

/** The list in the order a screen draws it: oldest first, so rows do not move. */
export function gatewaysInOrder(registry: GatewayRegistry): GatewayRecord[] {
  return [...registry.gateways].sort((left, right) => left.addedAt - right.addedAt || left.id.localeCompare(right.id))
}

const AUTH_KINDS: readonly GatewayAuthMode[] = ['native_pkce', 'session_token', 'cookie']

/** Read one row defensively: it arrived from disk and may predate any field here. */
function asRecord(value: unknown): GatewayRecord | null {
  if (!value || typeof value !== 'object') {
    return null
  }

  const raw = value as Record<string, unknown>

  if (!isGatewayId(raw.id) || typeof raw.address !== 'string' || !raw.address) {
    return null
  }

  const authKind = (AUTH_KINDS as readonly string[]).includes(raw.authKind as string)
    ? (raw.authKind as GatewayAuthMode)
    : 'native_pkce'

  return {
    id: raw.id,
    name: typeof raw.name === 'string' && raw.name ? raw.name : defaultGatewayName(raw.address),
    address: raw.address,
    authKind,
    ...(typeof raw.signedInUser === 'string' && raw.signedInUser ? { signedInUser: raw.signedInUser } : {}),
    addedAt: typeof raw.addedAt === 'number' && Number.isFinite(raw.addedAt) ? raw.addedAt : 0
  }
}

/** Read a stored registry, dropping rows that are not rows. */
export function asRegistry(value: unknown): GatewayRegistry {
  if (!value || typeof value !== 'object') {
    return EMPTY_REGISTRY
  }

  const raw = value as Record<string, unknown>

  if (raw.v !== GATEWAY_REGISTRY_VERSION) {
    return EMPTY_REGISTRY
  }

  const gateways = (Array.isArray(raw.gateways) ? raw.gateways : [])
    .map(asRecord)
    .filter((record): record is GatewayRecord => record !== null)

  const activeGatewayId =
    typeof raw.activeGatewayId === 'string' && gateways.some(gateway => gateway.id === raw.activeGatewayId)
      ? raw.activeGatewayId
      : (gateways[0]?.id ?? null)

  return { v: GATEWAY_REGISTRY_VERSION, gateways, activeGatewayId }
}

/**
 * The entry a single stored config becomes.
 *
 * Everything on it is already on disk, which is what makes this a rename rather
 * than a question: the address and the auth mode come off the config, and the
 * name is the host the reader typed. `addedAt` is now, because there is no
 * record of when the gateway was first set up and a made-up earlier date would
 * be a fact nobody established.
 */
export function recordFromConfig(config: StoredGatewayConfig, id: string, now: number): GatewayRecord {
  return {
    id,
    name: defaultGatewayName(config.baseUrl),
    address: config.baseUrl,
    authKind: config.authMode,
    ...(config.userDisplayName ? { signedInUser: config.userDisplayName } : {}),
    addedAt: now
  }
}

/**
 * Fold a freshly saved configuration back into the active entry.
 *
 * The wizard writes a `StoredGatewayConfig`; the registry has to agree with it
 * afterwards, or the list would name an address the app is no longer dialling.
 * With nothing active — a first run, or a reader who removed their last entry
 * and then set one up — this ADDS the entry instead, which is the same sentence
 * from the other end.
 *
 * A name the reader typed survives an address change and a default one does
 * not. Renaming is a statement about the machine ("Work", "The Pi"), and a
 * machine that moved to another address is still that machine; a name that is
 * merely the old host, left behind next to a new one, is just wrong.
 */
export function reconcileActiveGateway(
  registry: GatewayRegistry,
  config: StoredGatewayConfig,
  now: number
): GatewayRegistry {
  const active = activeGatewayOf(registry)

  if (!active) {
    return addGateway(registry, recordFromConfig(config, newGatewayId(), now))
  }

  const renamed = active.name !== defaultGatewayName(active.address)

  return updateGateway(registry, active.id, {
    address: config.baseUrl,
    authKind: config.authMode,
    name: renamed ? active.name : defaultGatewayName(config.baseUrl),
    // Absent rather than empty: the gateway did not name anybody this time, and
    // a blank row under "Signed in as" says less than no row at all.
    ...(config.userDisplayName ? { signedInUser: config.userDisplayName } : { signedInUser: undefined })
  })
}

export interface LoadRegistryResult {
  registry: GatewayRegistry
  /**
   * The id the single stored gateway was given, when this launch was the one
   * that migrated it.
   *
   * The caller needs it because the registry entry is only half of the move:
   * everything else on disk is still under the unsuffixed keys, and
   * `gateway/migrate.ts` is what carries those across. Null on every launch
   * after the first.
   */
  migratedId: string | null
}

/**
 * Read the registry, creating the first entry out of a single stored gateway.
 *
 * The migration runs exactly once and is decided by the registry key being
 * ABSENT rather than by the list being empty: a reader who removed their last
 * gateway has an empty list on purpose, and re-adopting the config they just
 * deleted would put it back on the next launch.
 *
 * A device that has never been set up writes nothing. An abandoned wizard
 * should leave no more behind than it did before this existed.
 */
export async function loadGatewayRegistry(now: number = Date.now()): Promise<LoadRegistryResult> {
  const stored = await keyValueStore.getJson<unknown>(GATEWAY_REGISTRY_KEY)

  if (stored !== null) {
    return { registry: asRegistry(stored), migratedId: null }
  }

  const config = await keyValueStore.getJson<StoredGatewayConfig>(CONFIG_KEY)

  if (!config || typeof config.baseUrl !== 'string' || !config.baseUrl) {
    return { registry: EMPTY_REGISTRY, migratedId: null }
  }

  const id = newGatewayId()
  const registry = addGateway(EMPTY_REGISTRY, recordFromConfig(config, id, now))

  await saveGatewayRegistry(registry)

  return { registry, migratedId: id }
}

export async function saveGatewayRegistry(registry: GatewayRegistry): Promise<void> {
  await keyValueStore.setJson(GATEWAY_REGISTRY_KEY, registry)
}
