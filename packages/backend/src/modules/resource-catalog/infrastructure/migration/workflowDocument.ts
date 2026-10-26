import { workflowDependencyIndexEntries, TASK_DEFINITION_HOST_IDS } from '@agent-workflow/shared'
import type { SourceRow, TargetRow } from '@/platform/persistence/migration/conversion/types'

export function workflowDocument(row: SourceRow): {
  readonly nodes?: readonly unknown[]
  readonly [key: string]: unknown
} {
  const value: unknown = JSON.parse(String(row.values.definition))
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ('nodes' in value && !Array.isArray(value.nodes))
  )
    throw new Error('v2-workflow-definition-shape')
  return value as { readonly nodes?: readonly unknown[]; readonly [key: string]: unknown }
}

export function classifyHostWorkflow(
  row: SourceRow,
): 'not-host' | 'placeholder' | 'non-skeleton-host' {
  if (!TASK_DEFINITION_HOST_IDS.includes(String(row.values.id))) return 'not-host'
  if (row.codecFailure || row.values.builtin !== true) return 'non-skeleton-host'
  try {
    const definition = workflowDocument(row)
    if (
      Object.keys(definition).some(
        (key) => !['inputs', 'nodes', 'edges', '$schema_version', 'outputs'].includes(key),
      )
    )
      return 'non-skeleton-host'
    return ['inputs', 'nodes', 'edges'].every(
      (key) => Array.isArray(definition[key]) && definition[key].length === 0,
    ) &&
      (definition.$schema_version === undefined ||
        (typeof definition.$schema_version === 'number' &&
          [1, 2, 3, 4, 5, 6, 7].includes(definition.$schema_version))) &&
      (definition.outputs === undefined ||
        (Array.isArray(definition.outputs) && definition.outputs.length === 0))
      ? 'placeholder'
      : 'non-skeleton-host'
  } catch {
    return 'non-skeleton-host'
  }
}

export function buildWorkflowDependencyIndex(row: SourceRow): readonly TargetRow[] {
  return workflowDependencyIndexEntries(String(row.values.definition)).map((entry) => ({
    workflow_id: row.values.id!,
    revision: row.values.version!,
    reference_path: entry.referencePath,
    resource_kind: entry.resourceKind,
    selector_kind: entry.selectorKind,
    selector_value: entry.selectorValue,
    namespace_json: entry.namespaceJson,
  }))
}
