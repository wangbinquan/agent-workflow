// RFC-235 v22 — actor-filtered resource labels for mounted-context and
// agent-suggested mount resolution. This is a display/selection projection;
// final approval still rechecks ACL in the write transaction.

import type { AclResourceType } from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import { listAgents } from '@/services/agent'
import { listMcps } from '@/services/mcp'
import { listPlugins } from '@/services/plugin'
import { filterVisibleRows } from '@/services/resourceAcl'
import { listSkills } from '@/services/skill'
import { listWorkflows } from '@/services/workflow'
import { listWorkgroups } from '@/services/workgroups'

export interface IntentVisibleResource {
  resourceType: AclResourceType
  resourceId: string
  name: string
  description: string | null
}

interface CatalogRow {
  id: string
  name: string
  description?: string | null
  ownerUserId?: string | null
  visibility?: 'private' | 'public'
}

function project(
  resourceType: AclResourceType,
  rows: readonly CatalogRow[],
): IntentVisibleResource[] {
  return rows.map((row) => ({
    resourceType,
    resourceId: row.id,
    name: row.name,
    description: row.description ?? null,
  }))
}

export async function listVisibleIntentResources(
  db: DbClient,
  actor: Actor,
): Promise<IntentVisibleResource[]> {
  const [agents, skills, mcps, plugins, workflows, workgroups] = await Promise.all([
    listAgents(db).then((rows) => filterVisibleRows(db, actor, 'agent', rows)),
    listSkills(db).then((rows) => filterVisibleRows(db, actor, 'skill', rows)),
    listMcps(db).then((rows) => filterVisibleRows(db, actor, 'mcp', rows)),
    listPlugins(db).then((rows) => filterVisibleRows(db, actor, 'plugin', rows)),
    listWorkflows(db).then((rows) => filterVisibleRows(db, actor, 'workflow', rows)),
    listWorkgroups(db).then((rows) => filterVisibleRows(db, actor, 'workgroup', rows)),
  ])
  return [
    ...project('agent', agents),
    ...project('skill', skills),
    ...project('mcp', mcps),
    ...project('plugin', plugins),
    ...project('workflow', workflows),
    ...project('workgroup', workgroups),
  ]
}
