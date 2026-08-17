// RFC-304 §3.1 — the repo × capability matrix, persisted.
//
// One row per (repo, capability): is it on, which binding runs it, which events
// wake it, and the derived readiness. `deriveReadiness` decides the state; this
// module's job is to store it and to answer the one question the webhook path
// asks on every delivery — "does this repo want this capability?"
//
// ## Why readiness is written, not computed on read
//
// The question is asked on the hot path, per delivery, and answering it live
// would mean re-checking a binding, a framework, an agent's visibility and a
// code-host connection before deciding whether to even start. So the derived
// state is stored, and `dependencyRevision` records what it was derived FROM —
// a cell whose revision is behind its dependencies is stale, and callers can
// tell rather than trusting a cached `ready` forever (see `isReadinessFresh`).
//
// ## Why `wantsCapability` requires `ready` and not merely `enabled`
//
// `enabled` is a person's intent; `ready` is whether acting on that intent can
// work. Starting a round for an enabled-but-misconfigured cell produces a task
// that fails at some later stage, on the MR, in front of the author — when the
// honest answer was available before anything started.

import { and, eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { DbClient } from '@/db/client'
import { repoCapabilityConfig } from '@/db/schema'
import {
  deriveReadiness,
  type ReadinessInput,
  type ReadinessIssue,
  type ReadinessState,
} from '@/modules/code-capability/domain/templateLayers'

export interface CapabilityCell {
  id: string
  repoId: string
  capability: string
  templateId: string | null
  enabled: boolean
  triggerConfig: Readonly<Record<string, unknown>>
  readiness: ReadinessState
  readinessIssues: readonly ReadinessIssue[]
  dependencyRevision: number
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T
  } catch {
    // A row written by an older shape, or hand-edited. Falling back keeps the
    // matrix readable instead of making one bad row break the whole page.
    return fallback
  }
}

function toCell(row: typeof repoCapabilityConfig.$inferSelect): CapabilityCell {
  return {
    id: row.id,
    repoId: row.repoId,
    capability: row.capability,
    templateId: row.templateId,
    enabled: row.enabled,
    triggerConfig: parseJson<Record<string, unknown>>(row.triggerConfigJson, {}),
    readiness: row.readiness,
    readinessIssues: parseJson<ReadinessIssue[]>(row.readinessIssuesJson, []),
    dependencyRevision: row.dependencyRevision,
  }
}

export async function readCapabilityCell(
  db: DbClient,
  repoId: string,
  capability: string,
): Promise<CapabilityCell | null> {
  const [row] = await db
    .select()
    .from(repoCapabilityConfig)
    .where(
      and(eq(repoCapabilityConfig.repoId, repoId), eq(repoCapabilityConfig.capability, capability)),
    )
    .limit(1)
  return row === undefined ? null : toCell(row)
}

export async function listCapabilityCells(db: DbClient, repoId: string): Promise<CapabilityCell[]> {
  const rows = await db
    .select()
    .from(repoCapabilityConfig)
    .where(eq(repoCapabilityConfig.repoId, repoId))
  return rows.map(toCell)
}

export interface UpsertCellInput {
  repoId: string
  capability: string
  templateId: string | null
  enabled: boolean
  triggerConfig?: Readonly<Record<string, unknown>>
  /** The facts readiness is derived from, gathered by the caller. */
  facts: Omit<ReadinessInput, 'enabled'>
  /** What the facts were read at; a later change makes this cell stale. */
  dependencyRevision: number
  now: number
}

/**
 * Create or update one cell, deriving its readiness from the supplied facts.
 *
 * Readiness is never accepted from the caller — only the facts are. A caller
 * that could pass `readiness: 'ready'` directly would eventually pass it from
 * somewhere that had not checked, and the matrix would show green for a cell
 * that cannot run.
 */
export async function upsertCapabilityCell(
  db: DbClient,
  input: UpsertCellInput,
): Promise<CapabilityCell> {
  const derived = deriveReadiness({ enabled: input.enabled, ...input.facts })
  const triggerConfigJson = JSON.stringify(input.triggerConfig ?? {})
  const readinessIssuesJson = JSON.stringify(derived.issues)

  await db
    .insert(repoCapabilityConfig)
    .values({
      id: ulid(),
      repoId: input.repoId,
      capability: input.capability,
      templateId: input.templateId,
      enabled: input.enabled,
      triggerConfigJson,
      readiness: derived.state,
      readinessIssuesJson,
      dependencyRevision: input.dependencyRevision,
      lastValidatedAt: input.now,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .onConflictDoUpdate({
      // The unique index is (repoId, capability) — the cell's identity. Toggling
      // a capability twice must update one row, not accumulate rows that later
      // disagree about whether it is on.
      target: [repoCapabilityConfig.repoId, repoCapabilityConfig.capability],
      set: {
        templateId: input.templateId,
        enabled: input.enabled,
        triggerConfigJson,
        readiness: derived.state,
        readinessIssuesJson,
        dependencyRevision: input.dependencyRevision,
        lastValidatedAt: input.now,
        updatedAt: input.now,
      },
    })

  const cell = await readCapabilityCell(db, input.repoId, input.capability)
  if (cell === null) throw new Error('capability cell vanished immediately after being written')
  return cell
}

/**
 * Turn a capability off without forgetting how it was configured.
 *
 * Keeps `templateId` and the trigger config: switching off and back on is a
 * routine thing to do while diagnosing, and making it destructive turns a
 * two-second toggle into re-doing the setup.
 */
export async function disableCapabilityCell(
  db: DbClient,
  repoId: string,
  capability: string,
  now: number,
): Promise<CapabilityCell | null> {
  const existing = await readCapabilityCell(db, repoId, capability)
  if (existing === null) return null

  await db
    .update(repoCapabilityConfig)
    .set({
      enabled: false,
      readiness: 'disabled',
      // Cleared with the state: issues describe why an ENABLED cell cannot run,
      // and keeping them on a disabled row shows a list of problems about
      // something nobody asked to run.
      readinessIssuesJson: '[]',
      updatedAt: now,
    })
    .where(
      and(eq(repoCapabilityConfig.repoId, repoId), eq(repoCapabilityConfig.capability, capability)),
    )

  return await readCapabilityCell(db, repoId, capability)
}

/**
 * The question the webhook path asks per delivery: should this repo run this
 * capability right now?
 *
 * `ready` rather than `enabled`, for the reason in the header: an
 * enabled-but-misconfigured cell would start a round that fails later, on the
 * MR, in front of the author.
 */
export async function wantsCapability(
  db: DbClient,
  repoId: string,
  capability: string,
): Promise<boolean> {
  const cell = await readCapabilityCell(db, repoId, capability)
  return cell !== null && cell.enabled && cell.readiness === 'ready'
}
