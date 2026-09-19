/**
 * Picking an arbitrary file for the composer.
 *
 * Separate from `attachments.ts` because the two go to the gateway by different
 * roads and share nothing but the composer. An image is resized, base64-encoded
 * and handed to `image.attach_bytes` over the socket. A file is not touched at
 * all: upstream has no file-attach RPC, so the bytes go over HTTP and the prompt
 * references where they landed (see `file-upload.ts`, and the 2026-09-19 section
 * of docs/platform-notes.md for why that is the only shape that works).
 *
 * So this module deliberately does NOT read the file. It returns the URI the
 * picker gave it and lets `fetch` stream from there — a 90 MB archive read into
 * a JavaScript string would be the one thing the streaming upload exists to
 * avoid, and base64 would inflate it by a third on the way.
 *
 * There is no "is this supported" flag, for the same reason `attachments.ts` no
 * longer has one: `expo-document-picker` has an implementation on every target
 * this builds for, the Mac included, where the iPad build gets UIKit's own
 * document picker. A flag that is always true only invites a caller to branch on
 * it.
 */
import * as DocumentPicker from 'expo-document-picker'

export interface PickedFile {
  name: string
  /** Bytes. `0` when the platform did not say; the upload then finds out. */
  size: number
  mimeType: string
  /** A local `file://` URI. Handed to `FormData` as-is, never read here. */
  uri: string
}

const FALLBACK_MIME_TYPE = 'application/octet-stream'

function nameFor(uri: string, given: string | null | undefined): string {
  if (given) {
    return given
  }

  const tail = uri.split('/').pop()?.split('?')[0]

  return tail ? decodeURIComponent(tail) : 'attachment'
}

/**
 * Open the document picker and return one file, or `null` when the user backed
 * out.
 *
 * `copyToCacheDirectory` is on, and it is load-bearing rather than a default
 * worth trimming: without it iOS hands back a URI inside the provider's own
 * sandbox, which stops resolving the moment the picker closes — and this
 * function returns before the upload starts.
 */
export async function pickFile(): Promise<PickedFile | null> {
  const picked = await DocumentPicker.getDocumentAsync({
    type: '*/*',
    multiple: false,
    copyToCacheDirectory: true
  })

  const asset = picked.canceled ? undefined : picked.assets?.[0]

  if (!asset?.uri) {
    // Cancelled, or a picker that answered with nothing: not an error, and
    // nothing to show for it.
    return null
  }

  return {
    name: nameFor(asset.uri, asset.name),
    size: typeof asset.size === 'number' && Number.isFinite(asset.size) ? asset.size : 0,
    mimeType: asset.mimeType || FALLBACK_MIME_TYPE,
    uri: asset.uri
  }
}
