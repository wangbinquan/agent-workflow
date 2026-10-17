import { and, eq } from 'drizzle-orm'
import type { ProviderNeutralDatabase } from '@/db/query'
import { pluginArtifactGenerations } from '@/db/schema'

/** Publication and retirement lock the same generation before touching its
 * current pointer. A generation which GC has claimed cannot be republished. */
export async function assertHostedPluginPublicationInTx(
  tx: ProviderNeutralDatabase,
  pluginId: string,
  cachedPath: string,
): Promise<void> {
  if (!cachedPath.startsWith('cs-plugin:')) return
  const match = /^(cs-plugin:([A-Za-z0-9_-]+)\/[A-Za-z0-9_-]+)(?:\/[^/]+)?$/.exec(cachedPath)
  if (!match || match[2] !== pluginId) throw new Error('hosted-plugin-publication-owner-mismatch')
  const locked = await tx
    .update(pluginArtifactGenerations)
    .set({ state: 'ready' })
    .where(
      and(
        eq(pluginArtifactGenerations.reference, match[1]!),
        eq(pluginArtifactGenerations.state, 'ready'),
      ),
    )
    .returning({ reference: pluginArtifactGenerations.reference })
  if (locked.length !== 1) throw new Error('hosted-plugin-generation-not-ready')
}
