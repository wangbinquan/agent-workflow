// GET    /api/workflows               list
// GET    /api/workflows/:id            one
// POST   /api/workflows                create
// PUT    /api/workflows/:id            update (version+1)
// DELETE /api/workflows/:id            delete (refuses when running task references)
// POST   /api/workflows/:id/validate   exact-revision static validation receipt
// GET    /api/workflows/:id/export     exact-revision YAML export

import {
  CreateWorkflowSchema,
  DeleteWorkflowSchema,
  ImportWorkflowRequestSchema,
  UpdateWorkflowSchema,
  WorkflowDraftValidationRequestSchema,
  WorkflowExactRevisionSchema,
  WorkflowValidationRequestSchema,
} from '@agent-workflow/shared'
import type { WorkflowDetail, WorkflowExactRevision } from '@agent-workflow/shared'
import type { Hono } from 'hono'
import { actorOf, type Actor } from '@/auth/actor'
import type { AppDeps } from '@/server'
import { canViewResource, filterVisibleRows } from '@/services/resourceAcl'
import { excludeBuiltinWorkflows } from '@/services/systemResources'
import {
  assertNewRefsUsable,
  diffNewNames,
  extractWorkflowAgentNames,
} from '@/services/resourceRefs'
import {
  createWorkflow,
  deleteWorkflow,
  getWorkflow,
  listWorkflows,
  updateWorkflow,
  workflowRevisionOf,
} from '@/services/workflow'
import {
  loadWorkflowValidationContext,
  validateWorkflowDefinition,
  workflowDefinitionCandidateHashOf,
  workflowValidationContextHashOf,
} from '@/services/workflow.validator'
import { importWorkflowYaml, stringifyWorkflowYaml } from '@/services/workflow.yaml'
import { ConflictError, NotFoundError, ValidationError } from '@/util/errors'
import { mountAclEndpoints } from './resourceAcl'

