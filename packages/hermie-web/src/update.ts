/**
 * Self-update: telling the operator a newer Hermie Web exists, and — where the
 * install shape allows it — fetching and switching to it.
 *
 * The design in one paragraph. A release on GitHub carries `hermie-web.zip` and
 * a `SHA256SUMS` next to it. `GET /hermie/update` compares the running version
 * with the newest tag and says whether an update can be applied HERE;
 * `POST /hermie/update` downloads the zip over https, checks it against the
 * published digest, unpacks it into `<installRoot>/releases/<version>/`, flips
 * a `current` symlink and then exits so the supervisor starts the new code.
 *
 * Two things are refused outright rather than half-done:
 *
 *  - **An install this process does not own.** In Docker the image IS the
 *    version, and writing a new one inside the container would be undone by the
 *    next `docker run`; an `npm -g` install belongs to npm. Both answer
 *    `canSelfUpdate: false` with the command that actually works.
 *  - **A caller without a gateway session.** The endpoint runs code on the
 *    operator's server, so it is gated on exactly the credential the rest of the
 *    app uses: the request's own cookies are put to the gateway's
 *    `/api/auth/me`, and anything but a 200 is a 401 here. Hermie Web has no
 *    user database of its own and is not about to grow one.
 *
 * What is NOT claimed: nothing here verifies a signature. The digest proves the
 * bytes match what the release lists, and https proves they came from GitHub;
 * an attacker who can publish a release can publish a matching digest. That is
 * the same trust as `npm i -g`, and it is stated in the ADR rather than dressed
 * up.
 */
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readlink, rename, rm, symlink, writeFile, readFile } from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'

import { extractZip } from './zip'

export const RELEASES_URL = 'https://api.github.com/repos/fullstackstudio-nl/hermie/releases/latest'
export const RELEASE_ASSET = 'hermie-web.zip'
export const CHECKSUM_ASSET = 'SHA256SUMS'
/** How long a release listing is trusted before it is fetched again. */
export const RELEASE_CACHE_TTL_MS = 6 * 60 * 60 * 1000

export interface ReleaseInfo {
  version: string
  publishedAt: string
  notesUrl: string
  zipUrl: string
  checksumUrl: string
}

export interface UpdateStatus {
  current: string
  latest: string | null
  publishedAt: string | null
  notesUrl: string | null
  canSelfUpdate: boolean
  updateAvailable: boolean
  reason?: string
}

/**
 * Compare two versions the way a release tag means them.
 *
 * Numeric parts compare numerically, so `0.10.0` is newer than `0.9.0`; a
 * pre-release suffix sorts BEFORE the release it precedes, so `1.0.0-rc.1` is
 * older than `1.0.0`. Anything unparseable compares as equal rather than as
 * newer — an update offered because a version string was odd is worse than an
 * update not offered.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string) => {
    const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-(.+))?$/.exec(value.trim())

    return match
      ? {
          numbers: [Number(match[1] ?? 0), Number(match[2] ?? 0), Number(match[3] ?? 0)],
          pre: match[4] ?? ''
        }
      : null
  }

  const left = parse(a)
  const right = parse(b)

  if (!left || !right) {
    return 0
  }

  for (let index = 0; index < 3; index += 1) {
    const difference = (left.numbers[index] ?? 0) - (right.numbers[index] ?? 0)

    if (difference !== 0) {
      return difference < 0 ? -1 : 1
    }
  }

  if (left.pre === right.pre) {
    return 0
  }

  if (!left.pre) {
    return 1
  }

  if (!right.pre) {
    return -1
  }

  return left.pre < right.pre ? -1 : 1
}

/** Read one GitHub "latest release" body into the four things we need from it. */
export function parseRelease(body: unknown): ReleaseInfo | null {
  if (!body || typeof body !== 'object') {
    return null
  }

  const release = body as {
    tag_name?: unknown
    name?: unknown
    published_at?: unknown
    html_url?: unknown
    assets?: unknown
  }
  const tag = typeof release.tag_name === 'string' ? release.tag_name : ''

  if (!tag) {
    return null
  }

  const assets = Array.isArray(release.assets) ? release.assets : []
  const urlOf = (assetName: string): string => {
    const found = assets.find(
      (asset): asset is { name: string; browser_download_url: string } =>
        Boolean(asset) &&
        typeof asset === 'object' &&
        (asset as { name?: unknown }).name === assetName &&
        typeof (asset as { browser_download_url?: unknown }).browser_download_url === 'string'
    )

    return found?.browser_download_url ?? ''
  }

  const zipUrl = urlOf(RELEASE_ASSET)

  if (!zipUrl) {
    // A release without the web artefact is a release of the apps only; there
    // is nothing here to update to.
    return null
  }

  return {
    version: tag.replace(/^v/, ''),
    publishedAt: typeof release.published_at === 'string' ? release.published_at : '',
    notesUrl: typeof release.html_url === 'string' ? release.html_url : '',
    zipUrl,
    checksumUrl: urlOf(CHECKSUM_ASSET)
  }
}

