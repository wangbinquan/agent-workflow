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
  /**
   * RFC-291 — this entry's copy LINEAGE ROOT (a resourceId), set when the
   * resource was created by a `copy` decision.
   *
   * It is the root, NOT the immediate source: copying C1 (itself a copy of O)
   * records O, not C1. Recording the immediate source would break "keep only
   * the newest copy" — O→C1→C2 then O→C3 would retire only C1 and leave C2
   * and C3 both mounted (design-gate P1-c).
   */
  copiedFromResourceId?: string
}

export type IntentContextManifest = IntentManifestEntry[]

/** Per-type high-water mark of allocated handle ordinals (RFC-291 面 F). */
export type IntentHandleWatermark = Partial<Record<AclResourceType, number>>

/**
 * Session-scoped handle counter.
 *
 * Ordinals must NEVER be reused: a handle that once meant `res#agent#3` may sit
 * in the conversation history forever, and re-minting it for a different row
 * silently re-points that history at another resource.
 *
 * ⚠️ The manifest alone cannot guarantee that (RFC-291 / design-gate P1-d):
 * `buildIntentDump` rebuilds the manifest from scratch every epoch and keeps
 * only detail entries plus the capped inventory, so an entry that was retired
 * (or whose resource was deleted) and then fell outside the cap simply vanishes
 * — taking its ordinal with it. The seed-derived counter would then hand that
 * ordinal to the next new resource.
 *
 * Hence the second input: a PERSISTED per-type watermark
 * (`intent_sessions.handle_watermark_json`) that only ever grows. The counter
 * is the max of both sources.
 */
export interface HandleAllocator {
  next: Record<string, number>
  byResource: Map<string, string> // `${type}:${id}` → handle
}

export function createHandleAllocator(
  seed?: IntentContextManifest,
  watermark?: IntentHandleWatermark,
): HandleAllocator {
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
  // RFC-291 面 F — the persisted watermark outranks whatever survived in the
  // manifest; a missing/empty column degrades to the pre-RFC-291 behaviour.
  for (const [type, mark] of Object.entries(watermark ?? {})) {
    if (typeof mark !== 'number' || !Number.isFinite(mark)) continue
    const cur = alloc.next[type] ?? 0
    if (mark > cur) alloc.next[type] = mark
  }
  return alloc
}

/** Current high-water mark of an allocator — persist this after every mint. */
export function handleWatermarkOf(alloc: HandleAllocator): IntentHandleWatermark {
  const out: IntentHandleWatermark = {}
  for (const [type, n] of Object.entries(alloc.next)) {
    if (typeof n === 'number' && n > 0) out[type as AclResourceType] = n
  }
  return out
}

/** Merge two watermarks by max — monotonic, so a stale writer cannot lower it. */
export function mergeHandleWatermarks(
  a: IntentHandleWatermark | undefined,
  b: IntentHandleWatermark | undefined,
): IntentHandleWatermark {
  const out: IntentHandleWatermark = { ...(a ?? {}) }
  for (const [type, mark] of Object.entries(b ?? {})) {
    if (typeof mark !== 'number' || !Number.isFinite(mark)) continue
    const cur = out[type as AclResourceType] ?? 0
    if (mark > cur) out[type as AclResourceType] = mark
  }
  return out
}

export function parseHandleWatermark(json: string | null | undefined): IntentHandleWatermark {
  if (json === null || json === undefined || json === '') return {}
  try {
    const parsed: unknown = JSON.parse(json)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const out: IntentHandleWatermark = {}
    for (const [type, mark] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof mark === 'number' && Number.isFinite(mark) && mark > 0) {
        out[type as AclResourceType] = mark
      }
    }
    return out
  } catch {
    // A corrupt column must not brick the session: degrade to manifest-derived.
    return {}
  }
}

/** A resource this commit created, plus its copy lineage root when applicable. */
export interface CommitCreatedResource {
  resourceType: AclResourceType
  resourceId: string
  /** Lineage ROOT of the copy (see IntentManifestEntry.copiedFromResourceId). */
  copiedFromResourceId?: string
}

export interface AutoMountInput {
  created: readonly CommitCreatedResource[]
  /** Handles of copy SOURCES — they stop being explicit roots. */
  unmountHandles: readonly string[]
}

const entryKey = (type: AclResourceType, id: string): string => `${type}:${id}`

