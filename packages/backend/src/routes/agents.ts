// GET    /api/agents             — list
// GET    /api/agents/:id         — one
// POST   /api/agents             — create
// PUT    /api/agents/:id         — update (any subset of fields)
// DELETE /api/agents/:id         — delete (refuses if referenced)
// POST   /api/agents/:id/rename  — display-name change (refuses name collision)

import {
  type AgentClosureSummary,
  AgentNameSchema,
  CreateAgentSchema,
  rejectRetiredStartTaskKeys,
  RenameAgentSchema,
  ResourceRefSchema,
  StartAgentTaskSchema,
  UpdateAgentSchema,
} from '@agent-workflow/shared'
import { z } from 'zod'
import type { Hono } from 'hono'
import { actorOf, SYSTEM_USER_ID, type Actor } from '@/auth/actor'
import type { AppDeps } from '@/server'
import {
  createAgent,
  deleteAgent,
  getAgentById,
  listAgents,
  renameAgent,
  updateAgent,
} from '@/services/agent'
import { resolveDependsClosure, validateDependsOn } from '@/services/agentDeps'
import { resolveRefsUsableById } from '@/services/resourceRefs'
import { assertDeleteConfirm, readDeleteBody } from '@/services/deleteConfirm'
import { canViewResource, filterVisibleRows, requireResourceOwner } from '@/services/resourceAcl'
import {
  assertNotBuiltin,
  excludeBuiltinAgents,
  isBuiltinRow,
  SKILL_MERGER_AGENT_ID,
} from '@/services/systemResources'
import { mcps, plugins, skills } from '@/db/schema'
import { inArray } from 'drizzle-orm'
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
  async function loadVisibleAgent(actor: Actor, id: string) {
    const agent = await getAgentById(deps.db, id)
    if (agent === null || !(await canViewResource(deps.db, actor, 'agent', agent))) {
      throw new NotFoundError('agent-not-found', 'agent not found')
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

  // Stable semantic seam for the hidden Settings resource. PR4 seeds and
  // repairs this exact id; never fall back to its mutable display name.
  app.get('/api/agents/builtins/skill-merger', async (c) => {
    const agent = await getAgentById(deps.db, SKILL_MERGER_AGENT_ID)
    if (
      agent === null ||
      agent.id !== SKILL_MERGER_AGENT_ID ||
      agent.builtin !== true ||
      agent.ownerUserId !== SYSTEM_USER_ID ||
      !(await canViewResource(deps.db, actorOf(c), 'agent', agent))
    ) {
      throw new NotFoundError('agent-not-found', 'agent not found')
    }
    return c.json(agent)
  })

  app.get('/api/agents/:id', async (c) => {
    const agent = await loadVisibleAgent(actorOf(c), c.req.param('id'))
    return c.json(agent)
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
    // RFC-099 (D15) / RFC-223 (PR-1, Codex impl-gate P1-2): reference ACL is
    // enforced INSIDE createAgent, bound to the same single resolution that
    // produces the persisted ids (no check-then-resolve TOCTOU). On create every
    // reference is new.
    const created = await createAgent(deps.db, parsed.data, {
      ownerUserId: actor.user.id,
      actor,
    })
    return c.json(created, 201)
  })

  app.put('/api/agents/:id', async (c) => {
    const id = c.req.param('id')
    const body = await safeJson(c.req.raw)
    const parsed = UpdateAgentSchema.safeParse(body)
    if (!parsed.success) {
      throw new ValidationError('agent-invalid', 'invalid agent patch', {
        issues: parsed.error.issues,
      })
    }
    const actor = actorOf(c)
    const existing = await loadVisibleAgent(actor, id)
    // RFC-117: built-in framework agents (aw-skill-merger) stay read-only EXCEPT a
    // runtime-ONLY patch — an admin may point fusion's merger at a runtime profile
    // (the "select a runtime" parity user agents have). Any other field, or a mixed
    // patch, on a built-in is still rejected (RFC-104). requireResourceOwner below
    // still gates it (built-ins are SYSTEM-owned → admin only).
    if (!(isBuiltinRow(existing) && isRuntimeOnlyAgentPatch(body))) {
      assertNotBuiltin('agent', existing) // RFC-104: built-ins are read-only
    }
    await requireResourceOwner(deps.db, actor, 'agent', existing)
    // RFC-099 (D15) / RFC-223 (PR-1, Codex impl-gate P1-2): reference ACL is
    // enforced INSIDE updateAgent, bound to the same single resolution that
    // produces the persisted ids. Only NEWLY-added references (diffed by RESOLVED
    // ID, not raw token) are checked — a grandfathered ref re-submitted by name is
    // not mis-flagged as new.
    const updated = await updateAgent(deps.db, id, parsed.data, actor)
    return c.json(updated)
  })

  app.delete('/api/agents/:id', async (c) => {
    const id = c.req.param('id')
    const actor = actorOf(c)
    const existing = await loadVisibleAgent(actor, id)
    assertNotBuiltin('agent', existing) // RFC-104: built-ins are read-only
    await requireResourceOwner(deps.db, actor, 'agent', existing)
    // RFC-222 (D5): type-to-confirm — echo the current name (N-5 order).
    assertDeleteConfirm(await readDeleteBody(c), existing.name, 'agent')
    await deleteAgent(deps.db, id, actor)
    return c.body(null, 204)
  })

  // RFC-165 §4 — launch a SINGLE-AGENT task (POST /api/agents/:id/tasks).
  // Service-layer entry (the builtin __agent_host__ workflow would 403
  // assertWorkflowLaunchable via /api/tasks by design); permission-wise this
  // is a LAUNCH, gated by tasks:launch in server.ts (F15) — deliberately
  // exempt from the agents:write method gate. The schema only ever declared
  // modern space fields, so no raw-key gate is needed (workgroup precedent).
  app.post('/api/agents/:id/tasks', async (c) => {
    const actor = actorOf(c)
    const existing = await loadVisibleAgent(actor, c.req.param('id'))
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
    const opencodeCmd = resolveOpencodeCmd(deps.configPath)
    const task = await startAgentTask(
      deps.db,
      actor,
      existing.id,
      parsed.data,
      buildStartTaskDeps(deps.db, deps.configPath, actor.user.id, opencodeCmd, deps.secretBox),
      uploads,
    )
    return c.json(task, 201)
  })

  app.post('/api/agents/:id/rename', async (c) => {
    const id = c.req.param('id')
    const body = await safeJson(c.req.raw)
    const parsed = RenameAgentSchema.safeParse(body)
    if (!parsed.success) {
      throw new ValidationError('agent-rename-invalid', 'invalid rename payload', {
        issues: parsed.error.issues,
      })
    }
    const actor = actorOf(c)
    const existing = await loadVisibleAgent(actor, id)
    assertNotBuiltin('agent', existing) // RFC-104: built-ins are read-only
    await requireResourceOwner(deps.db, actor, 'agent', existing)
    const renamed = await renameAgent(deps.db, id, parsed.data)
    return c.json(renamed)
  })

  // RFC-022: closure read-only endpoint. Returns the BFS-ordered agent list
  // for the named agent's dependsOn closure (root first). Missing closure
  // members surface as `{ name, masked, missing }` placeholders so the UI can
  // distinguish ACL-hidden rows from deleted references.
  app.get('/api/agents/:id/closure', async (c) => {
    const actor = actorOf(c)
    const root = await loadVisibleAgent(actor, c.req.param('id'))
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
    // RFC-099 / RFC-223 (PR-1, Codex impl-gate P2-1 + P2-2): project stored id
    // refs to display NAMES (skills/mcp/plugins/dependsOn — never raw ULIDs in the
    // UI), and mask closure members the viewer cannot see. A masked member no
    // longer discloses its NAME: its display identity collapses to its opaque id
    // (and other agents' dependsOn projections keep that id opaque too), so a
    // private dependency's name never leaks (D1 — mirrors the "无权限占位" rule).
    const visible = await filterVisibleRows(deps.db, actor, 'agent', closure.agents)
    const visibleAgentIds = new Set(visible.map((a) => a.id))
    const names = await loadClosureRefNames(deps.db, actor, closure.agents, visibleAgentIds)
    const masked = toAgentClosureSummaries(closure.agents, {
      names,
      visibleAgentIds,
    })
    return c.json({ ok: true, agents: masked })
  })

  // RFC-022: preview endpoint used by AgentForm while editing. Returns
  // HTTP 200 with `ok: false` on validation errors (instead of a 4xx)
  // because every keystroke would otherwise flash red in the browser's
  // network panel. Save-time POST/PUT keep their 400 path.
  const ClosurePreviewBodySchema = z.object({
    /** Existing resource identity; absent for an unsaved create form. */
    id: z.string().min(1).optional(),
    name: AgentNameSchema,
    // RFC-223 (PR-1): the edit form's dependsOn holds ids (the picker stores
    // ids). Accept id-or-name refs, not the name grammar.
    dependsOn: z.array(ResourceRefSchema).max(64).default([]),
  })
  app.post('/api/agents/closure-preview', async (c) => {
    const actor = actorOf(c)
    const body = await safeJson(c.req.raw)
    const parsed = ClosurePreviewBodySchema.safeParse(body)
    if (!parsed.success) {
      return c.json({
        ok: false,
        code: 'agent-closure-preview-invalid',
        details: { issues: parsed.error.issues },
      })
    }
    // The closure guard is keyed by the existing agent's immutable id. A new
    // draft has no id and stays synthetic; mutable name is display-only.
    const resolved = await resolveRefsUsableById(deps.db, actor, 'agent', parsed.data.dependsOn)
    if (resolved.missing.length > 0) {
      return c.json({
        ok: false,
        code: 'acl-missing-refs',
        details: { missing: resolved.missing },
      })
    }
    const dependsOn = resolved.ids
    const existing =
      parsed.data.id === undefined ? null : await loadVisibleAgent(actor, parsed.data.id)
    const selfId = existing?.id ?? ''
    try {
      await validateDependsOn(deps.db, selfId, dependsOn, parsed.data.name)
    } catch (err) {
      if (err instanceof DomainError) {
        return c.json({ ok: false, code: err.code, details: err.details })
      }
      throw err
    }
    // Build a synthetic root agent for closure expansion (self may not exist in
    // DB yet — new-agent flow). validateDependsOn already vetted ids exist + no
    // cycle, so allowMissing:false is safe here.
    const syntheticRoot: Agent = existing
      ? { ...existing, dependsOn }
      : ({
          id: selfId,
          name: parsed.data.name,
          description: '',
          outputs: [],
          inputs: [], // RFC-166
          syncOutputsOnIterate: true,
          permission: {},
          skills: [],
          dependsOn,
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
    const visible = await filterVisibleRows(deps.db, actor, 'agent', closure.agents)
    const visibleAgentIds = new Set(visible.map((a) => a.id))
    return c.json({
      ok: true,
      agents: toAgentClosureSummaries(closure.agents, {
        names: await loadClosureRefNames(deps.db, actor, closure.agents, visibleAgentIds),
        visibleAgentIds,
      }),
    })
  })

  // RFC-099 / RFC-223 — GET/PUT /api/agents/:id/acl
  mountAclEndpoints(app, deps, {
    type: 'agent',
    base: '/api/agents',
    param: 'id',
    load: (db, id) => getAgentById(db, id),
  })
}

interface ClosureRefNameMaps {
  skill: Map<string, string>
  mcp: Map<string, string>
  plugin: Map<string, string>
}

/**
 * RFC-223 (PR-1, Codex impl-gate P2-1): load display NAMES for the managed
 * skill / mcp / plugin IDS referenced anywhere in the closure, so the wire
 * projection shows names, not raw ULIDs. Unresolvable ids (deleted out-of-band)
 * fall back to the id (best-effort, never silently dropped).
 */
async function loadClosureRefNames(
  db: AppDeps['db'],
  actor: Actor,
  closure: Agent[],
  visibleAgentIds: ReadonlySet<string>,
): Promise<ClosureRefNameMaps> {
  const skillIds = new Set<string>()
  const mcpIds = new Set<string>()
  const pluginIds = new Set<string>()
  for (const a of closure) {
    if (!visibleAgentIds.has(a.id)) continue
    for (const ref of a.skills) if (ref.kind === 'managed') skillIds.add(ref.skillId)
    for (const id of a.mcp ?? []) mcpIds.add(id)
    for (const id of a.plugins ?? []) pluginIds.add(id)
  }
  const [skillRows, mcpRows, pluginRows] = await Promise.all([
    skillIds.size > 0
      ? db
          .select({
            id: skills.id,
            name: skills.name,
            ownerUserId: skills.ownerUserId,
            visibility: skills.visibility,
          })
          .from(skills)
          .where(inArray(skills.id, [...skillIds]))
      : Promise.resolve([]),
    mcpIds.size > 0
      ? db
          .select({
            id: mcps.id,
            name: mcps.name,
            ownerUserId: mcps.ownerUserId,
            visibility: mcps.visibility,
          })
          .from(mcps)
          .where(inArray(mcps.id, [...mcpIds]))
      : Promise.resolve([]),
    pluginIds.size > 0
      ? db
          .select({
            id: plugins.id,
            name: plugins.name,
            ownerUserId: plugins.ownerUserId,
            visibility: plugins.visibility,
          })
          .from(plugins)
          .where(inArray(plugins.id, [...pluginIds]))
      : Promise.resolve([]),
  ])
  const [visibleSkills, visibleMcps, visiblePlugins] = await Promise.all([
    filterVisibleRows(db, actor, 'skill', skillRows),
    filterVisibleRows(db, actor, 'mcp', mcpRows),
    filterVisibleRows(db, actor, 'plugin', pluginRows),
  ])
  return {
    skill: new Map(visibleSkills.map((r) => [r.id, r.name])),
    mcp: new Map(visibleMcps.map((r) => [r.id, r.name])),
    plugin: new Map(visiblePlugins.map((r) => [r.id, r.name])),
  }
}

/**
 * RFC-022 closure response shape — minimal projection over `Agent` that the
 * `<DependencyTree>` renderer needs. `skillCount` is computed from
 * `agent.skills.length`; dependency-missing names appear as placeholder rows.
 *
 * RFC-223: skill/MCP/plugin ids are projected to display names via
 * `opts.names`; dependency edges stay in `dependsOnIds`. When
 * `opts.visibleAgentIds` is supplied (the GET closure endpoint), members the
 * viewer cannot see are masked — their display identity collapses to their
 * opaque id, owner is hidden, and their other fields are blanked (D1).
 */
function toAgentClosureSummaries(
  closure: Agent[],
  opts: { names: ClosureRefNameMaps; visibleAgentIds?: ReadonlySet<string> },
): AgentClosureSummary[] {
  const { names, visibleAgentIds } = opts
  const isVisible = (id: string): boolean =>
    visibleAgentIds === undefined || visibleAgentIds.has(id)
  const closureIds = new Set(closure.map((a) => a.id))
  const skillName = (ref: Agent['skills'][number]): string =>
    ref.kind === 'managed' ? (names.skill.get(ref.skillId) ?? ref.skillId) : ref.name

  const out: AgentClosureSummary[] = []
  for (const a of closure) {
    if (!isVisible(a.id)) {
      // Masked: opaque id as identity, everything else blanked.
      out.push({
        id: a.id,
        name: a.id,
        ownerUserId: null,
        description: '',
        skills: [],
        skillCount: 0,
        dependsOnIds: [],
        mcp: [],
        plugins: [],
        masked: true,
        missing: false,
      })
      continue
    }
    out.push({
      id: a.id,
      name: a.name,
      ownerUserId: a.ownerUserId ?? null,
      description: a.description,
      skills: a.skills.map(skillName),
      skillCount: a.skills.length,
      dependsOnIds: a.dependsOn,
      mcp: (a.mcp ?? []).map((id) => names.mcp.get(id) ?? id),
      plugins: (a.plugins ?? []).map((id) => names.plugin.get(id) ?? id),
      masked: false,
      missing: false,
    })
  }
  // Append placeholder rows for dependency IDS referenced by any closure member
  // but not present in the resolved list (dangling / removed). A missing member's
  // name is unknown, so its id stands in as the placeholder identity.
  const missing = new Set<string>()
  for (const a of closure) {
    if (!isVisible(a.id)) continue
    for (const depId of a.dependsOn) {
      if (!closureIds.has(depId)) missing.add(depId)
    }
  }
  for (const id of missing) {
    out.push({
      id,
      name: id,
      ownerUserId: null,
      description: '',
      skills: [],
      skillCount: 0,
      dependsOnIds: [],
      mcp: [],
      plugins: [],
      masked: false,
      missing: true,
    })
  }
  return out
}

async function safeJson(req: Request): Promise<unknown> {
  try {
    return await req.json()
  } catch {
    return {}
  }
}
