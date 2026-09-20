/**
 * Files dragged onto the window, from the Finder or from another app.
 *
 * React Native has no drop event on any platform it ships. `UIDropInteraction`
 * is UIKit's, and the local module in `apps/hermie/modules/hermie-drop` wraps it
 * as a host view — a view rather than a module function because a drop belongs
 * to a REGION: the chat takes a file, the sidebar beside it does not, and one
 * global event could not tell them apart.
 *
 * Probed by FUNCTION, like every other optional native surface in this folder:
 * `requireNativeView` throws for a view that is not registered, at module scope
 * where nothing can catch it usefully, and an older binary running a newer
 * bundle is exactly the case that would hit it.
 *
 * Nothing here is gated on the Mac. `UIDropInteraction` is the same interaction
 * on an iPad in Split View or Stage Manager, and on an iPhone there is no drag
 * session to receive — so the honest question is whether the view exists, not
 * which machine this is.
 */
import { requireNativeView, requireOptionalNativeModule } from 'expo'
import { type ReactNode } from 'react'
import type { StyleProp, ViewStyle } from 'react-native'

type DropProbe = { supportsFileDrop?: () => boolean }

function probe(): boolean {
  try {
    return typeof requireOptionalNativeModule<DropProbe>('HermieDrop')?.supportsFileDrop === 'function'
  } catch {
    // No Expo module host at all — a unit test renderer, or the web bundle.
    return false
  }
}

/** Whether this build can accept a dropped file. */
export const HAS_NATIVE_FILE_DROP = probe()

/** One file as the native side hands it over. Same four fields the picker produces. */
export interface DroppedFile {
  uri: string
  name: string
  size: number
  mimeType: string
}

export interface NativeDropViewProps {
  enabled?: boolean
  onDrop?: (event: { nativeEvent: { files?: unknown } }) => void
  onDropEnter?: () => void
  onDropExit?: () => void
  style?: StyleProp<ViewStyle>
  children?: ReactNode
  testID?: string
}

let cached: React.ComponentType<NativeDropViewProps> | null = null

export function nativeDropView(): React.ComponentType<NativeDropViewProps> | null {
  if (!HAS_NATIVE_FILE_DROP) {
    return null
  }

  if (cached) {
    return cached
  }

  try {
    cached = requireNativeView<NativeDropViewProps>('HermieDrop', 'HermieDropView')
  } catch {
    return null
  }

  return cached
}

const FALLBACK_MIME_TYPE = 'application/octet-stream'

/**
 * Read a drop payload back, defensively.
 *
 * The bridge carries `[[String: Any]]`, which is to say: anything. A drop is a
 * gesture the reader made with a file they care about, so the failure mode that
 * matters is not a wrong field — it is a payload shape that throws while the
 * chat is open. Every item without a URI is dropped, every other field falls
 * back, and a payload that is not a list at all reads as no files.
 *
 * Exported and pure so the mapping can be stated in a test, which is the only
 * half of this module that can be checked without a Mac and a Finder.
 */
export function normaliseDroppedFiles(payload: unknown): DroppedFile[] {
  if (!Array.isArray(payload)) {
    return []
  }

  const files: DroppedFile[] = []

  for (const raw of payload) {
    if (!raw || typeof raw !== 'object') {
      continue
    }

    const item = raw as Partial<Record<keyof DroppedFile, unknown>>
    const uri = typeof item.uri === 'string' ? item.uri : ''

    if (!uri) {
      continue
    }

    const name = typeof item.name === 'string' && item.name ? item.name : (uri.split('/').pop() ?? 'attachment')

    files.push({
      mimeType: typeof item.mimeType === 'string' && item.mimeType ? item.mimeType : FALLBACK_MIME_TYPE,
      name: decodeURIComponent(name),
      size: typeof item.size === 'number' && Number.isFinite(item.size) && item.size > 0 ? item.size : 0,
      uri
    })
  }

  return files
}
