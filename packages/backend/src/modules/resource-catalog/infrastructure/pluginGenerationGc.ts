// RFC-359 W4-B2 —— 插件世代 GC 的引用读取：一份实现，两个 provider 共用。

import { plugins } from '@/db/schema'
import type { ProviderNeutralDatabase } from '@/db/query'
import type { PluginGenerationReferenceReadPort } from '../application/ports/pluginGenerationGc'

export function createPluginGenerationReferenceReadPort(
  db: ProviderNeutralDatabase,
): PluginGenerationReferenceReadPort {
  return Object.freeze({
    async listReferencedCachedPaths(): Promise<readonly string[]> {
      const rows = await db.select({ cachedPath: plugins.cachedPath }).from(plugins).all()
      return Object.freeze(rows.map((row) => row.cachedPath))
    },
  })
}
