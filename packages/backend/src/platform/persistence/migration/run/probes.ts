// RFC-395 II-b W0: each owner implements probes; A collects them. Dormant, read-only.
import type { ReadOnlyProbe } from './types'

export const READ_ONLY_PROBE_OWNERS = [
  'code-capability',
  'collaboration',
  'development-automation',
  'digital-employee',
  'event-center',
  'identity-access',
  'integration',
  'intent',
  'knowledge-evolution',
  'memory',
  'resource-catalog',
  'run-observability',
  'runtime-management',
  'source-control',
  'system-operations',
  'task-execution',
  'platform/committed-events',
  'platform/content',
] as const
export type ReadOnlyProbeOwner = (typeof READ_ONLY_PROBE_OWNERS)[number]
export interface ReadOnlyProbeContribution {
  readonly owner: ReadOnlyProbeOwner
  readonly probes: readonly ReadOnlyProbe[]
}

/** Each owner exports `readOnlyProbes: readonly ReadOnlyProbe[]` from
 * <module>/infrastructure/migration/probes.ts (platform owners use their own root).
 * IDs are <owner>:<local-id>; result.id must equal probe.id. The owner re-exports
 * through composition; A explicitly supplies those arrays here and passes the result
 * to V3 validation/health. No glob loading, ordinary recovery, maintenance or effects.
 * Collection preserves A's owner order and each owner's probe order; it executes none.
 */
export function collectReadOnlyProbes(
  contributions: readonly ReadOnlyProbeContribution[],
): readonly ReadOnlyProbe[] {
  const owners = new Set<ReadOnlyProbeOwner>()
  const ids = new Set<string>()
  const probes: ReadOnlyProbe[] = []
  for (const contribution of contributions) {
    if (owners.has(contribution.owner))
      throw new Error(`migration-probe-owner-duplicate:${contribution.owner}`)
    owners.add(contribution.owner)
    const prefix = `${contribution.owner}:`
    for (const probe of contribution.probes) {
      if (!probe.id.startsWith(prefix) || probe.id.length === prefix.length)
        throw new Error(`migration-probe-id-owner-mismatch:${probe.id}`)
      if (ids.has(probe.id)) throw new Error(`migration-probe-id-duplicate:${probe.id}`)
      ids.add(probe.id)
      probes.push(probe)
    }
  }
  return Object.freeze(probes)
}
