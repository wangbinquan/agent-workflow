import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { createDevelopmentToolConnectionCatalog } from '../application/developmentToolConnectionCatalog'
import { createDevelopmentToolConnectionStore } from '../infrastructure/developmentToolConnectionStore'

// RFC-359 AC-1（plan §5ft）：store 合一之后这里也只剩一份——两个 bootstrap 根装的是同一个。
// RFC-502（RFC-294 S10 第九步）：目录的实现迁入 `application/developmentToolConnectionCatalog.ts`，这里只按 `PersistenceDb` 建 store。
export function composeDevelopmentToolConnectionCatalog(db: PersistenceDb) {
  return createDevelopmentToolConnectionCatalog(createDevelopmentToolConnectionStore(db))
}
