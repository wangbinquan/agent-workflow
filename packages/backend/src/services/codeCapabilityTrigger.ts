// RFC-304 §3.1 — the webhook trigger that backs an enabled capability cell.
//
// Enabling "MR review on this repository" writes a `webhook_triggers` row;
// disabling retracts it. From then on the ordinary dispatch path does the work,
// which is the entire point of routing capabilities through the trigger table
// rather than building a second wake path:
//
//   fire records · stream keys · supersede · circuit breaker · RFC-301
//   attribution — all inherited, none rewritten.
//
// Supersede is the one that actually forced this design. Push three times to
// one MR and the first two rounds must be cancelled; that logic already lives
// on the trigger/fire tables, keyed by stream key. A parallel wake path would
// have had to reimplement it, and a reimplementation that drifts means paying
// for two reviews of code that no longer exists.
//
// ## These rows are platform-owned
//
// They appear in the user's trigger list — deliberately, because "why did this
// MR start a task by itself" should be answerable there — but they are NOT
// editable or deletable from it (`assertTriggerIsUserOwned` below). Deleting
// one would silently switch off a capability from a screen that never mentions
// capabilities, which is precisely the failure mode `CLAUDE.md` legislates
// against. The way to turn it off is the capability matrix.

import { and, eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { DbClient } from '@/db/client'
import { webhookTriggers } from '@/db/schema'
import { ValidationError } from '@/util/errors'
import { DEFAULT_MR_REVIEW_EVENTS } from '@/modules/code-capability/domain/capabilityWake'

/** Marks a trigger row as owned by a capability cell rather than by a person. */
export const CAPABILITY_LAUNCH_KIND = 'code-round' as const

/**
 * The display name a capability's trigger carries.
 *
 * Includes the capability and the repository so the trigger list can be read
 * without cross-referencing anything — a row called "auto" would send someone
 * hunting for what produced it.
 */
export function capabilityTriggerName(capability: string, repoId: string): string {
  return `${capability} · ${repoId}`
}

export interface SyncCapabilityTriggerInput {
  db: DbClient
  endpointId: string
  repoId: string
  capability: string
  ownerUserId: string
  /** Which events wake it; defaults to the capability's narrow set. */
  events?: readonly string[]
  now: number
}

/**
 * Create or update the trigger backing an enabled cell.
 *
 * Idempotent on (endpoint, repo, capability): toggling a capability twice must
 * leave one row, not accumulate rows that then fire the same round twice per
 * delivery.
 */
export async function syncCapabilityTrigger(
  input: SyncCapabilityTriggerInput,
): Promise<{ triggerId: string; created: boolean }> {
  const existing = await findCapabilityTrigger(input.db, {
    endpointId: input.endpointId,
    repoId: input.repoId,
    capability: input.capability,
  })

  const events = [...(input.events ?? DEFAULT_MR_REVIEW_EVENTS)]
  const values = {
    name: capabilityTriggerName(input.capability, input.repoId),
    endpointId: input.endpointId,
    ownerUserId: input.ownerUserId,
    enabled: true,
    // `exact` with a single path — a cell is ONE repository, not a prefix.
    // (`kind: 'path'` is not a member of WebhookRepoScopeSchema; writing it made
    // the row unparsable, and an unparsable trigger is SKIPPED silently by the
    // dispatcher, so the capability would simply never fire.)
    repoScope: JSON.stringify({ kind: 'exact', paths: [input.repoId] }),
    eventTypes: JSON.stringify(events),
    launchKind: CAPABILITY_LAUNCH_KIND,
    // The capability IS the target. There is no workflow/agent row to point at:
    // the stage contract is platform-owned and selected by this name.
    launchRefId: input.capability,
    launchPayload: JSON.stringify({ capability: input.capability }),
    // RFC-292 syntax: the round reads `trigger.webhook.*` out of the frozen
    // context, so a row written today must not claim the historical flat shape.
    templateSyntaxVersion: 2,
    // A round prepares its own worktree from the MR head, so registering the
    // event's repository would clone something it immediately replaces.
    autoRegisterRepos: false,
    updatedAt: input.now,
  }

  if (existing !== null) {
    await input.db.update(webhookTriggers).set(values).where(eq(webhookTriggers.id, existing))
    return { triggerId: existing, created: false }
  }

  const id = ulid()
  await input.db.insert(webhookTriggers).values({ id, createdAt: input.now, ...values })
  return { triggerId: id, created: true }
}

/** The trigger backing a cell, or null. */
export async function findCapabilityTrigger(
  db: DbClient,
  key: { endpointId: string; repoId: string; capability: string },
): Promise<string | null> {
  const rows = await db
    .select({ id: webhookTriggers.id, repoScope: webhookTriggers.repoScope })
    .from(webhookTriggers)
    .where(
      and(
        eq(webhookTriggers.endpointId, key.endpointId),
        eq(webhookTriggers.launchKind, CAPABILITY_LAUNCH_KIND),
        eq(webhookTriggers.launchRefId, key.capability),
      ),
    )
  // `repoScope` is JSON, so the repo dimension is filtered here rather than in
  // SQL. The candidate set is one row per capability per endpoint, so this is
  // a scan of a handful of rows, not a table sweep.
  for (const row of rows) {
    try {
      const scope: unknown = JSON.parse(row.repoScope)
      const paths =
        typeof scope === 'object' && scope !== null
          ? (scope as { paths?: unknown }).paths
          : undefined
      if (Array.isArray(paths) && paths.includes(key.repoId)) return row.id
    } catch {
      continue
    }
  }
  return null
}

/**
 * Retract the trigger when a capability is switched off.
 *
 * Deletes rather than disables: a disabled row left in the trigger list is a
 * thing a person can re-enable, which would start rounds for a capability the
 * matrix says is off — two switches for one behaviour, disagreeing.
 */
export async function retractCapabilityTrigger(
  db: DbClient,
  key: { endpointId: string; repoId: string; capability: string },
): Promise<boolean> {
  const id = await findCapabilityTrigger(db, key)
  if (id === null) return false
  await db.delete(webhookTriggers).where(eq(webhookTriggers.id, id))
  return true
}

/**
 * Refuse a user-facing edit or delete of a platform-owned trigger.
 *
 * Called by the trigger service's mutation paths. The message names where the
 * switch actually lives, because a bare "forbidden" leaves someone clicking the
 * same disabled button.
 */
export async function assertTriggerIsUserOwned(db: DbClient, triggerId: string): Promise<void> {
  const [row] = await db
    .select({ launchKind: webhookTriggers.launchKind, launchRefId: webhookTriggers.launchRefId })
    .from(webhookTriggers)
    .where(eq(webhookTriggers.id, triggerId))
    .limit(1)
  if (row === undefined || row.launchKind !== CAPABILITY_LAUNCH_KIND) return
  throw new ValidationError(
    'webhook-trigger-platform-owned',
    `this trigger is managed by the '${row.launchRefId}' capability for its repository — turn the capability off in the capability configuration rather than editing or deleting the trigger`,
  )
}
