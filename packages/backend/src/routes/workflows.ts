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
  WorkflowDraftValidationRequestSchema,
  WorkflowValidationRequestSchema,
} from '@agent-workflow/shared'
import type { WorkflowDetail, WorkflowExactRevision } from '@agent-workflow/shared'
import type { Hono } from 'hono'
import { actorOf, type Actor } from '@/auth/actor'
import type { WorkflowOperationDescriptors } from '@/modules/resource-catalog/public/operations'
import type { WorkflowOperationContext } from '@/modules/resource-catalog/public/participants'
import type { WorkflowQueries } from '@/modules/resource-catalog/public/queries'
import type { AppDeps } from '@/server'
import { registerRoute } from '@/routes/registry'
import { registerOperationRoute } from '@/routes/operationRoute'
import { captureDeleteSnapshot } from '@/services/tokenAudit'
import {
  serializeWorkflowFor,
  serializeWorkflowReceiptFor,
  workflowReadLensFor,
} from '@/services/tokenRedaction'
import {
  assertNewRefsUsable,
  diffNewNames,
  extractWorkflowAgentRefs,
  extractWorkflowWorkflowRefs,
  extractWorkflowWorkgroupRefs,
} from '@/services/resourceRefs'
import {
  loadWorkflowValidationContext,
  validateWorkflowDefinition,
  workflowDefinitionCandidateHashOf,
  workflowValidationContextHashOf,
} from '@/services/workflow.validator'
import {} from '@/services/workflow.yaml'
import { ConflictError, NotFoundError, ValidationError } from '@/util/errors'
import { safeJsonOrEmpty } from '@/util/http'

export interface WorkflowRouteDependencies {
  readonly queries: WorkflowQueries
  readonly operations: WorkflowOperationDescriptors
  readonly authorityFor: (actor: Actor) => WorkflowOperationContext
}