export function mountWorkflowRoutes(app: Hono, deps: AppDeps): void {
  // RFC-099: missing and not-visible produce the identical 404 (D1).
  async function loadVisibleWorkflow(actor: Actor, id: string) {
    const wf = await getWorkflow(deps.db, id)
    if (wf === null || !(await canViewResource(deps.db, actor, 'workflow', wf))) {
      throw new NotFoundError('workflow-not-found', `workflow '${id}' not found`)
    }
    return wf
  }

  app.get('/api/workflows', async (c) =>
    // Hide the built-in aw-skill-fusion workflow (RFC-101): infrastructure the
    // daemon references by name, not a user list row. Discriminator = reserved
    // name AND __system__ owner — workflows.name is non-unique, so a user-owned
    // workflow named aw-skill-fusion must stay visible. See systemResources.ts.
    c.json(
      await filterVisibleRows(
        deps.db,
        actorOf(c),
        'workflow',
        excludeBuiltinWorkflows(await listWorkflows(deps.db)),
      ),
    ),
  )

  app.get('/api/workflows/:id', async (c) => {
    return c.json(await loadVisibleWorkflow(actorOf(c), c.req.param('id')))
  })

  app.post('/api/workflows', async (c) => {
    const parsed = CreateWorkflowSchema.safeParse(await safeJson(c.req.raw))
    if (!parsed.success) {
      throw new ValidationError('workflow-invalid', 'invalid workflow payload', {
        issues: parsed.error.issues,
      })
    }
    const actor = actorOf(c)
    // RFC-099 (D15): on create every agent reference is new.
    await assertNewRefsUsable(deps.db, actor, [
      { type: 'agent', names: [...extractWorkflowAgentNames(parsed.data.definition)] },
    ])
    const created = await createWorkflow(deps.db, parsed.data, { ownerUserId: actor.user.id })
    return c.json(created, 201)
  })

  app.put('/api/workflows/:id', async (c) => {
    const id = c.req.param('id')
    const parsed = UpdateWorkflowSchema.safeParse(await safeJson(c.req.raw))
    if (!parsed.success) {
      throw new ValidationError('workflow-invalid', 'invalid workflow save payload', {
        issues: parsed.error.issues,
      })
    }
    const actor = actorOf(c)
    return c.json(await updateWorkflow(deps.db, id, parsed.data, { kind: 'actor', actor }))
  })

  app.delete('/api/workflows/:id', async (c) => {
    const parsed = DeleteWorkflowSchema.safeParse(await safeJson(c.req.raw))
    if (!parsed.success) {
      throw new ValidationError('workflow-invalid', 'invalid workflow delete payload', {
        issues: parsed.error.issues,
      })
    }
    const actor = actorOf(c)
    await deleteWorkflow(deps.db, c.req.param('id'), parsed.data, { kind: 'actor', actor })
    return c.body(null, 204)
  })

  app.post('/api/workflows/:id/validate', async (c) => {
    // ACL, revision guard and validation all consume this one immutable detail.
    // In particular, do not replace this with validateWorkflowById after the
    // guard: that would re-read latest and admit a check-vN/validate-vN+1 race.
    const workflow = await loadVisibleWorkflow(actorOf(c), c.req.param('id'))
    const parsed = WorkflowValidationRequestSchema.safeParse(await safeJson(c.req.raw))
    if (!parsed.success) {
      throw new ValidationError(
        'workflow-validation-invalid',
        'invalid exact workflow validation payload',
        { issues: parsed.error.issues },
      )
    }
    const revision = assertExactWorkflowRevision(workflow, parsed.data, 'workflow-validation-stale')
    await deps.workflowExactOperationHook?.({ operation: 'validate', revision })
    const context = await loadWorkflowValidationContext(deps.db)
    const result = validateWorkflowDefinition(workflow.definition, context)
    return c.json({
      revision,
      validationContextHash: workflowValidationContextHashOf(context),
      validatedAt: Date.now(),
      ...result,
    })
  })

  app.post('/api/workflows/:id/validate-draft', async (c) => {
    // Capture the stored reference baseline once. This endpoint validates only
    // in-memory bytes: it never creates a temporary workflow row and never
    // writes the captured workflow.
    const actor = actorOf(c)
    const workflow = await loadVisibleWorkflow(actor, c.req.param('id'))
    const parsed = WorkflowDraftValidationRequestSchema.safeParse(await safeJson(c.req.raw))
    if (!parsed.success) {
      throw new ValidationError(
        'workflow-draft-validation-invalid',
        'invalid workflow draft validation payload',
        { issues: parsed.error.issues },
      )
    }

    const candidateHash = workflowDefinitionCandidateHashOf(parsed.data.definition)
    if (candidateHash !== parsed.data.claimedCandidateHash) {
      throw new ValidationError(
        'workflow-candidate-hash-mismatch',
        'workflow candidate does not match the claimed hash',
        { claimed: parsed.data.claimedCandidateHash, actual: candidateHash },
      )
    }

    const addedAgentNames = diffNewNames(
      extractWorkflowAgentNames(workflow.definition),
      extractWorkflowAgentNames(parsed.data.definition),
    )
    await assertNewRefsUsable(deps.db, actor, [{ type: 'agent', names: addedAgentNames }])

    const context = await loadWorkflowValidationContext(deps.db)
    const result = validateWorkflowDefinition(parsed.data.definition, context)
    return c.json({
      candidateHash,
      validationContextHash: workflowValidationContextHashOf(context),
      validatedAt: Date.now(),
      ...result,
    })
  })

  // P-4-08: YAML export / import.
  app.get('/api/workflows/:id/export', async (c) => {
    // Capture once: ACL, exact-revision guard and YAML bytes are all derived
    // from this same immutable detail. Never re-read latest after the guard.
    const workflow = await loadVisibleWorkflow(actorOf(c), c.req.param('id'))
    const query = Object.fromEntries(
      Object.entries(c.req.queries()).map(([key, values]) => [
        key,
        values.length === 1 ? values[0] : values,
      ]),
    )
    const parsed = WorkflowExactRevisionSchema.safeParse({
      ...query,
      expectedVersion: parseExactPositiveInteger(
        typeof query.expectedVersion === 'string' ? query.expectedVersion : undefined,
      ),
    })
    if (!parsed.success) {
      throw new ValidationError('workflow-export-invalid', 'invalid exact workflow export query', {
        issues: parsed.error.issues,
      })
    }
    const revision = assertExactWorkflowRevision(workflow, parsed.data, 'workflow-version-mismatch')
    await deps.workflowExactOperationHook?.({ operation: 'export', revision })
    const yaml = stringifyWorkflowYaml(workflow)
    return c.body(yaml, 200, {
      'content-type': 'application/yaml; charset=utf-8',
      'content-disposition': `attachment; filename="${c.req.param('id')}.yaml"`,
    })
  })

  app.post('/api/workflows/import', async (c) => {
    const parsed = ImportWorkflowRequestSchema.safeParse(await safeJson(c.req.raw))
    if (!parsed.success) {
      throw new ValidationError('workflow-import-invalid', 'invalid workflow import payload', {
        issues: parsed.error.issues,
      })
    }
    const actor = actorOf(c)
    const result = await importWorkflowYaml(deps.db, parsed.data, { kind: 'actor', actor })
    return c.json(result, result.outcome === 'created' ? 201 : 200)
  })

  // RFC-099 — GET/PUT /api/workflows/:id/acl
  mountAclEndpoints(app, deps, {
    type: 'workflow',
    base: '/api/workflows',
    param: 'id',
    load: (db, id) => getWorkflow(db, id),
  })
}

async function safeJson(req: Request): Promise<unknown> {
  try {
    return await req.json()
  } catch {
    return {}
  }
}

function parseExactPositiveInteger(raw: string | undefined): number | undefined {
  if (raw === undefined || !/^[1-9][0-9]*$/.test(raw)) return undefined
  const value = Number(raw)
  return Number.isSafeInteger(value) ? value : undefined
}

function assertExactWorkflowRevision(
  workflow: WorkflowDetail,
  expected: WorkflowExactRevision,
  code: 'workflow-validation-stale' | 'workflow-version-mismatch',
) {
  const current = workflowRevisionOf(workflow)
  if (
    current.version !== expected.expectedVersion ||
    current.snapshotHash !== expected.expectedSnapshotHash
  ) {
    throw new ConflictError(
      code,
      `workflow '${workflow.id}' does not match the requested revision`,
      {
        expected,
        current,
      },
    )
  }
  return current
}
