// RFC-117 — shared runtime-picker data for the agent + settings runtime
// selectors. Single source so the AgentForm runtime <Select> and the settings
// (distiller / commit / fusion) pickers can't drift apart — same /api/runtimes
// fetch, same RFC-118 disabled-filter.
//
// flag-audit §8 决策（用户 2026-07-07）：RFC-111 D17 的 `claudeCodeEnabled`
// 配置门已删除（三重矛盾的假门：注释称默认关、前端按默认开消费、后端从不
// enforce）。claude 可用性改由 runtimes 注册表派生——per-runtime `enabled`
// 是唯一开关。

import { useQuery } from '@tanstack/react-query'
import { api } from '@/api/client'

export interface SelectableRuntime {
  name: string
  protocol: string
}

/**
 * Registered runtimes filtered to what's selectable now: enabled (or the
 * already-selected `currentValue`, so an existing pin is never hidden — RFC-118
 * D6). Mirrors the AgentForm picker logic.
 */
export function useRuntimesList(currentValue?: string | null): {
  selectableRuntimes: SelectableRuntime[]
  claudeEnabled: boolean
  isLoading: boolean
} {
  const runtimesQuery = useQuery<{
    runtimes: Array<{ name: string; protocol: string; enabled: boolean }>
  }>({
    queryKey: ['runtimes'],
    queryFn: ({ signal }) => api.get('/api/runtimes', undefined, signal),
    staleTime: 30_000,
  })
  const registered = runtimesQuery.data?.runtimes ?? []
  const claudeEnabled = hasEnabledClaudeRuntime(registered)
  const selectableRuntimes = filterSelectableRuntimes(registered, currentValue)
  return { selectableRuntimes, claudeEnabled, isLoading: runtimesQuery.isLoading }
}

/** True when the registry offers at least one enabled claude-protocol runtime —
 *  the registry-derived successor of the deleted `claudeCodeEnabled` config gate. */
export function hasEnabledClaudeRuntime(
  registered: ReadonlyArray<{ protocol: string; enabled: boolean }>,
): boolean {
  return registered.some((r) => r.protocol === 'claude-code' && r.enabled)
}

/**
 * Pure filter (testable without mounting react-query): keep runtimes that are
 * enabled — or the already-selected `currentValue` so an existing pin is never
 * hidden (RFC-118 D6). A disabled claude-protocol runtime is excluded by its
 * own `enabled` flag; there is no blanket claude gate any more.
 */
export function filterSelectableRuntimes(
  registered: ReadonlyArray<{ name: string; protocol: string; enabled: boolean }>,
  currentValue: string | null | undefined,
): SelectableRuntime[] {
  return registered
    .filter((r) => r.enabled || r.name === currentValue)
    .map((r) => ({ name: r.name, protocol: r.protocol }))
}
