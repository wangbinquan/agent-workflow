// RFC-234 §2/§7 (T4) — the context manifest: session handles + per-resource
// OCC fences for EVERY resource actually dumped into a context epoch (mounted
// roots AND dependency-closure members — Codex design-gate P1-2).
//
// The manifest is the ONLY place handles map to canonical ids (design §3.1 —
// the model never sees a ULID or a username); it is stored on
// `intent_sessions.context_manifest_json` and NEVER enters any prompt.
//
// Fences reuse each type's existing OCC primitive (design §7):
//   agent    {updatedAt, aclRevision}          (UpdateAgentRequestSchema pair)
//   skill    {contentVersion, metaRevision}    (composite-token components)
//   mcp      {configHash}                      (mcpOperationConfigHashOf)
//   plugin   {configHash}                      (pluginOperationConfigHashOf)
//   workflow {version}                         (PUT-bumped monotonic version)
//   workgroup{version}                         (RFC-225 content revision)

import type { Agent, Mcp, Plugin, Workflow, Workgroup } from '@agent-workflow/shared'
import { decodeIntentRef, encodeIntentRef, type AclResourceType } from '@agent-workflow/shared'
import { mcpOperationConfigHashOf } from '@/services/mcpOperationRevision'
import { pluginOperationConfigHashOf } from '@/services/pluginOperationRevision'

export type IntentFence =
  | { kind: 'agent'; updatedAt: number; aclRevision: number }
  | { kind: 'skill'; token: string }
  | { kind: 'mcp'; configHash: string }
  | { kind: 'plugin'; configHash: string }
  | { kind: 'workflow'; version: number }
  | { kind: 'workgroup'; version: number }

export interface IntentManifestEntry {
  handle: string
  resourceType: AclResourceType
  resourceId: string
  /** True for explicitly mounted roots; false for closure members / inventory. */
  root: boolean
  /**
   * True when the resource was fully DUMPED this epoch (mounted root or
   * closure member) — only detail entries carry a fence and may be an
   * `update` target. False = inventory-summary entry: the handle exists so
   * the model can REFERENCE or request the resource, but there is no dumped
   * document to edit against.
   */
  detail: boolean
  fence?: IntentFence
  /** sha-256 hex of the dump document (drift display; fence is authoritative). */
  dumpHash?: string
}

export type IntentContextManifest = IntentManifestEntry[]

/** Session-scoped handle counter. Counters only ever grow — a rebase reuses
 *  the same handle for the same resource id so conversation history stays
 *  coherent across epochs. */
export interface HandleAllocator {
  next: Record<string, number>
  byResource: Map<string, string> // `${type}:${id}` → handle
}

export function createHandleAllocator(seed?: IntentContextManifest): HandleAllocator {
  const alloc: HandleAllocator = { next: {}, byResource: new Map() }
  for (const entry of seed ?? []) {
    alloc.byResource.set(`${entry.resourceType}:${entry.resourceId}`, entry.handle)
    // RFC-282 D3 — parse via the intent-domain codec (RFC-271), not a bare exec.
    const ast = decodeIntentRef(entry.handle)
    if (ast?.k === 'handle') {
      const cur = alloc.next[entry.resourceType] ?? 0
      if (ast.ordinal > cur) alloc.next[entry.resourceType] = ast.ordinal
    }
  }
  return alloc
}

export function allocateHandle(
  alloc: HandleAllocator,
  resourceType: AclResourceType,
  resourceId: string,
): string {
  const key = `${resourceType}:${resourceId}`
  const existing = alloc.byResource.get(key)
  if (existing !== undefined) return existing
  const n = (alloc.next[resourceType] ?? 0) + 1
  alloc.next[resourceType] = n
  // RFC-282 D3 — mint via the intent-domain codec; the handle wire spelling
  // has exactly one producer (encodeIntentRef round-trips with decode).
  const handle = encodeIntentRef({ k: 'handle', type: resourceType, ordinal: n })
  if (handle === null) throw new Error(`intent handle encode failed for ${resourceType}#${n}`)
  alloc.byResource.set(key, handle)
  return handle
}

export function buildAgentFence(agent: Pick<Agent, 'updatedAt' | 'aclRevision'>): IntentFence {
  return { kind: 'agent', updatedAt: agent.updatedAt, aclRevision: agent.aclRevision ?? 0 }
}

/** Skill fence = the opaque composite precondition token (RFC-170 §2: base64url
 *  of [skillId, contentVersion, metaRevision]) — the same primitive every skill
 *  save CASes on. The token must be present on the detail read used to dump. */
export function buildSkillFence(skill: { id: string; token?: string }): IntentFence {
  if (skill.token === undefined || skill.token === '') {
    throw new Error(`skill ${skill.id} detail read carried no precondition token`)
  }
  return { kind: 'skill', token: skill.token }
}

export function buildMcpFence(mcp: Mcp): IntentFence {
  return { kind: 'mcp', configHash: mcpOperationConfigHashOf(mcp) }
}

export function buildPluginFence(plugin: Plugin): IntentFence {
  return { kind: 'plugin', configHash: pluginOperationConfigHashOf(plugin) }
}

export function buildWorkflowFence(workflow: Pick<Workflow, 'version'>): IntentFence {
  return { kind: 'workflow', version: workflow.version }
}

export function buildWorkgroupFence(workgroup: Pick<Workgroup, 'version'>): IntentFence {
  return { kind: 'workgroup', version: workgroup.version }
}

export function fenceEquals(a: IntentFence, b: IntentFence): boolean {
  if (a.kind !== b.kind) return false
  switch (a.kind) {
    case 'agent': {
      const other = b as Extract<IntentFence, { kind: 'agent' }>
      return a.updatedAt === other.updatedAt && a.aclRevision === other.aclRevision
    }
    case 'skill': {
      const other = b as Extract<IntentFence, { kind: 'skill' }>
      return a.token === other.token
    }
    case 'mcp':
    case 'plugin': {
      const other = b as Extract<IntentFence, { kind: 'mcp' | 'plugin' }>
      return a.configHash === other.configHash
    }
    case 'workflow':
    case 'workgroup': {
      const other = b as Extract<IntentFence, { kind: 'workflow' | 'workgroup' }>
      return a.version === other.version
    }
  }
}

export function manifestByHandle(
  manifest: IntentContextManifest,
): Map<string, IntentManifestEntry> {
  return new Map(manifest.map((e) => [e.handle, e]))
}

export function manifestEntryFor(
  manifest: IntentContextManifest,
  resourceType: AclResourceType,
  resourceId: string,
): IntentManifestEntry | undefined {
  return manifest.find((e) => e.resourceType === resourceType && e.resourceId === resourceId)
}
