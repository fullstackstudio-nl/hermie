// Naming a bot: core's PATCH route, and the local rekeying a real rename needs.
export { BotNameFields, type BotNameFieldsProps, initialBotName } from './BotNameFields'
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
