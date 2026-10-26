import {
  hostedContentColumnsInTx,
  hostedObjectOf,
  contentRefOf,
} from '@/platform/content/infrastructure/contentStore'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { eq } from 'drizzle-orm'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { HostedStoredObject } from '@/platform/crewstation/objectStorage'

/** Publication owner of development evidence blobs and bundles. */
export const DEVELOPMENT_EVIDENCE_OWNER = 'development-evidence'

export interface DevelopmentObjectIndex {
  find(reference: string): Promise<HostedStoredObject | null>
}

/** The index row commits in the ready transaction of its publication. */
export async function retainDevelopmentObjectInTx(
  tx: PersistenceDb,
  reference: string,
  object: HostedStoredObject,
): Promise<void> {
  const { developmentObjectArtifacts } = tablesOf(tx)
  await tx
    .insert(developmentObjectArtifacts)
    .values({
      reference,
      ...(await hostedContentColumnsInTx(tx, object)),
      digest: object.sha256,
      size: object.size,
      createdAt: Date.now(),
    })
    .onConflictDoNothing()
  const [saved] = await tx
    .select()
    .from(developmentObjectArtifacts)
    .where(eq(developmentObjectArtifacts.reference, reference))
    .limit(1)
  if (
    saved?.digest !== object.sha256 ||
    saved.size !== object.size ||
    hostedObjectOf(contentRefOf(saved)).id !== object.id
  )
    throw new Error('hosted-development-artifact-content-changed')
}

/** Only immutable object receipts are committed here, after upload and pin. */
export function createDevelopmentObjectIndex(input: {
  readonly db: PersistenceDb
}): DevelopmentObjectIndex {
  return {
    async find(reference) {
      const { developmentObjectArtifacts } = tablesOf(input.db)
      const row = (
        await input.db
          .select()
          .from(developmentObjectArtifacts)
          .where(eq(developmentObjectArtifacts.reference, reference))
          .limit(1)
      )[0]
      return row === undefined ? null : hostedObjectOf(contentRefOf(row))
    },
  }
}
