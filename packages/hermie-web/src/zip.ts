/**
 * Just enough ZIP to unpack a release.
 *
 * Node has no archive API and this package has no runtime dependencies, so the
 * central directory is read by hand. That is a deliberate trade and a small
 * one: a release zip is produced by `actions/upload` and uses exactly two
 * storage methods — stored (0) and deflate (8) — both of which `node:zlib`
 * already knows. Anything else is refused rather than guessed at.
 *
 * The security rule here is the same one every archive extractor gets wrong:
 * **an entry name is untrusted input.** A name containing `..` or an absolute
 * path is how an archive writes outside the directory it was extracted into, so
 * every entry is resolved and checked against the destination before a single
 * byte is written.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { inflateRawSync } from 'node:zlib'

const END_OF_CENTRAL_DIRECTORY = 0x06054b50
const CENTRAL_FILE_HEADER = 0x02014b50
const LOCAL_FILE_HEADER = 0x04034b50

export interface ZipEntry {
  name: string
  data: Buffer
  /** Unix mode from the external attributes, when the archive carried one. */
  mode: number
}

export function readZip(buffer: Buffer): ZipEntry[] {
  const end = findEndOfCentralDirectory(buffer)
  const count = buffer.readUInt16LE(end + 10)
  let offset = buffer.readUInt32LE(end + 16)
  const entries: ZipEntry[] = []

  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(offset) !== CENTRAL_FILE_HEADER) {
      throw new Error('This is not a readable zip: the central directory is malformed.')
    }

    const method = buffer.readUInt16LE(offset + 10)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const externalAttributes = buffer.readUInt32LE(offset + 38)
    const localOffset = buffer.readUInt32LE(offset + 42)
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength)

    entries.push({
      name,
      mode: (externalAttributes >>> 16) & 0o7777,
      data: readLocal(buffer, localOffset, method, compressedSize)
    })

    offset += 46 + nameLength + extraLength + commentLength
  }

  return entries
}

function readLocal(buffer: Buffer, offset: number, method: number, compressedSize: number): Buffer {
  if (buffer.readUInt32LE(offset) !== LOCAL_FILE_HEADER) {
    throw new Error('This is not a readable zip: a local file header is missing.')
  }

  const nameLength = buffer.readUInt16LE(offset + 26)
  const extraLength = buffer.readUInt16LE(offset + 28)
  const start = offset + 30 + nameLength + extraLength
  const raw = buffer.subarray(start, start + compressedSize)

  if (method === 0) {
    return Buffer.from(raw)
  }

  if (method === 8) {
    return inflateRawSync(raw)
  }

  throw new Error(`This zip uses compression method ${method}, which Hermie Web cannot read.`)
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  // The record is at the very end unless the archive carries a comment, which
  // is at most 64 KiB, so that is how far back it is worth looking.
  const floor = Math.max(0, buffer.length - 0x1_00_00 - 22)

  for (let offset = buffer.length - 22; offset >= floor; offset -= 1) {
    if (buffer.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY) {
      return offset
    }
  }

  throw new Error('This is not a zip file.')
}

/** Resolve one entry inside `destination`, or `null` when it would escape. */
export function safeEntryPath(destination: string, name: string): string | null {
  if (name.includes('\0') || path.isAbsolute(name) || /^[a-z]:/i.test(name)) {
    return null
  }

  const absolute = path.resolve(destination, name)
  const relative = path.relative(destination, absolute)

  return relative.startsWith('..') || path.isAbsolute(relative) ? null : absolute
}

/**
 * Unpack every entry into `destination`.
 *
 * `stripTopLevel` drops the single wrapper directory a release zip normally
 * has, so `hermie-web/dist/...` lands as `dist/...`.
 */
export async function extractZip(
  buffer: Buffer,
  destination: string,
  options: { stripTopLevel?: boolean } = {}
): Promise<number> {
  const entries = readZip(buffer)
  const strip = options.stripTopLevel === true ? commonTopLevel(entries) : ''
  let written = 0

  for (const entry of entries) {
    const name = strip && entry.name.startsWith(strip) ? entry.name.slice(strip.length) : entry.name

    if (!name || name.endsWith('/')) {
      continue
    }

    const absolute = safeEntryPath(destination, name)

    if (!absolute) {
      throw new Error(`The archive contains an entry that would be written outside the target: ${entry.name}`)
    }

    await mkdir(path.dirname(absolute), { recursive: true })
    await writeFile(absolute, entry.data, entry.mode ? { mode: entry.mode } : undefined)
    written += 1
  }

  return written
}

function commonTopLevel(entries: ZipEntry[]): string {
  const first = entries[0]?.name.split('/')[0]

  if (!first) {
    return ''
  }

  return entries.every(entry => entry.name === first || entry.name.startsWith(`${first}/`)) ? `${first}/` : ''
}
