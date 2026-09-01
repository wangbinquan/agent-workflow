// RFC-349 — SQLite realtime persistence adapter for runtime-management.

import { and, asc, eq, gt } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import {
  memories,
  nodeRunEvents,
  nodeRuns,
  taskCollaborators,
  tasks,
  workflows,
  workgroups,
} from '@/db/schema'
import type {
  RealtimeAclResourceType,
  RealtimeResourceRow,
  RealtimeStore,
} from '../application/ports/realtimeStore'

export class SqliteRealtimeStore implements RealtimeStore {
  constructor(private readonly db: DbClient) {}

  async findTaskAudience(taskId: string, userId: string) {
    const taskRows = await this.db
      .select({ ownerUserId: tasks.ownerUserId })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .limit(1)
    const task = taskRows[0]
    if (task === undefined) return null
    const memberships = await this.db
      .select({ userId: taskCollaborators.userId })
      .from(taskCollaborators)
      .where(and(eq(taskCollaborators.taskId, taskId), eq(taskCollaborators.userId, userId)))
      .limit(1)
    return { ownerUserId: task.ownerUserId, member: memberships.length > 0 }
  }

  async findResource(
    type: RealtimeAclResourceType,
    resourceId: string,
  ): Promise<RealtimeResourceRow | null> {
    if (type === 'workflow') {
      const rows = await this.db
        .select({
          id: workflows.id,
          ownerUserId: workflows.ownerUserId,
          visibility: workflows.visibility,
        })
        .from(workflows)
        .where(eq(workflows.id, resourceId))
        .limit(1)
      return rows[0] ?? null
    }
    const rows = await this.db
      .select({
        id: workgroups.id,
        ownerUserId: workgroups.ownerUserId,
        visibility: workgroups.visibility,
      })
      .from(workgroups)
      .where(eq(workgroups.id, resourceId))
      .limit(1)
    return rows[0] ?? null
  }

  async findMemoryScope(memoryId: string) {
    const rows = await this.db
      .select({ scopeType: memories.scopeType, scopeId: memories.scopeId })
      .from(memories)
      .where(eq(memories.id, memoryId))
      .limit(1)
    return rows[0] ?? null
  }

  async listTaskEvents(taskId: string, since: number) {
    return await this.db
      .select({
        id: nodeRunEvents.id,
        nodeRunId: nodeRunEvents.nodeRunId,
        ts: nodeRunEvents.ts,
        kind: nodeRunEvents.kind,
        payload: nodeRunEvents.payload,
      })
      .from(nodeRunEvents)
      .innerJoin(nodeRuns, eq(nodeRunEvents.nodeRunId, nodeRuns.id))
      .where(and(eq(nodeRuns.taskId, taskId), gt(nodeRunEvents.id, since)))
      .orderBy(asc(nodeRunEvents.id))
  }
}
