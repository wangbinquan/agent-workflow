import { eq } from 'drizzle-orm'
import type { ProviderNeutralDatabase } from '@/db/query'
import { developmentObjectArtifacts } from '@/db/schema'
import type { HostedStoredObject } from '@/platform/crewstation/objectStorage'

/** Publication owner of development evidence blobs and bundles. */
export const DEVELOPMENT_EVIDENCE_OWNER = 'development-evidence'

export interface DevelopmentObjectIndex {
  find(reference: string): Promise<HostedStoredObject | null>
}

/** The index row commits in the ready transaction of its publication. */
export async function retainDevelopmentObjectInTx(
  tx: ProviderNeutralDatabase,
  reference: string,
  object: HostedStoredObject,
): Promise<void> {
  await tx
    .insert(developmentObjectArtifacts)
    .values({
      reference,
      objectId: object.id,
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
  if (saved?.digest !== object.sha256 || saved.size !== object.size || saved.objectId !== object.id)
    throw new Error('hosted-development-artifact-content-changed')
}

/** Only immutable object receipts are committed here, after upload and pin. */
export function createDevelopmentObjectIndex(input: {
  readonly db: ProviderNeutralDatabase
}): DevelopmentObjectIndex {
  return {
    async find(reference) {
      const row = (
        await input.db
          .select()
          .from(developmentObjectArtifacts)
          .where(eq(developmentObjectArtifacts.reference, reference))
          .limit(1)
      )[0]
      return row === undefined ? null : { id: row.objectId, sha256: row.digest, size: row.size }
    },
  }
}
