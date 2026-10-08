import { nativeUsageEvidenceStorage } from './nativeUsageEvidenceStorage'
import { eq } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '@/db/query'
import type { NativeUsageExecutionOwnerBinding as NativeUsageOwnerBinding } from '../application/ports/nativeUsagePersistence'
import { withNativeUsageOwner } from './nativeUsageOwnerTransaction'
import { verifyNativeUsageEmissions } from './nativeUsageEmissionVerification'
import {
  originalNativeRootHead,
  originalNativeRootPage,
  verifyNativeRootSource,
} from './nativeUsageRootSource'

/** The original Task owner freezes source identities before Runtime reads any final root. */
export function createNativeUsageRootCollection(
  db: ProviderNeutralDatabase,
  binding: NativeUsageOwnerBinding,
) {
  const { nativeUsagePreparations, nativeUsageRootSets } = nativeUsageEvidenceStorage(
    binding.sourceKind,
  )

  return {
    async freeze(): Promise<void> {
      await withNativeUsageOwner(db, binding, async (tx, facts) => {
        const prepared = (
          await tx
            .select()
            .from(nativeUsagePreparations)
            .where(eq(nativeUsagePreparations.invocationId, binding.invocationId))
            .limit(1)
        )[0]
        if (!prepared || prepared.fence !== facts.fence)
          throw new Error('Native root collection lost its actual before-spawn owner')
        const source = await verifyNativeRootSource(tx, binding, facts)
        const existing = (
          await tx
            .select()
            .from(nativeUsageRootSets)
            .where(eq(nativeUsageRootSets.invocationId, binding.invocationId))
            .limit(1)
        )[0]
        if (existing) {
          if (existing.nextOrdinal !== source.nextOrdinal || existing.rootDigest !== source.digest)
            throw new Error('Native roots changed after the original frozen watermark')
          return
        }
        const emissions = await verifyNativeUsageEmissions(tx, binding)
        await tx.insert(nativeUsageRootSets).values({
          invocationId: binding.invocationId,
          nextOrdinal: source.nextOrdinal,
          rootDigest: source.digest,
          processWatermark: emissions.emissions.sourceWatermark,
          observedAt: Date.now(),
        })
      })
    },
    async page(after: string | null): Promise<readonly string[]> {
      return withNativeUsageOwner(db, binding, async (tx, facts) => {
        const frozen = (
          await tx
            .select()
            .from(nativeUsageRootSets)
            .where(eq(nativeUsageRootSets.invocationId, binding.invocationId))
            .limit(1)
        )[0]
        if (!frozen) throw new Error('Native roots have no original frozen population')
        // Full source verification happens at freeze and completion. The current original head
        // detects a new successful transition; a caller count or array is never accepted.
        const head = await originalNativeRootHead(tx, binding, facts)
        if (
          (head?.nextOrdinal ?? '0') !== frozen.nextOrdinal ||
          (head && head.digest !== frozen.rootDigest)
        )
          throw new Error('Native root population changed during its final scan')
        return originalNativeRootPage(tx, binding.invocationId, after, binding.sourceKind)
      })
    },
  }
}
