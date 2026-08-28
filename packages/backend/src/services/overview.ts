// RFC-190 — GET /api/overview assembly: per-actor-visible counts of platform
// resources + a 7-day task window, for the homepage capability portal.
//
// Count semantics are LOCKED to the corresponding list endpoints: the six
// ACL'd kinds reuse the exact list-service + filterVisibleRows pipeline the
// list routes use (resourceAcl.ts documents the full-table convention), so
// overview numbers can never drift from what the actor sees on the list
// pages. The oracle test (tests/rfc190-overview-route.test.ts) asserts that
// equality per actor. repos is the one exception — cardinality via
// countCachedRepos (listCachedRepos does a per-repo 1+N task count).
//
// per-key null = the actor lacks the coarse `<res>:read` permission the list
// route is gated by (server.ts gate block). tasks truth table (mirrors
// routes/tasks.ts scope decision): read:all → unscoped; read:own →
// owner∨collaborator; neither → null.

import { isNull, and, count, eq, gte, inArray, or, type SQL } from 'drizzle-orm'
import type { SQLiteTable } from 'drizzle-orm/sqlite-core'
import type {
  AclResourceType,
  OverviewResponse,
  OverviewTasks,
  Permission,
} from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import {
  agents as agentsTable,
  mcps as mcpsTable,
  plugins as pluginsTable,
  resourceGrants,
  scheduledTasks,
  skills as skillsTable,
  tasks,
  workflows as workflowsTable,
  workgroups as workgroupsTable,
} from '@/db/schema'
import { countCachedRepos } from '@/services/gitRepoCache'
import { filterMemoriesByScopeVisibility, listMemories } from '@/services/memory'
import { visibleRowsCondition, type AclColumnRef } from '@/services/resourceAcl'
import { taskVisibilityCondition } from '@/services/task'
import { createInFlightCoalescer, type InFlightCoalescer } from '@/util/inFlight'

const WINDOW_7D_MS = 7 * 86_400_000

const overviewFlights = new WeakMap<object, InFlightCoalescer<string, OverviewResponse>>()

function overviewFlight(db: DbClient): InFlightCoalescer<string, OverviewResponse> {
  const owner = db as unknown as object
  const existing = overviewFlights.get(owner)
  if (existing !== undefined) return existing
  const created = createInFlightCoalescer<string, OverviewResponse>()
  overviewFlights.set(owner, created)
  return created
}

function overviewFlightKey(actor: Actor): string {
  return JSON.stringify([
    actor.user.id,
    actor.source,
    actor.authorityRevision ?? 0,
    [...actor.permissions].sort(),
  ])
}

/** null when the actor lacks the coarse read permission (D2); lazy load otherwise. */
async function gatedCount(
  actor: Actor,
  perm: Permission,
  load: () => Promise<number>,
): Promise<number | null> {
  if (!actor.permissions.has(perm)) return null
  return await load()
}

/**
 * RFC-311 — the six ACL'd resource counts as one indexed `count(*)` each,
 * replacing "materialize the full list (workflows carried every definition
 * JSON) and take `.length`" on a 60s × per-tab poll. Semantics stay LOCKED to
 * the list pipeline via `visibleRowsCondition` (the SQL twin of
 * `filterVisibleRows`) and the RFC-190 oracle test, which asserts per-actor
 * equality between these numbers and the actual list endpoints.
 */
async function countAclResource(
  db: DbClient,
  actor: Actor,
  type: AclResourceType,
  table: SQLiteTable,
  cols: AclColumnRef,
  extra?: SQL<unknown>,
): Promise<number> {
  const conditions: SQL<unknown>[] = []
  const visibility = visibleRowsCondition(db, actor, type, cols)
  if (visibility !== undefined) conditions.push(visibility)
  if (extra !== undefined) conditions.push(extra)
  const rows = await db
    .select({ n: count() })
    .from(table)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
  return rows[0]?.n ?? 0
}

