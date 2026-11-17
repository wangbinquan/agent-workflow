// RFC-502（RFC-294 S10 第九步）：审批网关的回执投影迁入 `application/developmentApprovalGateway.ts`，此前同一段投影在这里逐字
// 出现两遍；这里的两条装配只建 store、绑定解析与执行适配器，再交给它。

import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { createSelectedApprovalExecutionAdapter } from '../application/developmentApprovalAdapter'
import { createDevelopmentApprovalGateway } from '../application/developmentApprovalGateway'
import type { ApprovalAdapterBinding } from '../application/ports/developmentPurposeBinding'
import { createApprovalExecutionAdapter } from '../infrastructure/developmentApprovalAdapter'
import { createAsyncDbAdapterBindingResolver } from '../infrastructure/developmentRequirementSourceAdapter'
import { createDevelopmentAdapterStore } from '../infrastructure/developmentAdapterStore'

/**
 * RFC-359 W4-D6：一份装配，两个 provider 共用（绑定解析经中立 store 的 Promise 读）。
 * 按进程环境取密钥与 mock 地址的旧装配：bootstrap 已不用（只装下面按选定绑定的那条），`rfc310-digital-employee-system-mock-e2e`
 * 与 `rfc359-w7-integration-composition-roots` 仍取它；删除见 RFC-502 design §8。
 */
export function composeApprovalGatewayRunnerFor(
  db: PersistenceDb,
  options: { readonly approvalMockUrl?: string } = {},
) {
  const store = createDevelopmentAdapterStore(db)
  const resolveBinding = createAsyncDbAdapterBindingResolver((id, revision) =>
    store.getRevision(id, revision),
  )
  const secretSource = Object.freeze({ ...process.env })
  const mockUrl = options.approvalMockUrl ?? process.env.AW_APPROVAL_MOCK_URL
  return createDevelopmentApprovalGateway(
    createApprovalExecutionAdapter({
      resolveBinding,
      secretSource,
      ...(mockUrl === undefined ? {} : { extraEnv: { AW_APPROVAL_MOCK_URL: mockUrl } }),
    }),
  )
}

export function composeSelectedApprovalGatewayRunnerFor(
  db: PersistenceDb,
  binding: ApprovalAdapterBinding,
) {
  const store = createDevelopmentAdapterStore(db)
  return createDevelopmentApprovalGateway(
    createSelectedApprovalExecutionAdapter({
      resolveBinding: createAsyncDbAdapterBindingResolver((id, revision) =>
        store.getRevision(id, revision),
      ),
      binding,
    }),
  )
}
