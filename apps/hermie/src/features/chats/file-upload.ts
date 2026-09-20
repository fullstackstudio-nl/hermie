/**
 * Getting a file onto the gateway, and telling the bot where it is.
 *
 * Upstream has no file-attach RPC — `image.attach` / `image.attach_bytes` take
 * images and nothing else — so a file travels over HTTP and the prompt
 * references the stored path. The two halves of that have constraints that do
 * not line up by default, and everything here exists to make them line up. The
 * long version is the 2026-09-19 section of docs/platform-notes.md; the short
 * version is two facts:
 *
 * 1. `POST /api/files/upload-stream` resolves `path` through
 *    `_resolve_managed_path`, which knows nothing about profiles and — on an
 *    ordinary self-hosted gateway, where no root is locked — REFUSES a relative
 *    path outright ("Path must be absolute").
 * 2. The gateway expands `@file:` with `allowed_root` pinned to the session's
 *    own working directory (`tui_gateway/prompt_turn.py:542`). A path outside it
 *    is refused with "path is outside the allowed workspace".
 *
 * Together those mean the file has to be uploaded to an ABSOLUTE path UNDER the
 * session's cwd. Anywhere else and either the upload or the reference fails —
 * uploading to the managed-files root and referencing it, which is the obvious
 * design, fails the second check every time, because the root contains the
 * workspace rather than the other way round.
 *
 * The session's cwd arrives with `session.resume` as `info.cwd`, so the client
 * already knows it. When it does not, this refuses instead of guessing: a
 * plausible-looking wrong directory produces an upload that succeeds and a
 * reference the agent will not read, which is the worst of the options.
 */
import type { GatewayHttp } from '@hermie/gateway-client'

/** `_MANAGED_FILE_MAX_BYTES` in `hermes_cli/web_server.py`. */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024

/**
 * Why an upload did not happen. Named rather than a message, because the screen
 * treats them differently and two of them are not the user's fault:
 *
 * - `too-large`   over the gateway's 100 MB cap. Caught before any bytes move.
 * - `no-workspace` the session never reported a `cwd`, so there is no directory
 *   that satisfies both constraints above.
 * - `refused`     the gateway answered, and said no. A locked managed-files root
 *   that does not contain the session's workspace lands here, and no path the
 *   client could pick would work.
 * - `failed`      the upload did not complete: the socket, the proxy, a 5xx.
 */
export type FileUploadFailureReason = 'too-large' | 'no-workspace' | 'refused' | 'failed'

export class FileUploadError extends Error {
  readonly reason: FileUploadFailureReason
  readonly status?: number

  constructor(reason: FileUploadFailureReason, message: string, status?: number) {
    super(message)
    this.name = 'FileUploadError'
    this.reason = reason

    if (status !== undefined) {
      this.status = status
    }
  }
}

export interface UploadableFile {
  name: string
  size: number
  mimeType: string
  uri: string
}

export interface UploadedFile {
  /** The absolute path on the gateway, as `display_path` reported it. */
  path: string
  /** What the prompt must contain for the agent to read it. */
  reference: string
  filename: string
  size: number
}

export interface UploadFileOptions {
  http: GatewayHttp
  file: UploadableFile
  /** The session's working directory: `SessionLiveInfo.cwd`. */
  cwd: string | undefined
  /** 0…1 where the platform reports it, which React Native's fetch does not. */
  onProgress?: (fraction: number) => void
  /** Injected in tests; the real one streams from a `file://` URI. */
  fetchImpl?: typeof fetch
  /** Injected in tests, so a path is predictable. */
  now?: Date
  token?: string
}

/**
 * A filename that cannot mean anything but itself.
 *
 * Path separators, `..`, control characters and leading dots are all removed
 * rather than escaped: the name is appended to a directory this module chose,
 * and a name that can climb out of it defeats the whole point of choosing one.
 */
export function sanitiseUploadName(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? ''
  const cleaned = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]+/g, '-')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+/, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 80)

  return cleaned || 'attachment'
}

const pad = (value: number): string => String(value).padStart(2, '0')

/** `2026-09-19`, in the phone's zone — a folder name, not a timestamp anyone computes with. */
function dateFolder(now: Date): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/**
 * Enough randomness that two uploads of the same name on the same day cannot
 * collide, short enough to stay readable in a path the bot will quote back.
 */
function randomToken(): string {
  return Math.random().toString(36).slice(2, 10).padEnd(8, '0')
}

/**
 * `<cwd>/uploads/hermie/<yyyy-mm-dd>/<random>-<name>`.
 *
 * Under the session's cwd because nowhere else satisfies both the upload and the
 * reference (see the module comment). `uploads/hermie/` rather than a bare
 * `uploads/` so that a directory appearing in somebody's project has a name that
 * says which program put it there, and the date folder so it can be cleared by
 * age without reading any of it.
 */
export function uploadPathFor(cwd: string, name: string, options: { now?: Date; token?: string } = {}): string {
  const root = cwd.replace(/\/+$/, '')
  const folder = dateFolder(options.now ?? new Date())
  const token = options.token ?? randomToken()

  return `${root}/uploads/hermie/${folder}/${token}-${sanitiseUploadName(name)}`
}

