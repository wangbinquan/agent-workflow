// Workflow service — CRUD on the workflows table.
//
// Definition is stored as a JSON string in the DB and parsed at this boundary.
// M1 keeps the schema permissive (passthrough on unknown node-kind fields);
// strict validation lands in P-2-01.

import type {
  CopyWorkflowRequest,
  CreateWorkflow,
  DeleteWorkflow,
  ResourceVisibility,
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
  CopyWorkflowRequestSchema,
  DeleteWorkflowSchema,
  serializeWorkflowDefinitionStorageV1,
  serializeWorkflowEditableSnapshotV1,
  normalizeResourceDisplayName,
  PRIVILEGED_LENS_TRANSPARENT,
  rehydratePrivilegedNodes,
  RESOURCE_DISPLAY_NAME_MSG,
  UpdateWorkflowSchema,
  WORKFLOW_SCHEMA_VERSION,
  WorkflowDefinitionSchema,
  WorkflowDraftSnapshotSchema,
  WorkflowNameSchema,
} from '@agent-workflow/shared'
import { and, eq } from 'drizzle-orm'
import { createHash } from 'node:crypto'
import { ulid } from 'ulid'
import { assertScriptAuthorAllowed, type ScriptAuthorPrincipal } from './scriptAuthorGate'
import { assertCodeHostAuthorAllowed } from './codeHostAuthorGate'
import { privilegedNodeLensFor } from './privilegedNodeLens'
import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import { type DbTxSync, dbTxSync } from '@/db/txSync'
import { resourceGrants, scheduledTasks, tasks, workflows } from '@/db/schema'
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@/util/errors'
import {
  WORKFLOWS_CHANNEL,
  workflowsBroadcaster,
  type WorkflowDeletedAudienceContext,
} from '@/ws/broadcaster'
import {
  assertNoMissingRefs,
  assertRefsUsableInTx,
  diffNewNames,
  extractWorkflowAgentRefs,
  extractWorkflowWorkflowRefs,
  extractWorkflowWorkgroupRefs,
  resolveRefsUsableById,
  resolveRefsUsableByName,
} from './resourceRefs'
import {
  assertInitialResourceOwner,
  canViewResource,
  canViewResourceInTx,
  initialBuiltinResourceAcl,
  initialPrivateResourceAcl,
  isResourceAdminActor,
  isResourceOwner,
} from './resourceAcl'
import { nextResourceCopyName } from './resourceCopyName'
import { assertNotBuiltin } from './systemResources'
import { validateWorkflowById } from './workflow.validator'

type WorkflowRow = typeof workflows.$inferSelect

/**
 * RFC-264 — one wording behind the `workflow-name-invalid` code, shared by the
 * save-path rename gate and YAML import so the two can never describe
 * different rules.
 */
export const WORKFLOW_NAME_INVALID_MESSAGE = `workflow ${RESOURCE_DISPLAY_NAME_MSG}`

export interface WorkflowWriteInTxGuard {
  /**
   * Synchronous check executed in the exact transaction immediately before
   * the workflow INSERT/UPDATE. It must only use drizzle's sync surface.
   */
  assert(tx: DbTxSync): void
}

export interface CreateWorkflowOptions {
  ownerUserId?: string
  builtin?: boolean
  id?: string
  inTxGuard?: WorkflowWriteInTxGuard
  /** User whose new canonical refs must remain usable at commit time. */
  actor?: Actor | null
  /** Deterministic race-test seam after preflight, before the final dbTxSync. */
  beforeWriteTransaction?: () => void | Promise<void>
}

export async function listWorkflows(db: DbClient): Promise<Workflow[]> {
  const rows = await db.select().from(workflows)
  return rows.map(rowToWorkflow)
}

