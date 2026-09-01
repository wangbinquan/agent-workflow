// RFC-030 — persistence layer for mcp_probes rows.
//
// Three operations:
//   - listProbes(store)                 → all probes (provider-owned ordering)
//   - getProbeByMcpId(store, mcpId)     → one probe by immutable parent id
//   - upsertProbe(store, mcpId, result) → provider-neutral upsert
//
// The wire shape we return matches `McpProbeSchema` (shared/mcpProbe.ts);
// rowToProbe is the only place where stored JSON strings get re-parsed.

import { McpProbeSchema, type McpProbe } from '@agent-workflow/shared'
import type { McpProbeRecord, McpProbeWrite } from '@/modules/resource-catalog/public/types'
import type { McpProbeStore } from '@/modules/resource-catalog/public/participants'
import type { ProbeResult } from '@/services/mcpProbe'

function parseJson(value: string | null): unknown {
  if (value === null) return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function toProbe(record: McpProbeRecord): McpProbe {
  const parsed = McpProbeSchema.safeParse({
    id: record.id,
    mcpId: record.mcpId,
    mcpName: record.mcpName,
    status: record.status,
    latencyMs: record.latencyMs,
    handshakeMs: record.handshakeMs,
    serverInfo: parseJson(record.serverInfoJson),
    protocolVersion: record.protocolVersion,
    capabilities: parseJson(record.capabilitiesJson),
    tools: parseJson(record.toolsJson),
    resources: parseJson(record.resourcesJson),
    resourceTemplates: parseJson(record.resourceTemplatesJson),
    prompts: parseJson(record.promptsJson),
    errorCode: record.errorCode,
    errorMessage: record.errorMessage,
    errorDetail: parseJson(record.errorDetailJson),
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    updatedAt: record.updatedAt,
  })
  if (!parsed.success) {
    throw new Error(
      `mcp probe '${record.id}' (mcp ${record.mcpName}) failed schema validation: ${parsed.error.message}`,
    )
  }
  return parsed.data
}

function toWrite(result: ProbeResult): McpProbeWrite {
  return Object.freeze({
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
  })
}

export async function listProbes(store: McpProbeStore): Promise<McpProbe[]> {
  return (await store.list()).map(toProbe)
}

/** Stable-id variant used by the operation coordinator across renames. */
export async function getProbeByMcpId(
  store: McpProbeStore,
  mcpId: string,
): Promise<McpProbe | null> {
  const record = await store.getByMcpId(mcpId)
  return record === null ? null : toProbe(record)
}

export async function upsertProbe(
  store: McpProbeStore,
  mcpId: string,
  _mcpName: string,
  result: ProbeResult,
): Promise<McpProbe> {
  return toProbe(await store.upsert(mcpId, toWrite(result)))
}
