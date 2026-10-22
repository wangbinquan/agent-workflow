// RFC-370 §9.2 V3 — the volume-use facts Task Execution owns, for Source
// Control's hosted parent lifecycle (`HostedVolumeActivity`). A volume is in
// use while an AW task bound to it is pending or running, or while any hosted
// execution on it has not settled. Logical children (call / fusion) and
// inherited tasks map to the physical owner named by their workspace
// reference; owners that are not tasks (`system:…`, `development:shared`) are
// their own owner.
import { tablesOf } from '@/platform/persistence/sessionTables'
import { inArray } from 'drizzle-orm'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import {
  hostedWorkspaceOwnerFromReference,
  type HostedVolumeActivity,
} from '@/modules/source-control/public/participants'
import type { HostedExecutionStore } from './executionStore'

const ACTIVE_TASK_STATUSES = ['pending', 'running'] as const
const SQL_CHUNK = 500

export function createHostedVolumeActivity(input: {
  readonly db: PersistenceDb
  readonly store: Pick<HostedExecutionStore, 'unsettled'>
}): HostedVolumeActivity {
  const ownerOf = (task: { id: string; worktreePath: string }) =>
    hostedWorkspaceOwnerFromReference(task.worktreePath) ?? task.id
  return {
    async activeVolumeOwners() {
      const owners = new Set<string>()
      const { tasks } = tablesOf(input.db)
      const active = await input.db
        .select({ id: tasks.id, worktreePath: tasks.worktreePath })
        .from(tasks)
        .where(inArray(tasks.status, [...ACTIVE_TASK_STATUSES]))
      for (const task of active) owners.add(ownerOf(task))
      const executing = [
        ...new Set((await input.store.unsettled()).map((binding) => binding.taskId)),
      ]
      const known = new Map<string, string>()
      for (let at = 0; at < executing.length; at += SQL_CHUNK) {
        const rows = await input.db
          .select({ id: tasks.id, worktreePath: tasks.worktreePath })
          .from(tasks)
          .where(inArray(tasks.id, executing.slice(at, at + SQL_CHUNK)))
        for (const row of rows) known.set(row.id, ownerOf(row))
      }
      for (const taskId of executing) owners.add(known.get(taskId) ?? taskId)
      return owners
    },
  }
}