export type FetchJson = (url: string) => Promise<unknown>

/**
 * The newest release, remembered.
 *
 * GitHub rate-limits unauthenticated API calls per IP, and a settings screen
 * that polls would spend that budget for nothing, so the listing is fetched at
 * start, once every six hours after that, and on an explicit refresh. A failed
 * fetch keeps the previous answer rather than replacing it with `null`: the
 * network being down is not news about the release.
 */
export class ReleaseCache {
  private value: ReleaseInfo | null = null
  private fetchedAt = 0
  private inFlight: Promise<ReleaseInfo | null> | null = null

  constructor(
    private readonly readReleases: FetchJson = fetchJson,
    private readonly ttlMs: number = RELEASE_CACHE_TTL_MS,
    private readonly now: () => number = () => Date.now()
  ) {}

  get cached(): ReleaseInfo | null {
    return this.value
  }

  async get(options: { force?: boolean } = {}): Promise<ReleaseInfo | null> {
    const fresh = this.value !== null && this.now() - this.fetchedAt < this.ttlMs

    if (fresh && options.force !== true) {
      return this.value
    }

    if (!this.inFlight) {
      this.inFlight = this.readReleases(RELEASES_URL)
        .then(body => {
          const parsed = parseRelease(body)

          if (parsed) {
            this.value = parsed
            this.fetchedAt = this.now()
          }

          return this.value
        })
        .catch(() => this.value)
        .finally(() => {
          this.inFlight = null
        })
    }

    return this.inFlight
  }
}

export interface InstallShape {
  canSelfUpdate: boolean
  reason?: string
}

/**
 * Can this process replace its own code, and if not, what should the operator
 * run instead?
 *
 * The two "no" answers are not failures; they are the honest description of an
 * install somebody else manages.
 */
export function detectInstallShape(
  options: { selfUpdate: boolean; installRoot: string; env?: NodeJS.ProcessEnv } = {
    selfUpdate: true,
    installRoot: ''
  }
): InstallShape {
  const env = options.env ?? process.env

  if (!options.selfUpdate) {
    return { canSelfUpdate: false, reason: 'Self-update is switched off (--no-self-update).' }
  }

  if (env.HERMIE_IN_DOCKER === '1' || existsSync('/.dockerenv')) {
    return {
      canSelfUpdate: false,
      reason: 'This is a container; the image is the version. Update with `docker pull` and recreate the container.'
    }
  }

  if (isGlobalNpmInstall(options.installRoot)) {
    return {
      canSelfUpdate: false,
      reason: 'This copy is managed by npm. Update with `npm i -g @hermie/web@latest`.'
    }
  }

  return { canSelfUpdate: true }
}

function isGlobalNpmInstall(installRoot: string): boolean {
  const normalized = installRoot.split(path.sep).join('/')

  return /\/(lib\/)?node_modules\//.test(`${normalized}/`)
}

export interface UpdateSession {
  gatewayUrl: string
  cookie: string | undefined
}

/**
 * Is the caller signed in to the gateway?
 *
 * Asked by handing the request's own `Cookie` header to the gateway's
 * `/api/auth/me` and reading the status. Deliberately not a local check:
 * Hermie Web has no idea what a valid session looks like, and the gateway does.
 */
