// Settings as routes: the registry, the stack, and the host that lays them out.
export { CategoryRow, type CategoryRowProps } from './CategoryRow'
export { SETTINGS_ROUTE_META, settingsChain, settingsTitle, type SettingsRouteMeta } from './route-meta'
export {
  SETTINGS_CATEGORIES,
  SETTINGS_ROUTE_NAMES,
  settingsRouteFrom,
  type SettingsCategoryName,
  type SettingsParamList,
  type SettingsRouteName
} from './route-names'
export {
  SETTINGS_ROUTES,
  settingsCategory,
  visibleCategories,
  visibleCategoryGroups,
  type SettingsCategory,
  type SettingsRoute
} from './routes'
export { SettingsCategoryList, type SettingsCategoryListProps } from './SettingsCategoryList'
export { SETTINGS_SPLIT_MIN_WIDTH, SettingsHost, type SettingsHostProps } from './SettingsHost'
export {
  SettingsHostChromeContext,
  SettingsPage,
  SettingsScroll,
  useSettingsBack,
  type SettingsHostChrome,
  type SettingsPageProps
} from './SettingsPage'
export { SettingsStack, type SettingsStackProps } from './SettingsStack'
