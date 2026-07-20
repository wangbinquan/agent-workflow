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
// route is gated by (server.ts gate block). workgroups / scheduled-tasks list
// routes have no coarse gate → always numbers. tasks truth table (mirrors
// routes/tasks.ts scope decision): read:all → unscoped; read:own →
// owner∨collaborator; neither → null.

import { and, count, eq, gte, inArray, type SQL } from 'drizzle-orm'
import type { OverviewResponse, OverviewTasks, Permission } from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import { tasks } from '@/db/schema'
import { listAgents } from '@/services/agent'
import { countCachedRepos } from '@/services/gitRepoCache'
import { listMcps } from '@/services/mcp'
import { filterMemoriesByScopeVisibility, listMemories } from '@/services/memory'
import { listPlugins } from '@/services/plugin'
import { filterVisibleRows } from '@/services/resourceAcl'
import { canViewScheduledTask, listScheduledTasks } from '@/services/scheduledTasks'
import { listSkills } from '@/services/skill'
import {
  excludeBuiltinAgents,
  excludeBuiltinWorkflows,
  excludeForeignExamples,
} from '@/services/systemResources'
import { taskVisibilityCondition } from '@/services/task'
import { listWorkflows } from '@/services/workflow'
import { listWorkgroups } from '@/services/workgroups'

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
    const where = vis === undefined ? cond : and(vis, cond)!
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
    gatedCount(
      actor,
      'agents:read',
      async () =>
        (
          await filterVisibleRows(
            db,
            actor,
            'agent',
            // RFC-211: mirror the list route exactly. This file's contract is
            // that every count equals the length of its list endpoint, and
            // filterVisibleRows short-circuits for admins — so without this an
            // admin's tile would count every learner's practice material while
            // the page it links to shows none of it.
            excludeForeignExamples(actor.user.id, excludeBuiltinAgents(await listAgents(db))),
          )
        ).length,
    ),
    gatedCount(
      actor,
      'skills:read',
      async () =>
        (
          await filterVisibleRows(
            db,
            actor,
            'skill',
            excludeForeignExamples(actor.user.id, await listSkills(db)),
          )
        ).length,
    ),
    gatedCount(
      actor,
      'mcps:read',
      async () => (await filterVisibleRows(db, actor, 'mcp', await listMcps(db))).length,
    ),
    gatedCount(
      actor,
      'plugins:read',
      async () => (await filterVisibleRows(db, actor, 'plugin', await listPlugins(db))).length,
    ),
    gatedCount(
      actor,
      'workflows:read',
      async () =>
        (
          await filterVisibleRows(
            db,
            actor,
            'workflow',
            excludeForeignExamples(actor.user.id, excludeBuiltinWorkflows(await listWorkflows(db))),
          )
        ).length,
    ),
    // No coarse gate on the workgroups list route — always a number.
    (async () =>
      (
        await filterVisibleRows(
          db,
          actor,
          'workgroup',
          excludeForeignExamples(actor.user.id, await listWorkgroups(db)),
        )
      ).length)(),
    gatedCount(actor, 'repos:read', () => countCachedRepos(db)),
    // No coarse gate on the scheduled-tasks list route — row filter only.
    (async () =>
      (await listScheduledTasks(db)).filter((row) => canViewScheduledTask(actor, row)).length)(),
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
