// P-4-08: YAML import/export for workflows.
//
// Export: dump the canonical Workflow object (id + name + description +
// definition) as YAML using the `yaml` package's pretty printer.
//
// Import: parse the structured request's YAML, validate the embedded definition
// with `WorkflowDefinitionSchema`, and apply one explicit mode:
//   - fail: a visible id collision returns a revision-bearing 409
//   - overwrite: requires the confirmed id/version/mutation fence and delegates
//     to the same full-snapshot save service as editor autosave
//   - new: discards an incoming id and inserts a fresh workflow

import type {
  ImportRefSelection,
  ImportWorkflowRequest,
  ImportWorkflowResult,
  Workflow,
  WorkflowDefinition,
  WorkflowDefinitionSelector,
} from '@agent-workflow/shared'
import {
  importRefSelectorKey,
  stringifyWorkflowYamlDocument,
  WorkflowDefinitionSelectorSchema,
  WorkflowDefinitionSchema,
  WorkflowNameSchema,
} from '@agent-workflow/shared'
import { inArray } from 'drizzle-orm'
import { parse as parseYaml } from 'yaml'
import { SYSTEM_USER_ID, type Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import { agents, users } from '@/db/schema'
import { canViewResource, filterVisibleRows } from '@/services/resourceAcl'
import { assertNotBuiltin } from '@/services/systemResources'
import { assertImportRefsStableInTx, resolveImportRefs } from '@/services/importRefs'
import {
  createWorkflow,
  getWorkflow,
  updateWorkflow,
  workflowRevisionOf,
  type WorkflowWriteInTxGuard,
  type WorkflowWritePrincipal,
} from '@/services/workflow'
import { ConflictError, ValidationError } from '@/util/errors'

/**
 * Serialize an already-captured workflow row. Callers that also perform an
 * ACL/revision guard must pass that exact immutable snapshot here instead of
 * re-reading by id after the guard (RFC-199 B1/B3).
 */
export function stringifyWorkflowYaml(
  wf: Pick<Workflow, 'id' | 'name' | 'description'> & {
    definition: WorkflowDefinition | WorkflowDefinitionSelector
  },
): string {
  return stringifyWorkflowYamlDocument(
    {
      name: wf.name,
      description: wf.description,
      // The shared serializer deliberately accepts the canonical definition
      // schema for full-fidelity backups. Portable selectors are a strict
      // no-agentId subset with passthrough selector metadata, so they normalize
      // through that same serializer without widening the import schema.
      definition: wf.definition as WorkflowDefinition,
    },
    { id: wf.id },
  )
}

export interface YamlImportPreview {
  /** Workflow id parsed from YAML, if any. */
  id: string | null
  name: string
  description: string
  definition: WorkflowDefinitionSelector
  /** True when a workflow with `id` already exists in DB. */
  conflicts: boolean
}

export interface WorkflowImportHooks {
  /**
   * Deterministic race-test seam after ordinary reference preflight and before
   * the final write transaction. Production callers omit it.
   */
  afterResolve?: () => void | Promise<void>
}

/**
 * Parse + validate a YAML payload without persisting it. The route layer can
 * use this to render a Preview dialog before deciding on the conflict policy.
 */
export function previewWorkflowYaml(yamlText: string): Omit<YamlImportPreview, 'conflicts'> {
  const raw = safeParse(yamlText)
  if (raw === null || typeof raw !== 'object') {
    throw new ValidationError('workflow-yaml-invalid', 'YAML did not parse to an object')
  }
  const obj = raw as Record<string, unknown>
  const name = typeof obj.name === 'string' && obj.name.length > 0 ? obj.name : null
  if (name === null) {
    throw new ValidationError('workflow-yaml-invalid', 'YAML missing required field: name')
  }
  // 2026-07-10 naming unification: an import always mints a NEW name, so the
  // workgroup slug rules apply flat — old exports carrying a legacy free-form
  // name get an explicit 422 (edit the YAML's name line and retry). Decided
  // over auto-slugging to avoid silent renames.
  const nameOk = WorkflowNameSchema.safeParse(name)
  if (!nameOk.success) {
    throw new ValidationError(
      'workflow-name-invalid',
      'workflow name must start with [a-z0-9] and contain only [a-z0-9_-] (max 128 chars)',
      { issues: nameOk.error.issues },
    )
  }
  const id = typeof obj.id === 'string' && obj.id.length > 0 ? obj.id : null
  const description = typeof obj.description === 'string' ? obj.description : ''
  const definitionRaw = obj.definition
  const parsed = WorkflowDefinitionSelectorSchema.safeParse(definitionRaw)
  if (!parsed.success) {
    throw new ValidationError('workflow-yaml-invalid', 'YAML definition failed schema validation', {
      issues: parsed.error.issues,
    })
  }
  return { id, name, description, definition: parsed.data }
}

/**
 * Convert one immutable persisted workflow snapshot into its portable YAML
 * selector shape. The current canonical agent row supplies both the display
 * name and owner hint; installation-local ids never leave this boundary.
 */
export async function workflowDefinitionToSelectors(
  db: DbClient,
  actor: Actor,
  definition: WorkflowDefinition,
): Promise<WorkflowDefinitionSelector> {
  const agentIds = [
    ...new Set(
      definition.nodes
        .filter((node) => node.kind === 'agent-single')
        .map((node) => node.agentId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    ),
  ]
  if (
    definition.nodes.some(
      (node) =>
        node.kind === 'agent-single' &&
        (typeof node.agentId !== 'string' || node.agentId.length === 0),
    )
  ) {
    throw new ValidationError(
      'workflow-export-ref-unavailable',
      'workflow contains an agent node without a canonical agent id',
    )
  }
  if (agentIds.length === 0) {
    return WorkflowDefinitionSelectorSchema.parse(definition)
  }

  const rows = await db
    .select({
      id: agents.id,
      name: agents.name,
      ownerUserId: agents.ownerUserId,
      visibility: agents.visibility,
    })
    .from(agents)
    .where(inArray(agents.id, agentIds))
  const visible = await filterVisibleRows(db, actor, 'agent', rows)
  const byId = new Map(visible.map((row) => [row.id, row]))
  if (byId.size !== agentIds.length) {
    throw new ValidationError(
      'workflow-export-ref-unavailable',
      'workflow references an agent that is missing or no longer visible',
    )
  }

  const ownerIds = [
    ...new Set(
      visible
        .map((row) => row.ownerUserId)
        .filter(
          (ownerUserId): ownerUserId is string =>
            ownerUserId !== null && ownerUserId !== SYSTEM_USER_ID,
        ),
    ),
  ]
  const ownerRows =
    ownerIds.length === 0
      ? []
      : await db
          .select({ id: users.id, username: users.username })
          .from(users)
          .where(inArray(users.id, ownerIds))
  const usernameById = new Map(ownerRows.map((row) => [row.id, row.username]))

  return WorkflowDefinitionSelectorSchema.parse({
    ...definition,
    nodes: definition.nodes.map((node) => {
      if (node.kind !== 'agent-single') return node
      const agentId = node.agentId
      const row = agentId === undefined ? undefined : byId.get(agentId)
      if (row === undefined) {
        throw new ValidationError(
          'workflow-export-ref-unavailable',
          'workflow references an agent that is missing or no longer visible',
        )
      }
      const ownerUsername =
        row.ownerUserId === SYSTEM_USER_ID
          ? SYSTEM_USER_ID
          : row.ownerUserId === null
            ? undefined
            : usernameById.get(row.ownerUserId)
      if (row.ownerUserId !== null && ownerUsername === undefined) {
        throw new ValidationError(
          'workflow-export-owner-unavailable',
          'workflow agent owner no longer has a portable username',
        )
      }
      const record = node as Record<string, unknown>
      const {
        agentId: _agentId,
        agentName: _agentName,
        agentOwnerUsername: _agentOwnerUsername,
        ...portable
      } = record
      return {
        ...portable,
        agentName: row.name,
        ...(ownerUsername === undefined ? {} : { agentOwnerUsername: ownerUsername }),
      }
    }),
  })
}

export async function importWorkflowYaml(
  db: DbClient,
  request: ImportWorkflowRequest,
  principal: WorkflowWritePrincipal,
  hooks: WorkflowImportHooks = {},
): Promise<ImportWorkflowResult> {
  if (request.yamlText.length === 0) {
    throw new ValidationError('workflow-yaml-empty', 'empty YAML body')
  }
  const preview = previewWorkflowYaml(request.yamlText)
  // RFC-223 (PR-2): resolve each agent-single node's canonical agentId from its
  // portable name+owner selector against THIS install's agents. Safe to
  // normalize server-side here — the import
  // path computes the snapshot hash itself (no client-provided hash to fence),
  // unlike the editor autosave which relies on the frontend having stamped it.
  const resolvedImport =
    principal.kind === 'actor'
      ? await resolveImportedWorkflowNodeAgentIds(
          db,
          principal.actor,
          preview.definition,
          request.selections ?? [],
        )
      : {
          definition: rejectPortableRefsForSystemImport(preview.definition),
          inTxGuard: undefined,
        }
  const definition = resolvedImport.definition

  if (request.mode === 'overwrite') {
    if (preview.id === null || preview.id !== request.overwrite.workflowId) {
      throw new ValidationError(
        'workflow-import-target-mismatch',
        'YAML workflow id does not match the confirmed overwrite target',
        { yamlWorkflowId: preview.id, workflowId: request.overwrite.workflowId },
      )
    }
    const receipt = await updateWorkflow(
      db,
      request.overwrite.workflowId,
      {
        expectedVersion: request.overwrite.expectedVersion,
        clientMutationId: request.overwrite.clientMutationId,
        snapshot: {
          name: preview.name,
          description: preview.description,
          definition,
        },
      },
      principal,
      resolvedImport.inTxGuard === undefined
        ? { beforeWriteTransaction: hooks.afterResolve }
        : {
            inTxGuard: resolvedImport.inTxGuard,
            beforeWriteTransaction: hooks.afterResolve,
          },
    )
    return { outcome: 'overwritten', receipt }
  }

  if (preview.id !== null && request.mode === 'fail') {
    const existing = await getWorkflow(db, preview.id)
    if (existing !== null) {
      // mode=fail discards a non-colliding incoming id and creates a fresh row.
      // A private collision must take that exact same path: returning 404 here
      // while a truly missing id returns 201 would be an existence oracle.
      if (
        principal.kind === 'actor' &&
        !(await canViewResource(db, principal.actor, 'workflow', existing))
      ) {
        // Deliberately fall through to the fresh-id create below.
      } else {
        // Built-ins are explicitly read-only for callers who can see them.
        assertNotBuiltin('workflow', existing)
        throw new ConflictError(
          'workflow-import-conflict',
          `workflow '${preview.id}' already exists`,
          {
            workflowId: preview.id,
            existingName: existing.name,
            incomingName: preview.name,
            current: workflowRevisionOf(existing),
          },
        )
      }
    }
  }

  // mode=new always discards the incoming id. mode=fail creates only when the
  // id is absent/non-colliding. HTTP callers always provide an actor principal;
  // framework callers must opt into the explicit audited system branch.
  const workflow = await createWorkflow(
    db,
    {
      name: preview.name,
      description: preview.description,
      definition,
    },
    principal.kind === 'actor'
      ? {
          ownerUserId: principal.actor.user.id,
          actor: principal.actor,
          beforeWriteTransaction: hooks.afterResolve,
          ...(resolvedImport.inTxGuard === undefined
            ? {}
            : { inTxGuard: resolvedImport.inTxGuard }),
        }
      : { beforeWriteTransaction: hooks.afterResolve },
  )
  return { outcome: 'created', workflow }
}

async function resolveImportedWorkflowNodeAgentIds(
  db: DbClient,
  actor: Extract<WorkflowWritePrincipal, { kind: 'actor' }>['actor'],
  def: WorkflowDefinitionSelector,
  selections: readonly ImportRefSelection[],
): Promise<{ definition: WorkflowDefinition; inTxGuard: WorkflowWriteInTxGuard }> {
  const selectors = (def.nodes ?? [])
    .filter((node) => node.kind === 'agent-single')
    .map((node) => {
      const record = node as Record<string, unknown>
      const name = record.agentName
      if (typeof name !== 'string' || name.length === 0) {
        throw new ValidationError(
          'import-ref-unresolved',
          'an imported agent node is missing its portable agentName selector',
        )
      }
      const ownerUsername = record.agentOwnerUsername
      return {
        type: 'agent' as const,
        name,
        ...(typeof ownerUsername === 'string' ? { ownerUsername } : {}),
      }
    })
  const resolved = await resolveImportRefs(db, actor, selectors, selections)
  const definition = WorkflowDefinitionSchema.parse({
    ...def,
    nodes: (def.nodes ?? []).map((node) => {
      if (node.kind !== 'agent-single') return node
      const rec = node as Record<string, unknown>
      const name = rec.agentName
      if (typeof name !== 'string' || name.length === 0) return node
      const ownerUsername = rec.agentOwnerUsername
      const selector = {
        type: 'agent' as const,
        name,
        ...(typeof ownerUsername === 'string' ? { ownerUsername } : {}),
      }
      const id = resolved.bySelector.get(importRefSelectorKey(selector))
      if (id === undefined) {
        throw new ValidationError(
          'import-ref-unresolved',
          'imported agent reference did not resolve',
        )
      }
      const { agentId: _foreignId, agentOwnerUsername: _portableOwner, ...portable } = rec
      return { ...portable, agentId: id }
    }),
  })
  return {
    definition,
    inTxGuard: {
      assert: (tx) => assertImportRefsStableInTx(tx, actor, resolved.fence),
    },
  }
}

function rejectPortableRefsForSystemImport(def: WorkflowDefinitionSelector): WorkflowDefinition {
  const hasPortableRef = (def.nodes ?? []).some((node) => node.kind === 'agent-single')
  if (hasPortableRef) {
    throw new ValidationError(
      'workflow-import-system-ref-unsupported',
      'system workflow import cannot resolve portable resource selectors',
    )
  }
  return WorkflowDefinitionSchema.parse(def)
}

function safeParse(yamlText: string): unknown {
  try {
    return parseYaml(yamlText)
  } catch (err) {
    throw new ValidationError(
      'workflow-yaml-invalid',
      `YAML parse error: ${(err as Error).message}`,
    )
  }
}
