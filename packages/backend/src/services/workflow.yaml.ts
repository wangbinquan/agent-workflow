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
  ImportWorkflowRequest,
  ImportWorkflowResult,
  Workflow,
  WorkflowDefinition,
} from '@agent-workflow/shared'
import {
  stringifyWorkflowYamlDocument,
  WorkflowDefinitionSchema,
  WorkflowNameSchema,
} from '@agent-workflow/shared'
import { parse as parseYaml } from 'yaml'
import type { DbClient } from '@/db/client'
import { canViewResource } from '@/services/resourceAcl'
import { assertNotBuiltin } from '@/services/systemResources'
import { assertNewRefsUsable, extractWorkflowAgentNames } from '@/services/resourceRefs'
import {
  createWorkflow,
  getWorkflow,
  updateWorkflow,
  workflowRevisionOf,
  type WorkflowWritePrincipal,
} from '@/services/workflow'
import { ConflictError, ValidationError } from '@/util/errors'

/**
 * Serialize an already-captured workflow row. Callers that also perform an
 * ACL/revision guard must pass that exact immutable snapshot here instead of
 * re-reading by id after the guard (RFC-199 B1/B3).
 */
export function stringifyWorkflowYaml(
  wf: Pick<Workflow, 'id' | 'name' | 'description' | 'definition'>,
): string {
  return stringifyWorkflowYamlDocument(
    { name: wf.name, description: wf.description, definition: wf.definition },
    { id: wf.id },
  )
}

export interface YamlImportPreview {
  /** Workflow id parsed from YAML, if any. */
  id: string | null
  name: string
  description: string
  definition: WorkflowDefinition
  /** True when a workflow with `id` already exists in DB. */
  conflicts: boolean
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
  const parsed = WorkflowDefinitionSchema.safeParse(definitionRaw)
  if (!parsed.success) {
    throw new ValidationError('workflow-yaml-invalid', 'YAML definition failed schema validation', {
      issues: parsed.error.issues,
    })
  }
  return { id, name, description, definition: parsed.data }
}

export async function importWorkflowYaml(
  db: DbClient,
  request: ImportWorkflowRequest,
  principal: WorkflowWritePrincipal,
): Promise<ImportWorkflowResult> {
  if (request.yamlText.length === 0) {
    throw new ValidationError('workflow-yaml-empty', 'empty YAML body')
  }
  const preview = previewWorkflowYaml(request.yamlText)

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
          definition: preview.definition,
        },
      },
      principal,
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
  if (principal.kind === 'actor') {
    await assertNewRefsUsable(db, principal.actor, [
      { type: 'agent', names: [...extractWorkflowAgentNames(preview.definition)] },
    ])
  }
  const workflow = await createWorkflow(
    db,
    {
      name: preview.name,
      description: preview.description,
      definition: preview.definition,
    },
    principal.kind === 'actor' ? { ownerUserId: principal.actor.user.id } : undefined,
  )
  return { outcome: 'created', workflow }
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