async function buildTaskStats(
  db: DbClient,
  actor: Actor,
  cutoff: number,
): Promise<OverviewTasks | null> {
  const unscoped = actor.permissions.has('tasks:read:all')
  if (!unscoped && !actor.permissions.has('tasks:read:own')) return null
  const vis = unscoped
    ? undefined
    : taskVisibilityCondition(db, { actorUserId: actor.user.id, scope: 'mine' })
  const countWhere = async (cond: SQL<unknown>): Promise<number> => {
    // RFC-243 §8 — child executions stay out of the homepage cards (the parent
    // task represents its tree), matching the task list's top-level default.
    // The overview is also a public task-catalog projection. Keep the boundary
    // generic so every internal execution host is excluded uniformly.
    const topLevel = and(cond, isNull(tasks.parentTaskId), eq(tasks.catalogVisibility, 'public'))!
    const where = vis === undefined ? topLevel : and(vis, topLevel)!
    const r = await db.select({ n: count() }).from(tasks).where(where)
    return r[0]?.n ?? 0
  }
  const [running, awaiting, done7d, failed7d] = await Promise.all([
    countWhere(eq(tasks.status, 'running')),
    countWhere(inArray(tasks.status, ['awaiting_review', 'awaiting_human'])),
    // canceled / interrupted deliberately stay out of the 7d window (D11).
    countWhere(and(eq(tasks.status, 'done'), gte(tasks.finishedAt, cutoff))!),
    countWhere(and(eq(tasks.status, 'failed'), gte(tasks.finishedAt, cutoff))!),
  ])
  return { running, awaiting, done7d, failed7d }
}

/**
 * Pure read; `now` is injectable so the 7d cutoff and generatedAt come from
 * one clock capture and boundary tests are deterministic (D10).
 */
async function buildOverviewFresh(
  db: DbClient,
  actor: Actor,
  now: () => number = Date.now,
): Promise<OverviewResponse> {
  const t = now()
  const [
    agents,
    skills,
    mcps,
    plugins,
    workflows,
    workgroups,
    repos,
    scheduled,
    memories,
    taskStats,
  ] = await Promise.all([
    gatedCount(actor, 'agents:read', () =>
      countAclResource(
        db,
        actor,
        'agent',
        agentsTable,
        agentsTable,
        eq(agentsTable.builtin, false),
      ),
    ),
    gatedCount(actor, 'skills:read', () =>
      countAclResource(db, actor, 'skill', skillsTable, skillsTable),
    ),
    gatedCount(actor, 'mcps:read', () => countAclResource(db, actor, 'mcp', mcpsTable, mcpsTable)),
    gatedCount(actor, 'plugins:read', () =>
      countAclResource(db, actor, 'plugin', pluginsTable, pluginsTable),
    ),
    gatedCount(actor, 'workflows:read', () =>
      countAclResource(
        db,
        actor,
        'workflow',
        workflowsTable,
        workflowsTable,
        eq(workflowsTable.builtin, false),
      ),
    ),
    gatedCount(actor, 'workgroups:read', () =>
      countAclResource(db, actor, 'workgroup', workgroupsTable, workgroupsTable),
    ),
    gatedCount(actor, 'repos:read', () => countCachedRepos(db)),
    gatedCount(actor, 'scheduled-tasks:read', async () => {
      // resolveScheduleAccess ≡ bypass ∨ owner=me ∨ 任意档 grant ∨ tasks:read:all
      // （其 SYSTEM 分支是 owner=me 的子集），所以计数仍能下推成一条带索引的查询，
      // 不必把每行的 launch_payload JSON 都物化出来。
      // RFC-324 —— grant 子查询是新加的那一项：漏掉它，概览计数会比列表少，
      // 而两者本应逐条同口径（RFC-190 的 oracle）。
      const rows = await db
        .select({ n: count() })
        .from(scheduledTasks)
        .where(
          actor.permissions.has('tasks:read:all') || actor.permissions.has('resource-acl:bypass')
            ? undefined
            : or(
                eq(scheduledTasks.ownerUserId, actor.user.id),
                inArray(
                  scheduledTasks.id,
                  db
                    .select({ resourceId: resourceGrants.resourceId })
                    .from(resourceGrants)
                    .where(
                      and(
                        eq(resourceGrants.resourceType, 'scheduled_task'),
                        eq(resourceGrants.userId, actor.user.id),
                      ),
                    ),
                ),
              ),
        )
      return rows[0]?.n ?? 0
    }),
    gatedCount(actor, 'memory:read', async () => {
      const approved = await listMemories(db, { status: 'approved' })
      return (await filterMemoriesByScopeVisibility(db, actor, approved)).length
    }),
    buildTaskStats(db, actor, t - WINDOW_7D_MS),
  ])
  return {
    resources: { agents, skills, mcps, plugins, workflows, workgroups, repos, scheduled, memories },
    tasks: taskStats,
    generatedAt: new Date(t).toISOString(),
  }
}

export function buildOverview(
  db: DbClient,
  actor: Actor,
  now: () => number = Date.now,
): Promise<OverviewResponse> {
  // An injected clock defines an independent observation and is used by
  // boundary tests; never merge it with another caller's clock. Production
  // requests use Date.now and can safely share only their overlapping read.
  if (now !== Date.now) return buildOverviewFresh(db, actor, now)
  return overviewFlight(db)(overviewFlightKey(actor), () => buildOverviewFresh(db, actor, now))
}
