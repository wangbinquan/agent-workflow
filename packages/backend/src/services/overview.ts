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

import { isNull, and, count, eq, gte, inArray, type SQL } from 'drizzle-orm'
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

const WINDOW_7D_MS = 7 * 86_400_000

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
    const topLevel = and(cond, isNull(tasks.parentTaskId))!
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
export async function buildOverview(
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
      // canViewScheduledTask ≡ tasks:read:all ∨ owner=me (its SYSTEM branch is
      // a subset of owner=me), so the count pushes down to one indexed query
      // instead of materializing every row's launch_payload JSON.
      const rows = await db
        .select({ n: count() })
        .from(scheduledTasks)
        .where(
          actor.permissions.has('tasks:read:all')
            ? undefined
            : eq(scheduledTasks.ownerUserId, actor.user.id),
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
