/**
 * The reader's own author id, spelled exactly the way the gateway spells the
 * per-message author stamp (HERM-83).
 *
 * `/api/auth/me` answers with the provider's BARE `user_id` — `7f3a…` for an
 * OIDC subject, `alice` under basic auth — and `provider` as a separate field.
 * The stamp on a row is `"<provider>:<user_id>"`, built by the gateway's
 * `_transport_auth_user` (and by `pictures.identity_id`, the picture store's
 * key) as `f"{provider.strip()}:{user_id.strip()}"`: provider first, one colon,
 * Python's `str.strip()` on each half, and nothing else — no case folding, no
 * other separator. A client that compared the bare id with that stamp read
 * every one of the reader's own messages as somebody else's.
 *
 * So this mirrors that construction and nothing more. In particular there is
 * no `|| email` fallback: the gateway never stamps an email, so an id built
 * from one could only ever match nobody — or, worse, somebody. A missing or
 * blank `provider` or `user_id` is the gateway's own "no authenticated
 * identity" (`_is_authenticated_identity`), and the reader then has no author
 * id at all, so nothing counts as "own" by id.
 */

/**
 * The characters Python's `str.isspace()` is true for, which is what
 * `str.strip()` with no argument removes from each end.
 *
 * Spelled out rather than left to `String.prototype.trim`, because the two sets
 * differ at the edges: Python strips U+001C..U+001F and U+0085 and JavaScript
 * does not, and JavaScript strips U+FEFF and Python does not. An id that
 * differed from the gateway's by one invisible character would compare unequal
 * to the stamp, which is exactly the bug this file exists to prevent.
 */
const PY_SPACE =
  '\\t\\n\\u000b\\f\\r\\u001c-\\u001f \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000'
const PY_STRIP = new RegExp(`^[${PY_SPACE}]+|[${PY_SPACE}]+$`, 'gu')

/** Python's `str.strip()`. */
function pyStrip(value: string): string {
  return value.replace(PY_STRIP, '')
}

/**
 * `"<provider>:<user_id>"` for this `/api/auth/me` answer, or `undefined` when
 * either half is missing or blank.
 */
export function authorIdOf(identity: { provider: string; userId: string }): string | undefined {
  const provider = pyStrip(identity.provider ?? '')
  const userId = pyStrip(identity.userId ?? '')

  return provider && userId ? `${provider}:${userId}` : undefined
}

/**
 * The reader's own author, in the shape a stamped row carries it — `{ id, name }`,
 * where `name` is the display name the gateway mints the WS ticket with
 * (`sess.display_name`, stripped), omitted when there is none, exactly as
 * `row_author` omits it.
 */
export function ownAuthorOf(identity: {
  provider: string
  userId: string
  displayName: string
}): { id: string; name?: string } | undefined {
  const id = authorIdOf(identity)

  if (!id) {
    return undefined
  }

  const name = pyStrip(identity.displayName ?? '')

  return name ? { id, name } : { id }
}
