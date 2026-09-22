/**
 * What each Settings route is CALLED and where it sits, without the page itself.
 *
 * The page components live in `routes.tsx`. The split exists because a page
 * needs its own title and its parent's (the back label), and a page importing
 * the registry that imports the page would be a cycle.
 *
 * `parent` is required on every entry — `null` only for `Root` — so a route
 * without one does not compile. It is what `settings-routes.test.tsx` walks: a
 * route's back control must be labelled with its parent's title and must land
 * on its parent.
 */
import { strings } from '../../../i18n/strings'
import { connectorStrings } from '../../connectors/strings'
import { kanbanStrings } from '../../kanban/strings'
import { mcpStrings } from '../../mcp/strings'
import { memoryStrings } from '../../memory/strings'
import { skillStrings } from '../../skills/strings'
import { GALLERY_ROW_TITLE } from '../GalleryScreen'
import type { SettingsRouteName } from './route-names'

export interface SettingsRouteMeta {
  /** Called, not read: the strings follow the language picked at runtime. */
  title: () => string
  parent: SettingsRouteName | null
}

const category = strings.settings.categories

export const SETTINGS_ROUTE_META: Record<SettingsRouteName, SettingsRouteMeta> = {
  Root: { title: () => strings.settings.title, parent: null },

  Account: { title: () => category.account, parent: 'Root' },

  Gateways: { title: () => category.gateways, parent: 'Root' },
  GatewayDetail: { title: () => strings.settings.gateways.detailTitle, parent: 'Gateways' },
  GatewayAdd: { title: () => strings.settings.gateways.add, parent: 'Gateways' },

  ChatsMessages: { title: () => category.chats, parent: 'Root' },
  Notifications: { title: () => category.notifications, parent: 'Root' },
  Context: { title: () => category.context, parent: 'Root' },

  Memory: { title: () => category.memory, parent: 'Root' },
  MemoryBot: { title: () => memoryStrings.title, parent: 'Memory' },

  Appearance: { title: () => category.appearance, parent: 'Root' },
  Theme: { title: () => strings.settings.themes.title, parent: 'Appearance' },

  Privacy: { title: () => category.privacy, parent: 'Root' },
  LockThreshold: { title: () => strings.settings.lock.label, parent: 'Privacy' },
  Voice: { title: () => category.voice, parent: 'Root' },

  Capabilities: { title: () => category.capabilities, parent: 'Root' },
  Skills: { title: () => skillStrings.title, parent: 'Capabilities' },
  Mcp: { title: () => mcpStrings.title, parent: 'Capabilities' },
  McpServer: { title: () => mcpStrings.detail.title, parent: 'Mcp' },
  Connectors: { title: () => connectorStrings.title, parent: 'Capabilities' },
  Connector: { title: () => connectorStrings.detail.title, parent: 'Connectors' },
  Boards: { title: () => kanbanStrings.title, parent: 'Capabilities' },

  Advanced: { title: () => category.advanced, parent: 'Root' },
  ConnectionTest: { title: () => strings.settings.connectionTest, parent: 'Advanced' },
  Gallery: { title: () => GALLERY_ROW_TITLE, parent: 'Advanced' },

  About: { title: () => category.about, parent: 'Root' },
  Licences: { title: () => strings.settings.licences, parent: 'About' }
}

export function settingsTitle(name: string): string {
  return SETTINGS_ROUTE_META[name as SettingsRouteName]?.title() ?? name
}

/**
 * The routes from the top of the stack down to `name`, top first.
 *
 * `Root` is left out when the stack has no root of its own — the split layout,
 * where the category list is a column beside the stack rather than a page in it.
 */
export function settingsChain(name: SettingsRouteName, { withRoot }: { withRoot: boolean }): SettingsRouteName[] {
  const chain: SettingsRouteName[] = []
  let at: SettingsRouteName | null = name

  while (at) {
    chain.unshift(at)
    at = SETTINGS_ROUTE_META[at].parent
  }

  return withRoot ? chain : chain.filter(entry => entry !== 'Root')
}
