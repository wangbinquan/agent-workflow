// RFC-359 W4-D11 —— 上传输入的 transport 持久化与过期清扫：两份薄适配都建在同一份中立的上传会话 store 上。

import type { ProviderNeutralDatabase } from '@/db/query'
import type { MissionInputUploadPersistence } from '../application/missionInputUploadOperations'
import type { UploadMaintenancePersistence } from '../application/ports/uploadMaintenance'
import { createUploadSessionPersistence } from './uploadSessionStore'

export function createMissionInputUploadPersistence(
  db: ProviderNeutralDatabase,
): MissionInputUploadPersistence {
  const store = createUploadSessionPersistence(db)
  return {
    get: (uploadRef) => store.getUpload(uploadRef),
    create: (input) => store.createUpload(input),
    delete: ({ uploadRef, actorUserId }) => store.deleteUpload(uploadRef, actorUserId),
  }
}

export function createUploadMaintenancePersistence(
  db: ProviderNeutralDatabase,
): UploadMaintenancePersistence {
  const store = createUploadSessionPersistence(db)
  return {
    sweepExpired: (now, limit) => store.sweepExpired(now, limit),
  }
}
