/**
 * Who the reader is, in the one spelling a message row's `author.id` uses
 * (HERM-83, D3).
 *
 * A row is the reader's own when its stamped `author.id` equals this. The
 * stamp is `"<provider>:<user_id>"`, and `/api/auth/me` answers with the bare
 * `user_id` and the `provider` separately, so the id is BUILT here, by
 * `ownAuthorOf` in `@hermie/gateway-client`, which mirrors the gateway's own
 * construction exactly. Comparing the bare id with the stamp is what drew the
 * reader's own messages on the left, under their own name and picture.
 *
 * Owned by `ChatRuntimeProvider`, which feeds it from the `/api/auth/me` read it
 * already does on every ready edge, and read by the three places that ask
 * "is this row mine?": the transcript (`ChatScreen`), the chat-list preview
 * (`row-preview.ts`) and the optimistic bubble (`ChatController.send`, through
 * the `ownAuthor` option), so an optimistic bubble and the row that replaces it
 * agree.
 *
 * Keyed per gateway. Two gateways can mint the same `provider:sub` for two
 * different people, and an `/api/auth/me` answer that lands after the reader
 * has switched gateways must never be read as the new gateway's identity: it
 * is filed under the gateway that answered, and readers look only under the
 * gateway the runtime is bound to.
 *
 * Deliberately not `device-context`: that store's `userId` keys `ui_meta` and
 * is spelled differently (the bare id, or the email), and the two must not be
 * conflated.
 */
import type { MessageAuthor } from '@hermie/transcript'
import { create } from 'zustand'

interface OwnAuthorState {
  /** Per gateway id: the reader's own author, as that gateway stamps it. */
  byGateway: Record<string, MessageAuthor>
  /** The gateway the running chat runtime is connected to, or `null` for none. */
  gatewayId: string | null
  bind: (gatewayId: string | null) => void
  /** File what `gatewayId` answered; `undefined` forgets it (no id, a refusal, a new sign-in). */
  set: (gatewayId: string, author: MessageAuthor | undefined) => void
  reset: () => void
}

export const useOwnAuthorStore = create<OwnAuthorState>((set, get) => ({
  byGateway: {},
  gatewayId: null,

  bind: gatewayId => {
    if (get().gatewayId !== gatewayId) {
      set({ gatewayId })
    }
  },

  set: (gatewayId, author) => {
    const current = get().byGateway[gatewayId]

    if (current?.id === author?.id && current?.name === author?.name) {
      return
    }

    set(state => {
      const byGateway = { ...state.byGateway }

      if (author) {
        byGateway[gatewayId] = author
      } else {
        delete byGateway[gatewayId]
      }

      return { byGateway }
    })
  },

  reset: () => set({ byGateway: {}, gatewayId: null })
}))

/** The reader's own author on `gatewayId`, or `undefined` when unknown. */
export function ownAuthorOn(gatewayId: string | null | undefined): MessageAuthor | undefined {
  return gatewayId ? useOwnAuthorStore.getState().byGateway[gatewayId] : undefined
}

/**
 * The reader's own author id on the gateway the runtime is bound to — a
 * string, so a row re-renders only when the id itself changes. `undefined`
 * before `/api/auth/me` has answered, on a gateway that named nobody, and
 * with no gateway at all: every one of those draws every row as the reader's
 * own, unchanged from before `author` existed.
 */
export function useOwnAuthorId(): string | undefined {
  return useOwnAuthorStore(state => (state.gatewayId ? state.byGateway[state.gatewayId]?.id : undefined))
}
