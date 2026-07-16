// RFC-030 — persistence layer for mcp_probes rows.
//
// Three operations:
//   - listProbes(db)               → all probes (JOIN to mcps for mcpName)
//   - getProbe(db, name)           → one probe by parent mcp name (null if none)
//   - upsertProbe(db, mcpId, result) → INSERT or REPLACE (UNIQUE(mcp_id))
//
// The wire shape we return matches `McpProbeSchema` (shared/mcpProbe.ts);
// rowToProbe is the only place where stored JSON strings get re-parsed.

import type { McpProbe } from '@agent-workflow/shared'
import { McpProbeSchema } from '@agent-workflow/shared'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { DbClient } from '@/db/client'
import { mcpProbes, mcps } from '@/db/schema'
import type { ProbeResult } from '@/services/mcpProbe'
import { ValidationError } from '@/util/errors'

type ProbeRow = typeof mcpProbes.$inferSelect

export async function listProbes(db: DbClient): Promise<McpProbe[]> {
  const rows = await db
    .select({
      probe: mcpProbes,
      mcpName: mcps.name,
    })
    .from(mcpProbes)
    .innerJoin(mcps, eq(mcpProbes.mcpId, mcps.id))
  // Stable sort by mcpName so the front-end list page renders deterministically
  // and tests don't have to special-case ordering.
  rows.sort((a, b) => a.mcpName.localeCompare(b.mcpName))
  return rows.map((r) => rowToProbe(r.probe, r.mcpName))
}

export async function getProbe(db: DbClient, mcpName: string): Promise<McpProbe | null> {
  const rows = await db
    .select({ probe: mcpProbes, mcpName: mcps.name })
    .from(mcpProbes)
    .innerJoin(mcps, eq(mcpProbes.mcpId, mcps.id))
    .where(eq(mcps.name, mcpName))
    .limit(1)
  const r = rows[0]
  return r === undefined ? null : rowToProbe(r.probe, r.mcpName)
}

/** Stable-id variant used by the operation coordinator across renames. */
export async function getProbeByMcpId(db: DbClient, mcpId: string): Promise<McpProbe | null> {
  const rows = await db
    .select({ probe: mcpProbes, mcpName: mcps.name })
    .from(mcpProbes)
    .innerJoin(mcps, eq(mcpProbes.mcpId, mcps.id))
    .where(eq(mcpProbes.mcpId, mcpId))
    .limit(1)
  const row = rows[0]
  return row === undefined ? null : rowToProbe(row.probe, row.mcpName)
}

export async function upsertProbe(
  db: DbClient,
  mcpId: string,
  _mcpName: string,
  result: ProbeResult,
): Promise<McpProbe> {
  // Pre-check parent mcp exists — defends against caller passing a stale id
  // (FK would also reject, but we'd lose the row context for the error).
  const parent = await db.select({ id: mcps.id }).from(mcps).where(eq(mcps.id, mcpId)).limit(1)
  if (parent[0] === undefined) {
    throw new ValidationError('mcp-not-found', `mcp id '${mcpId}' not found for probe upsert`)
  }

  const now = Date.now()
  const existing = await db
    .select({ id: mcpProbes.id })
    .from(mcpProbes)
    .where(eq(mcpProbes.mcpId, mcpId))
    .limit(1)

  const cols = {
    mcpId,
    status: result.status,
    latencyMs: result.latencyMs,
    handshakeMs: result.handshakeMs,
    serverInfoJson: result.serverInfo === null ? null : JSON.stringify(result.serverInfo),
    protocolVersion: result.protocolVersion,
    capabilitiesJson: result.capabilities === null ? null : JSON.stringify(result.capabilities),
    toolsJson: result.tools === null ? null : JSON.stringify(result.tools),
    resourcesJson: result.resources === null ? null : JSON.stringify(result.resources),
    resourceTemplatesJson:
      result.resourceTemplates === null ? null : JSON.stringify(result.resourceTemplates),
    promptsJson: result.prompts === null ? null : JSON.stringify(result.prompts),
    errorCode: result.errorCode,
    errorMessage: result.errorMessage,
    errorDetailJson: result.errorDetail === null ? null : JSON.stringify(result.errorDetail),
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    updatedAt: now,
  } as const

  if (existing[0] === undefined) {
    await db.insert(mcpProbes).values({ ...cols, id: ulid(), createdAt: now })
  } else {
    await db.update(mcpProbes).set(cols).where(eq(mcpProbes.mcpId, mcpId))
  }
  const after = await getProbeByMcpId(db, mcpId)
  if (after === null) throw new Error('probe row disappeared after upsert')
  return after
}

function rowToProbe(row: ProbeRow, mcpName: string): McpProbe {
  const parsed = McpProbeSchema.safeParse({
    id: row.id,
    mcpId: row.mcpId,
    mcpName,
    status: row.status,
    latencyMs: row.latencyMs,
    handshakeMs: row.handshakeMs,
    serverInfo: row.serverInfoJson === null ? null : safeJson(row.serverInfoJson),
    protocolVersion: row.protocolVersion,
    capabilities: row.capabilitiesJson === null ? null : safeJson(row.capabilitiesJson),
    tools: row.toolsJson === null ? null : safeJson(row.toolsJson),
    resources: row.resourcesJson === null ? null : safeJson(row.resourcesJson),
    resourceTemplates:
      row.resourceTemplatesJson === null ? null : safeJson(row.resourceTemplatesJson),
    prompts: row.promptsJson === null ? null : safeJson(row.promptsJson),
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    errorDetail: row.errorDetailJson === null ? null : safeJson(row.errorDetailJson),
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    updatedAt: row.updatedAt,
  })
  if (!parsed.success) {
    throw new Error(
      `mcp_probes row '${row.id}' (mcp ${mcpName}) failed schema validation: ${
        parsed.error.message
      }`,
    )
  }
  return parsed.data
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}