export async function hasGatewaySession(session: UpdateSession): Promise<boolean> {
  if (!session.cookie) {
    return false
  }

  const url = new URL('/api/auth/me', session.gatewayUrl)
  const client = url.protocol === 'https:' ? https : http

  return new Promise<boolean>(resolve => {
    const request = client.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'GET',
        headers: {
          cookie: session.cookie as string,
          host: new URL(session.gatewayUrl).host,
          accept: 'application/json'
        }
      },
      response => {
        response.resume()
        resolve(response.statusCode === 200)
      }
    )

    request.on('error', () => resolve(false))
    request.end()
  })
}

export function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

/**
 * Find one file's digest in a `SHA256SUMS` body.
 *
 * `sha256sum` writes `<hex>  <name>`, with the name sometimes prefixed by `*`
 * for binary mode. A file the list does not mention is a failure, not a pass.
 */
export function digestFor(checksums: string, fileName: string): string | null {
  for (const line of checksums.split('\n')) {
    const match = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/i.exec(line.trim())

    if (match && path.basename(match[2] ?? '') === fileName) {
      return (match[1] ?? '').toLowerCase()
    }
  }

  return null
}

export function verifyDownload(zip: Buffer, checksums: string, fileName = RELEASE_ASSET): void {
  const expected = digestFor(checksums, fileName)

  if (!expected) {
    throw new Error(`The release's ${CHECKSUM_ASSET} does not list ${fileName}; refusing to install it.`)
  }

  const actual = sha256(zip)

  if (actual !== expected) {
    throw new Error(`${fileName} does not match the published digest; refusing to install it.`)
  }
}

/**
 * Point `current` at one release directory, atomically.
 *
 * `symlink` then `rename` rather than `unlink` then `symlink`: the second pair
 * has a window in which `current` does not exist at all, and a restart landing
 * in that window has nothing to run. `rename` over an existing link is atomic
 * on every POSIX filesystem.
 */
export async function switchCurrent(installRoot: string, version: string): Promise<void> {
  const target = path.join(installRoot, 'releases', version)

  if (!existsSync(target)) {
    throw new Error(`There is no unpacked release at ${target}.`)
  }

  const link = path.join(installRoot, 'current')
  const staging = path.join(installRoot, `.current.${process.pid}`)

  await rm(staging, { force: true })
  await symlink(target, staging, 'dir')
  await rename(staging, link)
}

/** Which version `current` points at, or `null` when nothing does. */
export async function currentVersion(installRoot: string): Promise<string | null> {
  try {
    return path.basename(await readlink(path.join(installRoot, 'current')))
  } catch {
    return null
  }
}

/**
 * Go back to the release before this one.
 *
 * "Before" is decided by version order over what is actually on disk, not by a
 * remembered pointer: a pointer can be stale after a manual `rm`, and the
 * directory listing cannot.
 */
export async function rollback(installRoot: string): Promise<string> {
  const releasesDir = path.join(installRoot, 'releases')
  const versions = (await readdir(releasesDir, { withFileTypes: true }))
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort(compareVersions)
  const active = await currentVersion(installRoot)
  const previous = [...versions].reverse().find(version => active === null || compareVersions(version, active) < 0)

  if (!previous) {
    throw new Error('There is no earlier release to roll back to.')
  }

  await switchCurrent(installRoot, previous)

  return previous
}

export interface ApplyUpdateOptions {
  installRoot: string
  release: ReleaseInfo
  download?: (url: string) => Promise<Buffer>
  /** Install production dependencies when the zip did not bundle them. */
  installDependencies?: (directory: string) => Promise<void>
}

/**
 * Download, verify, unpack and switch. It does NOT restart; the caller answers
 * the HTTP request first and then decides how this process goes away.
 */
