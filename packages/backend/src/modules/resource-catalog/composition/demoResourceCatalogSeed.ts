import type { ProviderNeutralDatabase } from '@/db/query'
import { createDemoResourceCatalogSeedParticipant } from '../application/demoResourceCatalogSeed'
import { createDemoResourceCatalogSeedPersistence } from '../infrastructure/demoResourceCatalogSeed'
import type { DemoResourceCatalogSeedParticipant } from '../public/participants'

/**
 * RFC-359：此前是两个**函数体逐字相同**的孪生，唯一差别是形参上 `db` 的声明类型——
 * 而 `createDemoResourceCatalogSeedPersistence` 本来就收中立客户端。收成一份（plan §5ds）。
 */
export function composeDemoResourceCatalogSeedParticipant(
  db: ProviderNeutralDatabase,
): DemoResourceCatalogSeedParticipant {
  return createDemoResourceCatalogSeedParticipant(createDemoResourceCatalogSeedPersistence(db))
}
