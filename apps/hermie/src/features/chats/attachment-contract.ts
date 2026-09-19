/**
 * What both attachment pickers agree on.
 *
 * It is a THIRD module on purpose, and the reason is a platform-resolution
 * trap worth naming: inside `attachments.macos.ts`, the specifier
 * `./attachments` resolves back to `attachments.macos.ts` itself, because
 * Metro prefers the platform variant for every importer including that
 * variant. A value re-export written there (`export { X } from './attachments'`)
 * therefore becomes a self-referencing getter and the app dies at startup with
 * `RangeError: Maximum call stack size exceeded`. A module with no `.macos`
 * sibling cannot be captured that way.
 */

/** The longest edge an attachment is resized to before it is encoded. */
export const MAX_ATTACHMENT_EDGE = 1568

export interface PickedAttachment {
  id: string
  filename: string
  /** Raw base64, no `data:` prefix — `image.attach_bytes` takes it as-is. */
  base64: string
  /** Local URI, for the composer's thumbnail. */
  uri?: string
}

let counter = 0

/** A stable id for one staged attachment, unique within a session. */
export const nextAttachmentId = (): string => `attachment-${Date.now().toString(36)}-${(counter += 1)}`
