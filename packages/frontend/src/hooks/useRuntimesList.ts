// RFC-117 — shared runtime-picker data for the agent + settings runtime
// selectors. Single source so the AgentForm runtime <Select> and the settings
// (distiller / commit / fusion) pickers can't drift apart — same /api/runtimes
// fetch, same RFC-118 disabled-filter + claude-protocol gating.

import { useQuery } from '@tanstack/react-query'
import type { Config } from '@agent-workflow/shared'
import { api } from '@/api/client'

export interface SelectableRuntime {
  name: string
  protocol: string
}

/**
 * Registered runtimes filtered to what's selectable now: enabled (or the
 * already-selected `currentValue`, so an existing pin is never hidden — RFC-118
 * D6), and claude-protocol runtimes dropped when claude-code is disabled. Mirrors
 * the AgentForm picker logic.
 */
export function useRuntimesList(currentValue?: string | null): {
  selectableRuntimes: SelectableRuntime[]
  claudeEnabled: boolean
  isLoading: boolean
} {
  // Shared ['config'] cache (also used by the agent routes) for claudeCodeEnabled,
  // which gates whether claude-protocol runtimes are offered.
  const config = useQuery<Config>({
    queryKey: ['config'],
    queryFn: ({ signal }) => api.get('/api/config', undefined, signal),
    staleTime: 30_000,
    retry: false,
  })
  const claudeEnabled = config.data?.claudeCodeEnabled !== false
  const runtimesQuery = useQuery<{
    runtimes: Array<{ name: string; protocol: string; enabled: boolean }>
  }>({
    queryKey: ['runtimes'],
    queryFn: ({ signal }) => api.get('/api/runtimes', undefined, signal),
    staleTime: 30_000,
  })
  const registered = runtimesQuery.data?.runtimes ?? []
  const selectableRuntimes = filterSelectableRuntimes(registered, currentValue, claudeEnabled)
  return { selectableRuntimes, claudeEnabled, isLoading: runtimesQuery.isLoading }
}

/**
 * Pure filter (testable without mounting react-query): keep runtimes that are
 * enabled — or the already-selected `currentValue` so an existing pin is never
 * hidden (RFC-118 D6) — and drop claude-protocol runtimes when claude-code is off.
 */
export function filterSelectableRuntimes(
  registered: ReadonlyArray<{ name: string; protocol: string; enabled: boolean }>,
  currentValue: string | null | undefined,
  claudeEnabled: boolean,
): SelectableRuntime[] {
  return registered
    .filter(
      (r) =>
        (r.enabled || r.name === currentValue) && (claudeEnabled || r.protocol !== 'claude-code'),
    )
    .map((r) => ({ name: r.name, protocol: r.protocol }))
}
