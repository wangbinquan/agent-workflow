// GET    /api/workflows               list
// GET    /api/workflows/:id            one
// POST   /api/workflows                create
// PUT    /api/workflows/:id            update (version+1)
// DELETE /api/workflows/:id            delete (refuses when running task references)
// POST   /api/workflows/:id/validate   M1 stub returning { ok:true, issues:[] }
//
// YAML import/export endpoints land in P-4-08.

import { CreateWorkflowSchema, UpdateWorkflowSchema } from '@agent-workflow/shared'
import type { Hono } from 'hono'
import { actorOf, type Actor } from '@/auth/actor'
import type { AppDeps } from '@/server'
import { canViewResource, filterVisibleRows, requireResourceOwner } from '@/services/resourceAcl'
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
  validateWorkflow,
} from '@/services/workflow'
import { exportWorkflowYaml, importWorkflowYaml } from '@/services/workflow.yaml'
import { NotFoundError, ValidationError } from '@/util/errors'
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
      throw new ValidationError('workflow-invalid', 'invalid workflow patch', {
        issues: parsed.error.issues,
      })
    }
    const actor = actorOf(c)
    const existing = await loadVisibleWorkflow(actor, id)
    await requireResourceOwner(deps.db, actor, 'workflow', existing)
    // RFC-099 (D15): only NEWLY-added agent references are checked.
    if (parsed.data.definition !== undefined) {
      const newNames = diffNewNames(
        extractWorkflowAgentNames(existing.definition),
        extractWorkflowAgentNames(parsed.data.definition),
      )
      await assertNewRefsUsable(deps.db, actor, [{ type: 'agent', names: newNames }])
    }
    return c.json(await updateWorkflow(deps.db, id, parsed.data))
  })

  app.delete('/api/workflows/:id', async (c) => {
    const actor = actorOf(c)
    const existing = await loadVisibleWorkflow(actor, c.req.param('id'))
    await requireResourceOwner(deps.db, actor, 'workflow', existing)
    await deleteWorkflow(deps.db, c.req.param('id'))
    return c.body(null, 204)
  })

  app.post('/api/workflows/:id/validate', async (c) => {
    await loadVisibleWorkflow(actorOf(c), c.req.param('id'))
    return c.json(await validateWorkflow(deps.db, c.req.param('id')))
  })

  // P-4-08: YAML export / import.
  app.get('/api/workflows/:id/export', async (c) => {
    await loadVisibleWorkflow(actorOf(c), c.req.param('id'))
    const yaml = await exportWorkflowYaml(deps.db, c.req.param('id'))
    return c.body(yaml, 200, {
      'content-type': 'application/yaml; charset=utf-8',
      'content-disposition': `attachment; filename="${c.req.param('id')}.yaml"`,
    })
  })

  app.post('/api/workflows/import', async (c) => {
    const body = await c.req.text()
    if (body.length === 0) {
      throw new ValidationError('workflow-yaml-empty', 'empty YAML body')
    }
    const onConflictRaw = c.req.query('onConflict')
    const onConflict =
      onConflictRaw === 'overwrite' || onConflictRaw === 'new' || onConflictRaw === 'fail'
        ? onConflictRaw
        : 'fail'
    const wf = await importWorkflowYaml(deps.db, body, { onConflict, actor: actorOf(c) })
    return c.json(wf, 201)
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
