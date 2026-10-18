// RFC-304/RFC-375 — shared facts used by the live capability matrix.

import { lookupStageContract } from '@/modules/code-capability/domain/capabilityRegistry'
import { parseCodeCapabilityId } from '@/modules/code-capability/domain/stageContract'

export interface CapabilityTriggerCandidate {
  readonly id: string
  readonly repoScope: string
  readonly eventTypes: string
}

export interface CapabilityTriggerMatch {
  readonly triggerId: string
  readonly events: readonly string[]
}

/** Select one repository's trigger while tolerating malformed legacy JSON. */
export function selectCapabilityTrigger(
  rows: readonly CapabilityTriggerCandidate[],
  repoId: string,
): CapabilityTriggerMatch | null {
  for (const row of rows) {
    try {
      const scope: unknown = JSON.parse(row.repoScope)
      const paths =
        typeof scope === 'object' && scope !== null
          ? (scope as { paths?: unknown }).paths
          : undefined
      if (Array.isArray(paths) && paths.includes(repoId)) {
        let events: string[] = []
        try {
          const parsed: unknown = JSON.parse(row.eventTypes)
          if (Array.isArray(parsed)) {
            events = parsed.filter((e): e is string => typeof e === 'string')
          }
        } catch {
          events = []
        }
        return { triggerId: row.id, events }
      }
    } catch {
      continue
    }
  }
  return null
}

/**
 * Capabilities that cannot be woken by anything else.
 *
 * `ci-fix` is the design's named case (AC-14d): without a wake source it would
 * show `ready` while nothing could ever start it — the worst readiness answer,
 * because it is confidently wrong. `mr-review` is woken by ordinary MR events,
 * so it does not need one.
 */
const NEEDS_WAKE_SOURCE = new Set(['ci-fix'])

export function capabilityRequiresWakeSource(capability: string): boolean {
  return NEEDS_WAKE_SOURCE.has(capability)
}

export function capabilityAgentSlots(capability: string): string[] {
  const parsed = parseCodeCapabilityId(capability)
  const contract = parsed === undefined ? undefined : lookupStageContract(parsed)
  if (contract === undefined) return []
  return [
    ...new Set(contract.stages.flatMap((stage) => (stage.kind === 'ai' ? [stage.agentSlot] : []))),
  ].sort()
}
