import { join } from 'node:path'

import type { DbClient } from '@/db/client'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import {
  createMissionInputUploadOperations,
  type MissionInputBlobPersistence,
  type MissionInputUploadOperations,
} from '../application/missionInputUploadOperations'
import { EvidenceStore } from '../infrastructure/evidenceStore'
import {
  createPostgresqlMissionInputUploadPersistence,
  createSqliteMissionInputUploadPersistence,
} from '../infrastructure/missionInputUploadPersistence'

function lazyEvidenceBlobs(appHome: string): MissionInputBlobPersistence {
  let evidence: EvidenceStore | undefined
  return {
    async putFile(absolutePath) {
      evidence ??= new EvidenceStore(join(appHome, 'evidence'))
      return await evidence.putBlobFromFile(absolutePath)
    },
  }
}

export function composeSqliteMissionInputUploadOperations(input: {
  readonly db: DbClient
  readonly appHome: string
}): MissionInputUploadOperations {
  return createMissionInputUploadOperations({
    persistence: createSqliteMissionInputUploadPersistence(input.db),
    blobs: lazyEvidenceBlobs(input.appHome),
  })
}

export function composePostgresqlMissionInputUploadOperations(input: {
  readonly db: PostgresqlDatabaseClient
  readonly appHome: string
}): MissionInputUploadOperations {
  return createMissionInputUploadOperations({
    persistence: createPostgresqlMissionInputUploadPersistence(input.db),
    blobs: lazyEvidenceBlobs(input.appHome),
  })
}
