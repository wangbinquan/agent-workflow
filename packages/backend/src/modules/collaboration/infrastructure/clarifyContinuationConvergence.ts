import type { ProviderNeutralDatabase } from '@/db/query'
import type { MemoryDistillEnqueuer } from '@/modules/memory/public/participants'
import { finishCommittedClarifyAutoDispatch } from '@/services/clarify/autoDispatch'
import type {
  ClarifyContinuationConvergence,
  ClarifyContinuationConvergenceRequest,
} from '../application/ports/clarifyContinuationConvergence'

/**
 * 澄清续跑收敛端口的**唯一**实现，两个 provider 共用。
 *
 * RFC-359 W9：类型面从 `DbClient`（bun:sqlite 同步客户端）改成 `ProviderNeutralDatabase`。
 * 这里从来只做一件事——把请求转给早已中立的 `finishCommittedClarifyAutoDispatch`
 * （它的 `db` 就是 `ProviderNeutralDatabase`）；`DbClient` 是这条链上唯一残留的引擎断言，
 * RFC-382 核对发现：PostgreSQL 会话原来直接构造协调器，并未经过 services/task 的默认
 * pre-drive 绑定。现在两边会话都由 daemon task-execution 模块组显式绑定此端口；每次调用的
 * 旧协调器保持原有默认绑定。提交边中断后的收敛由 RFC-382 双引擎回归覆盖。
 * RFC-359 W12：实现与调用方统一改为中立名称。
 */
export function createClarifyContinuationConvergence(input: {
  readonly db: ProviderNeutralDatabase
  readonly memoryDistillEnqueuer: MemoryDistillEnqueuer
}): ClarifyContinuationConvergence {
  return Object.freeze({
    async finish(request: ClarifyContinuationConvergenceRequest) {
      await finishCommittedClarifyAutoDispatch({
        db: input.db,
        memoryDistillEnqueuer: input.memoryDistillEnqueuer,
        ...request,
      })
    },
  })
}
