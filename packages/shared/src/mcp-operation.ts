// RFC-201 T10.1 — exact saved-resource revision for MCP operations.
//
// The operation hash is intentionally wider than the executable `config`.
// Probe receipts can otherwise be mistaken for the current resource after a
// rename, description/ACL change, enable toggle, or same-millisecond write.
// Keep the projector explicit: the companion golden test is a ratchet against
// adding a mutable MCP wire field without deciding whether it belongs here.

import type { Mcp } from './schemas/mcp'
import { canonicalJson } from './workflow-canonical'

export const MCP_OPERATION_CONFIG_DOMAIN_V1 = 'mcp-operation-config/v1\n'

export interface McpOperationConfigProjectionV1 {
  id: string
  name: string
  description: string
  ownerUserId: string | null
  visibility: 'private' | 'public'
  aclRevision: number
  type: 'local' | 'remote'
  config: Mcp['config']
  enabled: boolean
  schemaVersion: number
  createdAt: number
  updatedAt: number
}

// Compile-time source ratchet: adding any field to either Mcp union member
// requires an explicit projection decision here. The golden test below the
// shared package additionally locks the canonical field names and digest.
type KeysOfUnion<T> = T extends unknown ? keyof T : never
type McpOperationProjectionIsExact =
  Exclude<KeysOfUnion<Mcp>, keyof McpOperationConfigProjectionV1> extends never
    ? Exclude<keyof McpOperationConfigProjectionV1, KeysOfUnion<Mcp>> extends never
      ? true
      : never
    : never
const mcpOperationProjectionIsExact: McpOperationProjectionIsExact = true
void mcpOperationProjectionIsExact

/** Complete persisted MCP row projection (derived `operationConfigHash` excluded). */
export function projectMcpOperationConfigV1(mcp: Mcp): McpOperationConfigProjectionV1 {
  return {
    id: mcp.id,
    name: mcp.name,
    description: mcp.description,
    ownerUserId: mcp.ownerUserId ?? null,
    visibility: mcp.visibility ?? 'public',
    aclRevision: mcp.aclRevision ?? 0,
    type: mcp.type,
    config: mcp.config,
    enabled: mcp.enabled,
    schemaVersion: mcp.schemaVersion,
    createdAt: mcp.createdAt,
    updatedAt: mcp.updatedAt,
  }
}

export function serializeMcpOperationConfigV1(mcp: Mcp): string {
  return `${MCP_OPERATION_CONFIG_DOMAIN_V1}${canonicalJson(projectMcpOperationConfigV1(mcp))}`
}

/** Sync variant for backend callers that already have a SHA-256 implementation. */
export function mcpOperationConfigHashWith(
  mcp: Mcp,
  sha256Hex: (canonical: string) => string,
): string {
  return sha256Hex(serializeMcpOperationConfigV1(mcp)).toLowerCase()
}

/** Browser/Bun variant backed by the runtime Web Crypto implementation. */
export async function mcpOperationConfigHash(mcp: Mcp): Promise<string> {
  const TextEncoderCtor = (
    globalThis as unknown as { TextEncoder: new () => { encode: (s: string) => Uint8Array } }
  ).TextEncoder
  // shared deliberately has no DOM lib; describe only the small surface used.
  const subtle = (
    globalThis as unknown as {
      crypto?: {
        subtle?: { digest: (algorithm: string, data: Uint8Array) => Promise<ArrayBuffer> }
      }
    }
  ).crypto?.subtle
  if (TextEncoderCtor === undefined || subtle === undefined) {
    throw new Error('Web Crypto is unavailable; use mcpOperationConfigHashWith with a hasher')
  }
  const digest = await subtle.digest(
    'SHA-256',
    new TextEncoderCtor().encode(serializeMcpOperationConfigV1(mcp)),
  )
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}
