/**
 * `resolveSenderPictureUri` for the group chat's `TranscriptContext` (HERM-120
 * Task 2) — a colleague's picture, fetched by `author.id` and cached per
 * gateway, the same store the reader's own Account picture uses.
 *
 * Built here rather than inside a transcript row, because it has to SUBSCRIBE
 * to the cache to repaint once a fetch resolves, and a transcript row is not
 * where a hook may run — `TranscriptList` invokes `resolveSenderName`'s sibling
 * as a plain callback while laying out rows, not as a hook. `ChatScreen`
 * subscribes once, at the top, exactly as it already does for `resolveSenderName`'s
 * eventual `context.users` directory (HERM-83 Task 4's rung 1).
 *
 * `RowView` only ever calls this for a row that is already proven to be a
 * colleague's (`!own && item.author`), so the reader's own messages and
 * unattributed rows never reach it — nothing here needs to guard against them
 * again.
 */
import { useCallback } from 'react'

import { authPicturePath } from '@hermie/gateway-client'
import type { MessageAuthor } from '@hermie/transcript'

import { useGateway } from '../../gateway'
import { personPictureKey, personPictureUri, usePeoplePicturesStore } from './people-pictures'

export function useSenderPictureResolver(): (author: MessageAuthor) => string | undefined {
  const { gatewayId, http } = useGateway()
  // Subscribed for its OWN sake: reading `byKey` here is what makes this
  // component re-render once a fetch resolves. The callback below reads the
  // freshest map through `getState()` rather than this closed-over value, but
  // the two are the same object on any render this subscription did not just
  // repaint for.
  usePeoplePicturesStore(state => state.byKey)
  const ensure = usePeoplePicturesStore(state => state.ensure)

  return useCallback(
    (author: MessageAuthor) => {
      if (!gatewayId || !http || !author.id) {
        return undefined
      }

      const path = authPicturePath(author.id)
      const key = personPictureKey(gatewayId, path)
      const entry = usePeoplePicturesStore.getState().byKey[key]

      if (!entry) {
        ensure(key, http, path)

        return undefined
      }

      return personPictureUri(entry)
    },
    [gatewayId, http, ensure]
  )
}
