/**
 * The development launch hook.
 *
 * Two things are worth pinning. The grammar, because a mistyped argument produces
 * a screenshot of the wrong thing and nobody notices until the design review. And
 * the `__DEV__` gate, because this opens arbitrary screens and the only acceptable
 * behaviour in a shipped build is that it does not exist.
 */
import { GALLERY_SECTION_IDS } from '../src/features/settings'
import { parseDevLaunchArguments } from '../src/dev/launch-intent'

describe('parseDevLaunchArguments', () => {
  it('finds nothing in the arguments a plain launch carries', () => {
    expect(parseDevLaunchArguments(['/path/to/Hermie.app/Hermie'])).toBeNull()
    expect(parseDevLaunchArguments(['--initialUrl', 'http://localhost:8081'])).toBeNull()
  })

  it('reads a gallery section, a theme and a wallpaper in any order', () => {
    expect(
      parseDevLaunchArguments([
        'Hermie',
        '--hermieTheme',
        'dark',
        '--initialUrl',
        'http://localhost:8081',
        '--hermieOpen',
        'gallery:sheet-options-model-page',
        '--hermieWallpaper',
        'warm'
      ])
    ).toEqual({
      open: { kind: 'gallery', section: 'sheet-options-model-page' },
      scheme: 'dark',
      wallpaper: 'warm'
    })
  })

  it('accepts the `--flag=value` spelling, because shells differ', () => {
    expect(parseDevLaunchArguments(['--hermieOpen=chat:researcher', '--hermieTheme=light'])).toEqual({
      open: { kind: 'chat', bot: 'researcher' },
      scheme: 'light'
    })
  })

  it('does not swallow the next flag as a missing value', () => {
    expect(parseDevLaunchArguments(['--hermieOpen', '--hermieTheme', 'dark'])).toEqual({ scheme: 'dark' })
  })

  it('maps a sheet shorthand onto the gallery section that holds it', () => {
    expect(parseDevLaunchArguments(['--hermieOpen', 'sheet:approval'])?.open).toEqual({
      kind: 'gallery',
      section: 'sheet-approval'
    })
    expect(parseDevLaunchArguments(['--hermieOpen', 'sheet:colour'])?.open).toEqual({
      kind: 'gallery',
      section: 'sheet-options-colour-page'
    })
  })

  it('reads an overlay and its settings page, under either spelling', () => {
    expect(parseDevLaunchArguments(['--hermieOpen', 'overlay:crons'])?.open).toEqual({
      kind: 'overlay',
      section: 'cron'
    })
    expect(parseDevLaunchArguments(['--hermieOpen', 'overlay:settings/licenses'])?.open).toEqual({
      kind: 'overlay',
      section: 'settings',
      page: 'licences'
    })
  })

  it('ignores a target, a theme or a wallpaper it does not recognise', () => {
    expect(parseDevLaunchArguments(['--hermieOpen', 'nonsense:thing'])).toBeNull()
    expect(parseDevLaunchArguments(['--hermieOpen', 'overlay:nowhere'])).toBeNull()
    expect(parseDevLaunchArguments(['--hermieTheme', 'sepia'])).toBeNull()
    expect(parseDevLaunchArguments(['--hermieWallpaper', 'tartan'])).toBeNull()
  })

  it('names sheet shorthands that exist in the gallery', () => {
    // A shorthand pointing at a section nobody wrote is a launch that silently
    // shows the whole gallery instead of the sheet that was asked for.
    for (const shorthand of ['agents', 'approval', 'clarify', 'colour', 'cron-editor', 'model', 'options']) {
      const open = parseDevLaunchArguments(['--hermieOpen', `sheet:${shorthand}`])?.open

      expect(open?.kind).toBe('gallery')
      expect(GALLERY_SECTION_IDS).toContain(open?.kind === 'gallery' ? open.section : '')
    }
  })
})

describe('the __DEV__ gate', () => {
  /**
   * `DEV_LAUNCH_INTENT` is `__DEV__ ? parse(...) : null`, evaluated once at module
   * load, so the assertion has to be made on a fresh load with the flag down.
   * That is also exactly the shape Metro's minifier folds away: with `__DEV__`
   * inlined as `false`, the ternary and the native read beside it are dead code
   * and do not reach a Release bundle at all. The `#if DEBUG` in
   * `HermieMacModule.swift` removes the constant they would have read.
   */
  const withDev = (value: boolean) => {
    jest.resetModules()
    const previous = (globalThis as { __DEV__?: boolean }).__DEV__

    ;(globalThis as { __DEV__?: boolean }).__DEV__ = value

    try {
      return require('../src/dev/launch-intent').DEV_LAUNCH_INTENT as unknown
    } finally {
      ;(globalThis as { __DEV__?: boolean }).__DEV__ = previous
    }
  }

  it('is null when __DEV__ is false, whatever the process was launched with', () => {
    expect(withDev(false)).toBeNull()
  })

  it('is null in this environment even with __DEV__ true, because there is no native module', () => {
    // The Jest renderer has no Expo module host, so the argument read degrades to
    // an empty array rather than throwing. A gallery test must not accidentally
    // inherit a launch argument from the runner.
    expect(withDev(true)).toBeNull()
  })
})
