/**
 * What a chat row can do, as data.
 *
 * The native menu and the fallback sheet are two ways of drawing ONE list of
 * intentions, and this is that list. Keeping it here rather than inside either
 * drawing has a concrete payoff: the ids are a closed alphabet, so the thing that
 * reads a selection back is a parser with a total switch rather than a pile of
 * string comparisons spread across a component.
 *
 * The ids are structured on purpose — `accent:teal`, `section:d3f` — because two
 * of the groups are open sets. Nine colours and any number of sections cannot be
 * enumerated in a union type, and a parser that splits on the first colon can
 * answer for both without the menu and the handler agreeing on an index.
 */
import { strings } from '../../i18n/strings'
import { menuItems, type MenuItem } from '../../ui/menu'
import { ACCENT_ORDER, type AccentName } from '../../ui/tokens'

export interface RowMenuModel {
  botName: string
  displayName: string
  accent: AccentName
  archived: boolean
  /** Greys out Mark as read for a row that has nothing unread. */
  unread: boolean
  /** Every section the row could move to; `null` is the unsectioned top group. */
  sections: readonly { id: string | null; name: string }[]
  /** False in the archive drawer, where up and down mean nothing. */
  movable?: boolean
}

export type RowMenuAction =
  | { kind: 'open' }
  | { kind: 'markRead' }
  | { kind: 'accent'; accent: AccentName }
  | { kind: 'section'; dividerId: string | null }
  | { kind: 'move'; offset: number }
  /** Open the bot's profile editor — the same sheet the chat header's pill opens. */
  | { kind: 'editProfile' }
  /** A toggle, not a value: the menu already says which way round it is. */
  | { kind: 'archiveToggle' }
  | { kind: 'dividerAbove' }

const SECTION_TOP = 'top'

/**
 * The row's menu, in the order the owner asked for it.
 *
 * Open first because it is what the row already does on a click, and a context
 * menu whose first line is not the obvious one reads as a menu of exceptions.
 * Archive last but one and the destructive-looking things never above the
 * harmless ones.
 */
export function rowMenuItems(model: RowMenuModel): MenuItem[] {
  const sections = model.sections.map<MenuItem>(section => ({
    id: `section:${section.id ?? SECTION_TOP}`,
    title: section.name || strings.layout.unnamedSection
  }))

  return menuItems(
    { id: 'open', title: strings.layout.openChat, systemImage: 'bubble.left.and.bubble.right' },
    {
      id: 'markRead',
      title: strings.layout.markRead,
      systemImage: 'envelope.open',
      disabled: !model.unread
    },
    {
      id: 'editProfile',
      title: strings.botProfile.menuItem,
      systemImage: 'person.crop.circle'
    },
    {
      id: 'colour',
      title: strings.layout.colour,
      systemImage: 'paintpalette',
      children: ACCENT_ORDER.map<MenuItem>(name => ({
        id: `accent:${name}`,
        title: strings.layout.accents[name],
        selected: name === model.accent
      }))
    },
    sections.length > 0 && {
      id: 'section',
      title: strings.layout.moveToSectionMenu,
      systemImage: 'folder',
      children: sections
    },
    model.movable !== false && {
      id: 'move',
      title: '',
      inline: true,
      children: [
        { id: 'move:-1', title: strings.layout.moveUp, systemImage: 'arrow.up' },
        { id: 'move:1', title: strings.layout.moveDown, systemImage: 'arrow.down' }
      ]
    },
    model.movable !== false && {
      id: 'dividerAbove',
      title: strings.layout.addDividerAbove,
      systemImage: 'text.insert'
    },
    {
      id: 'archive',
      title: model.archived ? strings.layout.unarchive : strings.layout.archive,
      systemImage: model.archived ? 'tray.and.arrow.up' : 'archivebox'
    }
  )
}

/**
 * Read a selection back.
 *
 * `null` for anything this menu did not offer, which includes a submenu's own id.
 * UIKit never reports opening a submenu, but a fallback sheet built from the same
 * data could hand one over by accident, and a switch that silently did the wrong
 * thing with it would be worse than one that does nothing.
 */
export function parseRowMenuAction(id: string): RowMenuAction | null {
  const [head, ...rest] = id.split(':')
  const tail = rest.join(':')

  switch (head) {
    case 'open':
      return { kind: 'open' }

    case 'markRead':
      return { kind: 'markRead' }

    case 'dividerAbove':
      return { kind: 'dividerAbove' }

    case 'editProfile':
      return { kind: 'editProfile' }

    case 'accent':
      return (ACCENT_ORDER as readonly string[]).includes(tail) ? { kind: 'accent', accent: tail as AccentName } : null

    case 'section':
      return tail ? { kind: 'section', dividerId: tail === SECTION_TOP ? null : tail } : null

    case 'move': {
      const offset = Number(tail)

      return Number.isFinite(offset) && offset !== 0 ? { kind: 'move', offset } : null
    }

    case 'archive':
      return { kind: 'archiveToggle' }

    default:
      return null
  }
}