export function mountWorkflowRoutes(
  app: Hono,
  deps: AppDeps,
  module: WorkflowRouteDependencies,
): void {
  const { queries, operations } = module

  // RFC-099: missing and not-visible produce the identical 404 (D1).
  async function loadVisibleWorkflow(actor: Actor, id: string) {
    const wf = await queries.get(module.authorityFor(actor), { id })
    if (wf === null) {
      throw new NotFoundError('workflow-not-found', `workflow '${id}' not found`)
    }
    return wf
  }

  registerOperationRoute(app, {
    descriptor: operations.list,
    method: 'GET',
    path: '/api/workflows',
    tokenAccess: 'allow',
    decode: () => ({}),
    context: (c) => module.authorityFor(actorOf(c)),
    encode: (c, rows) => {
      // Hide the built-in aw-skill-fusion workflow (RFC-101): infrastructure the
      // daemon references by name, not a user list row. Discriminator = reserved
      // name AND __system__ owner — workflows.name is non-unique, so a user-owned
      // workflow named aw-skill-fusion must stay visible. See systemResources.ts.
      const actor = actorOf(c)
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
          const serialized = serializeWorkflowFor(wf, workflowReadLensFor(actor))
          const nodeCount = serialized.definition.nodes.length
          if (withDefinition) return { ...serialized, nodeCount }
          const { definition: _definition, ...rest } = serialized
          return { ...rest, nodeCount }
        }),
      )
    },
  })

  registerOperationRoute(app, {
    descriptor: operations.get,
    method: 'GET',
    path: '/api/workflows/:id',
    tokenAccess: 'allow',
    decode: (c) => ({ id: c.req.param('id') }),
    context: (c) => module.authorityFor(actorOf(c)),
    encode: (c, workflow) => {
      const actor = actorOf(c)
      if (workflow === null) {
        throw new NotFoundError('workflow-not-found', `workflow '${c.req.param('id')}' not found`)
      }
      return c.json(serializeWorkflowFor(workflow, workflowReadLensFor(actor)))
    },
  })

  registerOperationRoute(app, {
    descriptor: operations.create,
    method: 'POST',
    path: '/api/workflows',
    tokenAccess: 'allow',
    decode: async (c) => ({
      submission: { kind: 'json-body', body: await c.req.raw.text().catch(() => '') },
    }),
    context: (c) => module.authorityFor(actorOf(c)),
    encode: (c, created) => {
      const actor = actorOf(c)
      return c.json(serializeWorkflowFor(created, workflowReadLensFor(actor)), 201)
    },
  })

  registerOperationRoute(app, {
    descriptor: operations.copy,
    method: 'POST',
    path: '/api/workflows/:id/copy',
    tokenAccess: 'allow',
    decode: async (c) => {
      const parsed = CopyWorkflowRequestSchema.safeParse(await safeJsonOrEmpty(c.req.raw))
      if (!parsed.success) {
        throw new ValidationError('workflow-copy-invalid', 'invalid workflow copy payload', {
          issues: parsed.error.issues,
        })
      }
      return { id: c.req.param('id'), copy: parsed.data }
    },
    context: (c) => module.authorityFor(actorOf(c)),
    encode: (c, copied) => {
      const actor = actorOf(c)
      // Copy is the one write a PAT can perform on a script-bearing workflow
      // (verbatim provenance skips the scripts:author gate, D21) — its response
      // must not hand back the env plaintext the read path hides.
      return c.json(serializeWorkflowFor(copied, workflowReadLensFor(actor)), 201)
    },
  })

  registerOperationRoute(app, {
    descriptor: operations.update,
    method: 'PUT',
    path: '/api/workflows/:id',
    tokenAccess: 'allow',
    decode: async (c) => ({
      id: c.req.param('id'),
      submission: { kind: 'json-body', body: await c.req.raw.text().catch(() => '') },
    }),
    context: (c) => module.authorityFor(actorOf(c)),
    encode: (c, receipt) => {
      const actor = actorOf(c)
      // A save answers with a RECEIPT, whose `snapshot` carries the definition
      // just written — the record projection would not reach it.
      return c.json(serializeWorkflowReceiptFor(receipt, workflowReadLensFor(actor)))
    },
  })

  registerOperationRoute(app, {
    descriptor: operations.delete,
    method: 'DELETE',
    path: '/api/workflows/:id',
    tokenAccess: 'allow',
    decode: async (c) => ({
      id: c.req.param('id'),
      submission: { kind: 'json-body', body: await c.req.raw.text().catch(() => '') },
    }),
    context: (c) => module.authorityFor(actorOf(c)),
    encode: (c, receipt) => {
      captureDeleteSnapshot(c, actorOf(c), receipt.deleted)
      return c.body(null, 204)
    },
  })

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
  registerOperationRoute(app, {
    descriptor: operations.getAcl,
    method: 'GET',
    path: '/api/workflows/:id/acl',
    tokenAccess: 'allow',
    decode: (c) => ({ id: c.req.param('id') }),
    context: (c) => module.authorityFor(actorOf(c)),
    encode: (c, acl) => c.json(acl),
  })

  registerOperationRoute(app, {
    descriptor: operations.updateAcl,
    method: 'PUT',
    path: '/api/workflows/:id/acl',
    tokenAccess: 'never',
    decode: async (c) => ({
      id: c.req.param('id'),
      submission: {
        kind: 'json-body',
        body: JSON.stringify(await safeJsonOrEmpty(c.req.raw)) ?? '{}',
      },
    }),
    context: (c) => module.authorityFor(actorOf(c)),
    encode: (c, acl) => c.json(acl),
  })
}

function assertExactWorkflowRevision(
  workflow: WorkflowDetail,
  expected: WorkflowExactRevision,
  code: 'workflow-validation-stale' | 'workflow-version-mismatch',
) {
  const current = {
    workflowId: workflow.id,
    version: workflow.version,
    snapshotHash: workflow.snapshotHash,
    updatedAt: workflow.updatedAt,
  }
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
