import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { CapabilityParamRead } from '../application/ports/capabilityParamRead'
import { createCapabilityParamRead } from '../infrastructure/capabilityParamRead'

export interface LegacyCodeReadProviders {
  readonly capabilityParams: CapabilityParamRead
}

/**
 * RFC-359：此前是两个**函数体逐字相同**的孪生，唯一差别是形参上 `db` 的声明类型——
 * 两个读端口本来就都收中立客户端。收成一份（plan §5ds）。
 */
export function composeLegacyCodeReadProviders(db: PersistenceDb): LegacyCodeReadProviders {
  return Object.freeze({
    capabilityParams: createCapabilityParamRead(db),
  })
}
