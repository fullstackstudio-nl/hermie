import { keyValueStore } from '../src/platform/key-value-store'
import { CHAT_VIEW_KEY, chatViewFor, DEFAULT_CHAT_VIEW, useSettingsStore } from '../src/store/settings'

beforeEach(async () => {
  useSettingsStore.getState().reset()
  await keyValueStore.delete(CHAT_VIEW_KEY)
})

/** The store serialises its writes; this waits for the one just queued. */
const settled = () => new Promise(resolve => setTimeout(resolve, 0))

describe('chat view settings', () => {
  it('starts at Normal, bot-to-bot on, thinking off', () => {
    expect(DEFAULT_CHAT_VIEW).toEqual({ level: 'normal', showBotToBot: true, showThinking: false })
  })

  it('lets a chat without an override follow the default as it moves', () => {
    useSettingsStore.getState().setDefaults({ level: 'verbose' })

    expect(chatViewFor(useSettingsStore.getState(), 'researcher').level).toBe('verbose')
  })

  it('pins a chat that has an override', () => {
    useSettingsStore.getState().setChatView('researcher', { level: 'quiet' })
    useSettingsStore.getState().setDefaults({ level: 'verbose' })

    expect(chatViewFor(useSettingsStore.getState(), 'researcher').level).toBe('quiet')
    expect(chatViewFor(useSettingsStore.getState(), 'writer').level).toBe('verbose')

    useSettingsStore.getState().resetChatView('researcher')

    expect(chatViewFor(useSettingsStore.getState(), 'researcher').level).toBe('verbose')
  })

  it('reads its settings back from the key-value store', async () => {
    useSettingsStore.getState().setDefaults({ showThinking: true })
    useSettingsStore.getState().setChatView('writer', { level: 'quiet' })
    await settled()

    useSettingsStore.getState().reset()
    await useSettingsStore.getState().hydrate()

    expect(useSettingsStore.getState().defaults.showThinking).toBe(true)
    expect(chatViewFor(useSettingsStore.getState(), 'writer').level).toBe('quiet')
  })

  it('falls back to the defaults when the stored blob is from another build', async () => {
    await keyValueStore.setJson(CHAT_VIEW_KEY, { defaults: { level: 'shouty' }, perChat: { writer: 'nonsense' } })

    await useSettingsStore.getState().hydrate()

    expect(useSettingsStore.getState().defaults).toEqual(DEFAULT_CHAT_VIEW)
    expect(useSettingsStore.getState().perChat).toEqual({})
  })
})
