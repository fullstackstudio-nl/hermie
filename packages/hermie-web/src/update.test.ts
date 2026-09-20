import { deflateRawSync } from 'node:zlib'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { type FakeGateway, startFakeGateway } from '@hermie/fake-gateway'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { startHermieWeb, type HermieWebServer } from './server'
import {
  applyUpdate,
  compareVersions,
  currentVersion,
  detectInstallShape,
  digestFor,
  parseRelease,
  ReleaseCache,
  type ReleaseInfo,
  rollback,
  sha256,
  statusFrom,
  switchCurrent,
  verifyDownload
} from './update'
import { extractZip, readZip } from './zip'

/**
 * A GitHub "latest release" body as the API actually answers it, trimmed to the
 * fields this code reads. Recorded rather than invented so the parser is tested
 * against the shape it will meet.
 */
const RELEASE_JSON = {
  url: 'https://api.github.com/repos/fullstackstudio-nl/hermie/releases/198342001',
  html_url: 'https://github.com/fullstackstudio-nl/hermie/releases/tag/v0.2.0',
  tag_name: 'v0.2.0',
  name: 'v0.2.0',
  draft: false,
  prerelease: false,
  created_at: '2026-09-25T09:11:04Z',
  published_at: '2026-09-25T09:20:31Z',
  assets: [
    {
      name: 'Hermie-android-release.apk',
      browser_download_url:
        'https://github.com/fullstackstudio-nl/hermie/releases/download/v0.2.0/Hermie-android-release.apk'
    },
    {
      name: 'hermie-web.zip',
      browser_download_url: 'https://github.com/fullstackstudio-nl/hermie/releases/download/v0.2.0/hermie-web.zip'
    },
    {
      name: 'SHA256SUMS',
      browser_download_url: 'https://github.com/fullstackstudio-nl/hermie/releases/download/v0.2.0/SHA256SUMS'
    }
  ]
}

