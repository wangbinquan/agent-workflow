// Workflow service — CRUD on the workflows table.
//
// Definition is stored as a JSON string in the DB and parsed at this boundary.
// M1 keeps the schema permissive (passthrough on unknown node-kind fields);
// strict validation lands in P-2-01.

import type {
  CreateWorkflow,
  DeleteWorkflow,
  SaveWorkflowReceipt,
  UpdateWorkflow,
  Workflow,
  WorkflowDetail,
  WorkflowDefinition,
  WorkflowDraftSnapshot,
  WorkflowRevision,
  WorkflowSnapshotHash,
  WorkflowValidationResult,
} from '@agent-workflow/shared'
import {
  DeleteWorkflowSchema,
  serializeWorkflowDefinitionStorageV1,
  serializeWorkflowEditableSnapshotV1,
  UpdateWorkflowSchema,
  WORKFLOW_SCHEMA_VERSION,
  WorkflowDefinitionSchema,
  WorkflowDraftSnapshotSchema,
  WorkflowNameSchema,
} from '@agent-workflow/shared'
import { and, eq } from 'drizzle-orm'
import { createHash } from 'node:crypto'
import { ulid } from 'ulid'
import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import { type DbTxSync, dbTxSync } from '@/db/txSync'
import { resourceGrants, tasks, workflows } from '@/db/schema'
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@/util/errors'
import {
  WORKFLOWS_CHANNEL,
  workflowsBroadcaster,
  type WorkflowDeletedAudienceContext,
} from '@/ws/broadcaster'
import { assertNewRefsUsable, diffNewNames, extractWorkflowAgentNames } from './resourceRefs'
import { canViewResource, isAdminActor, isResourceOwner } from './resourceAcl'
import { assertNotBuiltin } from './systemResources'
import { validateWorkflowById } from './workflow.validator'

type WorkflowRow = typeof workflows.$inferSelect

export async function listWorkflows(db: DbClient): Promise<Workflow[]> {
  const rows = await db.select().from(workflows)
  return rows.map(rowToWorkflow)
}

export async function getWorkflow(db: DbClient, id: string): Promise<WorkflowDetail | null> {
  const rows = await db.select().from(workflows).where(eq(workflows.id, id)).limit(1)
  const row = rows[0]
  return row ? rowToWorkflowDetail(row) : null
}

