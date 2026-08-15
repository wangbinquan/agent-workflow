// RFC-304 §3.1 — turning a verified webhook delivery into code-round tasks.
//
// The last link: a delivery arrives, the matrix says which capabilities this
// repository has switched on, and each woken cell gets its own round.
//
// Deliberately NOT routed through the workflow trigger table. A trigger is
// something a person wrote for one workflow; a cell is "this repo has MR review
// turned on". Sending capabilities through triggers would make every team
// hand-write the same event list and get it subtly different — and the platform
// could never change the set without editing everybody's rows.
//
// ## Why one task per cell rather than one per delivery
//
// `mr-review` and `mr-monitor` on the same MR are two work items (design §2.1),
// with separate ledgers and separate lifecycles. Sharing a task would make one
// capability's failure settle the other's round.

import { ulid } from 'ulid'
import type { DbClient } from '@/db/client'
import { repoCapabilityConfig } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { cellsWokenBy, type WakeableCell } from '@/modules/code-capability/domain/capabilityWake'
import { startCodeRoundTask } from '@/services/codeRoundLaunch'
import type { StartTaskDeps } from '@/services/task'
import type { TriggerContext } from '@agent-workflow/shared'

export interface WakeDeliveryInput {
  db: DbClient
  /** The repo the delivery resolved to — the matrix is keyed by it. */
  repoId: string
  eventType: string
  mrIid?: string | undefined
  authorUsername?: string | undefined
  /** The frozen context each round reads its target from. */
  triggerContext: TriggerContext
  /** Attribution for the launch; RFC-301 requires both ids with a webhook origin. */
  webhookTriggerId: string
  webhookFireId: string
  /** Suppresses self-triggered loops when the platform's account is known. */
  botUsername?: string | undefined
  launchDeps: StartTaskDeps & { db: DbClient }
}

export interface WokenRound {
  capability: string
  taskId: string
  roundId: string
}

export interface WakeResult {
  started: WokenRound[]
  /** Cells that matched but could not start, with the reason. */
  failed: Array<{ capability: string; error: string }>
}

function parseTriggerConfig(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  } catch {
    // A malformed row falls back to the default event set rather than making
    // this repository silently stop responding.
    return {}
  }
}

/**
 * Start a round for every capability this delivery wakes.
 *
 * Never throws: a delivery that woke three cells and failed to launch the
 * second must still launch the third. Failures come back in `failed` so the
 * caller can record them — a launch that vanished with no row is the shape this
 * RFC exists to prevent.
 */
export async function wakeCapabilitiesForDelivery(input: WakeDeliveryInput): Promise<WakeResult> {
  const rows = await input.db
    .select()
    .from(repoCapabilityConfig)
    .where(eq(repoCapabilityConfig.repoId, input.repoId))

  const cells: WakeableCell[] = rows.map((row) => ({
    capability: row.capability,
    enabled: row.enabled,
    readiness: row.readiness,
    triggerConfig: parseTriggerConfig(row.triggerConfigJson),
  }))

  const woken = cellsWokenBy(
    cells,
    {
      eventType: input.eventType,
      mrIid: input.mrIid,
      authorUsername: input.authorUsername,
    },
    { botUsername: input.botUsername },
  )

  const started: WokenRound[] = []
  const failed: Array<{ capability: string; error: string }> = []

  for (const cell of woken) {
    const roundId = ulid()
    try {
      const task = await startCodeRoundTask(
        {
          roundId,
          capability: cell.capability,
          roundSeq: 1,
          name: `${cell.capability} · MR ${input.mrIid ?? '?'}`,
          scratch: true,
        },
        {
          ...input.launchDeps,
          launchProvenance: { kind: 'webhook' },
          webhookTriggerId: input.webhookTriggerId,
          webhookFireId: input.webhookFireId,
          triggerContext: input.triggerContext,
        } as never,
      )
      started.push({ capability: cell.capability, taskId: task.id, roundId })
    } catch (err) {
      failed.push({
        capability: cell.capability,
        error: (err instanceof Error ? err.message : String(err)).slice(0, 500),
      })
    }
  }

  return { started, failed }
}
