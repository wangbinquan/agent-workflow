import type { DbClient } from '@/db/client'
import type { RuntimeRegistryPersistence } from '@/platform/runtime-registry/application/runtimeRegistryOperations'
import { DrizzleRuntimeRegistryPersistence } from '@/platform/runtime-registry/infrastructure/runtimeRegistryPersistence'

/**
 * 给 service 层的存量 runtime-registry 用例绑一个持久化实现。
 * RFC-359 W4-D28b 之后只有一份中立实现，两个引擎共用；这里传的是本地 SQLite 句柄。
 */
export function runtimeRegistryPersistence(db: DbClient): RuntimeRegistryPersistence {
  return new DrizzleRuntimeRegistryPersistence(db)
}
