/**
 * Settings → Appearance → Themes: the reader's own themes and the editor.
 *
 * A route rather than a boolean inside Appearance, so its back control is the
 * stack's like every other page's. HERM-107 moves the preset cards here too.
 */
import { ThemesScreen } from '../ThemesScreen'
import { useSettingsBack } from '../navigation/SettingsPage'

export function Page() {
  const back = useSettingsBack('Theme')

  return <ThemesScreen {...(back ? { back } : {})} />
}
