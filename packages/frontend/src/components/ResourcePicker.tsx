// RFC-151 PR-2 — configurable "pick an existing resource" widget.
//
// One shared implementation behind SkillsPicker / McpsPicker / PluginsPicker /
// AgentDependsPicker (previously four byte-similar copies of the same
// Select-above-ChipsInput form). The wrappers stay as thin config shells so
// their call sites and behavior tests keep working unchanged.
//
// Shape (identical to the historical pickers):
//   - one-shot "add to list" dropdown: value stays "" so the trigger always
//     shows the picker label; picking a row appends it to the chips.
//   - falls back to a plain ChipsInput when the list query fails, so the
//     hosting form stays usable even if the daemon endpoint is broken.
//
// NOT for UserPicker — that is an async-search combobox, a different form
// (RFC-151 D2).

import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { api } from '@/api/client'
import { ChipsInput } from './ChipsInput'
import { Select } from './Select'

/** Per-resource label strings (already resolved through i18n by the wrapper —
 *  the shared picker itself is i18n-agnostic). */
export interface ResourcePickerLabels {
  /** Trigger text while the list query is in flight. */
  loading: string
  /** Trigger text when no options remain after filtering. */
  empty: string
  /** Trigger text when there is something to pick. */
  pick: string
  /** Muted message shown under the chips when the list query failed. */
  loadFailed: string
}

export interface ResourcePickerProps<T> {
  value: string[]
  onChange: (next: string[]) => void
  /** React Query cache key for the resource list (share it with the list page). */
  queryKey: readonly unknown[]
  /** GET endpoint returning `T[]` (e.g. '/api/skills'). */
  endpoint: string
  /** Renders one dropdown row's label. */
  labelFn: (item: T) => string
  /** Which rows are offered. Defaults to `!existing.has(nameOf(item))`. */
  filter?: (item: T, existing: ReadonlySet<string>) => boolean
  /** Extracts the committed identity of a row. Defaults to `item.name`. */
  nameOf?: (item: T) => string
  /** Passed through to the ChipsInput free-text entry. */
  placeholder?: string
  /** data-testid for the dropdown trigger (Select passthrough). */
  testid?: string
  labels: ResourcePickerLabels
}

function defaultNameOf<T>(item: T): string {
  // Every current resource row (skill / mcp / plugin / agent) carries `name`;
  // callers with a different identity field must pass `nameOf` explicitly.
  return (item as { name: string }).name
}

export function ResourcePicker<T>(props: ResourcePickerProps<T>) {
  const { value, onChange, labels } = props
  const nameOf = props.nameOf ?? defaultNameOf<T>
  const list = useQuery<T[]>({
    queryKey: props.queryKey,
    queryFn: ({ signal }) => api.get(props.endpoint, undefined, signal),
    staleTime: 30_000,
    retry: false,
  })

  const filter = props.filter
  const available = useMemo(() => {
    const existing: ReadonlySet<string> = new Set(value)
    const pass =
      filter ?? ((item: T, exist: ReadonlySet<string>): boolean => !exist.has(nameOf(item)))
    return (list.data ?? []).filter((item) => pass(item, existing))
  }, [list.data, value, filter, nameOf])

  const failed = list.error !== null && list.error !== undefined

  // The dropdown is a one-shot "add to list" action: value stays "" so the
  // trigger always shows the picker label; picking a row appends it and the
  // controlled value="" pins the trigger back to the label on re-render.
  const pickerLabel = list.isLoading
    ? labels.loading
    : available.length === 0
      ? labels.empty
      : labels.pick

  return (
    <div>
      {!failed && (
        <div style={{ marginBottom: 6 }}>
          <Select<string>
            value=""
            placeholder={pickerLabel}
            ariaLabel={pickerLabel}
            disabled={list.isLoading || available.length === 0}
            data-testid={props.testid}
            options={available.map((item) => ({
              value: nameOf(item),
              label: props.labelFn(item),
            }))}
            onChange={(name) => {
              if (name === '' || value.includes(name)) return
              onChange([...value, name])
            }}
          />
        </div>
      )}
      <ChipsInput value={value} onChange={onChange} placeholder={props.placeholder} />
      {failed && (
        <p style={{ marginTop: 4, marginBottom: 0, fontSize: 12 }} className="muted">
          {labels.loadFailed}
        </p>
      )}
    </div>
  )
}
