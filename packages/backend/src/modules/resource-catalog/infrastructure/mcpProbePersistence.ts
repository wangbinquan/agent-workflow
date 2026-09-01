import { McpProbeErrorCode } from '@agent-workflow/shared'
import type { mcpProbes } from '@/db/schema'
import type { McpProbeRecord, McpProbeWrite } from '../public/types'

export type McpProbePersistenceRow = typeof mcpProbes.$inferSelect

export function mcpProbeFromPersistence(
  row: McpProbePersistenceRow,
  mcpName: string,
): McpProbeRecord {
  return Object.freeze({
    id: row.id,
    mcpId: row.mcpId,
    mcpName,
    status: row.status,
    latencyMs: row.latencyMs,
    handshakeMs: row.handshakeMs,
    serverInfoJson: row.serverInfoJson,
    protocolVersion: row.protocolVersion,
    capabilitiesJson: row.capabilitiesJson,
    toolsJson: row.toolsJson,
    resourcesJson: row.resourcesJson,
    resourceTemplatesJson: row.resourceTemplatesJson,
    promptsJson: row.promptsJson,
    errorCode: McpProbeErrorCode.nullable().parse(row.errorCode),
    errorMessage: row.errorMessage,
    errorDetailJson: row.errorDetailJson,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    updatedAt: row.updatedAt,
  })
}

export function mcpProbePersistenceValues(
  mcpId: string,
  measurement: McpProbeWrite,
  updatedAt: number,
) {
  return Object.freeze({
    mcpId,
    status: measurement.status,
    latencyMs: measurement.latencyMs,
    handshakeMs: measurement.handshakeMs,
    serverInfoJson: measurement.serverInfoJson,
    protocolVersion: measurement.protocolVersion,
    capabilitiesJson: measurement.capabilitiesJson,
    toolsJson: measurement.toolsJson,
    resourcesJson: measurement.resourcesJson,
    resourceTemplatesJson: measurement.resourceTemplatesJson,
    promptsJson: measurement.promptsJson,
    errorCode: measurement.errorCode,
    errorMessage: measurement.errorMessage,
    errorDetailJson: measurement.errorDetailJson,
    startedAt: measurement.startedAt,
    finishedAt: measurement.finishedAt,
    updatedAt,
  })
}
