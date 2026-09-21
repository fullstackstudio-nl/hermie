# 0018. The chat list groups into folders, and a bot is in exactly one

- Status: Accepted
- Date: 2026-09-21
- Amends: [0012](0012-local-chat-list-layout.md), [0016](0016-ui-meta-sync.md)

## Context

[ADR-0012](0012-local-chat-list-layout.md) gave the chat list named **dividers**, and it chose their
shape deliberately:

> Dividers and chats live in ONE array rather than in a tree of sections, which is what makes "move
> this bot into that section" a swap of two adjacent positions instead of a graft between two
> containers.

That was the right shape for a heading. It is the wrong one for what people actually wanted, and the
gap shows up in three places at once:

- **A divider has no inside.** There is nothing to close, so a list of forty chats under six
  headings is still a list of forty chats. The whole point of grouping is to be able to stop looking
  at a group.
- **A closed group has to be accounted for.** The moment something can be hidden, the thing hiding
  it has to say what is in there — an unread total, a question waiting — or hiding it means missing
  things.
- **There is nowhere to drop a row onto.** A heading is a line between two rows, so "put this in
  Finance" could only ever be expressed as "put this after the Finance line", which is the same
  gesture as "put this before the first chat under Finance" and reads as neither.

The one-flat-array trick also stopped paying for itself. Stepping past a heading changed a bot's
section for free, which was elegant — and it meant `moveBy(bot, 1)` on the last chat of a group
silently moved it into the next one. With a heading that is arguably a reordering. With a container
it is a mistake.

## Decision

**The chat list groups into folders. A bot is in exactly one folder, or in none.**

### The shape

Two lists that mean one thing, in `apps/hermie/src/store/folders.ts`:

```ts
entries: ({ kind: 'folder'; id: string } | { kind: 'chat'; name: string })[]
folders: { id: string; name: string; colour?: AccentName; bots: string[] }[]
```

`entries` is the **top level** in order — folders and loose chats interleaved — and a folder appears
in it by id only. `folders` carries each one's name, colour and contents. Two lists rather than a
tree because the top-level order and a folder's contents are two independent edits: dragging a
folder past a chat touches `entries` alone, and dragging a chat within a folder touches `folders`
alone.

**The invariant is enforced, not assumed.** `normalise` runs on every read and every write: a bot
appears at most once (the first position winning, so a bot that is both loose and in a folder stays
where the reader can see it), a folder id appears at most once, a folder named in `entries` with no
definition is dropped, and a folder defined but never placed is appended rather than lost. Two
copies of one row is a list in which every drag is ambiguous, and the data comes off a disk and a
gateway this build does not control.

### Where a drop lands

A position is no longer a single index. It is a **container and an index inside it**, because "third
from the top" and "third inside Finance" are different places the same number would name. So
`drag-order.ts` was split: it keeps the geometry — which gap the finger is over, which way the other
rows move, how far — and `features/bots/folder-rows.ts` owns what each gap MEANS.

Two anchors are not rows anybody drags, and both exist for a reason a divider never had:

- **`folderIn:<id>`** is the bottom half of a folder's own header and means "inside this folder,
  first". It is what makes _drop onto the folder_ a real gesture, and it is the only way into a
  **collapsed** folder, which by definition has no children to drop between.
- **`folderEmpty:<id>`** is the placeholder row an open, empty folder draws, so a folder somebody has
  just emptied is not a one-way trip.