export async function getWorkflow(db: DbClient, id: string): Promise<WorkflowDetail | null> {
  const rows = await db.select().from(workflows).where(eq(workflows.id, id)).limit(1)
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
  const rows = await db
    .select({
      id: workflows.id,
      name: workflows.name,
      ownerUserId: workflows.ownerUserId,
      visibility: workflows.visibility,
      builtin: workflows.builtin,
    })
    .from(workflows)
    .where(eq(workflows.id, id))
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

export async function createWorkflow(
  db: DbClient,
  input: CreateWorkflow,
  opts?: CreateWorkflowOptions,
): Promise<WorkflowDetail> {
  const id = opts?.id ?? ulid()
  const now = Date.now()
  const ownerUserId = opts?.ownerUserId ?? null
  assertInitialResourceOwner(opts?.actor, ownerUserId)
  // Normalize incoming v1 → v2 (RFC-005) so new rows always land at the
  // latest schema version. Older clients can still post v1 — they get upgraded.
  const normalized = migrateDefinitionToLatest(input.definition)
  assertCanonicalWorkflowAgentIds(normalized)
  const newAgentIds = [...extractWorkflowAgentRefs(normalized)]
  // RFC-243 (§5.3): call-workflow references are NAME selectors, checked with
  // the same D15 semantics as agent refs (existence tolerated until launch,
  // visibility enforced on save) in the dangle-tolerant name domain.
  const newWorkflowNames = extractWorkflowWorkflowRefs(normalized)
  const newWorkgroupNames = extractWorkflowWorkgroupRefs(normalized)
  const actor = opts?.actor ?? null
  const resolvedNewAgents = await resolveRefsUsableById(db, actor, 'agent', newAgentIds)
  const resolvedNewWorkflows = await resolveRefsUsableByName(
    db,
    actor,
    'workflow',
    newWorkflowNames,
  )
  const resolvedNewWorkgroups = await resolveRefsUsableByName(
    db,
    actor,
    'workgroup',
    newWorkgroupNames,
  )
  assertNoMissingRefs([
    ...resolvedNewAgents.missing,
    ...resolvedNewWorkflows.missing,
    ...resolvedNewWorkgroups.missing,
  ])
  // Workflow definitions historically tolerate a never-resolved agent id until
  // validator/launch time. Fence only ids that preflight actually matched.
  const fenceableAgentIds = new Set(resolvedNewAgents.byToken.values())
  await opts?.beforeWriteTransaction?.()
  const insertedRow = dbTxSync(db, (tx) => {
    // Preserve the import selector fence's richer stale/ambiguity errors, then
    // apply the ordinary exact-id existence/usability invariant. Both checks
    // run before the sole production workflow INSERT.
    opts?.inTxGuard?.assert(tx)
    assertRefsUsableInTx(tx, actor, [
      { type: 'agent', names: newAgentIds.filter((id) => fenceableAgentIds.has(id)), domain: 'id' },
      // Name domain is dangle-tolerant in-tx too: no fenceable filter needed.
      { type: 'workflow', names: newWorkflowNames, domain: 'name' },
      { type: 'workgroup', names: newWorkgroupNames, domain: 'name' },
    ])
    return insertWorkflowInTx(tx, {
      id,
      name: input.name,
      description: input.description,
      definition: normalized,
      ownerUserId,
      builtin: opts?.builtin === true,
      now,
      // A null actor is a platform-internal seed (builtin workflows, fixtures),
      // not an anonymous user: those paths are trusted by construction.
      scriptPrincipal:
        actor === null ? { kind: 'system', reason: 'no-actor' } : { kind: 'actor', actor },
    })
  })
  // RFC-199: the create response is derived from INSERT RETURNING. A post-insert
  // GET could race a later writer and falsely return somebody else's revision.
  const created = rowToWorkflowDetail(insertedRow)
  broadcastWorkflowCreated(created)
  return created
}

/**
 * RFC-231 exact-copy operation. Source visibility, revision, every reference,
 * name allocation and target INSERT share one synchronous transaction.
 */
export async function copyWorkflow(
  db: DbClient,
  sourceId: string,
  input: CopyWorkflowRequest,
  actor: Actor,
): Promise<WorkflowDetail> {
  const parsed = CopyWorkflowRequestSchema.safeParse(input)
  if (!parsed.success) {
    throw new ValidationError('workflow-copy-invalid', 'invalid workflow copy payload', {
      issues: parsed.error.issues,
    })
  }

  const inserted = dbTxSync(db, (tx) => {
    // Gate only on ACL identity first: an invisible corrupt workflow must be
    // indistinguishable from an absent one and must never reach JSON parsing.
    const aclRow = tx
      .select({
        id: workflows.id,
        ownerUserId: workflows.ownerUserId,
        visibility: workflows.visibility,
        builtin: workflows.builtin,
      })
      .from(workflows)
      .where(eq(workflows.id, sourceId))
      .get()
    if (aclRow === undefined || !canViewResourceInTx(tx, actor, 'workflow', aclRow)) {
      throwWorkflowNotFound(sourceId)
    }
    assertNotBuiltin('workflow', aclRow)

    const currentRow = tx.select().from(workflows).where(eq(workflows.id, sourceId)).get()
    if (currentRow === undefined) throwWorkflowNotFound(sourceId)
    const source = rowToWorkflow(currentRow)
    const currentRevision = workflowRevisionOf(source)
    if (
      parsed.data.expectedVersion !== currentRevision.version ||
      parsed.data.expectedSnapshotHash !== currentRevision.snapshotHash
    ) {
      throw new ConflictError(
        'workflow-copy-stale',
        `workflow '${sourceId}' changed; reload before copying`,
        { current: currentRevision },
      )
    }

    assertCanonicalWorkflowAgentIds(source.definition)
    assertRefsUsableInTx(tx, actor, [
      { type: 'agent', names: [...extractWorkflowAgentRefs(source.definition)], domain: 'id' },
      // RFC-243 (§5.3): copy re-checks the FULL call-ref set — the copier must
      // be able to see every referenced workflow name it is about to adopt
      // (dangling names pass; name domain).
      { type: 'workflow', names: extractWorkflowWorkflowRefs(source.definition), domain: 'name' },
      {
        type: 'workgroup',
        names: extractWorkflowWorkgroupRefs(source.definition),
        domain: 'name',
      },
    ])

    const occupiedNames = tx
      .select({ name: workflows.name })
      .from(workflows)
      .where(eq(workflows.ownerUserId, actor.user.id))
      .all()
      .map((row) => row.name)
    // RFC-264: persist the PARSED name — the schema is also the normalizer, so
    // ignoring its output would store an unfolded copy name.
    const name = WorkflowNameSchema.parse(
      nextResourceCopyName(source.name, occupiedNames, 'workflow'),
    )
    return insertWorkflowInTx(tx, {
      id: ulid(),
      name,
      description: source.description,
      definition: source.definition,
      ownerUserId: actor.user.id,
      builtin: false,
      now: Date.now(),
      // RFC-253 D21 — a copy re-persists one stored revision verbatim; it adds
      // no executable content the platform did not already accept.
      scriptPrincipal: { kind: 'verbatim-copy' },
    })
  })

  const created = rowToWorkflowDetail(inserted)
  broadcastWorkflowCreated(created)
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

/** RFC-234 (T6) — prepare/commit split of the workflow full-document save
 *  (agent.ts precedent). `commitWorkflowSaveInTx` is the former dbTxSync body
 *  verbatim modulo destructuring; updateWorkflow composes the halves. */
export interface PreparedWorkflowSave {
  id: string
  principal: WorkflowWritePrincipal
  parsed: { data: UpdateWorkflow }
  normalizedSnapshot: ReturnType<typeof normalizeWorkflowSnapshot>
  submittedBytes: string
  definitionStorage: string
  fenceableAgentIds: Set<string>
  inTxGuard?: WorkflowWriteInTxGuard
}

export async function prepareWorkflowSave(
  db: DbClient,
  id: string,
  input: UpdateWorkflow,
  principal: WorkflowWritePrincipal,
  opts?: {
    inTxGuard?: WorkflowWriteInTxGuard
    /** Deterministic race-test seam after ordinary preflight, before dbTxSync. */
    beforeWriteTransaction?: () => void | Promise<void>
  },
): Promise<PreparedWorkflowSave> {
  const parsed = UpdateWorkflowSchema.safeParse(input)
  if (!parsed.success) {
    throw new ValidationError('workflow-invalid', 'invalid workflow save payload', {
      issues: parsed.error.issues,
    })
  }
  // RFC-264: fold the submitted name (NFC / space runs / edges) BEFORE the
  // snapshot bytes are taken, so what gets hashed into the receipt is exactly
  // what gets stored. Only the WRITE path normalizes — `normalizeWorkflowSnapshot`
  // is shared with the read/hash path, where a stored row must stay byte-faithful.
  const submittedSnapshot = normalizeWorkflowSnapshot({
    ...parsed.data.snapshot,
    name: normalizeResourceDisplayName(parsed.data.snapshot.name),
  })
  assertCanonicalWorkflowAgentIds(submittedSnapshot.definition)

  // Schema/reference checks remain outside the single-row write transaction.
  // The current row gates below are repeated in dbTxSync, so an ACL transfer or
  // built-in flip between preflight and CAS cannot authorize a stale writer.
  const preflightRow = await loadRawWorkflow(db, id)
  let fenceableAgentIds = new Set<string>()
  // RFC-270 — what actually gets stored. Identical to the submitted snapshot
  // except for privileged-node fields this principal was not allowed to SEE:
  // those are restored from the stored row below, before the author gates run.
  let normalizedSnapshot = submittedSnapshot
  if (preflightRow !== null) {
    await assertPrincipalCanWritePreflight(db, principal, preflightRow)
    const preflightWorkflow = rowToWorkflow(preflightRow)
    // RFC-270 §2.3 — REHYDRATE BEFORE THE GATES.
    //
    // The read path hands a principal without `scripts:author` /
    // `code-host-calls:author` a definition whose privileged fields are `***`
    // (services/tokenRedaction.ts). Submitting that back verbatim — which the
    // editor does on any autosave, including one caused by dragging an
    // unrelated node — would change the sensitive projection and 403, breaking
    // the promise `scriptAuthorGate.ts` opens with: an author without the point
    // can still move nodes and edit unrelated parts of the same workflow.
    //
    // So the masked fields are restored from the stored row, by LENS and never
    // by value (see `rehydratePrivilegedNodes`). What is NOT restored — a new
    // privileged node, a deleted one, its inbound wiring, its wrapper placement
    // — still reaches the gates unchanged and is still refused.
    const rehydratedDefinition = rehydratePrivilegedNodes(
      submittedSnapshot.definition,
      preflightWorkflow.definition,
      principal.kind === 'actor'
        ? privilegedNodeLensFor(principal.actor)
        : PRIVILEGED_LENS_TRANSPARENT,
    )
    if (rehydratedDefinition !== submittedSnapshot.definition) {
      normalizedSnapshot = { ...submittedSnapshot, definition: rehydratedDefinition }
    }
    assertChangedWorkflowName(preflightWorkflow.name, normalizedSnapshot.name)
    // RFC-253 — the save path's script gate. Compares the sensitive projection
    // of the STORED definition against the submitted one, so an author without
    // `scripts:author` can still move nodes and edit unrelated parts of a
    // workflow that happens to contain a script.
    assertScriptAuthorAllowed({
      next: normalizedSnapshot.definition,
      previous: preflightWorkflow.definition,
      principal:
        principal.kind === 'actor'
          ? { kind: 'actor', actor: principal.actor }
          : { kind: 'system', reason: principal.reason },
    })
    // RFC-269 — the same shape for code-host call nodes. Separate point on
    // purpose: authoring host code and acting on the code host as the
    // platform's bot identity are different capabilities, and a deployment may
    // reasonably grant one without the other.
    assertCodeHostAuthorAllowed({
      next: normalizedSnapshot.definition,
      previous: preflightWorkflow.definition,
      principal:
        principal.kind === 'actor'
          ? { kind: 'actor', actor: principal.actor }
          : { kind: 'system', reason: principal.reason },
    })
    const newIds = diffNewNames(
      extractWorkflowAgentRefs(preflightWorkflow.definition),
      extractWorkflowAgentRefs(normalizedSnapshot.definition),
    )
    const principalActor = principal.kind === 'actor' ? principal.actor : null
    const resolved = await resolveRefsUsableById(db, principalActor, 'agent', newIds)
    // RFC-243 (§5.3): NEW call-workflow name selectors only (D15 grandfather —
    // references already stored keep working even if their target went private).
    // RFC-282 D4 — full next set + grandfatheredNames; the D15 diff lives in
    // the resolver now (a hand-rolled diff was the fail-open the design gate
    // flagged: forget it once and grandfathering silently vanishes).
    const resolvedWorkflows = await resolveRefsUsableByName(
      db,
      principalActor,
      'workflow',
      extractWorkflowWorkflowRefs(normalizedSnapshot.definition),
      { grandfatheredNames: new Set(extractWorkflowWorkflowRefs(preflightWorkflow.definition)) },
    )
    const resolvedWorkgroups = await resolveRefsUsableByName(
      db,
      principalActor,
      'workgroup',
      extractWorkflowWorkgroupRefs(normalizedSnapshot.definition),
      { grandfatheredNames: new Set(extractWorkflowWorkgroupRefs(preflightWorkflow.definition)) },
    )
    assertNoMissingRefs([
      ...resolved.missing,
      ...resolvedWorkflows.missing,
      ...resolvedWorkgroups.missing,
    ])
    fenceableAgentIds = new Set(resolved.byToken.values())
  }
  // Byte projections are taken from the REHYDRATED snapshot, not the submitted
  // one: everything downstream (receipt hash, logical-same short circuit, the
  // stored `definition` column) has to describe what is actually written. Pure
  // computations, so moving them below the preflight block changes no error
  // precedence — only which definition they describe.
  const submittedBytes = serializeWorkflowEditableSnapshotV1(normalizedSnapshot)
  const definitionStorage = serializeWorkflowDefinitionStorageV1(normalizedSnapshot.definition)
  return {
    id,
    principal,
    parsed: { data: parsed.data },
    normalizedSnapshot,
    submittedBytes,
    definitionStorage,
    fenceableAgentIds,
    ...(opts?.inTxGuard === undefined ? {} : { inTxGuard: opts.inTxGuard }),
  }
}

export function commitWorkflowSaveInTx(
  tx: DbTxSync,
  p: PreparedWorkflowSave,
): { receipt: SaveWorkflowReceipt; committed: boolean } {
  const {
    id,
    principal,
    parsed,
    normalizedSnapshot,
    submittedBytes,
    definitionStorage,
    fenceableAgentIds,
  } = p
  const opts = { inTxGuard: p.inTxGuard }
  const currentRow = tx.select().from(workflows).where(eq(workflows.id, id)).get()
  if (currentRow === undefined) throwWorkflowNotFound(id)

  assertPrincipalCanWriteInTx(tx, principal, currentRow)
  const current = rowToWorkflow(currentRow)
  assertChangedWorkflowName(current.name, normalizedSnapshot.name)

  // Import reference selectors are initially resolved for preview/mapping,
  // then re-read here from the transaction's fresh ACL snapshot. This must
  // precede version/logical-no-op reconciliation: a response-loss retry may
  // not report success after its selected reference became stale/invisible.
  opts?.inTxGuard?.assert(tx)
  const newAgentIds = diffNewNames(
    extractWorkflowAgentRefs(current.definition),
    extractWorkflowAgentRefs(normalizedSnapshot.definition),
  ).filter((id) => fenceableAgentIds.has(id))
  // RFC-243 (§5.3): re-diff call-workflow names against the transaction's row
  // snapshot; the name domain tolerates dangling in-tx, so no fenceable set.
  const newWorkflowNames = diffNewNames(
    new Set(extractWorkflowWorkflowRefs(current.definition)),
    new Set(extractWorkflowWorkflowRefs(normalizedSnapshot.definition)),
  )
  const newWorkgroupNames = diffNewNames(
    new Set(extractWorkflowWorkgroupRefs(current.definition)),
    new Set(extractWorkflowWorkgroupRefs(normalizedSnapshot.definition)),
  )
  assertRefsUsableInTx(tx, principal.kind === 'actor' ? principal.actor : null, [
    { type: 'agent', names: newAgentIds, domain: 'id' },
    { type: 'workflow', names: newWorkflowNames, domain: 'name' },
    { type: 'workgroup', names: newWorkgroupNames, domain: 'name' },
  ])

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
}

export async function updateWorkflow(
  db: DbClient,
  id: string,
  input: UpdateWorkflow,
  principal: WorkflowWritePrincipal,
  opts?: {
    inTxGuard?: WorkflowWriteInTxGuard
    /** Deterministic race-test seam after ordinary preflight, before dbTxSync. */
    beforeWriteTransaction?: () => void | Promise<void>
  },
): Promise<SaveWorkflowReceipt> {
  const prepared = await prepareWorkflowSave(db, id, input, principal, opts)
  await opts?.beforeWriteTransaction?.()

  const txResult = dbTxSync<{ receipt: SaveWorkflowReceipt; committed: boolean }>(db, (tx) =>
    commitWorkflowSaveInTx(tx, prepared),
  )

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

/**
 * RFC-223: portable workflow YAML is the only name-based selector boundary.
 * Every definition crossing the persisted-workflow write boundary must already
 * carry the canonical agent id stamped by the editor or YAML import resolver.
 */
export function assertCanonicalWorkflowAgentIds(definition: WorkflowDefinition): void {
  const nodeIds = (definition.nodes ?? [])
    .filter((node) => node.kind === 'agent-single')
    .filter((node) => typeof node.agentId !== 'string' || node.agentId.length === 0)
    .map((node) => node.id)
    .sort()
  if (nodeIds.length === 0) return
  throw new ValidationError(
    'workflow-agent-id-required',
    'agent-single nodes require a canonical agentId',
    { nodeIds },
  )
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

    // RFC-202 T5: refuse while any scheduled task still launches this
    // workflow — symmetric with deleteAgent's 'agent-scheduled-referenced'
    // guard. Without it the orphaned enabled schedule fires workflow-not-found
    // silently on every tick (no task row, no visible trace) until the
    // consecutive-failure auto-disable kicks in ~10 fires later (audit P1
    // F-12). Same transaction as the DELETE, so a schedule insert that wins
    // first is always observed.
    const schedRows = tx
      .select({
        id: scheduledTasks.id,
        name: scheduledTasks.name,
        launchKind: scheduledTasks.launchKind,
        launchPayload: scheduledTasks.launchPayload,
        ownerUserId: scheduledTasks.ownerUserId,
      })
      .from(scheduledTasks)
      .all()
    const referencing = scheduledRowsReferencingWorkflow(schedRows, id)
    if (referencing.length > 0) {
      // Schedules are member-private (owner + tasks:read:all admins). Details
      // disclose names only for schedules the principal may see; the rest is
      // an aggregate count — same 404-shape hiding discipline the routes use
      // (Codex design-gate P1: do not leak private schedule names/existence).
      const canSeeAll =
        principal.kind === 'system' || principal.actor.permissions.has('tasks:read:all' as never)
      const visible = referencing.filter(
        (r) =>
          canSeeAll || (principal.kind === 'actor' && r.ownerUserId === principal.actor.user.id),
      )
      throw new ConflictError(
        'workflow-scheduled-referenced',
        `workflow '${id}' is the launch target of ${referencing.length} scheduled task(s); delete or repoint them first`,
        {
          scheduledCount: referencing.length,
          visibleScheduled: visible.map((r) => ({ id: r.id, name: r.name })),
          hiddenCount: referencing.length - visible.length,
        },
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
 * RFC-202 T5 — pure core of the scheduled-task reference check (mirrors
 * `scheduledRowsReferencingAgent` in agent.ts). launchKind='workflow' rows
 * carry the target inside the JSON launch payload (`workflowId`); malformed
 * payloads are skipped (degraded rows are repaired/deleted via their own
 * flow).
 */
export function scheduledRowsReferencingWorkflow<
  R extends { id: string; launchKind: string; launchPayload: string },
>(rows: ReadonlyArray<R>, workflowId: string): R[] {
  const out: R[] = []
  for (const row of rows) {
    if (row.launchKind !== 'workflow') continue
    try {
      const p = JSON.parse(row.launchPayload) as { workflowId?: unknown }
      if (p.workflowId === workflowId) out.push(row)
    } catch {
      /* skip degraded rows */
    }
  }
  return out
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

/** RFC-234 (T6): exported for the intent apply pipeline (its big transaction
 *  runs assertRefsUsableInTx + this core per created workflow, exactly like
 *  createWorkflow's own composition above). */
export function insertWorkflowInTx(
  tx: DbTxSync,
  input: {
    id: string
    name: string
    description: string
    definition: WorkflowDefinition
    ownerUserId: string | null
    builtin: boolean
    now: number
    /**
     * RFC-253 — who is introducing this definition's executable content.
     *
     * REQUIRED, deliberately: this function is the single insert path for a
     * workflow document (routes, YAML import and the intent builder all land
     * here), so making provenance a mandatory parameter is what stops a future
     * caller from forgetting the script gate. There is no default.
     */
    scriptPrincipal: ScriptAuthorPrincipal
  },
): WorkflowRow {
  assertScriptAuthorAllowed({ next: input.definition, principal: input.scriptPrincipal })
  // RFC-269 — same persistence primitive, same provenance value (the two
  // principal types are structurally identical by design).
  assertCodeHostAuthorAllowed({ next: input.definition, principal: input.scriptPrincipal })
  const initialAcl = input.builtin
    ? initialBuiltinResourceAcl(input.ownerUserId)
    : initialPrivateResourceAcl(input.ownerUserId)
  const inserted = tx
    .insert(workflows)
    .values({
      id: input.id,
      name: input.name,
      description: input.description,
      definition: serializeWorkflowDefinitionStorageV1(input.definition),
      version: 1,
      // RFC-231: user resources are private; framework built-ins stay public.
      ...initialAcl,
      // RFC-104: built-in is internal-only and never accepted from HTTP.
      builtin: input.builtin,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .returning()
    .get()
  if (inserted === undefined) throw new Error('workflow insert returned no row')
  return inserted
}

export function broadcastWorkflowCreated(created: WorkflowDetail): void {
  workflowsBroadcaster.broadcast(WORKFLOWS_CHANNEL, {
    type: 'workflow.created',
    workflowId: created.id,
    name: created.name,
    version: created.version,
  })
}

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

export function rowToWorkflowDetail(row: WorkflowRow): WorkflowDetail {
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
  const isAdmin = isResourceAdminActor(actor)
  const isOwner = row.ownerUserId !== null && row.ownerUserId === actor.user.id
  // RFC-282 D1 — visibility is the shared predicate; isAdmin/isOwner stay
  // local for the 403 below, and the 404 → builtin → 403 order is contract.
  if (!canViewResourceInTx(tx, actor, 'workflow', row)) throwWorkflowNotFound(row.id)
  assertNotBuiltin('workflow', row)
  if (!isAdmin && !isOwner) {
    throw new ForbiddenError('forbidden', 'only the workflow owner or an admin can modify it')
  }
}

function assertChangedWorkflowName(currentName: string, submittedName: string): void {
  if (currentName === submittedName) return
  const parsed = WorkflowNameSchema.safeParse(submittedName)
  if (!parsed.success) {
    throw new ValidationError('workflow-name-invalid', WORKFLOW_NAME_INVALID_MESSAGE, {
      issues: parsed.error.issues,
    })
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
