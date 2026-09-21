/**
 * Delivering the outbox: one entry, one chat, one message.
 *
 * Every port is a fake here, which is the point of them being ports — the
 * questions worth asking are about ORDER and about what survives a failure, and
 * neither needs a gateway:
 *
 *  - a photograph and a note are ONE prompt, not two messages;
 *  - the chat is opened before the upload, because the upload needs the working
 *    directory the resume reports;
 *  - the entry is cleared AFTER the send and never before;
 *  - a send that failed leaves the entry exactly where it was.
 */
import { ShareDelivery, type ShareDeliveryPorts } from '../src/features/share/share-delivery'
import type { PendingShare, ShareOutboxEntry } from '../src/features/share/outbox'
import { SHARE_MANIFEST_VERSION } from '../src/features/share/outbox'

type Call = string

function entryFor(over: Record<string, unknown> = {}, files: Record<string, string> = {}): ShareOutboxEntry {
  const id = (over.id as string) ?? 'e1'

  return {
    id,
    manifest: JSON.stringify({
      version: SHARE_MANIFEST_VERSION,
      id,
      note: 'have a look',
      createdAt: 10,
      items: [],
      ...over
    }),
    files
  }
}

function harness(entries: ShareOutboxEntry[], over: Partial<ShareDeliveryPorts> = {}) {
  const calls: Call[] = []
  let remaining = [...entries]
  const sent: { bot: string; text: string; attachments: unknown[] }[] = []
  let waiting: readonly PendingShare[] = []

  const ports: ShareDeliveryPorts = {
    inbox: {
      available: true,
      async list() {
        calls.push('list')

        return remaining.map(entry => ({ ...entry }))
      },
      async clear(id) {
        calls.push(`clear:${id}`)
        remaining = remaining.filter(entry => entry.id !== id)

        return true
      }
    },
    ready: () => true,
    open: async bot => {
      calls.push(`open:${bot}`)
    },
    upload: async (bot, file) => {
      calls.push(`upload:${bot}:${file.name}`)

      return { path: `/work/${file.name}`, reference: `@file:/work/${file.name}`, filename: file.name, size: file.size }
    },
    readImage: async (uri, filename) => {
      calls.push(`image:${filename}`)

      return { filename, base64: 'AAAA' }
    },
    send: async (bot, text, attachments) => {
      calls.push(`send:${bot}`)
      sent.push({ bot, text, attachments })
    },
    onChange: next => {
      waiting = next
    },
    ...over
  }

  return { calls, ports, sent, delivery: new ShareDelivery(ports), waiting: () => waiting }
}

describe('an entry that names its chat', () => {
  it('opens the chat, moves the files, and sends one message', async () => {
    const { calls, delivery, sent } = harness([
      entryFor(
        {
          bot: 'lance-vance',
          items: [
            { kind: 'image', path: 'shot.jpg', filename: 'shot.jpg', mimeType: 'image/jpeg', size: 9 },
            { kind: 'file', path: 'notes.pdf', filename: 'notes.pdf', mimeType: 'application/pdf', size: 4 },
            { kind: 'url', text: 'https://example.org' }
          ]
        },
        { 'shot.jpg': 'file:///tmp/shot.jpg', 'notes.pdf': 'file:///tmp/notes.pdf' }
      )
    ])

    await delivery.pump()

    // The chat FIRST: the upload needs the working directory the resume reports.
    expect(calls).toEqual([
      'list',
      'open:lance-vance',
      'image:shot.jpg',
      'upload:lance-vance:notes.pdf',
      'send:lance-vance',
      'clear:e1'
    ])

    expect(sent).toHaveLength(1)
    expect(sent[0]?.text).toBe('have a look\n\nhttps://example.org')
    expect(sent[0]?.attachments).toEqual([
      { kind: 'image', filename: 'shot.jpg', base64: 'AAAA' },
      { kind: 'file', filename: 'notes.pdf', path: '/work/notes.pdf' }
    ])
  })

  it('clears the entry only after the send, so nothing can be lost in the gap', async () => {
    const { calls, delivery } = harness([entryFor({ bot: 'b' })])

    await delivery.pump()

    expect(calls.indexOf('send:b')).toBeLessThan(calls.indexOf('clear:e1'))
  })

  it('leaves the entry alone when the send fails, and stops retrying in a loop', async () => {
    const { calls, delivery } = harness([entryFor({ bot: 'b' })], {
      send: async () => {
        throw new Error('gateway said no')
      }
    })

    await delivery.pump()
    await delivery.pump()

    expect(calls.filter(call => call.startsWith('clear'))).toEqual([])
    // Two pumps, one attempt: a failed entry is not retried until something has
    // changed, or the badge would be a tight loop against a refusing gateway.
    expect(calls.filter(call => call === 'open:b')).toHaveLength(1)
  })

  it('does nothing at all while the gateway is down, but still reads the outbox', async () => {
    const { calls, delivery, waiting } = harness([entryFor({ bot: 'b' })], { ready: () => false })

    await delivery.pump()

    expect(calls).toEqual(['list'])
    // The badge is the whole of what the feature can offer here, and it needs
    // the entry to have been read.
    expect(waiting().map(share => share.id)).toEqual(['e1'])
  })
})

