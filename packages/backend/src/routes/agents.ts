// GET    /api/agents             — list
// GET    /api/agents/:name       — one
// POST   /api/agents             — create
// PUT    /api/agents/:name       — update (any subset of fields)
// DELETE /api/agents/:name       — delete (refuses if referenced)
// POST   /api/agents/:name/rename — rename (refuses if referenced or name taken)

import {
  AgentNameSchema,
  CreateAgentSchema,
  rejectRetiredStartTaskKeys,
  RenameAgentSchema,
  StartAgentTaskSchema,
  UpdateAgentSchema,
} from '@agent-workflow/shared'
import { z } from 'zod'
import type { Hono } from 'hono'
import { actorOf, type Actor } from '@/auth/actor'
import type { AppDeps } from '@/server'
import {
  createAgent,
  deleteAgent,
  getAgent,
  getAgentById,
  listAgents,
  renameAgent,
  updateAgent,
} from '@/services/agent'
import { resolveDependsClosure, validateDependsOn } from '@/services/agentDeps'
import { canViewResource, filterVisibleRows, requireResourceOwner } from '@/services/resourceAcl'
import { assertNotBuiltin, excludeBuiltinAgents, isBuiltinRow } from '@/services/systemResources'
import { assertNewRefsUsable, diffNewNames } from '@/services/resourceRefs'
import { startAgentTask } from '@/services/agentLaunch'
import {
  parseMultipartLaunch,
  resolveUploadLimits,
  type MultipartFilePart,
} from '@/services/launchMultipart'
import type { UploadLimits } from '@/services/upload'
import { buildStartTaskDeps } from '@/services/startTaskDeps'
import { resolveOpencodeCmd } from '@/util/opencode'
import { mountAclEndpoints } from './resourceAcl'
import { DomainError, NotFoundError, ValidationError } from '@/util/errors'
import type { Agent } from '@agent-workflow/shared'

/**
 * RFC-117: true iff the raw PUT body sets ONLY `runtime` (no other key). Lets the
 * built-in commit/merger agents (aw-skill-merger) be re-pointed at a runtime
 * profile while every OTHER built-in field stays locked (RFC-104) — "select a
 * runtime" parity with user agents, without un-hiding the infra agent from the
 * /agents list (it's reached by name from a settings picker). Keyed off the raw
 * body (not the parsed patch) so a future schema default can't widen the
 * exemption beyond a literal runtime-only request.
 */
function isRuntimeOnlyAgentPatch(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false
  const keys = Object.keys(body)
  return keys.length === 1 && keys[0] === 'runtime'
}

