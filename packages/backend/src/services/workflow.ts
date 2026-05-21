// Workflow service — CRUD on the workflows table.
//
// Definition is stored as a JSON string in the DB and parsed at this boundary.
// M1 keeps the schema permissive (passthrough on unknown node-kind fields);
// strict validation lands in P-2-01.

import type {
  CreateWorkflow,
  UpdateWorkflow,
  Workflow,
  WorkflowDefinition,
  WorkflowValidationResult,
} from '@agent-workflow/shared'
import {
  WORKFLOW_SCHEMA_VERSION,
  WorkflowDefinitionSchema,
  applyShardingBackfill,
} from '@agent-workflow/shared'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { DbClient } from '@/db/client'
import { tasks, workflows } from '@/db/schema'
import { ConflictError, NotFoundError, ValidationError } from '@/util/errors'
import { WORKFLOWS_CHANNEL, workflowsBroadcaster } from '@/ws/broadcaster'
import { validateWorkflowById } from './workflow.validator'

type WorkflowRow = typeof workflows.$inferSelect

export async function listWorkflows(db: DbClient): Promise<Workflow[]> {
  const rows = await db.select().from(workflows)
  return rows.map(rowToWorkflow)
}

export async function getWorkflow(db: DbClient, id: string): Promise<Workflow | null> {
  const rows = await db.select().from(workflows).where(eq(workflows.id, id)).limit(1)
  const row = rows[0]
  return row ? rowToWorkflow(row) : null
}

export async function createWorkflow(db: DbClient, input: CreateWorkflow): Promise<Workflow> {
  const id = ulid()
  const now = Date.now()
  // Normalize incoming v1 → v2 (RFC-005) so new rows always land at the
  // latest schema version. Older clients can still post v1 — they get upgraded.
  const normalized = migrateDefinitionToLatest(input.definition)
  await db.insert(workflows).values({
    id,
    name: input.name,
    description: input.description,
    definition: JSON.stringify(normalized),
    version: 1,
    createdAt: now,
    updatedAt: now,
  })
  const created = await getWorkflow(db, id)
  if (created === null) throw new Error('workflow disappeared right after insert')
  workflowsBroadcaster.broadcast(WORKFLOWS_CHANNEL, {
    type: 'workflow.created',
    workflowId: created.id,
    name: created.name,
    version: created.version,
  })
  return created
}

export async function updateWorkflow(
  db: DbClient,
  id: string,
  patch: UpdateWorkflow,
): Promise<Workflow> {
  const existing = await getWorkflow(db, id)
  if (existing === null) {
    throw new NotFoundError('workflow-not-found', `workflow '${id}' not found`)
  }

  const set: Partial<typeof workflows.$inferInsert> = {
    version: existing.version + 1,
    updatedAt: Date.now(),
  }
  if (patch.name !== undefined) set.name = patch.name
  if (patch.description !== undefined) set.description = patch.description
  if (patch.definition !== undefined)
    set.definition = JSON.stringify(migrateDefinitionToLatest(patch.definition))

  await db.update(workflows).set(set).where(eq(workflows.id, id))
  const updated = await getWorkflow(db, id)
  if (updated === null) throw new Error('workflow disappeared after update')
  workflowsBroadcaster.broadcast(WORKFLOWS_CHANNEL, {
    type: 'workflow.updated',
    workflowId: updated.id,
    version: updated.version,
    updatedAt: updated.updatedAt,
  })
  return updated
}

export async function deleteWorkflow(db: DbClient, id: string): Promise<void> {
  const existing = await getWorkflow(db, id)
  if (existing === null) {
    throw new NotFoundError('workflow-not-found', `workflow '${id}' not found`)
  }
  // Refuse on ANY task referencing this workflow — running, done, failed,
  // canceled, interrupted. Per the user's decision in design Q&A round 18:
  // "被引用拒绝（没引用才能删）". A future iteration may relax this by making
  // tasks.workflowId nullable + ON DELETE SET NULL.
  const refs = await findReferencingTasks(db, id)
  if (refs.length > 0) {
    throw new ConflictError(
      'workflow-in-use',
      `workflow '${id}' has ${refs.length} task(s) referencing it; delete those tasks first`,
      { tasks: refs },
    )
  }
  await db.delete(workflows).where(eq(workflows.id, id))
  workflowsBroadcaster.broadcast(WORKFLOWS_CHANNEL, {
    type: 'workflow.deleted',
    workflowId: id,
  })
}

/**
 * Static validation — see `workflow.validator.ts` for the 5 rules. Thin
 * wrapper kept here so existing routes can keep importing `validateWorkflow`
 * without a churny rename.
 */
export async function validateWorkflow(
  db: DbClient,
  id: string,
): Promise<WorkflowValidationResult> {
  return validateWorkflowById(db, id)
}

// --- helpers ---

async function findReferencingTasks(
  db: DbClient,
  workflowId: string,
): Promise<Array<{ id: string; status: string }>> {
  const rows = await db
    .select({ id: tasks.id, status: tasks.status })
    .from(tasks)
    .where(eq(tasks.workflowId, workflowId))
  return rows
}

function rowToWorkflow(row: WorkflowRow): Workflow {
  let definition: WorkflowDefinition
  try {
    const raw: unknown = JSON.parse(row.definition)
    const parsed = WorkflowDefinitionSchema.safeParse(raw)
    if (!parsed.success) {
      // Definition was stored but no longer parses — likely a schema drift.
      // Surface as a domain error so the API returns a structured 422.
      throw new ValidationError('workflow-definition-corrupt', 'stored definition is invalid', {
        workflowId: row.id,
        issues: parsed.error.issues,
      })
    }
    definition = migrateDefinitionToLatest(parsed.data)
  } catch (err) {
    if (err instanceof ValidationError) throw err
    throw new ValidationError('workflow-definition-corrupt', 'stored definition is not JSON', {
      workflowId: row.id,
      error: (err as Error).message,
    })
  }
  // RFC-055 — backfill agent-multi nodes' missing/invalid shardingStrategy
  // with the per-file default so the UI never starts on an empty Select.
  // Idempotent: returns the same reference when nothing changes. Read-only
  // path; PUT still accepts any legal shape and validator surfaces the
  // missing/invalid signals on raw YAML imports.
  definition = applyShardingBackfill(definition)
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    definition,
    version: row.version,
    schemaVersion: row.schemaVersion,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
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
 * The migration steps cascade — v1 docs walk 1 → 2 → 3 in a single call.
 * Only changes the in-memory representation returned by GET; the next PUT
 * (auto-save in the editor, YAML re-import, programmatic update) flushes
 * the bumped version back to the DB. This mirrors the RFC-004 "heal-on-edit"
 * pattern — no daemon-startup scan.
 *
 * Exported pure helper so it can be tested without DB plumbing.
 */
export function migrateDefinitionToLatest(def: WorkflowDefinition): WorkflowDefinition {
  let current: WorkflowDefinition = def
  if (current.$schema_version === 1) {
    current = { ...current, $schema_version: 2 }
  }
  if (current.$schema_version === 2) {
    current = { ...current, $schema_version: 3 }
  }
  if (current.$schema_version !== WORKFLOW_SCHEMA_VERSION) {
    // Forward-compat: an unknown future version (e.g. v4 stored by a newer
    // daemon, read by an older one) round-trips unchanged. The validator
    // and zod schema will surface incompatibility downstream if any.
  }
  return current
}
