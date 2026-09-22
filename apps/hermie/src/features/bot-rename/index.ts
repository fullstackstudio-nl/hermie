// Naming a bot: the app's own display name, and core's PATCH route behind the
// separate act of renaming the profile itself.
export { BotNameFields, type BotNameFieldsProps } from './BotNameFields'
export { renameBot, type RenameBotResult } from './rename-bot'
export {
  asRenameError,
  PROFILE_NAME_MAX,
  type ProfileRenameAnswer,
  ProfileRenameError,
  renameProfile
} from './rename-controller'
export { botNameChanged, saveBotName, type SaveBotNameOptions, type SaveBotNameResult } from './save-bot-name'
export { renameStrings } from './strings'
