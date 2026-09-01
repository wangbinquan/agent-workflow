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

import { eq } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import { repoCapabilityConfig } from '@/db/schema'
import { gatherReadinessFacts } from '@/modules/code-capability/application/readinessFacts'
import { resolveRepoEndpoint } from '@/modules/code-capability/application/resolveRepoEndpoint'
import type {
  CapabilityMatrixReadPort,
  CapabilityMatrixReadRow,
} from '@/modules/code-capability/application/ports/capabilityMatrixRead'
import {
  type ReadinessIssue,
  type ReadinessState,
} from '@/modules/code-capability/domain/templateLayers'
import { createSqliteReadinessFactsRead } from './sqliteReadinessFactsRead'

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

export async function listCapabilityCells(db: DbClient, repoId: string): Promise<CapabilityCell[]> {
  const rows = await db
    .select()
    .from(repoCapabilityConfig)
    .where(eq(repoCapabilityConfig.repoId, repoId))
  return rows.map(toCell)
}

export function createSqliteCapabilityMatrixRead(db: DbClient): CapabilityMatrixReadPort {
  const readiness = createSqliteReadinessFactsRead(db)
  return {
    async loadForRepo(repoId) {
      const cells = await listCapabilityCells(db, repoId)
      if (cells.length === 0) return []
      const endpoint = await resolveRepoEndpoint(readiness.repoEndpoints, repoId)
      return await Promise.all(
        cells.map(
          async (cell): Promise<CapabilityMatrixReadRow> => ({
            repoId: cell.repoId,
            capability: cell.capability,
            templateId: cell.templateId,
            enabled: cell.enabled,
            facts: await gatherReadinessFacts({
              reader: readiness,
              repoId,
              capability: cell.capability,
              endpointId: endpoint.ok ? endpoint.endpointId : '',
              templateId: cell.templateId,
              enabled: cell.enabled,
              ...(endpoint.ok ? { provider: endpoint.provider } : {}),
            }),
          }),
        ),
      )
    },
  }
}