export async function createWorkflow(
  db: DbClient,
  input: CreateWorkflow,
  opts?: { ownerUserId?: string; builtin?: boolean },
): Promise<WorkflowDetail> {
  const id = ulid()
  const now = Date.now()
  // Normalize incoming v1 → v2 (RFC-005) so new rows always land at the
  // latest schema version. Older clients can still post v1 — they get upgraded.
  const normalized = migrateDefinitionToLatest(input.definition)
  const inserted = await db
    .insert(workflows)
    .values({
      id,
      name: input.name,
      description: input.description,
      definition: serializeWorkflowDefinitionStorageV1(normalized),
      version: 1,
      // RFC-099: creator becomes owner; new resources default to 'public' (D18).
      ownerUserId: opts?.ownerUserId ?? null,
      visibility: 'public',
      // RFC-104: built-in marker — only seedFusionResources passes builtin:true;
      // never set via any HTTP path (CreateWorkflowSchema omits it).
      builtin: opts?.builtin ?? false,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
  const insertedRow = inserted[0]
  if (insertedRow === undefined) throw new Error('workflow insert returned no row')
  // RFC-199: the create response is derived from INSERT RETURNING. A post-insert
  // GET could race a later writer and falsely return somebody else's revision.
  const created = rowToWorkflowDetail(insertedRow)
  workflowsBroadcaster.broadcast(WORKFLOWS_CHANNEL, {
    type: 'workflow.created',
    workflowId: created.id,
    name: created.name,
    version: created.version,
  })
  return created
}

/**
 * Every content writer must identify whether it is acting for an authenticated
 * user or as a framework-internal operation. There is intentionally no
 * `undefined` / implicit-system escape hatch.
 */
export type WorkflowWritePrincipal =
  | { kind: 'actor'; actor: Actor }
  | { kind: 'system'; reason: string }

export async function updateWorkflow(
  db: DbClient,
  id: string,
  input: UpdateWorkflow,
  principal: WorkflowWritePrincipal,
): Promise<SaveWorkflowReceipt> {
  const parsed = UpdateWorkflowSchema.safeParse(input)
  if (!parsed.success) {
    throw new ValidationError('workflow-invalid', 'invalid workflow save payload', {
      issues: parsed.error.issues,
    })
  }
  const normalizedSnapshot = normalizeWorkflowSnapshot(parsed.data.snapshot)
  const submittedBytes = serializeWorkflowEditableSnapshotV1(normalizedSnapshot)
  const definitionStorage = serializeWorkflowDefinitionStorageV1(normalizedSnapshot.definition)

  // Schema/reference checks remain outside the single-row write transaction.
  // The current row gates below are repeated in dbTxSync, so an ACL transfer or
  // built-in flip between preflight and CAS cannot authorize a stale writer.
  const preflightRow = await loadRawWorkflow(db, id)
  if (preflightRow !== null) {
    await assertPrincipalCanWritePreflight(db, principal, preflightRow)
    const preflightWorkflow = rowToWorkflow(preflightRow)
    assertChangedWorkflowName(preflightWorkflow.name, normalizedSnapshot.name)
    if (principal.kind === 'actor') {
      const newNames = diffNewNames(
        extractWorkflowAgentNames(preflightWorkflow.definition),
        extractWorkflowAgentNames(normalizedSnapshot.definition),
      )
      await assertNewRefsUsable(db, principal.actor, [{ type: 'agent', names: newNames }])
    }
  }

  const txResult = dbTxSync<{ receipt: SaveWorkflowReceipt; committed: boolean }>(db, (tx) => {
    const currentRow = tx.select().from(workflows).where(eq(workflows.id, id)).get()
    if (currentRow === undefined) throwWorkflowNotFound(id)

    assertPrincipalCanWriteInTx(tx, principal, currentRow)
    const current = rowToWorkflow(currentRow)
    assertChangedWorkflowName(current.name, normalizedSnapshot.name)

    const currentSnapshot = workflowDraftSnapshotOf(current)
    const currentBytes = serializeWorkflowEditableSnapshotV1(currentSnapshot)
    const currentRevision = workflowRevisionOf(current)
    const logicalSame = currentBytes === submittedBytes

    if (currentRow.version !== parsed.data.expectedVersion) {
      // Response-loss reconciliation: a retry of the exact bytes already at
      // the server succeeds without minting another revision or WS frame.
      if (logicalSame) {
        return {
          receipt: {
            clientMutationId: parsed.data.clientMutationId,
            requestedBaseVersion: parsed.data.expectedVersion,
            revision: currentRevision,
            snapshot: normalizedSnapshot,
            outcome: 'already-current',
          },
          committed: false,
        }
      }
      throw new ConflictError(
        'workflow-version-conflict',
        `workflow '${id}' is at version ${currentRow.version}, expected ${parsed.data.expectedVersion}`,
        { current: currentRevision },
      )
    }

    const physicalDefinitionCurrent = currentRow.definition === definitionStorage
    if (logicalSame && physicalDefinitionCurrent) {
      return {
        receipt: {
          clientMutationId: parsed.data.clientMutationId,
          requestedBaseVersion: parsed.data.expectedVersion,
          revision: currentRevision,
          snapshot: normalizedSnapshot,
          outcome: 'already-current',
        },
        committed: false,
      }
    }

    const updatedAt = Date.now()
    const returned = tx
      .update(workflows)
      .set({
        name: normalizedSnapshot.name,
        description: normalizedSnapshot.description,
        definition: definitionStorage,
        version: currentRow.version + 1,
        updatedAt,
      })
      .where(and(eq(workflows.id, id), eq(workflows.version, parsed.data.expectedVersion)))
      .returning()
      .get()
    if (returned === undefined) {
      // Defensive CAS-loss surface. In the synchronous SQLite transaction this
      // should be unreachable, but never manufacture a success receipt.
      throw new ConflictError('workflow-version-conflict', `workflow '${id}' changed; reload`, {
        current: currentRevision,
      })
    }
    const committed = rowToWorkflow(returned)
    const revision = workflowRevisionOf(committed)
    return {
      receipt: {
        clientMutationId: parsed.data.clientMutationId,
        requestedBaseVersion: parsed.data.expectedVersion,
        revision,
        snapshot: normalizedSnapshot,
        outcome: 'committed',
      },
      committed: true,
    }
  })

  if (txResult.committed) {
    workflowsBroadcaster.broadcast(WORKFLOWS_CHANNEL, {
      type: 'workflow.updated',
      workflowId: txResult.receipt.revision.workflowId,
      clientMutationId: txResult.receipt.clientMutationId,
      version: txResult.receipt.revision.version,
      snapshotHash: txResult.receipt.revision.snapshotHash,
      updatedAt: txResult.receipt.revision.updatedAt,
    })
  }
  return txResult.receipt
}

export async function deleteWorkflow(
  db: DbClient,
  id: string,
  input: DeleteWorkflow,
  principal: WorkflowWritePrincipal,
): Promise<void> {
  const parsed = DeleteWorkflowSchema.safeParse(input)
  if (!parsed.success) {
    throw new ValidationError('workflow-invalid', 'invalid workflow delete payload', {
      issues: parsed.error.issues,
    })
  }
  const deleted = dbTxSync<{
    deletedVersion: number
    audience: WorkflowDeletedAudienceContext
  }>(db, (tx) => {
    const currentRow = tx.select().from(workflows).where(eq(workflows.id, id)).get()
    if (currentRow === undefined) throwWorkflowNotFound(id)
    assertPrincipalCanWriteInTx(tx, principal, currentRow)

    if (currentRow.version !== parsed.data.expectedVersion) {
      throw new ConflictError(
        'workflow-version-conflict',
        `workflow '${id}' is at version ${currentRow.version}, expected ${parsed.data.expectedVersion}`,
        { current: workflowRevisionOf(rowToWorkflow(currentRow)) },
      )
    }

    // Refuse on ANY task referencing this workflow — running, done, failed,
    // canceled, interrupted. The check and DELETE share one transaction, so a
    // task insert that wins first is always observed as workflow-in-use.
    const referenceCount = countReferencingTasksInTx(tx, id)
    if (referenceCount > 0) {
      throw new ConflictError(
        'workflow-in-use',
        `workflow '${id}' has ${referenceCount} task(s) referencing it; delete those tasks first`,
        // Task ids/statuses are task-ACL protected. A public workflow's owner
        // may not be a member of tasks launched by other users, so disclose
        // only the aggregate needed to explain why deletion is blocked.
        { referenceCount },
      )
    }

    // The row cannot be re-read after DELETE. Capture its complete non-admin
    // visibility audience in this same transaction, then carry it beside (not
    // inside) the WS frame after commit. This closes the cold-cache delivery
    // gap without exposing ACL data on the shared client wire.
    const grantRows = tx
      .select({ userId: resourceGrants.userId })
      .from(resourceGrants)
      .where(and(eq(resourceGrants.resourceType, 'workflow'), eq(resourceGrants.resourceId, id)))
      .all()
    const audience: WorkflowDeletedAudienceContext = {
      kind: 'workflow.deleted-audience',
      workflowId: id,
      visibility: currentRow.visibility,
      ownerUserId: currentRow.ownerUserId,
      grantedUserIds: new Set(grantRows.map((row) => row.userId)),
    }

    const deletedRow = tx
      .delete(workflows)
      .where(and(eq(workflows.id, id), eq(workflows.version, parsed.data.expectedVersion)))
      .returning({ id: workflows.id, version: workflows.version })
      .get()
    if (deletedRow === undefined) {
      throw new ConflictError('workflow-version-conflict', `workflow '${id}' changed; reload`)
    }
    return { deletedVersion: deletedRow.version, audience }
  })

  workflowsBroadcaster.broadcast(
    WORKFLOWS_CHANNEL,
    {
      type: 'workflow.deleted',
      workflowId: id,
      clientMutationId: parsed.data.clientMutationId,
      deletedVersion: deleted.deletedVersion,
    },
    deleted.audience,
  )
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

function countReferencingTasksInTx(tx: DbTxSync, workflowId: string): number {
  return tx.select({ id: tasks.id }).from(tasks).where(eq(tasks.workflowId, workflowId)).all()
    .length
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
  // RFC-060 PR-E: agent-multi removed, so the RFC-055 sharding-backfill
  // call is no longer needed. wrapper-fanout carries its inputs[]/nodeIds
  // shape directly in the schema with no backfill.
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    definition,
    version: row.version,
    // RFC-099 ACL projection — routes filter on these.
    ownerUserId: row.ownerUserId,
    visibility: row.visibility,
    // RFC-104 built-in marker (read-only response field).
    builtin: row.builtin,
    schemaVersion: row.schemaVersion,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function rowToWorkflowDetail(row: WorkflowRow): WorkflowDetail {
  return workflowToDetail(rowToWorkflow(row))
}

/** Complete editable snapshot, normalized to the latest definition schema. */
export function workflowDraftSnapshotOf(workflow: Workflow): WorkflowDraftSnapshot {
  return normalizeWorkflowSnapshot({
    name: workflow.name,
    description: workflow.description,
    definition: workflow.definition,
  })
}

/** Lowercase SHA-256 over the shared domain-separated canonical serialization. */
export function workflowSnapshotHashOf(snapshot: WorkflowDraftSnapshot): WorkflowSnapshotHash {
  const normalized = normalizeWorkflowSnapshot(snapshot)
  return createHash('sha256')
    .update(serializeWorkflowEditableSnapshotV1(normalized), 'utf8')
    .digest('hex')
}

/** Pure detail projection reused by GET/create/YAML collision responses. */
export function workflowToDetail(workflow: Workflow): WorkflowDetail {
  const snapshot = workflowDraftSnapshotOf(workflow)
  return {
    ...workflow,
    definition: snapshot.definition,
    snapshotHash: workflowSnapshotHashOf(snapshot),
  }
}

/** Pure exact-revision projection reused by save, delete and YAML. */
export function workflowRevisionOf(workflow: Workflow): WorkflowRevision {
  const snapshot = workflowDraftSnapshotOf(workflow)
  return {
    workflowId: workflow.id,
    version: workflow.version,
    snapshotHash: workflowSnapshotHashOf(snapshot),
    updatedAt: workflow.updatedAt,
  }
}

function normalizeWorkflowSnapshot(snapshot: WorkflowDraftSnapshot): WorkflowDraftSnapshot {
  return WorkflowDraftSnapshotSchema.parse({
    name: snapshot.name,
    description: snapshot.description,
    definition: migrateDefinitionToLatest(snapshot.definition),
  })
}

async function loadRawWorkflow(db: DbClient, id: string): Promise<WorkflowRow | null> {
  const rows = await db.select().from(workflows).where(eq(workflows.id, id)).limit(1)
  return rows[0] ?? null
}

async function assertPrincipalCanWritePreflight(
  db: DbClient,
  principal: WorkflowWritePrincipal,
  row: WorkflowRow,
): Promise<void> {
  if (principal.kind === 'system') {
    assertNotBuiltin('workflow', row)
    return
  }
  if (!(await canViewResource(db, principal.actor, 'workflow', row))) {
    throwWorkflowNotFound(row.id)
  }
  assertNotBuiltin('workflow', row)
  if (!isResourceOwner(principal.actor, row)) {
    throw new ForbiddenError('forbidden', 'only the workflow owner or an admin can modify it')
  }
}

function assertPrincipalCanWriteInTx(
  tx: DbTxSync,
  principal: WorkflowWritePrincipal,
  row: WorkflowRow,
): void {
  if (principal.kind === 'system') {
    assertNotBuiltin('workflow', row)
    return
  }

  const actor = principal.actor
  const isAdmin = isAdminActor(actor)
  const isOwner = row.ownerUserId !== null && row.ownerUserId === actor.user.id
  let visible = isAdmin || isOwner || row.visibility === 'public'
  if (!visible) {
    const grant = tx
      .select({ resourceId: resourceGrants.resourceId })
      .from(resourceGrants)
      .where(
        and(
          eq(resourceGrants.resourceType, 'workflow'),
          eq(resourceGrants.resourceId, row.id),
          eq(resourceGrants.userId, actor.user.id),
        ),
      )
      .get()
    visible = grant !== undefined
  }
  if (!visible) throwWorkflowNotFound(row.id)
  assertNotBuiltin('workflow', row)
  if (!isAdmin && !isOwner) {
    throw new ForbiddenError('forbidden', 'only the workflow owner or an admin can modify it')
  }
}

function assertChangedWorkflowName(currentName: string, submittedName: string): void {
  if (currentName === submittedName) return
  const parsed = WorkflowNameSchema.safeParse(submittedName)
  if (!parsed.success) {
    throw new ValidationError(
      'workflow-name-invalid',
      'workflow name must start with [a-z0-9] and contain only [a-z0-9_-] (max 128 chars)',
      { issues: parsed.error.issues },
    )
  }
}

function throwWorkflowNotFound(id: string): never {
  throw new NotFoundError('workflow-not-found', `workflow '${id}' not found`)
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
  // RFC-056: pure metadata bump for the new 'clarify-cross-agent' NodeKind.
  // Old v3 docs never carry the new node, so the upgrade is structurally
  // safe — same pattern as the v2 → v3 bump that introduced RFC-023 clarify.
  if (current.$schema_version === 3) {
    current = { ...current, $schema_version: 4 }
  }
  if (current.$schema_version !== WORKFLOW_SCHEMA_VERSION) {
    // Forward-compat: an unknown future version (e.g. v4 stored by a newer
    // daemon, read by an older one) round-trips unchanged. The validator
    // and zod schema will surface incompatibility downstream if any.
  }
  return current
}