Anchors are derived from the **arrangement**, never from the rendered rows. The rendered list has
rows that stand for no position (a folder header stands for two) and hides rows that still have one
(a collapsed folder's children), and an archived chat keeps its place in the arrangement while being
drawn in the drawer — so counting visible rows would slide every drop below it by one.

### What is synced and what is not

`entries` and `folders` ride in the per-person `ui_meta` section
([ADR-0016's amendment](0016-ui-meta-sync.md)) with the order, the theme and the mutes. **Which
folders are open does not.** That is about the window in front of somebody — a Mac with everything
folded away must not fold a phone's list, and the phone has the room to keep them open — so it lives
on the device beside `sidebarCollapsed`, exactly where ADR-0012 put that.

### The migration, and why the section version does NOT move

Every divider becomes a folder holding the chats below it up to the next divider. Chats above the
first divider stay loose. That is the only reading that preserves what the reader was looking at: a
heading's rows ARE its rows, and they stop where the next heading starts. It runs in one place,
`readArrangement`, which both the disk read and the gateway read go through.

`folders` is an **additive field and `v` stays at 1**, which is a deliberate departure from the
obvious move. Bumping it would make an older build read the whole app-wide section as unreadable —
and a section an older build cannot read is one it **re-seeds from its own local copy**, because
`seedWhatTheGatewayLacks` treats an absent section as "nobody has decided anything yet". So a bump
would not protect the folders from a two-month-old phone. It would hand that phone the power to
delete them, along with the theme, the mutes and the push registrations sharing the key. An older
build that simply does not mention `folders` costs the reader their folders on its own next write,
which is the same last-writer-wins trade ADR-0016 already made for the order.

### What the folder row does

Name, an optional colour on its chevron, and — **only while it is closed** — an aggregate unread
count and a needs-input dot. Open, every row inside is on screen carrying its own count, and a total
above them would be the same information twice.

The aggregate **respects mute** ([ADR-0017's amendment](0017-push-through-hermie-web.md)): a muted
chat contributes nothing to either number. A folder is an aggregate, and an aggregate is exactly the
kind of number a reader who silenced a chat asked to stop seeing. Archived chats are excluded for the
reason they always were.

Its menu is New folder, Rename, Colour, Mute folder and Delete. **Mute fans out** — a folder has no
mute of its own, it applies the chosen span to every chat inside at once. A mute stored on the folder
would be a second place a chat can be silent from, and a chat dragged out of a muted folder would
then carry a silence nobody could see or lift.

**Delete keeps the chats**, and returns them to the top level _at the folder's own position_, in
their own order. Deleting a container should not also be a reordering: the reader can still see where
the group was.

"Archived" stays exactly what it was — a special group with its own header and its own rules, not a
folder. It is not in the arrangement, it cannot be dropped into, and archiving still takes a chat out
of every count.

## Consequences

- **`moveBy` no longer crosses a group.** Up and down mean the next row _inside the same container_.
  Changing folders now says which folder out loud — the drag, the row menu, or `moveToFolder`. This
  is a deliberate loss of ADR-0012's elegance and it removes a class of accident the flat array made
  free.
- **The rendered list and the arrangement have genuinely diverged**, where before one was a filter of
  the other. That is the cost of collapsing, and it is paid once, in `folder-rows.ts`, rather than at
  every call site.
- **Two lists can disagree**, which is why `normalise` is not optional and why it runs on the way in
  as well as on the way out.
- **A folder's open state is per device and is therefore not backed up.** Reinstalling opens
  everything. That is the right failure: the alternative is a phone that arrives with six groups
  already folded away because a Mac folded them.
- **The `dividers` name is gone from the strings and from the UI.** A build that still writes
  `divider` entries into the section will be migrated by the next reader that opens it, and its own
  next write will drop the folders — see above.

## What is verified

`apps/hermie/__tests__/folders.test.ts` covers the invariant (a duplicate bot, one bot named by two
folders, a folder nobody placed, an id nothing defines, and the invariant holding across a run of
moves), the migration (each divider's own chats, the chats above the first one, a folder stopping
where the next divider starts, the reading order preserved, and a blob written by something else
entirely), moving between containers, deleting a folder at its own position, folding the roster in,
the aggregate counts with mute and archive applied, the rows a list draws open and closed, every drop
target including the collapsed-folder case and the archived-chat offset, and the commit arithmetic
end to end.

`apps/hermie/__tests__/drag-reorder.test.ts` keeps the geometry half: midpoints, ragged rows, the
synthetic half-row over a folder header, and how far the neighbours move.
`apps/hermie/__tests__/chat-layout-store.test.ts` covers what the store adds — the disk keyed by
gateway, and the open/closed set surviving a reload and being forgotten with the folder.
`apps/hermie/__tests__/bots-screen.test.tsx` drives the screen: adding a folder, naming it, the empty
folder's own row, a search narrowing past it, and moving a bot in from the row menu.

**Not verified by a test:** the gesture itself. A `PanResponder` needs a touch and the boxes it reads
come from a real layout pass, so the drag is exercised as arithmetic and confirmed by hand.