describe('an entry with no chat on it — Android’s ACTION_SEND', () => {
  it('waits, and is published so the picker can ask', async () => {
    const { calls, delivery, waiting } = harness([entryFor()])

    await delivery.pump()

    expect(calls).toEqual(['list'])
    expect(waiting()).toHaveLength(1)
    expect(waiting()[0]).not.toHaveProperty('bot')
  })

  it('is sent once a chat is picked', async () => {
    const { calls, delivery, sent } = harness([entryFor()])

    await delivery.pump()
    await delivery.assign('e1', 'researcher')

    expect(calls).toContain('send:researcher')
    expect(sent[0]?.bot).toBe('researcher')
  })

  it('takes the note the picker typed over the one the manifest carried', async () => {
    const { delivery, sent } = harness([entryFor()])

    await delivery.pump()
    await delivery.assign('e1', 'researcher', 'my own words')

    expect(sent[0]?.text).toBe('my own words')
  })

  it('keeps the manifest’s note when the picker sent none', async () => {
    const { delivery, sent } = harness([entryFor()])

    await delivery.pump()
    await delivery.assign('e1', 'researcher')

    expect(sent[0]?.text).toBe('have a look')
  })

  it('discards without sending', async () => {
    const { calls, delivery, sent, waiting } = harness([entryFor()])

    await delivery.pump()
    await delivery.discard('e1')

    expect(sent).toHaveLength(0)
    expect(calls).toContain('clear:e1')
    expect(waiting()).toHaveLength(0)
  })
})

describe('entries it cannot use', () => {
  /**
   * A manifest from a build this one does not understand, or one whose files
   * the system has reclaimed, can never be delivered. Keeping it would be an
   * outbox that only grows, in a container nobody can inspect.
   */
  it('clears an unreadable entry rather than retrying it forever', async () => {
    const { calls, delivery, waiting } = harness([
      { id: 'bad', manifest: '{not json', files: {} },
      { id: 'old', manifest: JSON.stringify({ version: 99, id: 'old' }), files: {} }
    ])

    await delivery.pump()

    expect(calls).toEqual(['list', 'clear:bad', 'clear:old'])
    expect(waiting()).toHaveLength(0)
  })

  it('sends nothing when there is no inbox on this platform', async () => {
    const { calls, delivery } = harness([entryFor({ bot: 'b' })], {
      inbox: {
        available: false,
        async list() {
          return []
        },
        async clear() {
          return false
        }
      }
    })

    await delivery.pump()

    expect(calls).toEqual([])
  })

  it('refuses a bot the roster does not have, and keeps the entry', async () => {
    const { calls, delivery, waiting } = harness([entryFor({ bot: 'ghost' })], {
      open: async bot => {
        throw new Error(`${bot} is not a bot on this gateway.`)
      }
    })

    await delivery.pump()

    expect(calls).toEqual(['list'])
    expect(waiting().map(share => share.id)).toEqual(['e1'])
  })
})

describe('two shares at once', () => {
  it('delivers them oldest first', async () => {
    const { calls, delivery } = harness([
      entryFor({ id: 'later', bot: 'b', createdAt: 20 }),
      entryFor({ id: 'earlier', bot: 'b', createdAt: 10 })
    ])

    await delivery.pump()

    expect(calls.filter(call => call.startsWith('clear'))).toEqual(['clear:earlier', 'clear:later'])
  })

  /**
   * Two pumps overlapping is the ordinary case: a foreground and a gateway
   * becoming ready happen within a frame of each other. Without the guard both
   * would read the same entry and send it twice.
   */
  it('does not deliver the same entry twice when two pumps overlap', async () => {
    const { calls, delivery } = harness([entryFor({ bot: 'b' })])

    await Promise.all([delivery.pump(), delivery.pump()])

    expect(calls.filter(call => call === 'send:b')).toHaveLength(1)
  })
})
