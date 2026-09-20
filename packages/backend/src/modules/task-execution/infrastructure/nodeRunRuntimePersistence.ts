// RFC-359 W4-B1 —— node run 冻结运行时持久化：一份实现，两个 provider 共用。

import { eq } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '@/db/query'
import { nodeRuns } from '@/db/schema'
import { engineOf } from '@/platform/persistence/databaseTransaction'
import type {
  NodeRunRuntimePersistence,
  FrozenNodeRunRuntime,
  NodeRunRuntimeSelectionSession,
} from '../application/ports/nodeRunRuntimePersistence'
import { fenceTaskWrite, withTaskExecutionWrite } from './ownedTaskExecution'

const projection = {
  runtime: nodeRuns.runtime,
  runtimeBinary: nodeRuns.runtimeBinary,
  runtimeParamsJson: nodeRuns.runtimeParamsJson,
}

export class DrizzleNodeRunRuntimePersistence implements NodeRunRuntimePersistence {
  constructor(
    private readonly db: ProviderNeutralDatabase,
    private readonly isRuntimeKnown: (protocol: string | null) => boolean,
    private readonly bindSelection: (
      transaction: ProviderNeutralDatabase,
      assertTaskScope: () => void,
    ) => (
      agentRuntime: string | null | undefined,
      defaultRuntime: string | null | undefined,
    ) => Promise<FrozenNodeRunRuntime>,
  ) {}

  async withSelection<T>(
    nodeRunId: string,
    body: (session: NodeRunRuntimeSelectionSession) => Promise<T>,
  ): Promise<T> {
    return withTaskExecutionWrite(this.db, async (tx) => {
      // This capability never escapes the callback's live transaction. Its owner fence is
      // taken before either selection or snapshot write, including inherited snapshots.
      let active = true
      let fenced = false
      const assertActive = () => {
        if (!active) throw new Error('node-run-runtime-selection-outside-transaction')
      }
      const ensureFence = async () => {
        assertActive()
        if (fenced) return
        const rows = await tx
          .select({ taskId: nodeRuns.taskId })
          .from(nodeRuns)
          .where(eq(nodeRuns.id, nodeRunId))
          .limit(1)
        if (rows[0] !== undefined) await fenceTaskWrite(tx, { taskId: rows[0].taskId })
        await engineOf(tx).lockAggregateRoot(tx, nodeRuns, nodeRuns.id, nodeRunId)
        fenced = true
      }
      const select = this.bindSelection(tx, () => {
        assertActive()
        if (!fenced) throw new Error('node-run-runtime-selection-before-fence')
      })
      try {
        return await body({
          load: async () => {
            assertActive()
            let rows = await tx
              .select(projection)
              .from(nodeRuns)
              .where(eq(nodeRuns.id, nodeRunId))
              .limit(1)
            if (rows[0] === undefined || !this.isRuntimeKnown(rows[0].runtime)) {
              await ensureFence()
              // A concurrent first dispatch may have frozen while we waited for the owner/row lock.
              rows = await tx
                .select(projection)
                .from(nodeRuns)
                .where(eq(nodeRuns.id, nodeRunId))
                .limit(1)
            }
            return rows[0] ?? null
          },
          select: async (agentRuntime, defaultRuntime) => {
            await ensureFence()
            return select(agentRuntime, defaultRuntime)
          },
          freeze: async (input) => {
            if (input.nodeRunId !== nodeRunId)
              throw new Error('node-run-runtime-selection-node-mismatch')
            await ensureFence()
            await tx
              .update(nodeRuns)
              .set({
                runtime: input.runtime,
                runtimeBinary: input.runtimeBinary,
                runtimeParamsJson: input.runtimeParamsJson,
              })
              .where(eq(nodeRuns.id, nodeRunId))
              .run()
          },
        })
      } finally {
        active = false
      }
    })
  }

  async load(nodeRunId: string) {
    const rows = await this.db
      .select(projection)
      .from(nodeRuns)
      .where(eq(nodeRuns.id, nodeRunId))
      .limit(1)
    return rows[0] ?? null
  }

  async findBySessionId(sessionId: string) {
    const rows = await this.db
      .select(projection)
      .from(nodeRuns)
      .where(eq(nodeRuns.opencodeSessionId, sessionId))
      .limit(1)
    return rows[0] ?? null
  }

  async freeze(input: Parameters<NodeRunRuntimePersistence['freeze']>[0]): Promise<void> {
    await withTaskExecutionWrite(this.db, async (tx) => {
      const rows = await tx
        .select({ taskId: nodeRuns.taskId })
        .from(nodeRuns)
        .where(eq(nodeRuns.id, input.nodeRunId))
        .limit(1)
      const row = rows[0]
      if (row === undefined) return
      await fenceTaskWrite(tx, { taskId: row.taskId })
      await tx
        .update(nodeRuns)
        .set({
          runtime: input.runtime,
          runtimeBinary: input.runtimeBinary,
          runtimeParamsJson: input.runtimeParamsJson,
        })
        .where(eq(nodeRuns.id, input.nodeRunId))
        .run()
    })
  }
}
