// Workgroup HTTP routes (RFC-164 PR-1).
// GET    /api/workgroups                — list (ACL-filtered)
// GET    /api/workgroups/:name          — one (invisible → 404, D1)
// POST   /api/workgroups                — create (creator becomes owner)
// PUT    /api/workgroups/:name          — RFC-225 version-fenced full document save
// DELETE /api/workgroups/:name          — RFC-225 version-fenced delete
// POST   /api/workgroups/:name/rename   — fenced compatibility adapter
// GET/PUT /api/workgroups/:name/acl     — RFC-099 ACL management
//
// RFC-099 D15 / RFC-223 (PR-1, Codex impl-gate P1-2): creating/updating checks
// that NEW agent-member references are usable by the editor — enforced INSIDE
// create/updateWorkgroup, bound to the same single name→id resolution that
// persists the member agentIds (no check-then-resolve TOCTOU). Dangling names
// still pass (existence is launch-validated, same as workflow agentName).

import {
  CreateWorkgroupSchema,
  DeleteWorkgroupSchema,
  rejectRetiredStartTaskKeys,
  RenameWorkgroupSchema,
  StartWorkgroupTaskSchema,
  UpdateWorkgroupSchema,
} from '@agent-workflow/shared'
import type { Hono } from 'hono'
import { actorOf, type Actor } from '@/auth/actor'
import type { AppDeps } from '@/server'
import { canViewResource, filterVisibleRows, requireResourceOwner } from '@/services/resourceAcl'
import { assertDeleteConfirm } from '@/services/deleteConfirm'
import {
  createWorkgroup,
  deleteWorkgroup,
  getWorkgroup,
  getWorkgroupById,
  listWorkgroups,
  renameWorkgroup,
  saveWorkgroup,
} from '@/services/workgroups'
import { startWorkgroupTask } from '@/services/workgroup/launch'
import { buildStartTaskDeps } from '@/services/startTaskDeps'
import { resolveOpencodeCmd } from '@/util/opencode'
import { NotFoundError, ValidationError } from '@/util/errors'
import { mountAclEndpoints } from './resourceAcl'

