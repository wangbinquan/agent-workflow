import type { ProviderNeutralDatabase } from '@/db/query'
import {
  createCodeCapabilityDemoSeedParticipant,
  type CodeCapabilityDemoSeedParticipant,
  type CodeCapabilityDemoSeedReceipt,
} from '../application/demoSeed'
import { createCodeCapabilityDemoSeedPersistence } from '../infrastructure/demoSeedPersistence'

export type { CodeCapabilityDemoSeedParticipant, CodeCapabilityDemoSeedReceipt }

/**
 * RFC-359：此前是两个**函数体逐字相同**的孪生，唯一差别是形参上 `db` 的声明类型——
 * 而 `createCodeCapabilityDemoSeedPersistence` 本来就收中立客户端。收成一份（plan §5ds）。
 */
export function composeCodeCapabilityDemoSeedParticipant(
  db: ProviderNeutralDatabase,
): CodeCapabilityDemoSeedParticipant {
  return createCodeCapabilityDemoSeedParticipant(createCodeCapabilityDemoSeedPersistence(db))
}
