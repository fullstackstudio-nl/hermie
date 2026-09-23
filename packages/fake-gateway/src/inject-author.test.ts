/**
 * `POST /__fake/inject`'s `author` field.
 *
 * HERM-83's fork stamps `display_metadata.author` on a submitted turn; this
 * fake has no login to submit one through, so `author` on `/__fake/inject`
 * stages the same shape directly on the injected row — the fixture the app
 * side's Task 3 is verified against by eye, and this is what proves the wire
 * shape it reads is the one this endpoint actually produces.
 */
import { describe, expect, it } from 'vitest'

import { startFakeGateway } from './server'

describe('POST /__fake/inject, author', () => {
  it('stamps display_metadata.author on the injected row when given one', async () => {
    const gateway = await startFakeGateway({ port: 0 })

    try {
      const injected = await fetch(`${gateway.url}/__fake/inject`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          profile: 'researcher',
          user: 'Does the export still match the totals?',
          assistant: 'Checked — yes.',
          author: { id: 'authentik:writer-review', name: 'Robin' },
          stream: false
        })
      }).then(response => response.json() as Promise<{ stored_session_id: string }>)

      const messages = await fetch(
        `${gateway.url}/api/sessions/${injected.stored_session_id}/messages?order=latest&limit=2`
      ).then(response => response.json() as Promise<{ messages: Record<string, unknown>[] }>)

      const userRow = messages.messages.find(row => row.role === 'user')

      expect(userRow?.display_metadata).toEqual({ author: { id: 'authentik:writer-review', name: 'Robin' } })
    } finally {
      await gateway.close()
    }
  })

  it('targets one exact session by id rather than the profile’s canonical chat', async () => {
    const gateway = await startFakeGateway({ port: 0 })

    try {
      // The profile lookup always finds a bot's OWN canonical session, so a
      // second bot's session id stands in for "some other conversation this
      // profile also has" — a sub-chat, once one exists — without needing a
      // live socket to create one.
      const writer = await fetch(`${gateway.url}/__fake/inject`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ profile: 'writer', stream: false })
      }).then(response => response.json() as Promise<{ stored_session_id: string }>)

      const injected = await fetch(`${gateway.url}/__fake/inject`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          session_id: writer.stored_session_id,
          user: 'Targeted at one conversation.',
          author: { id: 'authentik:robin-vale' },
          stream: false
        })
      }).then(response => response.json() as Promise<{ stored_session_id: string }>)

      expect(injected.stored_session_id).toBe(writer.stored_session_id)

      const messages = await fetch(
        `${gateway.url}/api/sessions/${writer.stored_session_id}/messages?order=latest&limit=2`
      ).then(response => response.json() as Promise<{ messages: Record<string, unknown>[] }>)

      const userRow = messages.messages.find(row => row.role === 'user')

      expect(userRow?.content).toBe('Targeted at one conversation.')
    } finally {
      await gateway.close()
    }
  })

  it('answers 404 for an unknown session_id rather than falling back to a profile guess', async () => {
    const gateway = await startFakeGateway({ port: 0 })

    try {
      const response = await fetch(`${gateway.url}/__fake/inject`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session_id: 'stored-nobody-here', stream: false })
      })

      expect(response.status).toBe(404)
    } finally {
      await gateway.close()
    }
  })

  it('leaves display_metadata untouched when no author is given, as before HERM-83', async () => {
    const gateway = await startFakeGateway({ port: 0 })

    try {
      const injected = await fetch(`${gateway.url}/__fake/inject`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ profile: 'researcher', stream: false })
      }).then(response => response.json() as Promise<{ stored_session_id: string }>)

      const messages = await fetch(
        `${gateway.url}/api/sessions/${injected.stored_session_id}/messages?order=latest&limit=2`
      ).then(response => response.json() as Promise<{ messages: Record<string, unknown>[] }>)

      const userRow = messages.messages.find(row => row.role === 'user')

      expect(userRow?.display_metadata).toBeUndefined()
    } finally {
      await gateway.close()
    }
  })
})
