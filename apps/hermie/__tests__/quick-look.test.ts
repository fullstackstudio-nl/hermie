/**
 * Looking at an attachment, rather than choosing somewhere to send it.
 *
 * A tap on a file chip used to open the share sheet on every Apple target, and a
 * share sheet is a list of DESTINATIONS — reading the PDF somebody attached
 * meant picking an app to read it in first. `QLPreviewController` is the verb a
 * reader means, and it is iOS API, so the phones and the iPad get it too; the
 * Mac is only what made the old behaviour obvious.
 *
 * The native half — presenting the controller over whatever is on screen,
 * fetching a remote URL to the caches directory first — is not reachable from
 * here and is reasoned in `HermieQuickLook.swift`. What IS worth holding still
 * is everything around it, because all of it is either a decision or a refusal:
 *
 *  - **the order.** Quick Look first, the share sheet only when it could not
 *    show the file. A change that flipped those would still "open the file" on
 *    every platform and would be invisible in every screenshot.
 *  - **every refusal is a `false`, never a throw.** Android, the browser, a
 *    type with no previewer, an older binary with no `previewFile` at all: the
 *    caller's fallback has to be one branch, not a message it has to read.
 *  - **an attachment with no URI opens nothing.** The gateway stores an upload
 *    on its own disk and serves nothing back, so most chips in a transcript are
 *    a name and a path on another machine. An empty share sheet would be worse
 *    than doing nothing.
 */
import { openInQuickLook } from '../src/platform/quick-look'
import { openAttachmentFile } from '../src/features/chats/open-attachment'

const mockPreviewFile = jest.fn<Promise<boolean>, [string, string | undefined]>()
const mockSupportsQuickLook = jest.fn<boolean, []>()
const mockShareFile = jest.fn<Promise<boolean>, [string, string | undefined]>()

/**
 * Read through getters, not captured.
 *
 * The seam asks the registry for the module ONCE, at its own module load, and
 * Babel hoists both that load and this `jest.mock` above the `const`s above — so
 * a factory that captured the spies would hand over `undefined` and every
 * assertion here would pass for the wrong reason.
 */
jest.mock('expo', () => ({
  requireOptionalNativeModule: () => ({
    get previewFile() {
      return mockPreviewFile
    },
    get supportsQuickLook() {
      return mockSupportsQuickLook
    }
  })
}))

jest.mock('../src/platform/share-file', () => ({
  SHARE_FILE_VERB: 'share',
  shareFile: (uri: string, name?: string) => mockShareFile(uri, name)
}))

beforeEach(() => {
  mockPreviewFile.mockReset()
  mockPreviewFile.mockResolvedValue(true)
  mockSupportsQuickLook.mockReset()
  mockSupportsQuickLook.mockReturnValue(true)
  mockShareFile.mockReset()
  mockShareFile.mockResolvedValue(true)
})

describe('the Quick Look seam', () => {
  it('hands the native side the URI and the app filename', async () => {
    await expect(openInQuickLook('file:///tmp/report.pdf', 'report.pdf')).resolves.toBe(true)

    expect(mockPreviewFile).toHaveBeenCalledWith('file:///tmp/report.pdf', 'report.pdf')
  })

  it('answers false for a file the previewer would not show', async () => {
    mockPreviewFile.mockResolvedValue(false)

    await expect(openInQuickLook('file:///tmp/thing.xyz', 'thing.xyz')).resolves.toBe(false)
  })

  it('answers false rather than rejecting when the native call fails', async () => {
    mockPreviewFile.mockRejectedValue(new Error('no window'))

    await expect(openInQuickLook('file:///tmp/report.pdf', 'report.pdf')).resolves.toBe(false)
  })

  it('does not call the native side for an empty URI', async () => {
    await expect(openInQuickLook('', 'report.pdf')).resolves.toBe(false)

    expect(mockPreviewFile).not.toHaveBeenCalled()
  })
})

describe('opening an attachment', () => {
  it('previews it, and does not open the share sheet as well', async () => {
    await expect(openAttachmentFile({ name: 'report.pdf', uri: 'file:///tmp/report.pdf' })).resolves.toBe('quick-look')

    expect(mockPreviewFile).toHaveBeenCalledTimes(1)
    expect(mockShareFile).not.toHaveBeenCalled()
  })

  it('falls back to the share sheet when the previewer cannot show it', async () => {
    mockPreviewFile.mockResolvedValue(false)

    await expect(openAttachmentFile({ name: 'thing.xyz', uri: 'file:///tmp/thing.xyz' })).resolves.toBe('shared')

    expect(mockShareFile).toHaveBeenCalledWith('file:///tmp/thing.xyz', 'thing.xyz')
  })

  it('tries the previewer FIRST, which is the whole ordering', async () => {
    const order: string[] = []

    mockPreviewFile.mockImplementation(async () => {
      order.push('quick-look')

      return false
    })
    mockShareFile.mockImplementation(async () => {
      order.push('share')

      return true
    })

    await openAttachmentFile({ name: 'thing.xyz', uri: 'file:///tmp/thing.xyz' })

    expect(order).toEqual(['quick-look', 'share'])
  })

  it('does nothing at all for a reference this device has no bytes for', async () => {
    await expect(openAttachmentFile({ name: 'quarterly-figures.xlsx' })).resolves.toBe('nothing')

    expect(mockPreviewFile).not.toHaveBeenCalled()
    expect(mockShareFile).not.toHaveBeenCalled()
  })
})

describe('the browser half of the seam', () => {
  it('never previews, so the caller downloads instead', async () => {
    // Required rather than imported so the native mock above cannot answer for it.
    const web = jest.requireActual('../src/platform/quick-look.web') as {
      CAN_QUICK_LOOK: boolean
      openInQuickLook: (uri: string, name?: string) => Promise<boolean>
    }

    expect(web.CAN_QUICK_LOOK).toBe(false)
    await expect(web.openInQuickLook('blob:https://hermie.dev/abc', 'report.pdf')).resolves.toBe(false)
  })
})
