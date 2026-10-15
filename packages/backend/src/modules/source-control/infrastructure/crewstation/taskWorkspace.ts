import { eq, inArray } from 'drizzle-orm'
import { createHash } from 'node:crypto'
import type { ProviderNeutralDatabase } from '@/db/query'
import { hostedTaskWorkspaces } from '@/db/schema'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import type { CrewStationMutationFence } from '@/platform/crewstation/mutationFence'
import type { CrewStationBusinessExecution } from '@/platform/crewstation/businessExecution'

export interface HostedTaskWorkspace {
  readonly taskId: string
  readonly businessTaskId: string
}

export interface HostedTaskWorkspaces {
  ensure(taskId: string): Promise<HostedTaskWorkspace>
  find(taskId: string): Promise<HostedTaskWorkspace | null>
  list(): Promise<readonly HostedTaskWorkspace[]>
  close(taskId: string): Promise<boolean>
}

/** Source Control owns the parent task/volume. Task execution owns subtasks.
 * Persist the parent request key before network I/O so concurrent preparations
 * and a lost create response all resolve to the same persistent work volume. */
export function createHostedTaskWorkspaces(input: {
  readonly db: ProviderNeutralDatabase
  readonly api: CrewStationBusinessExecution
  readonly fence: CrewStationMutationFence
  readonly installation: string
  readonly taskContractVersion: string
  readonly sleep?: (ms: number) => Promise<void>
}): HostedTaskWorkspaces {
  const session = databaseSessionFor(input.db)
  const sleep = input.sleep ?? ((ms) => Bun.sleep(ms))
  const read = async (db: ProviderNeutralDatabase, taskId: string) =>
    (
      await db
        .select()
        .from(hostedTaskWorkspaces)
        .where(eq(hostedTaskWorkspaces.taskId, taskId))
        .limit(1)
    )[0]
  const write = async <T>(operation: (tx: ProviderNeutralDatabase) => Promise<T>) => {
    const fence = input.fence.current()
    return session.transaction(async (tx) => {
      await input.fence.assertHeld(tx, fence)
      return operation(tx)
    })
  }
  const ready = async (taskId: string, businessTaskId: string): Promise<HostedTaskWorkspace> => {
    const deadline = Date.now() + 300_000
    while (true) {
      input.fence.current()
      const task = await input.api.getTask(businessTaskId)
      if (task.state === 'running' && task.resourceState === 'ready') {
        await write(async (tx) => {
          const current = await read(tx, taskId)
          if (current === undefined || current.state === 'closing' || current.state === 'closed')
            throw new Error('hosted-workspace-closed')
          await tx
            .update(hostedTaskWorkspaces)
            .set({ state: 'ready', updatedAt: Date.now() })
            .where(eq(hostedTaskWorkspaces.taskId, taskId))
        })
        return { taskId, businessTaskId }
      }
      if (!['admitting', 'creating', 'running'].includes(task.state)) {
        throw new Error(`hosted-workspace-unavailable: ${task.state}: ${task.message ?? ''}`)
      }
      if (Date.now() >= deadline) throw new Error('hosted-workspace-provisioning-timeout')
      await sleep(2_000)
    }
  }
  return {
    async ensure(taskId) {
      // Hash the installation so request keys remain below the platform's 128
      // byte limit even when project/service names are long.
      const installation = createHash('sha256')
        .update(input.installation)
        .digest('hex')
        .slice(0, 20)
      const row = await write(async (tx) => {
        await tx
          .insert(hostedTaskWorkspaces)
          .values({
            taskId,
            requestKey: `aw-task:${installation}:${taskId}`,
            state: 'creating',
            createdAt: Date.now(),
            updatedAt: Date.now(),
          })
          .onConflictDoNothing()
        return (await read(tx, taskId))!
      })
      if (row.state === 'closed' || row.state === 'closing')
        throw new Error('hosted-workspace-closed')
      if (row.businessTaskId !== null) return ready(taskId, row.businessTaskId)
      const task = await input.api.createTask({
        requestKey: row.requestKey,
        fence: input.fence.current(),
        taskContractVersion: input.taskContractVersion,
        labels: { 'aw-task-id': taskId, 'aw-installation': input.installation },
      })
      await write(async (tx) => {
        const current = await read(tx, taskId)
        if (
          current === undefined ||
          (current.businessTaskId !== null && current.businessTaskId !== task.id)
        ) {
          throw new Error('hosted-workspace-receipt-mismatch')
        }
        await tx
          .update(hostedTaskWorkspaces)
          .set({ businessTaskId: task.id, updatedAt: Date.now() })
          .where(eq(hostedTaskWorkspaces.taskId, taskId))
      })
      return ready(taskId, task.id)
    },
    async find(taskId) {
      const row = await read(input.db, taskId)
      return row?.businessTaskId == null || row.state === 'closing' || row.state === 'closed'
        ? null
        : { taskId, businessTaskId: row.businessTaskId }
    },
    async list() {
      const rows = await input.db
        .select()
        .from(hostedTaskWorkspaces)
        .where(inArray(hostedTaskWorkspaces.state, ['creating', 'ready']))
      return rows.flatMap((row) =>
        row.businessTaskId === null
          ? []
          : [{ taskId: row.taskId, businessTaskId: row.businessTaskId }],
      )
    },
    async close(taskId) {
      const row = await read(input.db, taskId)
      if (row === undefined || row.state === 'closed') return true
      if (row.businessTaskId === null) return false
      await write(async (tx) => {
        await tx
          .update(hostedTaskWorkspaces)
          .set({ state: 'closing', updatedAt: Date.now() })
          .where(eq(hostedTaskWorkspaces.taskId, taskId))
      })
      let task = await input.api.getTask(row.businessTaskId)
      if (task.state !== 'closed' && task.state !== 'closing') {
        await input.api.closeTask(task.id, {
          requestKey: `${row.requestKey}:close:${task.generation}`,
          fence: input.fence.current(),
          expectedGeneration: task.generation,
        })
        task = await input.api.getTask(task.id)
      }
      // Acknowledged close is not physical release. GC retries until the
      // platform confirms the resources actually disappeared.
      if (task.state !== 'closed' || task.resourceState !== 'released') return false
      await write(async (tx) => {
        await tx
          .update(hostedTaskWorkspaces)
          .set({ state: 'closed', updatedAt: Date.now() })
          .where(eq(hostedTaskWorkspaces.taskId, taskId))
      })
      return true
    },
  }
}