export function mountWorkgroupRoutes(app: Hono, deps: AppDeps): void {
  // RFC-099: missing and not-visible produce the identical 404 (D1).
  async function loadVisibleWorkgroup(actor: Actor, name: string) {
    const group = await getWorkgroup(deps.db, name)
    if (group === null || !(await canViewResource(deps.db, actor, 'workgroup', group))) {
      throw new NotFoundError('workgroup-not-found', `workgroup '${name}' not found`)
    }
    return group
  }

  app.get('/api/workgroups', async (c) => {
    const list = await listWorkgroups(deps.db)
    return c.json(await filterVisibleRows(deps.db, actorOf(c), 'workgroup', list))
  })

  app.get('/api/workgroups/:name', async (c) => {
    return c.json(await loadVisibleWorkgroup(actorOf(c), c.req.param('name')))
  })

  // RFC-177: resolve a workgroup by its stable id → current name, so a task's
  // frozen `workgroupId` subject link survives a rename (never opens a same-named
  // replacement). Two-segment path never collides with :name (arity-distinct).
  // Invisible/missing → identical 404 (D1); returns ONLY {name} (no live state).
  app.get('/api/workgroups/by-id/:id', async (c) => {
    const actor = actorOf(c)
    const group = await getWorkgroupById(deps.db, c.req.param('id'))
    if (group === null || !(await canViewResource(deps.db, actor, 'workgroup', group))) {
      throw new NotFoundError('workgroup-not-found', 'workgroup not found')
    }
    return c.json({ name: group.name })
  })

  app.post('/api/workgroups', async (c) => {
    const body = await safeJson(c.req.raw)
    const parsed = CreateWorkgroupSchema.safeParse(body)
    if (!parsed.success) {
      throw new ValidationError('workgroup-invalid', 'invalid workgroup payload', {
        issues: parsed.error.issues,
      })
    }
    const actor = actorOf(c)
    // RFC-223 (PR-1, Codex impl-gate P1-2): member reference ACL is enforced
    // INSIDE createWorkgroup, bound to the same single resolution that produces
    // the persisted member agentIds (no check-then-resolve TOCTOU).
    const created = await createWorkgroup(deps.db, parsed.data, {
      ownerUserId: actor.user.id,
      actor,
    })
    return c.json(created, 201)
  })

  app.put('/api/workgroups/:name', async (c) => {
    const name = c.req.param('name')
    const body = await safeJson(c.req.raw)
    const parsed = UpdateWorkgroupSchema.safeParse(body)
    if (!parsed.success) {
      throw new ValidationError('workgroup-invalid', 'invalid workgroup payload', {
        issues: parsed.error.issues,
      })
    }
    const actor = actorOf(c)
    const existing = await loadVisibleWorkgroup(actor, name)
    await requireResourceOwner(deps.db, actor, 'workgroup', existing)
    return c.json(await saveWorkgroup(deps.db, existing.id, parsed.data, { kind: 'actor', actor }))
  })

  app.delete('/api/workgroups/:name', async (c) => {
    const name = c.req.param('name')
    const actor = actorOf(c)
    const existing = await loadVisibleWorkgroup(actor, name)
    await requireResourceOwner(deps.db, actor, 'workgroup', existing)
    const parsed = DeleteWorkgroupSchema.safeParse(await safeJson(c.req.raw))
    if (!parsed.success) {
      throw new ValidationError('workgroup-invalid', 'invalid workgroup delete payload', {
        issues: parsed.error.issues,
      })
    }
    // RFC-222 (D5): type-to-confirm (N-5 order).
    assertDeleteConfirm(parsed.data, existing.name, 'workgroup')
    await deleteWorkgroup(deps.db, existing.id, parsed.data, { kind: 'actor', actor })
    return c.body(null, 204)
  })

  app.post('/api/workgroups/:name/rename', async (c) => {
    const name = c.req.param('name')
    const body = await safeJson(c.req.raw)
    const parsed = RenameWorkgroupSchema.safeParse(body)
    if (!parsed.success) {
      throw new ValidationError('workgroup-rename-invalid', 'invalid rename payload', {
        issues: parsed.error.issues,
      })
    }
    const actor = actorOf(c)
    const existing = await loadVisibleWorkgroup(actor, name)
    await requireResourceOwner(deps.db, actor, 'workgroup', existing)
    return c.json(
      await renameWorkgroup(deps.db, existing.id, parsed.data, {
        kind: 'actor',
        actor,
      }),
    )
  })

  // RFC-164 PR-3 — launch a workgroup task. Service-layer entry (the builtin
  // host workflow would 403 assertWorkflowLaunchable by design); the group
  // itself is the launch permission surface (view ⇒ launch, RFC-099 D3).
  app.post('/api/workgroups/:name/tasks', async (c) => {
    const name = c.req.param('name')
    const body = await safeJson(c.req.raw)
    // RFC-165 实现门 P2 修复：即便本 schema 从未声明退役键，非 strict parse
    // 仍会把 {scratch:true, repoPath} 静默剥键降级成 scratch 启动（F1
    // silent-degrade 同型）——四个 launch 入口一致挂 raw-key 拒收。
    const retired = rejectRetiredStartTaskKeys(body)
    if (retired !== null) {
      throw new ValidationError(
        'start-task-path-retired',
        `field '${retired}' was retired by RFC-165 — launch with repoUrl/repos (file:// for local repos) or scratch`,
      )
    }
    const parsed = StartWorkgroupTaskSchema.safeParse(body)
    if (!parsed.success) {
      throw new ValidationError('workgroup-launch-invalid', 'invalid workgroup launch payload', {
        issues: parsed.error.issues,
      })
    }
    const actor = actorOf(c)
    const opencodeCmd = resolveOpencodeCmd(deps.configPath)
    const task = await startWorkgroupTask(
      deps.db,
      actor,
      name,
      parsed.data,
      buildStartTaskDeps(deps.db, deps.configPath, actor.user.id, opencodeCmd),
    )
    return c.json(task, 201)
  })

  // RFC-099 — GET/PUT /api/workgroups/:name/acl
  mountAclEndpoints(app, deps, {
    type: 'workgroup',
    base: '/api/workgroups',
    param: 'name',
    load: (db, name) => getWorkgroup(db, name),
  })
}

async function safeJson(req: Request): Promise<unknown> {
  try {
    return await req.json()
  } catch {
    return {}
  }
}
