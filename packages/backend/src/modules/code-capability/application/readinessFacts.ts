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

import { and, eq } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import { capabilityTemplates, webhookTriggers } from '@/db/schema'
import { lookupStageContract } from '@/modules/code-capability/domain/capabilityRegistry'
import { parseCodeCapabilityId } from '@/modules/code-capability/domain/stageContract'
import type { ReadinessInput } from '@/modules/code-capability/domain/templateLayers'
import { resolveCodeHostEndpointId } from '@/modules/code-capability/application/resolveRepoEndpoint'
import { resolveAgentForBinding } from '@/services/codeReviewAgentCaller'

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

/** T104 后内联自 services/codeCapabilityTrigger（读面自持，writer 已删）。 */
async function findCapabilityTriggerRow(
  db: DbClient,
  key: { endpointId: string; repoId: string; capability: string },
): Promise<CapabilityTriggerMatch | null> {
  const rows = await db
    .select({
      id: webhookTriggers.id,
      repoScope: webhookTriggers.repoScope,
      eventTypes: webhookTriggers.eventTypes,
    })
    .from(webhookTriggers)
    .where(
      and(
        eq(webhookTriggers.endpointId, key.endpointId),
        eq(webhookTriggers.launchKind, 'code-round'),
        eq(webhookTriggers.launchRefId, key.capability),
      ),
    )
  return selectCapabilityTrigger(rows, key.repoId)
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

export interface GatherFactsInput {
  db: DbClient
  repoId: string
  capability: string
  /** The endpoint this repository's events arrive on. */
  endpointId: string
  /** The template about to be saved, when checking a not-yet-written cell. */
  templateId: string | null
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
  const hasBinding = input.templateId !== null && input.templateId !== ''

  // RFC-309 — one lookup, not two. The old pair asked "does the binding exist"
  // and then "does the framework it names exist", because a cell could point at
  // a binding whose framework had been deleted underneath it. A merged template
  // cannot be half-missing, so `frameworkExists` is now simply "the template
  // this cell points at is still there".
  let frameworkExists = false
  if (hasBinding) {
    const [template] = await db
      .select({ id: capabilityTemplates.id })
      .from(capabilityTemplates)
      .where(eq(capabilityTemplates.id, input.templateId as string))
      .limit(1)
    frameworkExists = template !== undefined
  }

  const trigger = await findCapabilityTriggerRow(db, {
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
    hasTrigger: trigger !== null,
    codeHostConfigured: endpoint.ok,
    invisibleAgentSlots: await invisibleSlots(db, input),
    requiresWakeSource: capabilityRequiresWakeSource(input.capability),
    // What can start this capability, given it is not woken by an MR event.
    //
    // This was hardcoded `false` while the wake entry point (T35c) was believed
    // mandatory — which meant `ci-fix`, the only capability requiring one, was
    // permanently `misconfigured` and could never run at all. Proposal
    // §6ter-H1 settled that: the pipelines are GitLab-triggered and GitLab
    // already produces a pipeline object, so «链路本来就通» and T35c was demoted
    // to optional with «PR-9 范围不变». The placeholder outlived the ruling.
    //
    // Derived rather than assumed, so both directions stay honest: an ordinary
    // cell subscribed to pipeline events can be started and reads `ready`,
    // while one whose events were narrowed to exclude them still reports
    // `no-wake-source` — which is exactly the case AC-14d put the rule there
    // for. A `ready` that cannot start remains the worst possible answer.
    hasWakeSource: (trigger?.events ?? []).some((event) => event.startsWith('pipeline_')),
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
  const slots = capabilityAgentSlots(input.capability)

  // Resolved against the binding being SAVED, not the one currently stored.
  // On a first save nothing is stored yet, so reading the cell reported every
  // slot invisible and the capability could only become ready on a SECOND save
  // — "press it twice", with nothing on screen explaining why.
  if (input.templateId === null || input.templateId === '') return [...slots]

  const invisible: string[] = []
  for (const slot of slots) {
    const resolved = await resolveAgentForBinding(db, { templateId: input.templateId, slot })
    if (!resolved.ok) invisible.push(slot)
  }
  return invisible
}
