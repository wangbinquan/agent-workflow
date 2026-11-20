import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import {
  createMissionInputUploadOperations,
  type MissionInputBlobPersistence,
  type MissionInputUploadOperations,
} from '../application/missionInputUploadOperations'
import { createMissionInputUploadPersistence } from '../infrastructure/missionInputUploadPersistence'

import type { EvidenceArtifactPort } from '../application/ports/evidenceArtifacts'

export type { MissionInputBlobPersistence }

/**
 * RFC-359 W4-D11：一份装配，两个 provider 共用（persistence 已是中立实现）。
 * RFC-524：证据库由调用方给出（daemon：部署选择的证据库），组合层不再懒建本机证据库。
 */
export function composeMissionInputUploadOperations(input: {
  readonly db: PersistenceDb
  readonly artifacts: EvidenceArtifactPort
}): MissionInputUploadOperations {
  return createMissionInputUploadOperations({
    persistence: createMissionInputUploadPersistence(input.db),
    blobs: input.artifacts,
  })
}
