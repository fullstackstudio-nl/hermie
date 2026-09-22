/**
 * `POST /__fake/request`, the control surface that makes `clarify` reachable.
 *
 * Two of the three question shapes a client has to survive could already be
 * raised by typing a sentence into a chat — "approve" parks the turn on an
 * approval, "delegate" fans out. `clarify` could only be raised by a test
 * holding the gateway object, so the clarify sheet was the one question card no
 * manual pass had ever opened, and every web QA pass so far has said so.
 *
 * Two things are pinned, and the second is the one that keeps it usable: the
 * request reaches an attached socket as a server→client JSON-RPC call, and the
 * HTTP call ANSWERS rather than parking until somebody clicks the sheet.
 */
import { describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'

import { startFakeGateway } from './server'

const openSocket = async (url: string): Promise<WebSocket> => {
  const socket = new WebSocket(url, ['hermes-gateway-v1'])

  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve())
    socket.once('error', reject)
  })

  return socket
}

/** The next server→client request frame to arrive, whatever else is on the wire. */
const nextRequest = (socket: WebSocket): Promise<{ id: string; method: string; params: Record<string, unknown> }> =>
  new Promise(resolve => {
    socket.on('message', raw => {
      const frame = JSON.parse(String(raw)) as {
        id?: string
        method?: string
        params?: Record<string, unknown>
      }

      if (frame.id !== undefined && frame.method !== undefined) {
        resolve({ id: frame.id, method: frame.method, params: frame.params ?? {} })
      }
    })
  })

describe('POST /__fake/request', () => {
  it('raises a clarify on an attached client and answers straight away', async () => {
    const gateway = await startFakeGateway({ port: 0 })
    const socket = await openSocket(gateway.wsUrl)

    try {
      const arrived = nextRequest(socket)

      const response = await fetch(`${gateway.url}/__fake/request`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          profile: 'researcher',
          method: 'clarify',
          params: { question: 'Which branch?', choices: ['main', 'next'] }
        })
      })

      // Answered, with the question still open: the endpoint raises, it does
      // not wait for the reader.
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ raised: 'clarify' })

      const request = await arrived

      expect(request.method).toBe('clarify')
      expect(request.params).toMatchObject({ question: 'Which branch?', choices: ['main', 'next'] })
      expect(typeof request.params.session_id).toBe('string')
    } finally {
      socket.terminate()
      await gateway.close()
    }
  })

  it('says which profile it could not find rather than raising on the wrong chat', async () => {
    const gateway = await startFakeGateway({ port: 0 })

    try {
      const response = await fetch(`${gateway.url}/__fake/request`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ profile: 'nobody', method: 'clarify' })
      })

      expect(response.status).toBe(404)
      expect(await response.json()).toMatchObject({ detail: expect.stringContaining('nobody') })
    } finally {
      await gateway.close()
    }
  })
})