/**
 * RFC-291 面 A/B — the manifest migration a successful commit performs.
 *
 * Three steps, and THE ORDER IS LOAD-BEARING:
 *   1. retire same-lineage copies   (older copies of the same origin)
 *   2. retire the copy sources      (`unmountHandles`)
 *   3. mount everything created
 *
 * Step 1 must precede step 3 because a freshly created copy carries the very
 * `copiedFromResourceId` that step 1 matches on — mounting first would make the
 * newest copy retire ITSELF, which is the exact opposite of what the user asked
 * for ("挂载最新的修改副本"). `rfc291-auto-mount-manifest.test.ts` locks this.
 *
 * Retiring only ever flips `root` to false: the entry and its handle stay, so
 * conversation history keeps resolving and the user can still unmount/remount
 * it in the UI (same stance as `removeIntentMount`).
 *
 * Pure and idempotent — replaying the same input converges.
 */
export function applyCommitMounts(
  manifest: IntentContextManifest,
  input: AutoMountInput,
): IntentContextManifest {
  const next: IntentContextManifest = manifest.map((entry) => ({ ...entry }))

  // ── 1. same-lineage copies retire ──
  const retiringOrigins = new Set<string>()
  for (const created of input.created) {
    if (created.copiedFromResourceId === undefined) continue
    retiringOrigins.add(entryKey(created.resourceType, created.copiedFromResourceId))
  }
  if (retiringOrigins.size > 0) {
    for (const entry of next) {
      if (!entry.root || entry.copiedFromResourceId === undefined) continue
      if (retiringOrigins.has(entryKey(entry.resourceType, entry.copiedFromResourceId))) {
        entry.root = false
      }
    }
  }

  // ── 2. copy sources retire ──
  if (input.unmountHandles.length > 0) {
    const retiring = new Set(input.unmountHandles)
    for (const entry of next) {
      if (retiring.has(entry.handle)) entry.root = false
    }
  }

  // ── 3. created resources mount ──
  const alloc = createHandleAllocator(next)
  const byKey = new Map(
    next.map((entry) => [entryKey(entry.resourceType, entry.resourceId), entry]),
  )
  for (const created of input.created) {
    const key = entryKey(created.resourceType, created.resourceId)
    const existing = byKey.get(key)
    if (existing !== undefined) {
      existing.root = true
      if (
        created.copiedFromResourceId !== undefined &&
        existing.copiedFromResourceId === undefined
      ) {
        existing.copiedFromResourceId = created.copiedFromResourceId
      }
      continue
    }
    const entry: IntentManifestEntry = {
      handle: allocateHandle(alloc, created.resourceType, created.resourceId),
      resourceType: created.resourceType,
      resourceId: created.resourceId,
      root: true,
      // Not dumped yet — the next turn's dump promotes it and attaches a fence.
      // Until then `intent-target-not-mounted` still (correctly) rejects it:
      // no fence means editing it would be a blind write.
      detail: false,
      ...(created.copiedFromResourceId === undefined
        ? {}
        : { copiedFromResourceId: created.copiedFromResourceId }),
    }
    next.push(entry)
    byKey.set(key, entry)
  }

  return next
}

/**
 * RFC-291 面 B — carry copy lineage across an epoch rebuild.
 *
 * `buildIntentDump` reconstructs the manifest from scratch through three
 * separate paths (detail refs / inventory summaries / unavailable roots). None
 * of them knows about lineage, so without this single pass the
 * `copiedFromResourceId` written at commit time would silently disappear on the
 * next turn and "keep only the newest copy" would hold only within one epoch.
 */
export function inheritCopyProvenance(
  next: IntentContextManifest,
  prior: IntentContextManifest | undefined,
): IntentContextManifest {
  if (prior === undefined || prior.length === 0) return next
  const lineageByKey = new Map<string, string>()
  for (const entry of prior) {
    if (entry.copiedFromResourceId === undefined) continue
    lineageByKey.set(entryKey(entry.resourceType, entry.resourceId), entry.copiedFromResourceId)
  }
  if (lineageByKey.size === 0) return next
  for (const entry of next) {
    if (entry.copiedFromResourceId !== undefined) continue
    const lineage = lineageByKey.get(entryKey(entry.resourceType, entry.resourceId))
    if (lineage !== undefined) entry.copiedFromResourceId = lineage
  }
  return next
}

/** Lineage root of a manifest entry: its own root when it is a copy, else itself. */
export function lineageRootOf(
  entry: Pick<IntentManifestEntry, 'resourceId' | 'copiedFromResourceId'>,
): string {
  return entry.copiedFromResourceId ?? entry.resourceId
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
