// RFC-359 W8 —— 冻结任务的溯源预检：**一份实现，两个 provider 共用**。
//
// 合一前这段在 `services/task.ts`（SQLite 路径）与本目录的
// `postgresqlTaskRouteOperations.ts`（PG 路径）各有一份**逐字相同**的文件私有副本，
// 差别只有 `db` 的类型标注。它读的是 provider 中立的单行 `tasks` select，没有任何方言面，
// 两份副本存在的唯一后果就是「改一份、漂另一份」——而漂了之后两条路径各自的用例都还绿着，
// 没有任何测试会因此变红。这正是 RFC-359 要消灭的形状。
//
// 落在 infrastructure 而不是 `services/execution/triggerPreflight.ts`（`assertTriggerPreflight`
// 本体所在处）是被守卫按住的：`rfc349-provider-cutover` 的
// `databaseMechanismDependencies` 判据禁止 `services/` 面直接拥有 `@/db/*` / drizzle。
// 纯判据留在那边，带读点的这一层归 task-execution 的 infrastructure。
import { eq } from 'drizzle-orm'
import {
  WorkflowDefinitionSchema,
  migrateWorkflowDefinitionToLatest,
  parseTriggerContextJson,
} from '@agent-workflow/shared'

import type { ProviderNeutralDatabase } from '@/db/query'
import { tasks } from '@/db/schema'
import { assertTriggerPreflight } from '@/services/execution/triggerPreflight'
import { ValidationError } from '@/util/errors'

/** 只读一行 `tasks` 就够——两个 provider 的任何 db / tx 句柄都满足这个面。 */
export type FrozenTaskTriggerReader = Pick<ProviderNeutralDatabase, 'select'>

/** 调用方可以给一份候选 root+closure（syncWorkflow 换定义时用），但绝不能替换 trigger 源。 */
export interface FrozenTaskTriggerCandidate {
  readonly workflowSnapshot: string
  readonly refClosureJson: string | null
}

/**
 * RFC-292 —— resume / retry / syncWorkflow 的任务行权威预检。
 *
 * webhook 上下文永远从 **durable 任务行**重读；它必须落在准入 CAS **之前**，否则一个注定
 * 被拒的重试 / 同步会先把任务状态推走、铸出「queued for retry」的假尝试，然后才拒绝。
 */
export async function assertFrozenTaskTriggerPreflight(
  db: FrozenTaskTriggerReader,
  taskId: string,
  candidate?: FrozenTaskTriggerCandidate,
): Promise<void> {
  const frozen = (
    await db
      .select({
        workflowSnapshot: tasks.workflowSnapshot,
        refClosureJson: tasks.refClosureJson,
        triggerContextJson: tasks.triggerContextJson,
      })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .limit(1)
  )[0]
  if (frozen === undefined) return

  const source = parseTriggerContextJson(frozen.triggerContextJson)
  if (source.kind === 'invalid') {
    throw new ValidationError(
      'trigger-context-invalid',
      'the frozen task trigger context is invalid',
    )
  }
  const selected = candidate ?? frozen
  try {
    const root = migrateWorkflowDefinitionToLatest(
      WorkflowDefinitionSchema.parse(JSON.parse(selected.workflowSnapshot)),
    )
    assertTriggerPreflight({ root, closureJson: selected.refClosureJson, source })
  } catch (error) {
    // 历史上损坏的工作流快照保留既有的恢复姿势；来自**合法**快照的 trigger 失败是权威的，
    // 必须先于任何生命周期 / 调度副作用发生。
    if (error instanceof ValidationError && error.code.startsWith('trigger-')) throw error
  }
}
