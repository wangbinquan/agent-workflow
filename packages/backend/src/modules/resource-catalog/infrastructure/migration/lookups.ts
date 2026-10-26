import { TASK_DEFINITION_HOST_IDS, collectWorkflowDependencyRefs } from '@agent-workflow/shared'
import { lookupKey, type LookupBuilder } from '@/platform/persistence/migration/conversion/lookups'
import { TASK_FACTS } from '@/platform/persistence/migration/conversion/lookups/keys'
import type { RuleContext } from '@/platform/persistence/migration/conversion/rule'
import type { SourceRow } from '@/platform/persistence/migration/conversion/types'
import { classifyHostWorkflow, workflowDocument } from './workflowDocument'

export interface HostPlaceholder {
  readonly classification: ReturnType<typeof classifyHostWorkflow>
  readonly name: string
}
export interface WorkflowReference {
  readonly table: string
  readonly sourceKey: string
  readonly column: string
  readonly path: string
  readonly reason: string
}
export const HOST_PLACEHOLDERS = lookupKey<HostPlaceholder>('resource-catalog/host-placeholders', 1)
export const REFERENCED_WORKFLOW_IDS = lookupKey<readonly WorkflowReference[]>(
  'resource-catalog/referenced-workflow-ids',
  2,
)

export const hostPlaceholders: LookupBuilder<HostPlaceholder> = {
  key: HOST_PLACEHOLDERS,
  sources: ['workflows'],
  build(staged, put) {
    for (const row of staged.rows('workflows'))
      if (TASK_DEFINITION_HOST_IDS.includes(String(row.values.id)))
        put(String(row.values.id), {
          classification: classifyHostWorkflow(row),
          name: String(row.values.name),
        })
  },
}

function document(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

// Catalog consumers only: frozen task payloads, provenance and memory namespaces are history.
export const referencedWorkflowIds: LookupBuilder<readonly WorkflowReference[]> = {
  key: REFERENCED_WORKFLOW_IDS,
  sources: [
    'workflows',
    'tasks',
    'scheduled_tasks',
    'webhook_triggers',
    'event_response_rules',
    'resource_grants',
  ],
  dependsOn: [HOST_PLACEHOLDERS, TASK_FACTS],
  build(staged, put, lookups) {
    const refs = new Map<string, WorkflowReference[]>()
    const hosts = lookups(HOST_PLACEHOLDERS)
    const add = (id: unknown, row: SourceRow, column: string, path = column) => {
      if (typeof id !== 'string' || !hosts.get(id)) return
      const entries = refs.get(id) ?? []
      entries.push({
        table: row.table,
        sourceKey: row.encodedKey,
        column,
        path,
        reason: 'catalog-reference',
      })
      refs.set(id, entries)
    }
    for (const row of staged.rows('workflows')) {
      if (classifyHostWorkflow(row) === 'placeholder') continue
      try {
        for (const ref of collectWorkflowDependencyRefs(workflowDocument(row))) {
          if (ref.resourceType !== 'workflow') continue
          // A stale ID hint is ignored by pickCallTarget; the authored name is authoritative.
          for (const [id, host] of hosts.entries())
            if (ref.value === host.name)
              add(id, row, 'definition', `definition.${ref.referencePath}`)
        }
      } catch {
        // The workflow rule decides unreadable definitions; they prove no particular target.
      }
    }
    for (const row of staged.rows('tasks')) {
      const fact = lookups(TASK_FACTS).get(String(row.values.id))
      if (fact?.execution === 'executable' && fact.subjectKind === 'workflow')
        add(row.values.workflow_id, row, 'workflow_id')
    }
    for (const row of staged.rows('scheduled_tasks'))
      if (row.values.launch_kind === 'workflow')
        add(
          document(row.values.launch_payload)?.workflowId,
          row,
          'launch_payload',
          'launch_payload.workflowId',
        )
    for (const row of staged.rows('webhook_triggers'))
      if (row.values.launch_kind === 'workflow') add(row.values.launch_ref_id, row, 'launch_ref_id')
    for (const row of staged.rows('event_response_rules')) {
      const target = document(row.values.target_json)
      if (target?.kind === 'workflow') add(target.refId, row, 'target_json', 'target_json.refId')
    }
    for (const row of staged.rows('resource_grants')) {
      if (row.values.resource_type !== 'workflow') continue
      // Grants of a proven placeholder are deleted with it, so they do not keep it alive.
      if (hosts.get(String(row.values.resource_id))?.classification === 'placeholder') continue
      add(row.values.resource_id, row, 'resource_id')
    }
    for (const [id, entries] of refs) put(id, entries)
  },
}

export function survivingWorkflowReferences(
  ctx: RuleContext,
  id: string,
): readonly WorkflowReference[] {
  return (ctx.lookup(REFERENCED_WORKFLOW_IDS).get(id) ?? []).filter(
    (ref) =>
      ctx.preflight.tables.some(
        (table) => table.table === ref.table && table.destination.kind === 'business',
      ) &&
      ctx.preflight.contract?.tables.some(
        (table) =>
          table.id === ref.table && table.columns.some((column) => column.name === ref.column),
      ),
  )
}
