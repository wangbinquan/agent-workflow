// integration 装配：pipeline-gate adapter runner（RFC-310 PR-6 T63）。
//
// 只做本 context 内的实例化（sqlite adapter store → binding resolver →
// CLI runner），requirementSource 同款；development-automation 的 pipeline
// evidence importer 以结构同形依赖接收返回值，装配点（routes/cli）把它注入
// composeDevelopmentAutomation——两个模块互不 import 对方内部。
//
// AW_PIPELINE_MOCK_URL：system-mocks E2E 座席（AW_REQUIREMENT_MOCK_URL 同款
// 透传）；真实内网 adapter 只读取已发布定义点名的 connectionRef 与
// daemon-boot secretProjection。

import type { ProviderNeutralDatabase } from '@/db/query'
import {
  createPipelineEvidenceAdapter,
  type PipelineEvidenceExecution,
} from '../infrastructure/developmentPipelineAdapter'
import { createAsyncDbAdapterBindingResolver } from '../infrastructure/developmentRequirementSourceAdapter'
import { createDevelopmentAdapterStore } from '../infrastructure/developmentAdapterStore'

function runner(input: {
  readonly resolveBinding: Parameters<typeof createPipelineEvidenceAdapter>[0]['resolveBinding']
}): PipelineEvidenceExecution {
  const secretSource = Object.freeze({ ...process.env })
  const mockUrl = process.env.AW_PIPELINE_MOCK_URL
  return createPipelineEvidenceAdapter({
    resolveBinding: input.resolveBinding,
    secretSource,
    ...(mockUrl === undefined ? {} : { extraEnv: { AW_PIPELINE_MOCK_URL: mockUrl } }),
  })
}

/** RFC-359 W4-D6：一份装配，两个 provider 共用（绑定解析经中立 store 的 Promise 读）。 */
export function composePipelineEvidenceRunnerFor(
  db: ProviderNeutralDatabase,
): PipelineEvidenceExecution {
  const store = createDevelopmentAdapterStore(db)
  return runner({
    resolveBinding: createAsyncDbAdapterBindingResolver((id, revision) =>
      store.getRevision(id, revision),
    ),
  })
}

/** 旧名保留为装配别名，bootstrap 收敛后删除。 */
export const composeSqlitePipelineEvidenceRunner = composePipelineEvidenceRunnerFor
export const composePostgresqlPipelineEvidenceRunner = composePipelineEvidenceRunnerFor
