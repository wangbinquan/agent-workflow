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

import type { DbClient } from '@/db/client'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import {
  createPipelineEvidenceAdapter,
  type PipelineEvidenceExecution,
} from '../infrastructure/developmentPipelineAdapter'
import {
  createAsyncDbAdapterBindingResolver,
  createDbAdapterBindingResolver,
} from '../infrastructure/developmentRequirementSourceAdapter'
import { createPostgresqlDevelopmentAdapterRevisionStore } from '../infrastructure/postgresqlDevelopmentAdapterRevisionStore'
import { createSqliteDevelopmentAdapterStore } from '../infrastructure/sqliteDevelopmentAdapterStore'

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

export function composeSqlitePipelineEvidenceRunner(db: DbClient): PipelineEvidenceExecution {
  const store = createSqliteDevelopmentAdapterStore(db)
  return runner({
    resolveBinding: createDbAdapterBindingResolver((id, revision) =>
      store.getRevision(id, revision),
    ),
  })
}

export function composePostgresqlPipelineEvidenceRunner(
  db: PostgresqlDatabaseClient,
): PipelineEvidenceExecution {
  const store = createPostgresqlDevelopmentAdapterRevisionStore(db)
  return runner({
    resolveBinding: createAsyncDbAdapterBindingResolver((id, revision) =>
      store.getRevision(id, revision),
    ),
  })
}