export function mountAgentRoutes(app: Hono, deps: AppDeps): void {
  // RFC-099: load-or-404 that treats "missing" and "not visible" identically
  // (same code + message) so existence never leaks to non-granted users.
  async function loadVisibleAgent(actor: Actor, name: string) {
    const agent = await getAgent(deps.db, name)
    if (agent === null || !(await canViewResource(deps.db, actor, 'agent', agent))) {
      throw new NotFoundError('agent-not-found', `agent '${name}' not found`)
    }
    return agent
  }

  app.get('/api/agents', async (c) => {
    // Hide framework built-ins (RFC-101 aw-skill-merger): infrastructure, never
    // a user-managed list row. Discriminator = reserved name AND __system__
    // owner (see systemResources.ts) — neither half alone is safe.
    const list = excludeBuiltinAgents(await listAgents(deps.db))
    return c.json(await filterVisibleRows(deps.db, actorOf(c), 'agent', list))
  })

  app.get('/api/agents/:name', async (c) => {
    const agent = await loadVisibleAgent(actorOf(c), c.req.param('name'))
    return c.json(agent)
  })

  // RFC-177: resolve an agent by its stable id → current name, so a task's frozen
  // `sourceAgentId` subject link survives a rename/reuse of the name (never opens a
  // same-named replacement). Two-segment path never collides with :name
  // (arity-distinct). Invisible/missing → identical 404; returns ONLY {name}.
  app.get('/api/agents/by-id/:id', async (c) => {
    const actor = actorOf(c)
    const agent = await getAgentById(deps.db, c.req.param('id'))
    if (agent === null || !(await canViewResource(deps.db, actor, 'agent', agent))) {
      throw new NotFoundError('agent-not-found', 'agent not found')
    }
    return c.json({ name: agent.name })
  })

  app.post('/api/agents', async (c) => {
    const body = await safeJson(c.req.raw)
    const parsed = CreateAgentSchema.safeParse(body)
    if (!parsed.success) {
      throw new ValidationError('agent-invalid', 'invalid agent payload', {
        issues: parsed.error.issues,
      })
    }
    const actor = actorOf(c)
    // RFC-099 (D15): on create, every reference is new — reject names that
    // resolve to resources the editor cannot view.
    await assertNewRefsUsable(deps.db, actor, [
      { type: 'skill', names: parsed.data.skills },
      { type: 'mcp', names: parsed.data.mcp },
      { type: 'plugin', names: parsed.data.plugins ?? [] },
      { type: 'agent', names: parsed.data.dependsOn },
    ])
    const created = await createAgent(deps.db, parsed.data, { ownerUserId: actor.user.id })
    return c.json(created, 201)
  })

  app.put('/api/agents/:name', async (c) => {
    const name = c.req.param('name')
    const body = await safeJson(c.req.raw)
    const parsed = UpdateAgentSchema.safeParse(body)
    if (!parsed.success) {
      throw new ValidationError('agent-invalid', 'invalid agent patch', {
        issues: parsed.error.issues,
      })
    }
    const actor = actorOf(c)
    const existing = await loadVisibleAgent(actor, name)
    // RFC-117: built-in framework agents (aw-skill-merger) stay read-only EXCEPT a
    // runtime-ONLY patch — an admin may point fusion's merger at a runtime profile
    // (the "select a runtime" parity user agents have). Any other field, or a mixed
    // patch, on a built-in is still rejected (RFC-104). requireResourceOwner below
    // still gates it (built-ins are SYSTEM-owned → admin only).
    if (!(isBuiltinRow(existing) && isRuntimeOnlyAgentPatch(body))) {
      assertNotBuiltin('agent', existing) // RFC-104: built-ins are read-only
    }
    await requireResourceOwner(deps.db, actor, 'agent', existing)
    // RFC-099 (D15): only NEWLY-added references are usability-checked.
    await assertNewRefsUsable(deps.db, actor, [
      ...(parsed.data.skills !== undefined
        ? [
            {
              type: 'skill' as const,
              names: diffNewNames(new Set(existing.skills), new Set(parsed.data.skills)),
            },
          ]
        : []),
      ...(parsed.data.mcp !== undefined
        ? [
            {
              type: 'mcp' as const,
              names: diffNewNames(new Set(existing.mcp), new Set(parsed.data.mcp)),
            },
          ]
        : []),
      ...(parsed.data.plugins !== undefined
        ? [
            {
              type: 'plugin' as const,
              names: diffNewNames(new Set(existing.plugins), new Set(parsed.data.plugins)),
            },
          ]
        : []),
      ...(parsed.data.dependsOn !== undefined
        ? [
            {
              type: 'agent' as const,
              names: diffNewNames(new Set(existing.dependsOn), new Set(parsed.data.dependsOn)),
            },
          ]
        : []),
    ])
    const updated = await updateAgent(deps.db, name, parsed.data)
    return c.json(updated)
  })

  app.delete('/api/agents/:name', async (c) => {
    const name = c.req.param('name')
    const actor = actorOf(c)
    const existing = await loadVisibleAgent(actor, name)
    assertNotBuiltin('agent', existing) // RFC-104: built-ins are read-only
    await requireResourceOwner(deps.db, actor, 'agent', existing)
    await deleteAgent(deps.db, name, actor)
    return c.body(null, 204)
  })

  // RFC-165 §4 — launch a SINGLE-AGENT task (POST /api/agents/:name/tasks).
  // Service-layer entry (the builtin __agent_host__ workflow would 403
  // assertWorkflowLaunchable via /api/tasks by design); permission-wise this
  // is a LAUNCH, gated by tasks:launch in server.ts (F15) — deliberately
  // exempt from the agents:write method gate. The schema only ever declared
  // modern space fields, so no raw-key gate is needed (workgroup precedent).
  app.post('/api/agents/:name/tasks', async (c) => {
    const name = c.req.param('name')
    // RFC-218: path<ext> input ports bind files via multipart — same parser
    // family as POST /api/tasks (services/launchMultipart). JSON stays the
    // only shape for text-port / zero-port launches.
    const ct = c.req.header('content-type') ?? ''
    let body: unknown
    let uploads: { parts: MultipartFilePart[]; limits: UploadLimits } | undefined
    if (ct.toLowerCase().startsWith('multipart/form-data')) {
      const parsedForm = await parseMultipartLaunch(c.req.raw)
      body = parsedForm.payloadJson
      uploads = { parts: parsedForm.parts, limits: resolveUploadLimits(deps.configPath) }
    } else {
      try {
        body = await c.req.raw.json()
      } catch {
        body = {}
      }
    }
    // 实现门 P2 修复（F1 同型）：schema 非 strict，{scratch:true, repoPath}
    // 会被静默剥键降级成 scratch 启动——退役键必须在 parse 前整体拒收。
    const retired = rejectRetiredStartTaskKeys(body)
    if (retired !== null) {
      throw new ValidationError(
        'start-task-path-retired',
        `field '${retired}' was retired by RFC-165 — launch with repoUrl/repos (file:// for local repos) or scratch`,
      )
    }
    const parsed = StartAgentTaskSchema.safeParse(body)
    if (!parsed.success) {
      throw new ValidationError('agent-launch-invalid', 'invalid agent launch payload', {
        issues: parsed.error.issues,
      })
    }
    const actor = actorOf(c)
    const opencodeCmd = resolveOpencodeCmd(deps.configPath)
    const task = await startAgentTask(
      deps.db,
      actor,
      name,
      parsed.data,
      buildStartTaskDeps(deps.db, deps.configPath, actor.user.id, opencodeCmd, deps.secretBox),
      uploads,
    )
    return c.json(task, 201)
  })

  app.post('/api/agents/:name/rename', async (c) => {
    const name = c.req.param('name')
    const body = await safeJson(c.req.raw)
    const parsed = RenameAgentSchema.safeParse(body)
    if (!parsed.success) {
      throw new ValidationError('agent-rename-invalid', 'invalid rename payload', {
        issues: parsed.error.issues,
      })
    }
    const actor = actorOf(c)
    const existing = await loadVisibleAgent(actor, name)
    assertNotBuiltin('agent', existing) // RFC-104: built-ins are read-only
    await requireResourceOwner(deps.db, actor, 'agent', existing)
    const renamed = await renameAgent(deps.db, name, parsed.data, actor)
    return c.json(renamed)
  })

  // RFC-022: closure read-only endpoint. Returns the BFS-ordered agent list
  // for the named agent's dependsOn closure (root first). Missing closure
  // members surface as `{ name, missing: true }` placeholders so the UI can
  // render `<missing> name` rather than silently shrinking the tree.
  app.get('/api/agents/:name/closure', async (c) => {
    const name = c.req.param('name')
    const actor = actorOf(c)
    const root = await loadVisibleAgent(actor, name)
    const closure = await resolveDependsClosure(deps.db, root, { allowMissing: true })
    // `allowMissing: true` never produces ok:false (cycles only arise when a
    // name appears on the active path — which agent.ts save guard prevents),
    // but defensively handle the type anyway.
    if (closure.ok === false) {
      return c.json({
        ok: false,
        code: 'agent-dependency-cycle',
        cyclePath: closure.cyclePath,
      })
    }
    // RFC-099: closure members the viewer cannot see keep their NAME (it
    // already appears in a visible agent's dependsOn) but mask everything
    // else, mirroring the "无权限占位" reference-site rule.
    const summaries = toAgentClosureSummaries(closure.agents, root)
    const memberRows = new Map(closure.agents.map((a) => [a.name, a]))
    const visible = await filterVisibleRows(deps.db, actor, 'agent', closure.agents)
    const visibleNames = new Set(visible.map((a) => a.name))
    const masked = summaries.map((s) => {
      if (s.missing || visibleNames.has(s.name) || !memberRows.has(s.name)) return s
      return {
        ...s,
        description: '',
        skills: [],
        skillCount: 0,
        dependsOn: [],
        mcp: [],
        plugins: [],
      }
    })
    return c.json({ ok: true, agents: masked })
  })

  // RFC-022: preview endpoint used by AgentForm while editing. Returns
  // HTTP 200 with `ok: false` on validation errors (instead of a 4xx)
  // because every keystroke would otherwise flash red in the browser's
  // network panel. Save-time POST/PUT keep their 400 path.
  const ClosurePreviewBodySchema = z.object({
    name: AgentNameSchema,
    dependsOn: z.array(AgentNameSchema).max(64).default([]),
  })
  app.post('/api/agents/closure-preview', async (c) => {
    const body = await safeJson(c.req.raw)
    const parsed = ClosurePreviewBodySchema.safeParse(body)
    if (!parsed.success) {
      return c.json({
        ok: false,
        code: 'agent-closure-preview-invalid',
        details: { issues: parsed.error.issues },
      })
    }
    try {
      await validateDependsOn(deps.db, parsed.data.name, parsed.data.dependsOn)
    } catch (err) {
      if (err instanceof DomainError) {
        return c.json({ ok: false, code: err.code, details: err.details })
      }
      throw err
    }
    // Build a synthetic root agent for closure expansion (selfName may not
    // exist in DB yet — new-agent flow). validateDependsOn already vetted
    // names exist + no cycle, so allowMissing:false is safe here.
    const existing = await getAgent(deps.db, parsed.data.name)
    const syntheticRoot: Agent = existing
      ? { ...existing, dependsOn: parsed.data.dependsOn }
      : ({
          id: '',
          name: parsed.data.name,
          description: '',
          outputs: [],
          inputs: [], // RFC-166
          syncOutputsOnIterate: true,
          permission: {},
          skills: [],
          dependsOn: parsed.data.dependsOn,
          mcp: [],
          plugins: [],
          frontmatterExtra: {},
          bodyMd: '',
          schemaVersion: 1,
          createdAt: 0,
          updatedAt: 0,
        } satisfies Agent)
    const closure = await resolveDependsClosure(deps.db, syntheticRoot, { allowMissing: false })
    if (closure.ok === false) {
      // Shouldn't happen — validateDependsOn already screened cycles — but
      // surface defensively so a race doesn't 500.
      return c.json({
        ok: false,
        code: 'agent-dependency-cycle',
        details: { cyclePath: closure.cyclePath },
      })
    }
    return c.json({
      ok: true,
      agents: toAgentClosureSummaries(closure.agents, syntheticRoot),
    })
  })

  // RFC-099 — GET/PUT /api/agents/:name/acl
  mountAclEndpoints(app, deps, {
    type: 'agent',
    base: '/api/agents',
    param: 'name',
    load: (db, name) => getAgent(db, name),
  })
}

