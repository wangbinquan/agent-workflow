// integration 装配：requirement-source adapter runner（RFC-310 PR-3）。
//
// 只做本 context 内的实例化（sqlite adapter store → binding resolver →
// CLI runner）；development-automation 的 materializer 以结构同形依赖接收
// 返回值（两边形状由边界测试配对锁定），生产 server/daemon 装配点把它注入
// development-automation workspace participant——两个模块互不 import 对方内部。
//
// AW_REQUIREMENT_MOCK_URL：system-mocks E2E 座席。adapter 子进程 env 从空
// 对象构造（developmentAdapterRunner），mock provider CLI 需要上游 URL 时由
// 平台进程 env 透传这一个名字；真实内网 adapter 只读取已发布定义点名的
// connectionRef 与 daemon-boot secretProjection。

import type { ProviderNeutralDatabase } from '@/db/query'
import {
  createAsyncDbAdapterBindingResolver,
  createRequirementSourceAdapter,
  type RequirementSourceExecution,
} from '../infrastructure/developmentRequirementSourceAdapter'
import { createDevelopmentAdapterStore } from '../infrastructure/developmentAdapterStore'

function runner(input: {
  readonly resolveBinding: Parameters<typeof createRequirementSourceAdapter>[0]['resolveBinding']
}): RequirementSourceExecution {
  const secretSource = Object.freeze({ ...process.env })
  const mockUrl = process.env.AW_REQUIREMENT_MOCK_URL
  return createRequirementSourceAdapter({
    resolveBinding: input.resolveBinding,
    secretSource,
    ...(mockUrl === undefined ? {} : { extraEnv: { AW_REQUIREMENT_MOCK_URL: mockUrl } }),
  })
}

/** RFC-359 W4-D6：一份装配，两个 provider 共用（绑定解析经中立 store 的 Promise 读）。 */
export function composeRequirementSourceRunnerFor(
  db: ProviderNeutralDatabase,
): RequirementSourceExecution {
  const store = createDevelopmentAdapterStore(db)
  return runner({
    resolveBinding: createAsyncDbAdapterBindingResolver((id, revision) =>
      store.getRevision(id, revision),
    ),
  })
}

/** 旧名保留为装配别名，bootstrap 收敛后删除。 */
export const composeSqliteRequirementSourceRunner = composeRequirementSourceRunnerFor
export const composePostgresqlRequirementSourceRunner = composeRequirementSourceRunnerFor
