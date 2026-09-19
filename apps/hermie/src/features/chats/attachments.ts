/**
 * Picking a file for the composer.
 *
 * Two jobs, and the second is the one that matters: get bytes, then make them
 * small enough to send. A modern phone photo is 4032 px on its long edge and
 * several megabytes; `image.attach_bytes` takes base64 over the same WebSocket
 * the transcript streams on, so an unresized photo stalls the chat it was meant
 * to illustrate. 1568 px is the longest edge a vision model reads at full
 * resolution — past that the extra pixels cost bandwidth and buy nothing.
 *
 * macOS uses the file picker instead; see `attachments.macos.ts`.
 */
import * as ImageManipulator from 'expo-image-manipulator'
import * as ImagePicker from 'expo-image-picker'

import { strings } from '../../i18n/strings'
import { MAX_ATTACHMENT_EDGE, nextAttachmentId, type PickedAttachment } from './attachment-contract'

export { MAX_ATTACHMENT_EDGE, type PickedAttachment }

/** What the "+" button offers on this platform, so the screen can label it. */
export const attachmentKind: 'photo' | 'file' = 'photo'

/**
 * Whether this build has a picker behind it. Always true here; the macOS
 * variant computes it, because `expo-document-picker` has no macOS slice.
 */
export const attachmentsSupported = true

function filenameFor(uri: string, given: string | null | undefined): string {
  if (given) {
    return given
  }

  const tail = uri.split('/').pop()?.split('?')[0]

  return tail && tail.includes('.') ? tail : 'image.jpg'
}

/**
 * Open the photo library and return one attachment, or `null` when the user
 * backed out. A denied permission throws with the sentence the user needs.
 */
export async function pickAttachment(): Promise<PickedAttachment | null> {
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync()

  if (!permission.granted) {
    throw new Error(strings.chat.attach.permission)
  }

  const picked = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsMultipleSelection: false,
    quality: 1,
    // Not `base64: true`: that would encode the ORIGINAL, which is the whole
    // thing this function exists to avoid. The resize below encodes instead.
    exif: false
  })

  const asset = picked.canceled ? undefined : picked.assets?.[0]

  if (!asset) {
    return null
  }

  return resizeToBase64(asset.uri, filenameFor(asset.uri, asset.fileName), asset.width, asset.height)
}

/**
 * Resize past the cap and encode. Below the cap the image is still re-encoded
 * as JPEG, because that is what bounds a 12 MB PNG screenshot.
 */
export async function resizeToBase64(
  uri: string,
  filename: string,
  width?: number,
  height?: number
): Promise<PickedAttachment> {
  const longest = Math.max(width ?? 0, height ?? 0)
  const actions: ImageManipulator.Action[] =
    longest > MAX_ATTACHMENT_EDGE
      ? [
          (width ?? 0) >= (height ?? 0)
            ? { resize: { width: MAX_ATTACHMENT_EDGE } }
            : { resize: { height: MAX_ATTACHMENT_EDGE } }
        ]
      : []

  const result = await ImageManipulator.manipulateAsync(uri, actions, {
    base64: true,
    compress: 0.85,
    format: ImageManipulator.SaveFormat.JPEG
  })

  return {
    id: nextAttachmentId(),
    filename: filename.replace(/\.(png|heic|heif|webp|gif)$/i, '.jpg'),
    base64: result.base64 ?? '',
    uri: result.uri
  }
}
