/**
 * The macOS variant of the composer's attachment picker.
 *
 * macOS has no photo library to launch, so this opens the document picker and
 * reads the chosen file itself. Two things about that are load-bearing.
 *
 * **The module is required lazily.** `expo-document-picker` has no macOS slice,
 * and an Expo module without one throws `Cannot find native module` the moment
 * it is imported — at module scope that is not a failed attachment, it is a
 * blank app. So the import happens inside the picker, behind a try, and
 * `attachmentsSupported` tells the screen whether to offer the button at all.
 *
 * **`expo-image-manipulator` is not used here** for the same reason. A file
 * picked on a desktop is usually a screenshot rather than a twelve-megapixel
 * camera-roll photo, so the cap is enforced by refusing an oversized file with
 * a readable sentence instead of silently sending it.
 */
import { MAX_ATTACHMENT_EDGE, nextAttachmentId, type PickedAttachment } from './attachment-contract'

export { MAX_ATTACHMENT_EDGE, type PickedAttachment }

/** What the "+" button offers on this platform, so the screen can label it. */
export const attachmentKind: 'photo' | 'file' = 'file'

/** Roughly what a 1568 px JPEG weighs; a file past this is refused, not resized. */
const MAX_ATTACHMENT_BYTES = 4_000_000

type DocumentPickerModule = {
  getDocumentAsync: (options: {
    type?: string | string[]
    multiple?: boolean
    copyToCacheDirectory?: boolean
  }) => Promise<{ canceled: boolean; assets?: { name: string; uri: string; size?: number }[] }>
}

function loadDocumentPicker(): DocumentPickerModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('expo-document-picker') as DocumentPickerModule
  } catch {
    return null
  }
}

/**
 * False when this build has no picker behind it. The composer then renders its
 * "+" disabled rather than offering a button that can only fail.
 */
export const attachmentsSupported = loadDocumentPicker() !== null

/** Read a local file as raw base64, without `expo-file-system`. */
async function readBase64(uri: string): Promise<string> {
  const response = await fetch(uri)
  const blob = await response.blob()

  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()

    reader.onerror = () => reject(new Error('The file could not be read.'))
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.readAsDataURL(blob)
  })

  const comma = dataUrl.indexOf(',')

  return comma >= 0 ? dataUrl.slice(comma + 1) : ''
}

export async function pickAttachment(): Promise<PickedAttachment | null> {
  const picker = loadDocumentPicker()

  if (!picker) {
    throw new Error('Attaching files is not available in this macOS build yet.')
  }

  const picked = await picker.getDocumentAsync({
    type: 'image/*',
    multiple: false,
    copyToCacheDirectory: true
  })

  const asset = picked.canceled ? undefined : picked.assets?.[0]

  if (!asset) {
    return null
  }

  if (asset.size !== undefined && asset.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(
      `${asset.name} is ${Math.round(asset.size / 100_000) / 10} MB. Attach an image under 4 MB, or resize it first.`
    )
  }

  const base64 = await readBase64(asset.uri)

  if (!base64) {
    throw new Error(`${asset.name} could not be read.`)
  }

  return { id: nextAttachmentId(), filename: asset.name, base64, uri: asset.uri }
}
