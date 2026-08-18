// integration 装配：requirement-source adapter runner（RFC-310 PR-3）。
//
// 只做本 context 内的实例化（sqlite adapter store → binding resolver →
// CLI runner）；development-automation 的 materializer 以结构同形依赖接收
// 返回值（两边形状由 rfc310-pr3-adapter-runner 测试配对锁定），装配点
// （routes/developmentMissions.ts、cli/start.ts）把它注入
// composeDevelopmentAutomation——两个模块互不 import 对方内部。
//
// AW_REQUIREMENT_MOCK_URL：system-mocks E2E 座席。adapter 子进程 env 从空
// 对象构造（developmentAdapterRunner），mock provider CLI 需要上游 URL 时由
// 平台进程 env 透传这一个名字；真实内网 adapter 的连接语义走 connectionRef
// （后续批次），不依赖此透传。

import type { DbClient } from '@/db/client'
import {
  createDbAdapterBindingResolver,
  createRequirementSourceAdapter,
  type RequirementSourceExecution,
} from '../infrastructure/developmentRequirementSourceAdapter'
import { createSqliteDevelopmentAdapterStore } from '../infrastructure/sqliteDevelopmentAdapterStore'

export function composeRequirementSourceRunner(db: DbClient): RequirementSourceExecution {
  const store = createSqliteDevelopmentAdapterStore(db)
  const mockUrl = process.env.AW_REQUIREMENT_MOCK_URL
  return createRequirementSourceAdapter({
    resolveBinding: createDbAdapterBindingResolver((id, revision) =>
      store.getRevision(id, revision),
    ),
    ...(mockUrl === undefined ? {} : { extraEnv: { AW_REQUIREMENT_MOCK_URL: mockUrl } }),
  })
}
