/**
 * The app's half of ADR-0016: the two stores against the two `ui_meta` keys.
 *
 * `packages/gateway-client/src/ui-meta.test.ts` exercises the protocol against a
 * real fake gateway. This is the adapter above it, and what is worth pinning here
 * is what a projection can get quietly wrong:
 *
 *  - the SHAPE: which store field lands in which key, and that `sidebarCollapsed`
 *    lands in neither, because it is about the window in front of the reader;
 *  - the DIFF: a change anybody makes, through any setter, is noticed — and a
 *    section that goes AWAY (unarchived, colour back to Default) is a change too,
 *    which is the case a diff over the new snapshot alone would miss;
 *  - the LOOP that must not close: applying a gateway's copy into the stores must
 *    not read back as a local change and be sent straight home again.
 */
import { keyValueStore } from '../src/platform/key-value-store'
import { CHAT_LAYOUT_KEY, useChatLayoutStore } from '../src/store/chat-layout'
import { useSettingsStore } from '../src/store/settings'
import { applySnapshot, snapshotFromStores, UiMetaBridge, type HermieAppShape } from '../src/store/ui-meta-bridge'

const settled = () => new Promise(resolve => setTimeout(resolve, 5))

beforeEach(async () => {
  useChatLayoutStore.getState().reset()
  useSettingsStore.getState().reset()
  // The arrangement is persisted per gateway, so one case's dividers are the
  // next one's unless the disk is cleared with the store.
  await keyValueStore.delete(CHAT_LAYOUT_KEY)
  await useChatLayoutStore.getState().load('http://gateway.example')
})

describe('the projection', () => {
  it('puts a bot’s own settings in the bot key and the rest in the app key', () => {
    useChatLayoutStore.getState().addDivider('Finance')
    useChatLayoutStore.getState().setArchived('writer', true)
    useChatLayoutStore.getState().setAccent('researcher', 'lime')
    useSettingsStore.getState().setDefaults({ level: 'verbose' })
    useSettingsStore.getState().setThemeChoice({ kind: 'preset', name: 'graphite' })

    const snapshot = snapshotFromStores()
    const app = snapshot.app as HermieAppShape

    expect(snapshot.bots).toEqual({
      writer: { v: 1, archived: true },
      researcher: { v: 1, colour: 'lime' }
    })
    expect(app.defaults?.level).toBe('verbose')
    expect(app.themeChoice).toEqual({ kind: 'preset', name: 'graphite' })
    expect(app.entries?.some(entry => entry.kind === 'divider' && entry.name === 'Finance')).toBe(true)
  })

  it('leaves the sidebar out of it', () => {
    useChatLayoutStore.getState().setSidebarCollapsed(true)

    // A desktop hiding its list must not collapse a tablet's, and a phone has no
    // sidebar to collapse at all.
    expect(JSON.stringify(snapshotFromStores())).not.toContain('sidebarCollapsed')
  })

  it('reads a gateway’s copy back into both stores', () => {
    applySnapshot({
      app: {
        v: 1,
        entries: [{ kind: 'chat', name: 'writer' }],
        defaults: { level: 'quiet', showBotToBot: false, showThinking: true },
        themeChoice: { kind: 'preset', name: 'lime' },
        themes: [{ id: 't1', name: 'Studio', base: 'lime' }]
      } as HermieAppShape,
      bots: { researcher: { v: 1, archived: true, colour: 'teal' } }
    })

    expect(useChatLayoutStore.getState().entries).toEqual([{ kind: 'chat', name: 'writer' }])
    expect(useChatLayoutStore.getState().archived).toEqual({ researcher: true })
    expect(useChatLayoutStore.getState().accents).toEqual({ researcher: 'teal' })
    expect(useSettingsStore.getState().defaults.level).toBe('quiet')
    expect(useSettingsStore.getState().themeChoice).toEqual({ kind: 'preset', name: 'lime' })
    expect(useSettingsStore.getState().userThemes[0]?.name).toBe('Studio')
  })

  it('does not read an absent arrangement as an empty one', () => {
    // A gateway nobody has written to has no arrangement. Taking that as "no
    // rows anywhere" would empty a list somebody spent an afternoon on.
    useChatLayoutStore.getState().addDivider('Finance')

    applySnapshot({ app: { v: 1 }, bots: {} })

    expect(useChatLayoutStore.getState().entries).toHaveLength(1)
  })

  it('ignores a colour this build does not have', () => {
    applySnapshot({ app: null, bots: { researcher: { v: 1, colour: 'tartan' } } })

    expect(useChatLayoutStore.getState().accents).toEqual({})
  })
})

