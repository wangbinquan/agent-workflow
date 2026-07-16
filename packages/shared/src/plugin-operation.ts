// RFC-201 T10.2 — exact saved-resource revision for Plugin operations.
//
// This projection deliberately covers the complete persisted Plugin row. A
// Check/Upgrade receipt must become stale after any config, ACL, identity, or
// immutable-generation publication change — even when timestamps collide.

import type { Plugin } from './schemas/plugin'
import { canonicalJson } from './workflow-canonical'

export const PLUGIN_OPERATION_CONFIG_DOMAIN_V1 = 'plugin-operation-config/v1\n'

export interface PluginOperationConfigProjectionV1 {
  id: string
  name: string
  spec: string
  options: Plugin['options']
  description: string
  ownerUserId: string | null
  visibility: 'private' | 'public'
  aclRevision: number
  enabled: boolean
  sourceKind: Plugin['sourceKind']
  cachedPath: string
  resolvedVersion: string | null
  installedAt: number
  schemaVersion: number
  createdAt: number
  updatedAt: number
}

export function projectPluginOperationConfigV1(plugin: Plugin): PluginOperationConfigProjectionV1 {
  return {
    id: plugin.id,
    name: plugin.name,
    spec: plugin.spec,
    options: plugin.options,
    description: plugin.description,
    ownerUserId: plugin.ownerUserId ?? null,
    visibility: plugin.visibility ?? 'public',
    aclRevision: plugin.aclRevision ?? 0,
    enabled: plugin.enabled,
    sourceKind: plugin.sourceKind,
    cachedPath: plugin.cachedPath,
    resolvedVersion: plugin.resolvedVersion,
    installedAt: plugin.installedAt,
    schemaVersion: plugin.schemaVersion,
    createdAt: plugin.createdAt,
    updatedAt: plugin.updatedAt,
  }
}

export function serializePluginOperationConfigV1(plugin: Plugin): string {
  return `${PLUGIN_OPERATION_CONFIG_DOMAIN_V1}${canonicalJson(projectPluginOperationConfigV1(plugin))}`
}

export function pluginOperationConfigHashWith(
  plugin: Plugin,
  sha256Hex: (canonical: string) => string,
): string {
  return sha256Hex(serializePluginOperationConfigV1(plugin)).toLowerCase()
}

export async function pluginOperationConfigHash(plugin: Plugin): Promise<string> {
  const TextEncoderCtor = (
    globalThis as unknown as { TextEncoder: new () => { encode: (s: string) => Uint8Array } }
  ).TextEncoder
  const subtle = (
    globalThis as unknown as {
      crypto?: {
        subtle?: { digest: (algorithm: string, data: Uint8Array) => Promise<ArrayBuffer> }
      }
    }
  ).crypto?.subtle
  if (TextEncoderCtor === undefined || subtle === undefined) {
    throw new Error('Web Crypto is unavailable; use pluginOperationConfigHashWith with a hasher')
  }
  const digest = await subtle.digest(
    'SHA-256',
    new TextEncoderCtor().encode(serializePluginOperationConfigV1(plugin)),
  )
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}
