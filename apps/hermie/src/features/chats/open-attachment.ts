/**
 * What a tap on an attachment chip does, as one decision in one place.
 *
 * Two verbs, and the order between them is the whole of it: **look at it
 * first, send it somewhere second**. A share sheet is a list of destinations,
 * and it was what a tap did on every platform — so reading a PDF that somebody
 * attached meant choosing an app to read it in. Quick Look is the verb a
 * reader means, and on the Mac it is the one they press Space for.
 *
 * The fallback is not a safety net so much as the answer for three real
 * platforms: a browser downloads, Android has no `QLPreviewController`, and a
 * type Quick Look has no previewer for still has to go somewhere. Each of those
 * comes back as a plain `false` from the seam rather than as an error, which is
 * why this can be a two-line decision instead of a try/catch.
 *
 * Its own file, and it returns what it did, because the ordering is the part
 * that can silently regress: a change that made the share sheet fire first
 * would still "open the file" on every platform and would be invisible in every
 * screenshot.
 */
import { openInQuickLook } from '../../platform/quick-look'
import { shareFile } from '../../platform/share-file'

/** One attachment, as the transcript holds it. */
export interface OpenableAttachment {
  name: string
  /** Absent for a reference whose bytes this device does not have. */
  uri?: string
}

/**
 * What happened, for a test and for nothing else.
 *
 * `'nothing'` is a legitimate outcome, not a failure: an attachment the gateway
 * stored on its own disk has no URI here, and a tap on it has nothing to open.
 * Opening an empty share sheet instead would be worse than doing nothing.
 */
export type AttachmentOpened = 'quick-look' | 'shared' | 'nothing'

export async function openAttachmentFile(attachment: OpenableAttachment): Promise<AttachmentOpened> {
  const { name, uri } = attachment

  if (!uri) {
    return 'nothing'
  }

  if (await openInQuickLook(uri, name)) {
    return 'quick-look'
  }

  // `shareFile` answers false as well — a sheet that would not open, a browser
  // with no document. There is nothing left to try after it, so its answer is
  // not branched on; the reader still has the transcript in front of them.
  await shareFile(uri, name)

  return 'shared'
}