describe('the bridge', () => {
  /**
   * Whoever the gateway named.
   *
   * Every case here has one, because the app-wide key carries a person's name
   * and a bridge that has not been told one writes no arrangement at all. On a
   * token gateway — which is what this fake is — that name is `owner`.
   */
  const OWNER = 'owner'

  /** A gateway that records what it was asked, and answers an empty roster. */
  function recorder() {
    const calls: { method: string; params?: Record<string, unknown> }[] = []

    return {
      calls,
      request: async (method: string, params?: Record<string, unknown>) => {
        calls.push({ method, params })

        return method === 'profiles.list'
          ? { profiles: [{ name: 'researcher', is_default: true, ui_meta: { 'hermes-bots': {} } }] }
          : { ok: true, applied: { ui_meta: true, ui_meta_revisions: { hermie: 1, 'hermie-app:owner': 1 } } }
      }
    }
  }

  it('sends a section anybody changed, whichever setter did it', async () => {
    const gateway = recorder()
    const bridge = new UiMetaBridge({ gateway, debounceMs: 0 })

    bridge.setUser(OWNER)
    const stop = bridge.start()

    useChatLayoutStore.getState().setAccent('researcher', 'lime')
    await settled()

    const write = gateway.calls.find(call => call.method === 'profiles.configure')

    expect(write?.params?.name).toBe('researcher')
    expect(write?.params?.ui_meta).toMatchObject({ hermie: { colour: 'lime' } })
    // Only the key it is changing: `hermes-bots` is not ours to send.
    expect(Object.keys((write?.params?.ui_meta ?? {}) as object)).toEqual(['hermie'])

    stop()
  })

  it('notices a section that went away', async () => {
    const gateway = recorder()
    const bridge = new UiMetaBridge({ gateway, debounceMs: 0 })

    bridge.setUser(OWNER)

    useChatLayoutStore.getState().setArchived('writer', true)

    const stop = bridge.start()

    useChatLayoutStore.getState().setArchived('writer', false)
    await settled()

    const write = gateway.calls.find(call => call.method === 'profiles.configure')

    // Removed, not emptied: a bot with nothing to say leaves no key behind.
    expect(write?.params?.ui_meta).toEqual({ hermie: null })

    stop()
  })

  it('seeds a gateway that has no section yet, and then says nothing more', async () => {
    // An absent key is not a decision anybody made. A reader who arranged their
    // list before signing in on a second device would otherwise find both the
    // tablet and the gateway empty, each waiting for the other to go first.
    const gateway = recorder()
    const bridge = new UiMetaBridge({ gateway, debounceMs: 0 })

    bridge.setUser(OWNER)
    const stop = bridge.start()

    await bridge.reconcile()
    await settled()

    expect(gateway.calls.filter(call => call.method === 'profiles.configure')).toHaveLength(1)

    // And nothing echoes: what came back in must not read as a local change.
    gateway.calls.length = 0
    await settled()

    expect(gateway.calls).toHaveLength(0)

    stop()
  })

  it('sends one request per profile, not one per section', async () => {
    const gateway = recorder()
    const bridge = new UiMetaBridge({ gateway, debounceMs: 0 })

    bridge.setUser(OWNER)

    await bridge.reconcile()

    const stop = bridge.start()

    // The reconcile above seeded the empty gateway; this case is about what goes
    // out AFTER that.
    gateway.calls.length = 0

    useChatLayoutStore.getState().setAccent('researcher', 'lime')
    useSettingsStore.getState().setThemeChoice({ kind: 'preset', name: 'lime' })
    await settled()

    const writes = gateway.calls.filter(call => call.method === 'profiles.configure')

    // `researcher` is the default profile here, so both sections are its own —
    // and the protocol applies the sections of one request independently.
    expect(writes).toHaveLength(1)
    expect(Object.keys((writes[0]?.params?.ui_meta ?? {}) as object).sort()).toEqual(['hermie', 'hermie-app:owner'])

    stop()
  })
})
