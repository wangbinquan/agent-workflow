// RFC-151 PR-2 → RFC-173 T3 — configurable "pick existing resources" widget.
//
// One shared implementation behind SkillsPicker / McpsPicker / PluginsPicker /
// AgentDependsPicker. RFC-173 replaced the old "single Select above a
// ChipsInput" two-zone form with a single <MultiSelect> tag combobox (selected
// items are inline removable tags; a searchable checkbox dropdown toggles
// more). The wrappers stay thin config shells.
//
// filter semantics (RFC-173 §3.2): `filter` is now an ELIGIBILITY predicate —
// which rows may be ADDED. Already-selected values are always kept in the
// dropdown (checked, uncheckable) so an item that later loses eligibility
// (a disabled plugin, a self-referencing agent) can still be un-checked. The
// old "exclude already selected" clause is gone (selection is shown, not
// hidden).
//
// RFC-223 (PR-1): value identity is the resource `id` (was `item.name`). The
// picker stores ids; the option `label` still shows the name, and MultiSelect's
// tag falls back to the raw value only for a stale/custom token. `allowCustom`
// still lets you type a name (forward-reference / degraded list) — the server
// resolves that id-or-name to an id at save (services/agentRefs.ts).

import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { api } from '@/api/client'
import { MultiSelect, type MultiSelectOption } from './MultiSelect'

/** Per-resource label strings (already resolved through i18n by the wrapper). */
export interface ResourcePickerLabels {
  /** Dropdown row shown while the list query is in flight. */
  loading: string
  /** Dropdown row shown when no options are available. */
  empty: string
  /** Muted message under the field when the list query failed. */
  loadFailed: string
}

export interface ResourcePickerProps<T extends { id: string; name: string }> {
  value: string[]
  onChange: (next: string[]) => void
  /** React Query cache key for the resource list (share it with the list page). */
  queryKey: readonly unknown[]
  /** GET endpoint returning `T[]` (e.g. '/api/skills'). */
  endpoint: string
  /** Renders one row's short title (→ tag text + dropdown title). */
  labelFn: (item: T) => string
  /** Renders one row's muted second line (optional). */
  descriptionFn?: (item: T) => string | undefined
  /** Eligibility predicate — which rows may be ADDED (default: all). Selected
   *  rows are always shown checked regardless of this. */
  filter?: (item: T) => boolean
  /** Accessible name for the combobox input (the hosting Field uses `group`,
   *  so it renders a <div>, not a <label> — the input needs its own name). */
  ariaLabel: string
  /** ChipsInput-style free-text placeholder when nothing is selected. */
  placeholder?: string
  /** data-testid forwarded to the combobox input. */
  testid?: string
  labels: ResourcePickerLabels
}

export function ResourcePicker<T extends { id: string; name: string }>(
  props: ResourcePickerProps<T>,
) {
  const { value, onChange, labels } = props
  const list = useQuery<T[]>({
    queryKey: props.queryKey,
    queryFn: ({ signal }) => api.get(props.endpoint, undefined, signal),
    staleTime: 30_000,
    retry: false,
  })

  const eligible = props.filter
  const options = useMemo<MultiSelectOption[]>(() => {
    // RFC-223 (PR-1): selection identity is the resource id.
    const selected = new Set(value)
    const pass = eligible ?? (() => true)
    return (list.data ?? [])
      .filter((item) => pass(item) || selected.has(item.id))
      .map((item) => ({
        value: item.id,
        label: props.labelFn(item),
        description: props.descriptionFn?.(item),
      }))
    // labelFn/descriptionFn are stable module fns in practice; keying on the
    // data + value is enough to recompute options.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list.data, value, eligible])

  const failed = list.error !== null && list.error !== undefined

  return (
    <div>
      <MultiSelect
        value={value}
        onChange={onChange}
        options={options}
        ariaLabel={props.ariaLabel}
        placeholder={props.placeholder}
        searchable
        // Keep the historical free-text ability: type a name not in the list
        // (forward-reference) or add one when the list endpoint is down.
        allowCustom
        loading={list.isLoading}
        loadingLabel={labels.loading}
        emptyLabel={labels.empty}
        data-testid={props.testid}
      />
      {failed && (
        <p style={{ marginTop: 4, marginBottom: 0, fontSize: 12 }} className="muted">
          {labels.loadFailed}
        </p>
      )}
    </div>
  )
}
