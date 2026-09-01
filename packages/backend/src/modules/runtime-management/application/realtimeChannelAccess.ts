// RFC-349 — realtime channel authorization belongs to runtime-management.

import type { TaskWsMessage } from '@agent-workflow/shared'

import { SYSTEM_USER_ID, type Actor, type ActorSource } from '@/auth/actor'
import type { DirectRequestAuthority } from '@/modules/identity-access/public/participants'
import type { RealtimeChannelAccess, RealtimeCompositionPolicy } from '../public/participants'
import type {
  RealtimeAclResourceType,
  RealtimeMemoryScope,
  RealtimeStore,
} from './ports/realtimeStore'

function decodePayload(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

export function createRealtimeChannelAccess(
  store: RealtimeStore,
  policy: RealtimeCompositionPolicy,
): RealtimeChannelAccess {
  async function canViewTask(actor: Actor, taskId: string): Promise<boolean> {
    const audience = await store.findTaskAudience(taskId, actor.user.id)
    if (audience === null) return false
    if (actor.permissions.has('tasks:read:all')) return true
    if (audience.ownerUserId === actor.user.id) return true
    if (audience.ownerUserId === SYSTEM_USER_ID && actor.user.id === SYSTEM_USER_ID) return true
    return audience.member
  }

  const access: RealtimeChannelAccess = {
    canViewTask,
    async canViewResource(actor: Actor, type: RealtimeAclResourceType, resourceId: string) {
      const row = await store.findResource(type, resourceId)
      return row !== null && (await policy.resourceVisibility.canViewResource(actor, type, row))
    },
    async canViewMemory(
      authority: DirectRequestAuthority,
      actor: Actor,
      scope: RealtimeMemoryScope,
    ) {
      return await policy.memoryVisibility.canViewMemory(authority, actor, scope)
    },
    async canViewStoredMemory(authority: DirectRequestAuthority, actor: Actor, memoryId: string) {
      const scope = await store.findMemoryScope(memoryId)
      return (
        scope !== null && (await policy.memoryVisibility.canViewMemory(authority, actor, scope))
      )
    },
    async replayTaskEvents(actorSource: ActorSource, taskId: string, since: number) {
      const rows = await store.listTaskEvents(taskId, since)
      return rows.map(
        (row): TaskWsMessage => ({
          id: row.id,
          type: 'node.event',
          nodeRunId: row.nodeRunId,
          ts: row.ts,
          kind: row.kind,
          payload: policy.redactTaskEventPayload(decodePayload(row.payload), actorSource),
        }),
      )
    },
    repoImportOwnerUserId: policy.repoImportOwnerUserId,
  }
  return Object.freeze(access)
}