/**
 * RFC-022 closure response shape — minimal projection over `Agent` that the
 * `<DependencyTree>` renderer needs. `skillCount` is computed from
 * `agent.skills.length`; dependency-missing names appear as placeholder
 * rows so the UI can still render them under their parent.
 */
function toAgentClosureSummaries(
  closure: Agent[],
  root: Agent,
): Array<{
  name: string
  description: string
  /**
   * Skill names this agent itself references. The DependencyTree UI shows
   * them as a chip (only when non-empty) so users can audit which closure
   * members contribute which skills. `skillCount` is preserved for
   * backwards compatibility but `skills` is the source of truth.
   */
  skills: string[]
  skillCount: number
  dependsOn: string[]
  /**
   * RFC-028: include this agent's mcp[] in the closure summary so the
   * NodeDetailDrawer Stats tab can render the inline-injected MCP union
   * without an extra round-trip. Empty array for pre-RFC-028 agents.
   */
  mcp: string[]
  /**
   * RFC-031: include this agent's plugins[] in the closure summary so the
   * Stats tab can render the inline-injected plugin union without an extra
   * round-trip. Empty array for pre-RFC-031 agents.
   */
  plugins: string[]
  missing: boolean
}> {
  const out: Array<{
    name: string
    description: string
    skills: string[]
    skillCount: number
    dependsOn: string[]
    mcp: string[]
    plugins: string[]
    missing: boolean
  }> = closure.map((a) => ({
    name: a.name,
    description: a.description,
    skills: a.skills,
    skillCount: a.skills.length,
    dependsOn: a.dependsOn,
    mcp: a.mcp ?? [],
    plugins: a.plugins ?? [],
    missing: false,
  }))
  // Append placeholder rows for names referenced by any closure member but
  // not present in the resolved list. Without this the UI can't show
  // `<missing>` rows under their parents — buildDependencyTree on the
  // frontend treats absent names as missing leaves anyway, but appending
  // them here keeps the wire shape symmetric.
  const present = new Set(closure.map((a) => a.name))
  const missing = new Set<string>()
  for (const a of closure) {
    for (const dep of a.dependsOn) {
      if (!present.has(dep)) missing.add(dep)
    }
  }
  for (const name of missing) {
    out.push({
      name,
      description: '',
      skills: [],
      skillCount: 0,
      dependsOn: [],
      mcp: [],
      plugins: [],
      missing: true,
    })
  }
  // root reference kept for future use (rendering hint); silence unused lint.
  void root
  return out
}

async function safeJson(req: Request): Promise<unknown> {
  try {
    return await req.json()
  } catch {
    return {}
  }
}
