// RFC-304 §11.6 T63 — turning a capability on across 200 repositories.
//
// `domain/configScale.ts` decided the shape and the reasoning is worth keeping
// in view here, because the obvious implementation contradicts it: a bulk change
// is an EXPLICIT WRITE TO EACH CELL, not an inherited value. The matrix stays
// the single source of truth, every cell keeps saying what it does, and "bulk"
// is a property of the editing tool rather than of the data model. Inheritance
// would make "why is this repository doing that?" unanswerable locally — the
// cell would show nothing and the value would live somewhere the reader has to
// go find.
//
// The cost of that decision is that a bulk edit is a REAL edit, several hundred
// of them, which is why preview and revert are part of this command rather than
// a later refinement:
//
//   preview — counts creates, updates and no-ops separately. "This will change
//             12 repositories" reads very differently from "this matched 200,
//             188 already set", and the second is what tells the author their
//             selector is wider than they meant.
//   revert  — built from each cell's recorded `before`, so it restores exactly
//             what this batch changed and nothing that landed since.
//
// Each cell goes through `enableCapability`, the same path a single toggle uses.
// A bulk path with its own write would be a second way to configure a cell, and
// the two would disagree the first time either changed.

import { and, eq } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import { repoCapabilityConfig } from '@/db/schema'
import {
  invertBatch,
  previewBulk,
  type BulkPreview,
  type CellChange,
} from '@/modules/code-capability/domain/configScale'
import { gatherReadinessFacts } from '@/modules/code-capability/application/readinessFacts'
import { resolveRepoEndpoint } from '@/modules/code-capability/application/resolveRepoEndpoint'
import { enableCapability } from '@/services/codeCapabilityEnable'
import { lookupStageContract } from '@/modules/code-capability/domain/capabilityRegistry'
import { parseCodeCapabilityId } from '@/modules/code-capability/domain/stageContract'

/**
 * Repositories one request may touch.
 *
 * The design's own example is 200. This bounds the request rather than the
 * ambition: each repository is a cell write plus a trigger sync, and a caller
 * that means to change more than this should say so twice.
 */
export const BULK_REPO_LIMIT = 500

export type BulkEnableResult =
  | { ok: false; code: 'unknown-capability' | 'too-many-repos'; message: string }
  | {
      ok: true
      preview: BulkPreview
      /** Present only when this was an apply. The inverse, for one-click revert. */
      undo?: readonly CellChange[]
      /** Repositories whose write failed, with the reason. Never silent. */
      failures: ReadonlyArray<{ repoId: string; message: string }>
    }

export interface BulkEnableInput {
  repoIds: readonly string[]
  capability: string
  enabled: boolean
  bindingId?: string | null
  actorUserId: string
  /** True to answer what WOULD happen without writing anything. */
  preview: boolean
}

/** The cell as it stands, or null when the repository has none for this capability. */
async function currentCell(
  db: DbClient,
  repoId: string,
  capability: string,
): Promise<{ enabled: boolean; bindingId: string | null } | null> {
  const [match] = await db
    .select({ enabled: repoCapabilityConfig.enabled, bindingId: repoCapabilityConfig.bindingId })
    .from(repoCapabilityConfig)
    .where(
      and(eq(repoCapabilityConfig.repoId, repoId), eq(repoCapabilityConfig.capability, capability)),
    )
    .limit(1)
  return match === undefined ? null : { enabled: match.enabled, bindingId: match.bindingId }
}

export function createBulkEnableCommand(db: DbClient, now?: () => number) {
  return {
    async run(input: BulkEnableInput): Promise<BulkEnableResult> {
      const capability = parseCodeCapabilityId(input.capability)
      if (capability === undefined || lookupStageContract(capability) === undefined) {
        return {
          ok: false,
          code: 'unknown-capability',
          message: `no capability named '${input.capability}' exists`,
        }
      }
      if (input.repoIds.length > BULK_REPO_LIMIT) {
        return {
          ok: false,
          code: 'too-many-repos',
          message: `this request names ${String(input.repoIds.length)} repositories; the limit is ${String(BULK_REPO_LIMIT)}`,
        }
      }

      const after = { enabled: input.enabled, bindingId: input.bindingId ?? null }
      const changes: CellChange[] = []
      for (const repoId of [...new Set(input.repoIds)]) {
        changes.push({
          repoId,
          capability: input.capability,
          before: await currentCell(db, repoId, input.capability),
          after,
        })
      }

      const preview = previewBulk(changes)
      if (input.preview) return { ok: true, preview, failures: [] }

      // Apply. No-ops are skipped rather than re-written: an "edit" that stamps
      // `updatedAt` on 188 unchanged rows makes the audit trail useless for
      // finding what actually changed.
      const failures: Array<{ repoId: string; message: string }> = []
      const applied: CellChange[] = []
      for (const change of [...preview.creates, ...preview.updates]) {
        const endpoint = await resolveRepoEndpoint(db, change.repoId)
        if (!endpoint.ok) {
          failures.push({ repoId: change.repoId, message: endpoint.message })
          continue
        }
        try {
          const facts = await gatherReadinessFacts({
            db,
            repoId: change.repoId,
            capability: input.capability,
            endpointId: endpoint.endpointId,
            bindingId: change.after.bindingId,
            enabled: change.after.enabled,
            provider: endpoint.provider,
          })
          const { enabled: _enabled, ...factsWithoutEnabled } = facts
          await enableCapability({
            db,
            endpointId: endpoint.endpointId,
            ownerUserId: input.actorUserId,
            repoId: change.repoId,
            capability: input.capability,
            bindingId: change.after.bindingId,
            enabled: change.after.enabled,
            facts: factsWithoutEnabled,
            dependencyRevision: 1,
            now: (now ?? Date.now)(),
          })
          applied.push(change)
        } catch (err: unknown) {
          // Collected, not thrown: one repository that cannot be written must
          // not abandon the other 199 half-done, and the caller needs the list
          // to decide whether to retry or investigate.
          failures.push({
            repoId: change.repoId,
            message: err instanceof Error ? err.message : String(err),
          })
        }
      }

      // The inverse of what ACTUALLY landed, not of what was asked for — a
      // revert built from the request would try to undo the failures too.
      return { ok: true, preview, undo: invertBatch(applied), failures }
    },
  }
}
