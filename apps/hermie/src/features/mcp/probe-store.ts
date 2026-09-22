/**
 * What the MCP pages have learned by testing, shared between the list and a
 * server's own page.
 *
 * The two used to be one component with the detail as an early return, so a
 * probe run on the detail was simply in scope when the list came back. As two
 * routes in the Settings stack they are two components, and this is the part of
 * their state that has to outlive either: the list marks a server that asked
 * for authorisation, and reloads once an authorisation changed what the
 * gateway reports (`revision`).
 */
import { create } from 'zustand'

import type { McpProbe } from './mcp-controller'

interface McpProbeState {
  probes: Record<string, McpProbe>
  /** Bumped when a server's runtime state changed underneath the list. */
  revision: number
  setProbe: (name: string, probe: McpProbe) => void
  changed: () => void
  reset: () => void
}

export const useMcpProbeStore = create<McpProbeState>(set => ({
  probes: {},
  revision: 0,
  setProbe: (name, probe) => set(state => ({ probes: { ...state.probes, [name]: probe } })),
  changed: () => set(state => ({ revision: state.revision + 1 })),
  reset: () => set({ probes: {}, revision: 0 })
}))
