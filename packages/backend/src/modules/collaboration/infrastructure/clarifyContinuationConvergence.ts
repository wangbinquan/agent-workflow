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
 * 而它在 PostgreSQL 上照样跑：`services/task.ts` 的 `createTaskDriveCoordinator` 把
 * `gateContinuationPreDrive` 默认成 `composeGateContinuationPreDrive(...)`，
 * 五个 drive 入口没有一个注入替代品，PG daemon 走的也是这一份。
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
