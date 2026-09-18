import { CompactShell } from './CompactShell'
import { RegularShell } from './RegularShell'
import { useLayoutMode } from './useLayoutMode'

export function Shell() {
  return useLayoutMode() === 'regular' ? <RegularShell /> : <CompactShell />
}
