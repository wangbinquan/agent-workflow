// GET    /api/workflows               list
// GET    /api/workflows/:id            one
// POST   /api/workflows                create
// POST   /api/workflows/:id/copy       exact-revision private copy
// PUT    /api/workflows/:id            update (version+1)
// DELETE /api/workflows/:id            delete (refuses when running task references)
// POST   /api/workflows/:id/validate   exact-revision static validation receipt
// GET    /api/workflows/:id/export     exact-revision YAML export

import {
  CopyWorkflowRequestSchema,
  CreateWorkflowSchema,
  DeleteWorkflowSchema,
  UpdateWorkflowSchema,
  WorkflowDraftValidationRequestSchema,
  WorkflowValidationRequestSchema,
} from '@agent-workflow/shared'
import type { WorkflowDetail, WorkflowExactRevision } from '@agent-workflow/shared'
import type { Hono } from 'hono'
import { actorOf, type Actor } from '@/auth/actor'
import type { AppDeps } from '@/server'
import { registerRoute } from '@/routes/registry'
import { captureDeleteSnapshot } from '@/services/tokenAudit'
import {
  serializeWorkflowFor,
  serializeWorkflowReceiptFor,
  workflowReadLensFor,
} from '@/services/tokenRedaction'
import {
  canViewResource,
  filterVisibleRows,
  requireResourceGovern,
  requireResourceView,
} from '@/services/resourceAcl'
import { assertDeleteConfirm } from '@/services/deleteConfirm'
import { assertNotBuiltin, excludeBuiltinWorkflows } from '@/services/systemResources'
import {
  assertNewRefsUsable,
  diffNewNames,
  extractWorkflowAgentRefs,
  extractWorkflowWorkflowRefs,
  extractWorkflowWorkgroupRefs,
} from '@/services/resourceRefs'
import {
  copyWorkflow,
  createWorkflow,
  deleteWorkflow,
  getWorkflow,
  getWorkflowAclRow,
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
import {} from '@/services/workflow.yaml'
import { ConflictError, NotFoundError, ValidationError } from '@/util/errors'
import { mountAclEndpoints } from './resourceAcl'
import { WORKFLOWS_CHANNEL, workflowsBroadcaster } from '@/ws/broadcaster'
import { safeJsonOrEmpty } from '@/util/http'

export function mountWorkflowRoutes(app: Hono, deps: AppDeps): void {
  // RFC-099: missing and not-visible produce the identical 404 (D1).
  async function loadVisibleWorkflow(actor: Actor, id: string) {
    const wf = await getWorkflow(deps.db, id)
    if (wf === null || !(await canViewResource(deps.db, actor, 'workflow', wf))) {
      throw new NotFoundError('workflow-not-found', `workflow '${id}' not found`)
    }
    return wf
  }

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/workflows',
      permissions: ['workflows:read'],
      tokenAccess: 'allow',
      summary: 'List workflows visible to the caller',
    },
    async (c) => {
      // Hide the built-in aw-skill-fusion workflow (RFC-101): infrastructure the
      // daemon references by name, not a user list row. Discriminator = reserved
      // name AND __system__ owner — workflows.name is non-unique, so a user-owned
      // workflow named aw-skill-fusion must stay visible. See systemResources.ts.
      const rows = await filterVisibleRows(
        deps.db,
        actorOf(c),
        'workflow',
        excludeBuiltinWorkflows(await listWorkflows(deps.db)),
      )
      // RFC-311 (proposal C2): the list carried every workflow's FULL definition
      // JSON — the transport bulk of this endpoint — while the list UI only
      // renders a node count. Detail keeps the definition.
      //
      // `?include=definition` is the ONE opt-in that still needs the graphs:
      // the workflow editor's call-workflow reference resolver derives a child's
      // ports from its `inputs` + output nodes (`shared/nodePorts.ts` call-workflow
      // deriver), and that derivation must not be duplicated server-side. Every
      // plain list surface (list page, launch pickers, onboarding, memory dialog,
      // gallery) stays on the slim shape.
      const withDefinition = c.req.query('include') === 'definition'
      return c.json(
        rows.map((wf) => {
          const serialized = serializeWorkflowFor(wf, workflowReadLensFor(actorOf(c)))
          const nodeCount = serialized.definition.nodes.length
          if (withDefinition) return { ...serialized, nodeCount }
          const { definition: _definition, ...rest } = serialized
          return { ...rest, nodeCount }
        }),
      )
    },
  )

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/workflows/:id',
      permissions: ['workflows:read'],
      tokenAccess: 'allow',
      summary: 'Get one workflow',
    },
    async (c) => {
      const actor = actorOf(c)
      return c.json(
        serializeWorkflowFor(
          await loadVisibleWorkflow(actor, c.req.param('id')),
          workflowReadLensFor(actor),
        ),
      )
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/workflows',
      permissions: ['workflows:create'],
      tokenAccess: 'allow',
      summary: 'Create a workflow',
    },
    async (c) => {
      const parsed = CreateWorkflowSchema.safeParse(await safeJsonOrEmpty(c.req.raw))
      if (!parsed.success) {
        throw new ValidationError('workflow-invalid', 'invalid workflow payload', {
          issues: parsed.error.issues,
        })
      }
      const actor = actorOf(c)
      // Service preflight + final dbTxSync bind every canonical id to this actor.
      const created = await createWorkflow(deps.db, parsed.data, {
        ownerUserId: actor.user.id,
        actor,
      })
      return c.json(serializeWorkflowFor(created, workflowReadLensFor(actor)), 201)
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/workflows/:id/copy',
      permissions: ['workflows:create'],
      tokenAccess: 'allow',
      summary: 'Copy a workflow into a private duplicate',
    },
    async (c) => {
      const parsed = CopyWorkflowRequestSchema.safeParse(await safeJsonOrEmpty(c.req.raw))
      if (!parsed.success) {
        throw new ValidationError('workflow-copy-invalid', 'invalid workflow copy payload', {
          issues: parsed.error.issues,
        })
      }
      const actor = actorOf(c)
      // Copy is the one write a PAT can perform on a script-bearing workflow
      // (verbatim provenance skips the scripts:author gate, D21) — its response
      // must not hand back the env plaintext the read path hides.
      return c.json(
        serializeWorkflowFor(
          await copyWorkflow(deps.db, c.req.param('id'), parsed.data, actor),
          workflowReadLensFor(actor),
        ),
        201,
      )
    },
  )

  registerRoute(
    app,
    {
      method: 'PUT',
      path: '/api/workflows/:id',
      permissions: ['workflows:update'],
      tokenAccess: 'allow',
      summary: 'Replace a workflow',
    },
    async (c) => {
      const id = c.req.param('id')
      const parsed = UpdateWorkflowSchema.safeParse(await safeJsonOrEmpty(c.req.raw))
      if (!parsed.success) {
        throw new ValidationError('workflow-invalid', 'invalid workflow save payload', {
          issues: parsed.error.issues,
        })
      }
      const actor = actorOf(c)
      // A save answers with a RECEIPT, whose `snapshot` carries the definition
      // just written — the record projection would not reach it.
      return c.json(
        serializeWorkflowReceiptFor(
          await updateWorkflow(deps.db, id, parsed.data, { kind: 'actor', actor }),
          workflowReadLensFor(actor),
        ),
      )
    },
  )

  registerRoute(
    app,
    {
      method: 'DELETE',
      path: '/api/workflows/:id',
      permissions: ['workflows:delete'],
      tokenAccess: 'allow',
      summary: 'Delete a workflow',
    },
    async (c) => {
      const actor = actorOf(c)
      // RFC-222 (N-5 order): existence 404 → visibility 404 → builtin/owner 403 →
      // confirm 422 → deleteWorkflow (OCC + reference refusal, re-checked in-tx).
      // Uses the raw ACL row (NOT loadVisibleWorkflow) so a workflow with a corrupt
      // stored definition is still deletable — deletion must not require a
      // parseable definition.
      const row = await getWorkflowAclRow(deps.db, c.req.param('id'))
      if (row === null) {
        throw new NotFoundError('workflow-not-found', `workflow '${c.req.param('id')}' not found`)
      }
      await requireResourceView(deps.db, actor, 'workflow', row)
      assertNotBuiltin('workflow', row) // RFC-104: built-ins are read-only
      // RFC-324: deletion is governance — an edit grant does not reach it.
      await requireResourceGovern(deps.db, actor, 'workflow', row)
      const parsed = DeleteWorkflowSchema.safeParse(await safeJsonOrEmpty(c.req.raw))
      if (!parsed.success) {
        throw new ValidationError('workflow-invalid', 'invalid workflow delete payload', {
          issues: parsed.error.issues,
        })
      }
      // RFC-222 (D5, N-1): confirm against the workflow's current name (id ≠ name).
      assertDeleteConfirm(parsed.data, row.name, 'workflow')
      captureDeleteSnapshot(c, actor, row)
      await deleteWorkflow(deps.db, c.req.param('id'), parsed.data, { kind: 'actor', actor })
      return c.body(null, 204)
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/workflows/:id/validate',
      permissions: ['workflows:execute'],
      tokenAccess: 'allow',
      summary: 'Validate a stored workflow',
    },
    async (c) => {
      // ACL, revision guard and validation all consume this one immutable detail.
      // In particular, do not replace this with validateWorkflowById after the
      // guard: that would re-read latest and admit a check-vN/validate-vN+1 race.
      const workflow = await loadVisibleWorkflow(actorOf(c), c.req.param('id'))
      const parsed = WorkflowValidationRequestSchema.safeParse(await safeJsonOrEmpty(c.req.raw))
      if (!parsed.success) {
        throw new ValidationError(
          'workflow-validation-invalid',
          'invalid exact workflow validation payload',
          { issues: parsed.error.issues },
        )
      }
      const revision = assertExactWorkflowRevision(
        workflow,
        parsed.data,
        'workflow-validation-stale',
      )
      await deps.workflowExactOperationHook?.({ operation: 'validate', revision })
      // RFC-243 实现门 P1-2: thread the candidate so the 4f/4g call-node rules
      // (closure loader + workgroup existence) actually run on the editor face.
      const context = await loadWorkflowValidationContext(deps.db, {
        definition: workflow.definition,
        currentWorkflow: { id: workflow.id, name: workflow.name },
      })
      const result = validateWorkflowDefinition(workflow.definition, context)
      return c.json({
        revision,
        validationContextHash: workflowValidationContextHashOf(context),
        validatedAt: Date.now(),
        ...result,
      })
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/workflows/:id/validate-draft',
      permissions: ['workflows:execute'],
      tokenAccess: 'allow',
      summary: 'Validate an unsaved draft',
    },
    async (c) => {
      // Capture the stored reference baseline once. This endpoint validates only
      // in-memory bytes: it never creates a temporary workflow row and never
      // writes the captured workflow.
      const actor = actorOf(c)
      const workflow = await loadVisibleWorkflow(actor, c.req.param('id'))
      const parsed = WorkflowDraftValidationRequestSchema.safeParse(
        await safeJsonOrEmpty(c.req.raw),
      )
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
        extractWorkflowAgentRefs(workflow.definition),
        extractWorkflowAgentRefs(parsed.data.definition),
      )
      // RFC-243 (§5.3): NEW call-workflow name selectors ride the same D15 gate
      // (dangle-tolerant name domain — see resourceRefs.RefCheckGroup.domain).
      const addedWorkflowNames = diffNewNames(
        new Set(extractWorkflowWorkflowRefs(workflow.definition)),
        new Set(extractWorkflowWorkflowRefs(parsed.data.definition)),
      )
      const addedWorkgroupNames = diffNewNames(
        new Set(extractWorkflowWorkgroupRefs(workflow.definition)),
        new Set(extractWorkflowWorkgroupRefs(parsed.data.definition)),
      )
      await assertNewRefsUsable(deps.db, actor, [
        { type: 'agent', names: addedAgentNames, domain: 'id' },
        { type: 'workflow', names: addedWorkflowNames, domain: 'name' },
        { type: 'workgroup', names: addedWorkgroupNames, domain: 'name' },
      ])

      // RFC-243 实现门 P1-2 — draft face gets the same candidate threading.
      const context = await loadWorkflowValidationContext(deps.db, {
        definition: parsed.data.definition,
        currentWorkflow: { id: workflow.id, name: workflow.name },
      })
      const result = validateWorkflowDefinition(parsed.data.definition, context)
      return c.json({
        candidateHash,
        validationContextHash: workflowValidationContextHashOf(context),
        validatedAt: Date.now(),
        ...result,
      })
    },
  )

  // RFC-271 C1/C2：`GET /api/workflows/:id/export`（单文件 YAML 导出）与
  // `POST /api/workflows/import`（裸 YAML 导入）已下线，由配置包取代
  // （`/api/workflows/:id/export-package` + `/api/resource-packages/*`）。
  //
  // 下线的理由不是「换个格式」：YAML 导出只序列化工作流自己的 `definition`，代理
  // 背后的技能 / MCP / 插件 / dependsOn 闭包**一个字节都不在文件里**，导入到另一个
  // 实例必然悬空。那不是「功能少一点」，是一个会稳定产出坏结果的出口。

  // RFC-099 — GET/PUT /api/workflows/:id/acl
  mountAclEndpoints(app, deps, {
    type: 'workflow',
    base: '/api/workflows',
    param: 'id',
    load: (db, id) => getWorkflow(db, id),
    // Lets connected /ws/workflows clients re-fetch AND lets the WS server
    // invalidate its per-connection visibility cache for this workflow.
    afterUpdate: (workflowId) => {
      workflowsBroadcaster.broadcast(WORKFLOWS_CHANNEL, {
        type: 'workflow.acl.updated',
        workflowId,
      })
    },
  })
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
