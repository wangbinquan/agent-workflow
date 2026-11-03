import { workflowCatalogPredicate } from '../workflowCatalogPredicate'
import { tablesOf, type PersistenceTables } from '@/platform/persistence/sessionTables'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
// Workflow service — CRUD on the workflows table.
//
// Definition is stored as a JSON string in the DB and parsed at this boundary.
// M1 keeps the schema permissive (passthrough on unknown node-kind fields);
// strict validation lands in P-2-01.

import type {
  ResourceVisibility,
  Workflow,
  WorkflowDetail,
  WorkflowDefinition,
  WorkflowDraftSnapshot,
  WorkflowSnapshotHash,
} from '@agent-workflow/shared'
import { migrateWorkflowDefinitionToLatest } from '@agent-workflow/shared'
import { eq } from 'drizzle-orm'
import type { DbClient } from '@/db/client'

import { scheduledRowsReferencing } from '@/services/scheduledTaskRefs'
import { WORKFLOWS_CHANNEL, workflowsBroadcaster } from '@/ws/broadcaster'
import {
  WORKFLOW_NAME_INVALID_MESSAGE,
  assertCanonicalWorkflowAgentIds,
  decodeStoredWorkflowDefinition,
  normalizeWorkflowSnapshot,
  workflowDetailOf as workflowToDetail,
  workflowDraftSnapshotOf,
  workflowFromPersistenceRow as rowToWorkflow,
  workflowRevisionOf,
  workflowSnapshotHashOf as hashWorkflowSnapshot,
} from '../workflowPersistence'

export {
  WORKFLOW_NAME_INVALID_MESSAGE,
  assertCanonicalWorkflowAgentIds,
  decodeStoredWorkflowDefinition,
  workflowDraftSnapshotOf,
  workflowRevisionOf,
  workflowToDetail,
}

type WorkflowRow = PersistenceTables['workflows']['$inferSelect']

// RFC-359：函数体就是一条中立 select（同文件的 `getWorkflow` 早已是 `PersistenceDb`）。
// 入参此前写 `DbClient` 是纯类型债，它把这个读面挡在双引擎用例之外。
export async function listWorkflows(db: PersistenceDb): Promise<Workflow[]> {
  const { workflows } = tablesOf(db)
  const rows = await db.select().from(workflows).where(workflowCatalogPredicate(workflows.id))
  return rows.map(rowToWorkflow)
}

export async function getWorkflow(db: PersistenceDb, id: string): Promise<WorkflowDetail | null> {
  const { workflows } = tablesOf(db)
  const rows = await db
    .select()
    .from(workflows)
    .where(workflowCatalogPredicate(workflows.id, eq(workflows.id, id)))
    .limit(1)
  const row = rows[0]
  return row ? rowToWorkflowDetail(row) : null
}

/**
 * RFC-222 — raw ACL identity of a workflow (name + owner/visibility/builtin)
 * WITHOUT parsing its definition. The delete path must work even on a workflow
 * whose stored definition is corrupt (you must be able to delete a broken
 * workflow), so it cannot go through getWorkflow's schema validation.
 */
export async function getWorkflowAclRow(
  db: DbClient,
  id: string,
): Promise<{
  id: string
  name: string
  ownerUserId: string | null
  visibility: ResourceVisibility
  builtin: boolean
} | null> {
  const { workflows } = tablesOf(db)
  const rows = await db
    .select({
      id: workflows.id,
      name: workflows.name,
      ownerUserId: workflows.ownerUserId,
      visibility: workflows.visibility,
      builtin: workflows.builtin,
    })
    .from(workflows)
    .where(workflowCatalogPredicate(workflows.id, eq(workflows.id, id)))
    .limit(1)
  const row = rows[0]
  if (row === undefined) return null
  return {
    id: row.id,
    name: row.name,
    ownerUserId: row.ownerUserId ?? null,
    visibility: (row.visibility ?? 'public') as ResourceVisibility,
    builtin: row.builtin === true,
  }
}

/**
 * RFC-202 T5 — pure core of the scheduled-task reference check (mirrors
 * `scheduledRowsReferencingAgent` in agent.ts). launchKind='workflow' rows
 * carry the target inside the JSON launch payload (`workflowId`); malformed
 * payloads are skipped (degraded rows are repaired/deleted via their own
 * flow).
 */
export function scheduledRowsReferencingWorkflow<
  R extends { id: string; launchKind: string; launchPayload: string },
>(rows: ReadonlyArray<R>, workflowId: string): R[] {
  // RFC-284 T9（§2.2）：实现收编 scheduledTasks.scheduledRowsReferencing；
  // 导出面保留（rfc202 生命周期测试等消费方零改动）。
  return scheduledRowsReferencing(rows, {
    launchKind: 'workflow',
    payloadKey: 'workflowId',
    id: workflowId,
  })
}

export function broadcastWorkflowCreated(created: WorkflowDetail): void {
  workflowsBroadcaster.broadcast(WORKFLOWS_CHANNEL, {
    type: 'workflow.created',
    workflowId: created.id,
    name: created.name,
    version: created.version,
  })
}

export function rowToWorkflowDetail(row: WorkflowRow): WorkflowDetail {
  return workflowToDetail(rowToWorkflow(row))
}

/** This compatibility entry hashes a migrated snapshot; the shared raw hash does not migrate. */
export function workflowSnapshotHashOf(snapshot: WorkflowDraftSnapshot): WorkflowSnapshotHash {
  const normalized = normalizeWorkflowSnapshot(snapshot)
  return hashWorkflowSnapshot(normalized)
}

/**
 * Transparently upgrade a stored definition to the latest schema version.
 *
 * v1 → v2 (RFC-005):
 *   v1 docs predate the `review` node kind, so by construction they contain
 *   no review nodes — the upgrade is a pure version-number bump.
 *
 * v2 → v3 (RFC-023):
 *   v2 docs predate the `clarify` node kind. Same story: pure version-number
 *   bump (no clarify nodes, no agent system ports `__clarify__` /
 *   `__clarify_response__`, no clarify edges ever appear in older docs).
 *
 * The migration steps cascade through v5 in a single call. RFC-292's v4 → v5
 * step additionally rewrites only the inventoried author-template surfaces to
 * the canonical trigger grammar while preserving old literal expressions.
 * Only changes the in-memory representation returned by GET; the next PUT
 * (auto-save in the editor, YAML re-import, programmatic update) flushes
 * the bumped version back to the DB. This mirrors the RFC-004 "heal-on-edit"
 * pattern — no daemon-startup scan.
 *
 * Exported pure helper so it can be tested without DB plumbing.
 */
export function migrateDefinitionToLatest(def: WorkflowDefinition): WorkflowDefinition {
  return migrateWorkflowDefinitionToLatest(def)
}