describe('version comparison', () => {
  it('orders releases the way a tag means them', () => {
    expect(compareVersions('0.2.0', '0.1.9')).toBe(1)
    expect(compareVersions('0.10.0', '0.9.0')).toBe(1)
    expect(compareVersions('v1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBe(-1)
    expect(compareVersions('1.0.0', '1.0.1')).toBe(-1)
  })

  it('treats an unreadable version as no news rather than as newer', () => {
    expect(compareVersions('nightly', '0.1.0')).toBe(0)
  })
})

describe('release listing', () => {
  it('reads the tag, the notes and both assets out of a recorded body', () => {
    const release = parseRelease(RELEASE_JSON)

    expect(release?.version).toBe('0.2.0')
    expect(release?.publishedAt).toBe('2026-09-25T09:20:31Z')
    expect(release?.notesUrl).toContain('/releases/tag/v0.2.0')
    expect(release?.zipUrl).toContain('hermie-web.zip')
    expect(release?.checksumUrl).toContain('SHA256SUMS')
  })

  it('ignores a release that carries no web artefact', () => {
    expect(parseRelease({ ...RELEASE_JSON, assets: [RELEASE_JSON.assets[0]] })).toBeNull()
  })

  it('fetches once inside its window and again when forced', async () => {
    let calls = 0
    const cache = new ReleaseCache(
      async () => {
        calls += 1

        return RELEASE_JSON
      },
      60_000,
      () => 1000
    )

    expect((await cache.get())?.version).toBe('0.2.0')
    await cache.get()
    expect(calls).toBe(1)

    await cache.get({ force: true })
    expect(calls).toBe(2)
  })

  it('keeps the last good answer when the network fails', async () => {
    let calls = 0
    const cache = new ReleaseCache(async () => {
      calls += 1

      if (calls > 1) {
        throw new Error('offline')
      }

      return RELEASE_JSON
    }, 0)

    await cache.get()
    expect((await cache.get())?.version).toBe('0.2.0')
  })

  it('reports an update as available only when the tag is newer', () => {
    const release = parseRelease(RELEASE_JSON) as ReleaseInfo

    expect(statusFrom('0.1.0', release, { canSelfUpdate: true }).updateAvailable).toBe(true)
    expect(statusFrom('0.2.0', release, { canSelfUpdate: true }).updateAvailable).toBe(false)
    expect(statusFrom('0.3.0', release, { canSelfUpdate: true }).updateAvailable).toBe(false)
  })
})

describe('install shape', () => {
  it('refuses inside a container, and says what to run instead', () => {
    const shape = detectInstallShape({
      selfUpdate: true,
      installRoot: '/opt/hermie-web',
      env: { HERMIE_IN_DOCKER: '1' }
    })

    expect(shape.canSelfUpdate).toBe(false)
    expect(shape.reason).toContain('docker pull')
  })

  it('refuses a global npm install, and says what to run instead', () => {
    const shape = detectInstallShape({
      selfUpdate: true,
      installRoot: '/usr/local/lib/node_modules/hermie-web',
      env: {}
    })

    expect(shape.canSelfUpdate).toBe(false)
    expect(shape.reason).toContain('npm i -g')
  })

  it('refuses when it was switched off', () => {
    expect(detectInstallShape({ selfUpdate: false, installRoot: '/opt/hermie-web', env: {} }).canSelfUpdate).toBe(false)
  })

  it('allows a plain directory install', () => {
    expect(detectInstallShape({ selfUpdate: true, installRoot: '/opt/hermie-web', env: {} }).canSelfUpdate).toBe(true)
  })
})

describe('download verification', () => {
  const zip = Buffer.from('not really a zip, but it has a digest')

  it('accepts bytes the release listed', () => {
    expect(() => verifyDownload(zip, `${sha256(zip)}  hermie-web.zip\n`)).not.toThrow()
  })

  it('refuses bytes the digest does not match', () => {
    expect(() => verifyDownload(zip, `${'0'.repeat(64)}  hermie-web.zip\n`)).toThrow(/does not match/)
  })

  it('refuses a release whose SHA256SUMS does not mention the asset', () => {
    expect(() => verifyDownload(zip, `${sha256(zip)}  something-else.zip\n`)).toThrow(/does not list/)
  })

  it('reads the binary-mode form sha256sum writes', () => {
    expect(digestFor(`${'a'.repeat(64)} *hermie-web.zip`, 'hermie-web.zip')).toBe('a'.repeat(64))
  })
})

describe('release directories', () => {
  it('switches current and rolls back again', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'hermie-web-install-'))
    await mkdir(path.join(root, 'releases', '0.1.0'), { recursive: true })
    await mkdir(path.join(root, 'releases', '0.2.0'), { recursive: true })

    await switchCurrent(root, '0.1.0')
    expect(await currentVersion(root)).toBe('0.1.0')

    // Switching over an EXISTING link is the case that breaks a naive
    // unlink-then-symlink, so it is the one worth asserting.
    await switchCurrent(root, '0.2.0')
    expect(await currentVersion(root)).toBe('0.2.0')

    expect(await rollback(root)).toBe('0.1.0')
    expect(await currentVersion(root)).toBe('0.1.0')
  })

  it('refuses to point current at a release that is not unpacked', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'hermie-web-install-'))
    await mkdir(path.join(root, 'releases'), { recursive: true })

    await expect(switchCurrent(root, '9.9.9')).rejects.toThrow(/no unpacked release/)
  })

  it('leaves current alone when the download fails verification', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'hermie-web-install-'))
    await mkdir(path.join(root, 'releases', '0.1.0'), { recursive: true })
    await switchCurrent(root, '0.1.0')

    const release = parseRelease(RELEASE_JSON) as ReleaseInfo

    await expect(
      applyUpdate({
        installRoot: root,
        release,
        download: async url =>
          url.endsWith('SHA256SUMS') ? Buffer.from(`${'0'.repeat(64)}  hermie-web.zip\n`) : Buffer.from('payload')
      })
    ).rejects.toThrow(/does not match/)

    expect(await currentVersion(root)).toBe('0.1.0')
  })

  it('unpacks a verified zip and switches to it', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'hermie-web-install-'))
    await mkdir(path.join(root, 'releases', '0.1.0'), { recursive: true })
    await switchCurrent(root, '0.1.0')

    const zip = makeZip([
      ['hermie-web/package.json', '{"name":"hermie-web"}'],
      ['hermie-web/node_modules/.keep', ''],
      ['hermie-web/dist/web/index.html', '<!doctype html>']
    ])
    const release = parseRelease(RELEASE_JSON) as ReleaseInfo

    await applyUpdate({
      installRoot: root,
      release,
      download: async url => (url.endsWith('SHA256SUMS') ? Buffer.from(`${sha256(zip)}  hermie-web.zip\n`) : zip)
    })

    expect(await currentVersion(root)).toBe('0.2.0')
    expect(await readFile(path.join(root, 'current', 'package.json'), 'utf8')).toContain('hermie-web')
    expect(await readFile(path.join(root, 'current', 'dist', 'web', 'index.html'), 'utf8')).toContain('doctype')
    // And the one before it is still there, which is what makes the rollback
    // above possible after a real update.
    expect(await rollback(root)).toBe('0.1.0')
  })
})

