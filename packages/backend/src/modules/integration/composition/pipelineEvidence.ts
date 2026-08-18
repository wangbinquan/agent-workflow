// integration 装配：pipeline-gate adapter runner（RFC-310 PR-6 T63）。
//
// 只做本 context 内的实例化（sqlite adapter store → binding resolver →
// CLI runner），requirementSource 同款；development-automation 的 pipeline
// evidence importer 以结构同形依赖接收返回值，装配点（routes/cli）把它注入
// composeDevelopmentAutomation——两个模块互不 import 对方内部。
//
// AW_PIPELINE_MOCK_URL：system-mocks E2E 座席（AW_REQUIREMENT_MOCK_URL 同款
// 透传）；真实内网 adapter 的连接语义走 connectionRef（后续批次）。

import type { DbClient } from '@/db/client'
import {
  createPipelineEvidenceAdapter,
  type PipelineEvidenceExecution,
} from '../infrastructure/developmentPipelineAdapter'
import { createDbAdapterBindingResolver } from '../infrastructure/developmentRequirementSourceAdapter'
import { createSqliteDevelopmentAdapterStore } from '../infrastructure/sqliteDevelopmentAdapterStore'

export function composePipelineEvidenceRunner(db: DbClient): PipelineEvidenceExecution {
  const store = createSqliteDevelopmentAdapterStore(db)
  const mockUrl = process.env.AW_PIPELINE_MOCK_URL
  return createPipelineEvidenceAdapter({
    resolveBinding: createDbAdapterBindingResolver((id, revision) =>
      store.getRevision(id, revision),
    ),
    ...(mockUrl === undefined ? {} : { extraEnv: { AW_PIPELINE_MOCK_URL: mockUrl } }),
  })
}