/**
 * The token the gateway expands into the file's contents.
 *
 * Backticks because a path with a space in it otherwise ends at the space —
 * `agent/context_references.py` strips exactly this pair of wrappers back off.
 */
export function fileReferenceFor(path: string): string {
  return /\s/.test(path) ? `@file:\`${path}\`` : `@file:${path}`
}

/**
 * An attached image's reference, with only the name in the path position.
 *
 * Nothing puts this in the prompt: `image.attach_bytes` carries the bytes and the
 * gateway writes its own `@image:<path>` into the row it persists. This is what
 * the bubble records until that row lands, so the two can still be recognised as
 * one send — `attachmentsMatchKey` compares the name, which is all a client was
 * ever told. Same wrapping rule as a file, for a name with a space in it.
 */
export function imageReferenceFor(name: string): string {
  return /\s/.test(name) ? `@image:\`${name}\`` : `@image:${name}`
}

/** The prompt as it goes to the gateway: the user's words, then the references. */
export function withFileReferences(text: string, paths: readonly string[]): string {
  if (!paths.length) {
    return text
  }

  const references = paths.map(fileReferenceFor).join('\n')
  const body = text.trim()

  return body ? `${body}\n\n${references}` : references
}

/**
 * Stream one file to the gateway and answer where it landed.
 *
 * `FormData` with a `{uri}` part is React Native's streaming upload: the native
 * networking layer reads the file off disk as it sends, so nothing larger than a
 * chunk is ever in JavaScript memory. That is also why this uses `fetch`
 * directly instead of `GatewayHttp.post` — that method serialises a JSON body,
 * and routing 100 MB through it would undo the point. The URL and the headers
 * still come from `GatewayHttp`, so the bearer, its refresh and any configured
 * extra headers behave exactly as they do everywhere else.
 */
export async function uploadFile(options: UploadFileOptions): Promise<UploadedFile> {
  const { http, file, cwd } = options

  if (file.size > MAX_UPLOAD_BYTES) {
    // Before any bytes move: the gateway would take the whole upload and then
    // answer 413 as it crossed the cap.
    throw new FileUploadError(
      'too-large',
      `${file.name} is ${megabytes(file.size)} MB. The gateway accepts up to ${megabytes(MAX_UPLOAD_BYTES)} MB.`
    )
  }

  if (!cwd) {
    throw new FileUploadError(
      'no-workspace',
      'This conversation has not told us its working directory, and a file has to be uploaded inside it to be readable.'
    )
  }

  const path = uploadPathFor(cwd, file.name, {
    ...(options.now ? { now: options.now } : {}),
    ...(options.token ? { token: options.token } : {})
  })

  const body = new FormData()
  // The three fields `upload_managed_file_stream` declares: the part named
  // `file`, plus `path` and `overwrite` as form fields.
  body.append('path', path)
  body.append('overwrite', 'true')
  body.append(
    'file',
    // React Native's FormData takes this shape where the web takes a Blob; the
    // cast is the documented seam and there is no DOM type for it.
    { uri: file.uri, name: sanitiseUploadName(file.name), type: file.mimeType } as unknown as Blob
  )

  const headers = await http.requestHeaders()
  const doFetch = options.fetchImpl ?? fetch
  // Progress: React Native's fetch has no upload-progress event, so the only
  // honest report is "started" and "finished". An invented curve would be worse
  // than none — it stalls at 90% and lies about what is happening.
  options.onProgress?.(0)

  let response: Response

  try {
    response = await doFetch(`${trimSlash(http.baseUrl)}/api/files/upload-stream`, {
      method: 'POST',
      // No `content-type`: the runtime has to set it, because only it knows the
      // multipart boundary it generated.
      headers,
      body
    })
  } catch (cause) {
    throw new FileUploadError('failed', `${file.name} could not be uploaded: ${messageOf(cause)}`)
  }

  if (!response.ok) {
    throw new FileUploadError(
      response.status === 413 ? 'too-large' : 'refused',
      `The gateway refused the upload of ${file.name}: ${await detailOf(response)}`,
      response.status
    )
  }

  const result = (await response.json().catch(() => null)) as Record<string, unknown> | null
  // `display_path` is the resolved absolute path, which may differ from what we
  // asked for — a symlinked home is the ordinary case. The reference has to name
  // what the gateway will resolve, so its answer wins over our request.
  const stored = typeof result?.path === 'string' && result.path ? result.path : path

  options.onProgress?.(1)

  return { path: stored, reference: fileReferenceFor(stored), filename: file.name, size: file.size }
}

const trimSlash = (value: string): string => value.replace(/\/+$/, '')

const megabytes = (bytes: number): string => (bytes / (1024 * 1024)).toFixed(1)

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** FastAPI puts its reason in `detail`; anything else falls back to the status. */
async function detailOf(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as Record<string, unknown>

    if (typeof body.detail === 'string' && body.detail) {
      return body.detail
    }
  } catch {
    // Not JSON, or already consumed. The status line is still something.
  }

  return `HTTP ${response.status}`
}