describe('the zip reader', () => {
  it('reads stored and deflated entries', async () => {
    const zip = makeZip([
      ['a/one.txt', 'hello'],
      ['a/two.txt', 'x'.repeat(2000)]
    ])
    const entries = readZip(zip)

    expect(entries.map(entry => entry.name)).toEqual(['a/one.txt', 'a/two.txt'])
    expect(entries[0]?.data.toString('utf8')).toBe('hello')

    const target = await mkdtemp(path.join(tmpdir(), 'hermie-web-unzip-'))
    await extractZip(zip, target, { stripTopLevel: true })

    expect(await readFile(path.join(target, 'one.txt'), 'utf8')).toBe('hello')
  })

  it('refuses an entry that would be written outside the target', async () => {
    const zip = makeZip([['../escape.txt', 'no']])
    const target = await mkdtemp(path.join(tmpdir(), 'hermie-web-unzip-'))

    await expect(extractZip(zip, target)).rejects.toThrow(/outside the target/)
  })
})

describe('the update endpoints', () => {
  let gateway: FakeGateway
  let web: HermieWebServer
  let staticDir: string

  beforeAll(async () => {
    staticDir = await mkdtemp(path.join(tmpdir(), 'hermie-web-static-'))
    await writeFile(path.join(staticDir, 'index.html'), '<!doctype html><title>Hermie</title>', 'utf8')

    gateway = await startFakeGateway({ port: 0, auth: 'cookie', streamDelayMs: 1 })
    web = await startHermieWeb({
      gatewayUrl: gateway.url,
      port: 0,
      staticDir,
      version: '0.1.0',
      installRoot: await mkdtemp(path.join(tmpdir(), 'hermie-web-install-')),
      releaseCache: new ReleaseCache(async () => RELEASE_JSON)
    })
  })

  afterAll(async () => {
    await web.close()
    await gateway.close()
  })

  it('reports the running version next to the newest release', async () => {
    const body = (await (await fetch(`${web.url}/hermie/update`)).json()) as Record<string, unknown>

    expect(body.current).toBe('0.1.0')
    expect(body.latest).toBe('0.2.0')
    expect(body.updateAvailable).toBe(true)
    expect(body.canSelfUpdate).toBe(true)
  })

  it('refuses a POST from a caller with no gateway session', async () => {
    const response = await fetch(`${web.url}/hermie/update`, { method: 'POST' })

    expect(response.status).toBe(401)
  })

  it('refuses a POST whose cookie the gateway does not know', async () => {
    const response = await fetch(`${web.url}/hermie/update`, {
      method: 'POST',
      headers: { cookie: 'hermes_session_at=forged' }
    })

    expect(response.status).toBe(401)
  })
})

/** Build a zip in memory: stored under 64 bytes, deflated above it. */
function makeZip(files: [string, string][]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0

  for (const [name, content] of files) {
    const raw = Buffer.from(content, 'utf8')
    const deflated = deflateRawSync(raw)
    const useDeflate = deflated.length < raw.length
    const payload = useDeflate ? deflated : raw
    const nameBytes = Buffer.from(name, 'utf8')
    const crc = crc32(raw)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(useDeflate ? 8 : 0, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    locals.push(local, nameBytes, payload)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(useDeflate ? 8 : 0, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(payload.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt32LE(0o644 << 16, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBytes)

    offset += local.length + nameBytes.length + payload.length
  }

  const localBlock = Buffer.concat(locals)
  const centralBlock = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(centralBlock.length, 12)
  end.writeUInt32LE(localBlock.length, 16)

  return Buffer.concat([localBlock, centralBlock, end])
}

function crc32(buffer: Buffer): number {
  let crc = ~0

  for (const byte of buffer) {
    crc ^= byte

    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
    }
  }

  return ~crc >>> 0
}
