// RFC-359 AC-1（第 11 刀下半）—— 取消的**唯一**生产装配点。
//
// 合并之前，取消在 legacy 侧的入口是 `services/task.ts` 的 `cancelTask`：它既是实现、
// 又是装配点，于是 9 个生产调用点各自 import 它、连带把整个 legacy Task service 拉进依赖图
//（`resourceLimits.ts` 为此不得不写成惰性 `await import(...)`，注释里明写「PostgreSQL 装配
// 绝不能加载或捕获 SQLite-only 的 legacy Task service」）。
//
// 实现搬进模块之后这层顾虑消失了：这里只绑三样——中立库句柄、持久化、**任务驱动**注册表
//（停机票据，取自模块自己的 public 合同），一行 legacy 代码都不碰。
//
// ⚠️ `stop` 不能按名字抓：SQLite 参与者工厂输入里那个 `runtimeRegistry` 是
// `platform/runtime-registry` 的**运行时档案**注册表（`getRuntime(name)`），与这里要的
// 停机票据注册表**同名不同物**。
import type { ProviderNeutralDatabase } from '@/db/query'
import { createLogger } from '@/util/log'

import { cancelTaskProjection } from '../infrastructure/postgresqlChildTaskLifecycleParticipant'
import { taskExecutionModule } from '../public/participants'
import { createTaskExecutionPersistence } from './taskExecutionPersistence'

const log = createLogger('task')

/** 取消的来源。与共用实现的 `cause` 同一套词汇，不再经过 legacy 的 options 包。 */
export type TaskCancelCause = Parameters<typeof cancelTaskProjection>[2]

export interface TaskCancellation {
  /** 缺省是用户取消；父级联传 `{ kind: 'parent-cascade', parentTaskId }`。 */
  cancel(taskId: string, cause?: TaskCancelCause): Promise<void>
}

export function composeTaskCancellation(db: ProviderNeutralDatabase): TaskCancellation {
  const dependencies = {
    db,
    persistence: createTaskExecutionPersistence(db),
    stop: taskExecutionModule.runtimeRegistry,
    log,
  }
  return Object.freeze({
    async cancel(taskId: string, cause: TaskCancelCause = { kind: 'user' }): Promise<void> {
      await cancelTaskProjection(dependencies, taskId, cause)
    },
  })
}
