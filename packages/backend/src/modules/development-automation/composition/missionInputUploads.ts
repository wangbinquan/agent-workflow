import { join } from 'node:path'

import type { ProviderNeutralDatabase } from '@/db/query'
import {
  createMissionInputUploadOperations,
  type MissionInputBlobPersistence,
  type MissionInputUploadOperations,
} from '../application/missionInputUploadOperations'
import { EvidenceStore } from '../infrastructure/evidenceStore'
import { createMissionInputUploadPersistence } from '../infrastructure/missionInputUploadPersistence'

function lazyEvidenceBlobs(appHome: string): MissionInputBlobPersistence {
  let evidence: EvidenceStore | undefined
  return {
    async putFile(absolutePath) {
      evidence ??= new EvidenceStore(join(appHome, 'evidence'))
      return await evidence.putBlobFromFile(absolutePath)
    },
  }
}

/** RFC-359 W4-D11：一份装配，两个 provider 共用（persistence 已是中立实现）。 */
export function composeMissionInputUploadOperations(input: {
  readonly db: ProviderNeutralDatabase
  readonly appHome: string
}): MissionInputUploadOperations {
  return createMissionInputUploadOperations({
    persistence: createMissionInputUploadPersistence(input.db),
    blobs: lazyEvidenceBlobs(input.appHome),
  })
}
