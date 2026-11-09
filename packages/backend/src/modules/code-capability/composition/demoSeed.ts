import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import {
  createCodeCapabilityDemoSeedParticipant,
  type CodeCapabilityDemoSeedParticipant,
} from '../application/demoSeed'
import { createCodeCapabilityDemoSeedPersistence } from '../infrastructure/demoSeedPersistence'

// RFC-474: the participant's types are offered from `public/types` (their only outside consumer, the demo seed
// orchestrator, takes them there); this entry composes the participant for bootstrap.

/**
 * RFC-359：此前是两个**函数体逐字相同**的孪生，唯一差别是形参上 `db` 的声明类型——
 * 而 `createCodeCapabilityDemoSeedPersistence` 本来就收中立客户端。收成一份（plan §5ds）。
 */
export function composeCodeCapabilityDemoSeedParticipant(
  db: PersistenceDb,
): CodeCapabilityDemoSeedParticipant {
  return createCodeCapabilityDemoSeedParticipant(createCodeCapabilityDemoSeedPersistence(db))
}
