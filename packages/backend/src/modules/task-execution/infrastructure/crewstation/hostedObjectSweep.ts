// RFC-370 v3 V6 — Task Execution's hosted object sweep. Task deletion and task
// archival remove task rows by cascade, without visiting each object owner.
// This sweep reconciles the task-scoped publication families afterwards: a
// scope (task id) whose task and launch preparation are both gone releases all
// of its publications and drops the task's own reference rows. Archived tasks
// lose nothing: the archive linked its own pins before the rows were deleted.
import { tablesOf } from '@/platform/persistence/sessionTables'
import { and, eq, inArray, notExists } from 'drizzle-orm'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type {
  HostedObjectOwnerSweep,
  HostedObjectPublications,
} from '@/modules/system-operations/public/participants'
import type { CrewStationMutationFence } from '@/platform/crewstation/mutationFence'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { HOSTED_MATERIAL_OWNER } from './materialObjectUploads'
import { HOSTED_EVENT_ARCHIVE_OWNER } from './nodeEventArchive'
import { HOSTED_TASK_ARTIFACT_OWNER } from './taskArtifacts'

/** A launch may retain inputs before its task row exists. */
export const HOSTED_TASK_OBJECT_GRACE_MS = 24 * 60 * 60_000
const LIVE_PREPARATION = ['preparing', 'prepared', 'admitted', 'compensating'] as const
const OWNERS = [
  HOSTED_TASK_ARTIFACT_OWNER,
  HOSTED_MATERIAL_OWNER,
  HOSTED_EVENT_ARCHIVE_OWNER,
] as const

export function createHostedTaskObjectSweep(input: {
  readonly db: PersistenceDb
  readonly fence: CrewStationMutationFence
  readonly publications: HostedObjectPublications
  readonly graceMs?: number
  readonly pageSize?: number
}): HostedObjectOwnerSweep {
  const session = databaseSessionFor(input.db)
  const grace = input.graceMs ?? HOSTED_TASK_OBJECT_GRACE_MS
  const pageSize = input.pageSize ?? 200
  const write = <T>(run: (tx: PersistenceDb) => Promise<T>): Promise<T> => {
    const lease = input.fence.current()
    return session.transaction(async (tx) => {
      await input.fence.assertHeld(tx, lease)
      return run(tx)
    })
  }
  const liveTaskIds = async (ids: readonly string[]): Promise<Set<string>> => {
    if (ids.length === 0) return new Set()
    const { tasks, taskWorkspacePreparations } = tablesOf(input.db)
    const [taskRows, preparationRows] = await Promise.all([
      input.db
        .select({ id: tasks.id })
        .from(tasks)
        .where(inArray(tasks.id, [...ids])),
      input.db
        .select({ id: taskWorkspacePreparations.id })
        .from(taskWorkspacePreparations)
        .where(
          and(
            inArray(taskWorkspacePreparations.id, [...ids]),
            inArray(taskWorkspacePreparations.state, [...LIVE_PREPARATION]),
          ),
        ),
    ])
    return new Set([...taskRows, ...preparationRows].map((row) => row.id))
  }
  const releaseTask = (owner: (typeof OWNERS)[number] | null, taskId: string) =>
    write(async (tx) => {
      const { tasks, hostedTaskArtifacts, hostedNodeEventArchives } = tablesOf(tx)
      // Re-check inside the transaction: a task row is never resurrected, but a
      // launch can still create one for a preparation that just finished.
      const live = await tx
        .select({ id: tasks.id })
        .from(tasks)
        .where(eq(tasks.id, taskId))
        .limit(1)
      if (live.length > 0) return 0
      if (owner === null || owner === HOSTED_TASK_ARTIFACT_OWNER)
        await tx.delete(hostedTaskArtifacts).where(eq(hostedTaskArtifacts.taskId, taskId))
      if (owner === null || owner === HOSTED_EVENT_ARCHIVE_OWNER)
        await tx.delete(hostedNodeEventArchives).where(eq(hostedNodeEventArchives.taskId, taskId))
      let released = 0
      for (const family of owner === null ? OWNERS : [owner])
        released += await input.publications.release({ owner: family, scope: taskId }, tx)
      return released
    })
  return {
    name: 'task-execution',
    async sweep({ now }) {
      let released = 0
      for (const owner of OWNERS) {
        let after: string | undefined
        for (;;) {
          const scopes = await input.publications.scopes(owner, {
            before: now - grace,
            ...(after === undefined ? {} : { after }),
            limit: pageSize,
          })
          if (scopes.length === 0) break
          const live = await liveTaskIds(scopes)
          for (const scope of scopes)
            if (!live.has(scope)) released += await releaseTask(owner, scope)
          if (scopes.length < pageSize) break
          after = scopes.at(-1)
        }
      }
      const { hostedNodeEventArchives, tasks } = tablesOf(input.db)
      // Prepared chunks that never reached their publication have only rows.
      const orphans = await input.db
        .selectDistinct({ taskId: hostedNodeEventArchives.taskId })
        .from(hostedNodeEventArchives)
        .where(
          and(
            eq(hostedNodeEventArchives.state, 'prepared'),
            notExists(
              input.db
                .select({ id: tasks.id })
                .from(tasks)
                .where(eq(tasks.id, hostedNodeEventArchives.taskId)),
            ),
          ),
        )
        .limit(pageSize)
      for (const row of orphans) released += await releaseTask(null, row.taskId)
      return released
    },
  }
}
