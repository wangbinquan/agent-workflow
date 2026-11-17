// RFC-344 — integration-owned configuration participant for bootstrap wiring.
// RFC-359 W4-D6：一份实现，两个 provider 共用。
// RFC-502（RFC-294 S10 第九步）：六个配置操作的实现迁入 `application/developmentAdapterConfigOperations.ts`；这里只按
// `PersistenceDb` 建 store、给缺省时钟。

import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import {
  createDevelopmentAdapterConfigOperations,
  type DevelopmentAdapterAccess,
  type DevelopmentAdapterGrantReads,
} from '../application/developmentAdapterConfigOperations'
import { createDevelopmentAdapterStore } from '../infrastructure/developmentAdapterStore'

export interface DevelopmentAdapterConfigCompositionInput {
  readonly db: PersistenceDb
  readonly access: DevelopmentAdapterAccess
  readonly grants: DevelopmentAdapterGrantReads
  readonly now?: () => number
}

/**
 * 返回形状即 development-automation 的 `DevelopmentConfigResourceOperations` 合同（结构装配，bootstrap 处对齐）；实现在
 * application（RFC-344 单一入口根锁：integration 的配置参与者不反向依赖 development-automation）。
 */
export function composeDevelopmentAdapterConfigOperationsFor(
  input: DevelopmentAdapterConfigCompositionInput,
) {
  return createDevelopmentAdapterConfigOperations({
    store: createDevelopmentAdapterStore(input.db),
    access: input.access,
    grants: input.grants,
    now: input.now ?? (() => Date.now()),
  })
}
