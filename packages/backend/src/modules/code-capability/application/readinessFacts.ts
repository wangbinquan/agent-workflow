// RFC-304 T31b — establishing whether a capability can actually run.
//
// `deriveReadiness` is a pure function over facts, and until now nothing
// produced those facts: every caller was a test handing in whatever answer it
// wanted. So a cell's readiness was a claim rather than an observation, and a
// repository could sit at `ready` with no binding, no trigger and no agent —
// the exact state readiness exists to make visible.
//
// Each fact here is one question asked of the database, and each is asked the
// way the thing it is checking will actually be used at round time. That
// matters more than it sounds: checking "a binding is selected" while the round
// resolves "an agent visible to this repo for this slot" would report ready and
// then fail on the MR, in front of the author.

import { eq } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import { capabilityBindings, capabilityFrameworks } from '@/db/schema'
import { lookupStageContract } from '@/modules/code-capability/domain/capabilityRegistry'
import { parseCodeCapabilityId } from '@/modules/code-capability/domain/stageContract'
import type { ReadinessInput } from '@/modules/code-capability/domain/templateLayers'
import { resolveCodeHostEndpointId } from '@/modules/code-capability/composition/mrReviewEnvironment'
import { findCapabilityTrigger } from '@/services/codeCapabilityTrigger'
import { resolveAgentForBinding } from '@/services/codeReviewAgentCaller'

/**
 * Capabilities that cannot be woken by anything else.
 *
 * `ci-fix` is the design's named case (AC-14d): without a wake source it would
 * show `ready` while nothing could ever start it — the worst readiness answer,
 * because it is confidently wrong. `mr-review` is woken by ordinary MR events,
 * so it does not need one.
 */
const NEEDS_WAKE_SOURCE = new Set(['ci-fix'])

export interface GatherFactsInput {
  db: DbClient
  repoId: string
  capability: string
  /** The endpoint this repository's events arrive on. */
  endpointId: string
  /** The binding about to be saved, when checking a not-yet-written cell. */
  bindingId: string | null
  enabled: boolean
  provider?: 'gitlab' | 'github'
}

/**
 * Ask the database every question `deriveReadiness` needs.
 *
 * Returns facts, not a verdict: the verdict is the domain's, and keeping the
 * split means the interesting rules (what counts as ready, which issue each
 * gap produces) stay testable without a database.
 */
export async function gatherReadinessFacts(input: GatherFactsInput): Promise<ReadinessInput> {
  const { db } = input
  const hasBinding = input.bindingId !== null && input.bindingId !== ''

  let frameworkExists = false
  if (hasBinding) {
    const [binding] = await db
      .select({ frameworkId: capabilityBindings.frameworkId })
      .from(capabilityBindings)
      .where(eq(capabilityBindings.id, input.bindingId as string))
      .limit(1)
    if (binding !== undefined) {
      const [framework] = await db
        .select({ id: capabilityFrameworks.id })
        .from(capabilityFrameworks)
        .where(eq(capabilityFrameworks.id, binding.frameworkId))
        .limit(1)
      frameworkExists = framework !== undefined
    }
  }

  const triggerId = await findCapabilityTrigger(db, {
    endpointId: input.endpointId,
    repoId: input.repoId,
    capability: input.capability,
  })

  // The same resolution the round performs. An enabled endpoint for the
  // provider IS the code-host identity a round keys its ledger to, so asking
  // any other question here would let a cell pass a check the round then fails.
  const endpoint = await resolveCodeHostEndpointId(db, input.provider ?? 'gitlab')

  return {
    enabled: input.enabled,
    hasBinding,
    frameworkExists,
    hasTrigger: triggerId !== null,
    codeHostConfigured: endpoint.ok,
    invisibleAgentSlots: await invisibleSlots(db, input),
    requiresWakeSource: NEEDS_WAKE_SOURCE.has(input.capability),
    // Whatever wakes this capability other than an MR event. Nothing supplies
    // one yet (the wake entry point is PR-6 T35c), so for the capabilities that
    // need it this is honestly false rather than optimistically true — a `ready`
    // that cannot start is worse than a `misconfigured` that says why.
    hasWakeSource: false,
  }
}

/**
 * Agent slots this capability declares that cannot be resolved for this repo.
 *
 * Read from the CONTRACT rather than from the binding: the question is "does
 * every slot the sequence will ask for resolve", and a binding that maps a slot
 * the contract does not declare is harmless, while a contract slot the binding
 * has not mapped is a round that dies at that stage.
 */
async function invisibleSlots(db: DbClient, input: GatherFactsInput): Promise<string[]> {
  const capability = parseCodeCapabilityId(input.capability)
  const contract = capability === undefined ? undefined : lookupStageContract(capability)
  if (contract === undefined) return []

  const slots = [
    ...new Set(contract.stages.flatMap((stage) => (stage.kind === 'ai' ? [stage.agentSlot] : []))),
  ].sort()

  // Resolved against the binding being SAVED, not the one currently stored.
  // On a first save nothing is stored yet, so reading the cell reported every
  // slot invisible and the capability could only become ready on a SECOND save
  // — "press it twice", with nothing on screen explaining why.
  if (input.bindingId === null || input.bindingId === '') return [...slots]

  const invisible: string[] = []
  for (const slot of slots) {
    const resolved = await resolveAgentForBinding(db, { bindingId: input.bindingId, slot })
    if (!resolved.ok) invisible.push(slot)
  }
  return invisible
}