export async function applyUpdate(options: ApplyUpdateOptions): Promise<string> {
  const download = options.download ?? downloadBuffer
  const { release, installRoot } = options

  if (!release.checksumUrl) {
    throw new Error(`This release publishes no ${CHECKSUM_ASSET}; refusing to install it unverified.`)
  }

  const [zip, checksums] = await Promise.all([
    download(release.zipUrl),
    download(release.checksumUrl).then(buffer => buffer.toString('utf8'))
  ])

  verifyDownload(zip, checksums)

  const target = path.join(installRoot, 'releases', release.version)
  const staging = `${target}.incoming`

  // A half-unpacked directory must never become a release, so the unpack lands
  // beside the real name and is renamed into place once it is complete.
  await rm(staging, { recursive: true, force: true })
  await mkdir(staging, { recursive: true })
  await extractZip(zip, staging, { stripTopLevel: true })

  // The server has no runtime dependencies, so a release zip carries neither a
  // lockfile nor node_modules, and `npm ci` would refuse it. Only a package that
  // declares dependencies and ships its lockfile gets an install.
  if (!existsSync(path.join(staging, 'node_modules')) && (await declaresRuntimeDependencies(staging))) {
    await (options.installDependencies ?? npmCiOmitDev)(staging)
  }

  await rm(target, { recursive: true, force: true })
  await rename(staging, target)
  await switchCurrent(installRoot, release.version)

  return release.version
}

async function declaresRuntimeDependencies(directory: string): Promise<boolean> {
  try {
    const manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    const count = Object.keys(manifest.dependencies ?? {}).length
    return count > 0 && existsSync(path.join(directory, 'package-lock.json'))
  } catch {
    return false
  }
}

function npmCiOmitDev(directory: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn('npm', ['ci', '--omit=dev'], { cwd: directory, stdio: 'inherit' })

    child.on('error', reject)
    child.on('exit', code =>
      code === 0 ? resolve() : reject(new Error(`npm ci --omit=dev failed with exit code ${String(code)}.`))
    )
  })
}

/**
 * Stop this process so the new code runs.
 *
 * Under a supervisor (`systemd` with `Restart=always`, Docker's restart policy,
 * a process manager) exiting 0 IS the restart, and it is the only correct one:
 * re-executing inside the old process would leave the unit's notion of its main
 * PID pointing at something that no longer exists. With no supervisor there is
 * nothing to bring it back, so a detached child is spawned first — which is
 * strictly worse (no logs, no restart on crash) and is documented as the
 * fallback it is.
 */
export function restartProcess(
  options: { supervised: boolean; exit?: (code: number) => void } = { supervised: true }
): void {
  const exit = options.exit ?? ((code: number) => process.exit(code))

  if (!options.supervised) {
    const child = spawn(process.execPath, process.argv.slice(1), {
      detached: true,
      stdio: 'ignore',
      cwd: process.cwd()
    })
    child.unref()
  }

  exit(0)
}

/** systemd and friends announce themselves; that is the whole detection. */
export function isSupervised(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.INVOCATION_ID || env.NOTIFY_SOCKET || env.SUPERVISOR_ENABLED || env.HERMIE_SUPERVISED === '1')
}

export async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'hermie-web' }
  })

  if (!response.ok) {
    throw new Error(`${url} answered HTTP ${response.status}.`)
  }

  return response.json()
}

async function downloadBuffer(url: string): Promise<Buffer> {
  if (!url.startsWith('https://')) {
    throw new Error('A release asset must be downloaded over https.')
  }

  const response = await fetch(url, { headers: { 'user-agent': 'hermie-web' }, redirect: 'follow' })

  if (!response.ok) {
    throw new Error(`${url} answered HTTP ${response.status}.`)
  }

  return Buffer.from(await response.arrayBuffer())
}

/** Write a marker file so an operator can see what a release directory is. */
export async function writeReleaseMarker(directory: string, version: string): Promise<void> {
  await writeFile(path.join(directory, '.hermie-release'), `${version}\n`, 'utf8')
}

export function statusFrom(current: string, release: ReleaseInfo | null, shape: InstallShape): UpdateStatus {
  const latest = release?.version ?? null

  return {
    current,
    latest,
    publishedAt: release?.publishedAt ?? null,
    notesUrl: release?.notesUrl ?? null,
    canSelfUpdate: shape.canSelfUpdate,
    updateAvailable: latest !== null && compareVersions(latest, current) > 0,
    ...(shape.reason ? { reason: shape.reason } : {})
  }
}
