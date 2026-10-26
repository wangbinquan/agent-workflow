import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { contentRefColumns } from '@/platform/content/contentStore'
import {
  canonicalValue,
  encodeMigrationKey,
} from '@/platform/persistence/migration/conversion/migrationKey'
import type { TargetValue } from '@/platform/persistence/migration/conversion/types'

export async function seedNodeRunDisplayEvidence(
  db: PersistenceDb,
  taskId: string,
  id: string,
  values: Readonly<Record<string, TargetValue>> = { retry_index: 7, scope_path: 'legacy:2' },
) {
  const key = encodeMigrationKey('node_runs', [canonicalValue(id)])
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      format: 'node-run-evidence@2',
      sourceRef: { table: 'node_runs', key, phase: 'current' },
      sourceValues: Object.fromEntries(
        Object.entries({ ...values, id, task_id: taskId }).map(([column, value]) => [
          column,
          canonicalValue(value),
        ]),
      ),
      sourceReferences: {},
      codecTakeovers: [],
      detail: {},
    }),
  )
  const ref = contentRefColumns.encode({
    version: 1,
    kind: 'inline',
    bytes,
    location: { codec: 'execution-legacy-evidence@1', value: key },
    contentId: null,
    contentVersion: null,
    sha256: null,
    size: bytes.length,
    mediaType: 'application/json',
  })
  await db.insert(tablesOf(db).executionLegacyEvidence).values({
    taskId,
    recordKind: 'node-run',
    recordId: id,
    sourceContract: 'fixture:epoch-1',
    provenanceQuality: 'unknown',
    missingFieldsJson: '["role"]',
    contentRefJson: ref.json,
    contentInlineBytes: ref.inlineBytes === null ? null : Buffer.from(ref.inlineBytes),
  })
}
