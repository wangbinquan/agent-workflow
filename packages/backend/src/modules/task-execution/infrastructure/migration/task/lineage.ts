import {
  columnLookup,
  lookupKey,
  type LookupBuilder,
} from '@/platform/persistence/migration/conversion/lookups'
import type { SourceRow } from '@/platform/persistence/migration/conversion/types'
import { text, nullableText, pick } from './values'

export interface TaskLineage {
  readonly executionLineageId: string
  readonly lineageSlotPathJson: string
  readonly launchOrigin: string
  readonly parentLaunchOrigin: string | null
  readonly derived: boolean
  readonly missingFields: readonly string[]
}

// Package-private: no other domain consumes lineage through this key.
export const TASK_LINEAGE = lookupKey<TaskLineage>('task-execution/task-lineage', 2)
export const PARENT_RUN_SLOT = columnLookup('node_runs', ['id'], ['continuation_slot_key']).key

function compactSqliteJson(json: string): string {
  // SQLite json_insert preserves number tokens, duplicate keys and string escapes.
  let quoted = false
  let escaped = false
  let result = ''
  for (const character of json) {
    if (quoted || !/[\t\r\n ]/.test(character)) result += character
    if (escaped) escaped = false
    else if (quoted && character === '\\') escaped = true
    else if (character === '"') quoted = !quoted
  }
  return result
}

/** db/migrations/0210_rfc328_task_execution_ownership.sql:64 — trigger, not bulk backfill. */
export function fillLegacyLineage(
  task: SourceRow,
  parent: TaskLineage | undefined,
  parentRunSlotKey: string | null,
): Pick<TaskLineage, 'executionLineageId' | 'lineageSlotPathJson' | 'derived'> | null {
  const recordedId = nullableText(task, 'execution_lineage_id')
  const recordedPath = nullableText(task, 'lineage_slot_path_json')
  if (recordedId !== null && recordedPath !== null)
    return { executionLineageId: recordedId, lineageSlotPathJson: recordedPath, derived: false }
  const child = nullableText(task, 'parent_task_id') !== null
  const segment = JSON.stringify({
    stableNodeKey: child ? 'child-task' : 'task-root',
    frozenOccurrenceKey: child
      ? (parentRunSlotKey ?? nullableText(task, 'parent_node_run_id') ?? text(task, 'id'))
      : text(task, 'id'),
    workflowRevision: task.values.workflow_version,
  })
  let path = `[${segment}]`
  if (child && parent) {
    try {
      const parentPath: unknown = JSON.parse(parent.lineageSlotPathJson)
      const prefix = compactSqliteJson(parent.lineageSlotPathJson)
      path = Array.isArray(parentPath)
        ? `${prefix.slice(0, -1)}${prefix === '[]' ? '' : ','}${segment}]`
        : prefix
    } catch {
      return null
    }
  }
  return {
    executionLineageId: parent?.executionLineageId ?? text(task, 'id'),
    lineageSlotPathJson: path,
    derived: true,
  }
}

export const taskLineageLookup: LookupBuilder<TaskLineage> = {
  key: TASK_LINEAGE,
  sources: ['tasks'],
  dependsOn: [PARENT_RUN_SLOT],
  build(staged, put, lookups) {
    const tasks = new Map<string, SourceRow>()
    for (const row of staged.rows('tasks'))
      tasks.set(text(row, 'id'), {
        table: row.table,
        phase: row.phase,
        key: row.key,
        encodedKey: row.encodedKey,
        canonical: { key: [...row.key], values: [] },
        values: pick(row, [
          'id',
          'execution_lineage_id',
          'lineage_slot_path_json',
          'parent_task_id',
          'parent_node_run_id',
          'workflow_version',
          'launch_origin',
        ]),
        ...(row.codecFailure ? { codecFailure: row.codecFailure } : {}),
      })
    const resolved = new Map<string, TaskLineage>()
    const visiting = new Set<string>()
    const resolve = (id: string): TaskLineage | undefined => {
      if (resolved.has(id)) return resolved.get(id)
      if (visiting.has(id)) return undefined
      const task = tasks.get(id)
      if (!task || task.codecFailure) return undefined
      visiting.add(id)
      const parentId = nullableText(task, 'parent_task_id')
      const parent = parentId === null ? undefined : resolve(parentId)
      const runId = nullableText(task, 'parent_node_run_id')
      const slot =
        runId === null ? null : lookups(PARENT_RUN_SLOT).get(runId)?.continuation_slot_key
      const filled = fillLegacyLineage(task, parent, typeof slot === 'string' ? slot : null)
      const missingFields = [
        ...(filled?.derived && parentId !== null && !parent ? ['parent_task_id'] : []),
        ...(filled?.derived ? (parent?.missingFields ?? []) : []),
        ...(!filled ? ['lineage_slot_path_json'] : []),
      ]
      const value: TaskLineage = {
        // These fallback values support traversal only; unresolved target lineage is explicitly NULL.
        executionLineageId: filled?.executionLineageId ?? text(task, 'id'),
        lineageSlotPathJson: filled?.lineageSlotPathJson ?? '[]',
        launchOrigin: text(task, 'launch_origin'),
        parentLaunchOrigin: parent?.launchOrigin ?? null,
        derived: filled?.derived ?? false,
        missingFields: [...new Set(missingFields)],
      }
      visiting.delete(id)
      resolved.set(id, value)
      return value
    }
    for (const id of [...tasks.keys()].sort()) {
      const value = resolve(id)
      if (value) put(id, value)
    }
  },
}
