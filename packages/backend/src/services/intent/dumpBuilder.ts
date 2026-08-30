// RFC-234 §4 (T4) — the working-directory dump builder.
//
// One epoch = one call: given the actor's explicit mounts, produce
//   inventory/{type}.md        six visible-inventory summaries (handles, capped
//                              with EXPLICIT truncation notes — never silent)
//   mounted/res.{type}.{n}.*   full dumps of mounted roots + their dependency
//                              closure (BFS, ACL-filtered; invisible members
//                              surface as counted hidden-dependency notes, no
//                              name leak)
// plus the context manifest (handles ↔ ids ↔ fences — server-side only).
//
// Identity isolation and secret redaction are structural: every document goes
// through the shared whitelist serializers (agent-md-serialize /
// intent-dump-serialize) and the closed secret projections; this module never
// copies owner/user/grant fields at all. Locked by
// tests/rfc234-dump-builder.test.ts poisoned fixtures.

import { stringify as stringifyYaml } from 'yaml'
import type {
  AclResourceType,
  Agent,
  AgentSkillSelector,
  Mcp,
  Plugin,
  Workflow,
  WorkflowDefinition,
  Workgroup,
} from '@agent-workflow/shared'
import {
  maskFreeJsonSecrets,
  INTENT_REDACTED,
  maskWorkflowScriptEnv,
  redactPrivilegedNodes,
  resolveWorkgroupOutputContract,
  serializeAgentMarkdown,
  serializeMcpDump,
  serializePluginDump,
  serializeWorkgroupDump,
  fenceUntrusted,
  collectWorkflowCallRefs,
  collectWorkgroupCallRefs,
} from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'
import { NotFoundError } from '@/util/errors'
import { privilegedNodeLensFor } from '@/services/privilegedNodeLens'
import { pickCallTarget } from '@/services/execution/callRefTarget'
import { extractWorkflowAgentRefs } from '@/services/resourceRefs'
import { inArray } from 'drizzle-orm'
import { agents } from '@/db/schema'
import type { DbClient } from '@/db/client'
import { listRuntimes, resolveRuntimeByName } from '@/services/runtimeRegistry'
import { platformOnlyResourceTypes } from '@/modules/intent/domain/teaching/platformMap'
import {
  createDefaultIntentPlatformInventory,
  renderPlatformInventoryFile,
  type IntentPlatformInventory,
} from './platformInventory'
import { getAgentById } from '@/services/agent'
import { getMcpById } from '@/services/mcp'
import { getPlugin } from '@/services/plugin'
import { listSkillFiles, readSkillContent, readSkillFile } from '@/services/skill'
import { getWorkflow } from '@/services/workflow'
import { getWorkgroupById } from '@/services/workgroups'
import { listAllVisibleResourceSummariesForActor } from '@/modules/resource-catalog/public/operations'
import { resourceCatalogProjectionDependencies } from './resourceCatalogProjections'
import type { CatalogSelectorKind } from '@/modules/resource-catalog/public/types'
import type { SystemAgentSeedFile } from '@/services/systemAgentRun'
import {
  allocateHandle,
  buildAgentFence,
  buildMcpFence,
  buildPluginFence,
  buildSkillFence,
  buildWorkflowFence,
  buildWorkgroupFence,
  createHandleAllocator,
  handleWatermarkOf,
  inheritCopyProvenance,
  mergeHandleWatermarks,
  type IntentContextManifest,
  type IntentHandleWatermark,
} from './manifest'
import { sha256Hex } from '@/util/hash'

export const INTENT_INVENTORY_CAP = 500
const SKILL_DUMP_FILE_CAP_BYTES = 128 * 1024

export interface IntentMountRef {
  resourceType: AclResourceType
  resourceId: string
}

export interface IntentDumpInput {
  db: DbClient
  actor: Actor
  appHome: string
  mounts: readonly IntentMountRef[]
  /** Prior epoch's manifest — reused so handles stay stable across rebases. */
  priorManifest?: IntentContextManifest
  /**
   * RFC-291 面 F — persisted per-type handle high-water mark. The prior
   * manifest is NOT sufficient: entries evicted by the inventory cap (or whose
   * resource was deleted) vanish from it, so its ordinals can go backwards and
   * a later resource would reuse a handle the conversation already used for
   * something else.
   */
  handleWatermark?: IntentHandleWatermark
  /** Test seam; production uses INTENT_INVENTORY_CAP. */
  inventoryCap?: number
  /**
   * Codex impl-gate P1-4 — the turn's envelope nonce. Every dumped resource
   * body is UNTRUSTED (another user's description, a skill's SKILL.md), so
   * each file is wrapped in the same nonce fence INTENT.md history uses.
   * Optional so unit tests can assert raw bodies; production always passes it.
   */
  envelopeNonce?: string
  /**
   * RFC-348 D5b — the runtime an agent inherits when it omits `runtime`
   * (resolved by the turn config from `config.defaultRuntime`). Absent ⇒ the
   * registry's own fallback (`resolveRuntimeByName(db, null)`).
   */
  effectiveDefaultRuntime?: { name: string; protocol: string }
  /**
   * RFC-348 D5c — port names for the agents that survive the inventory cap,
   * printed beside each inventory row so a workflow can be wired without
   * mounting every agent. Default: one narrow select on `agents.inputs/outputs`.
   */
  loadAgentPorts?: (ids: readonly string[]) => Promise<Map<string, AgentPortNames>>
  /**
   * RFC-348 D3 — read-only rows of the platform-only ACL types
   * (`inventory/platform/<type>.md`). Default: the DB-backed loaders in
   * ./platformInventory.ts; bootstrap may inject the composed-module port.
   */
  platformInventory?: IntentPlatformInventory
}

/** Locked sentence (design §4; mirrors `validateRuntimeReference`'s `runtime-disabled` rule). */
export const RUNTIME_INVENTORY_RULE =
  'Choose an enabled row for a new or re-pointed agent; (disabled) rows are listed only so you can recognise an existing pin.'

async function fallbackDefaultRuntime(db: DbClient): Promise<{ name: string; protocol: string }> {
  const resolved = await resolveRuntimeByName(db, null)
  return { name: resolved.name, protocol: resolved.protocol }
}

export interface AgentPortNames {
  inputs: string[]
  outputs: string[]
}

async function loadAgentPortsFromDb(
  db: DbClient,
  ids: readonly string[],
): Promise<Map<string, AgentPortNames>> {
  const out = new Map<string, AgentPortNames>()
  if (ids.length === 0) return out
  const rows = await db
    .select({ id: agents.id, inputs: agents.inputs, outputs: agents.outputs })
    .from(agents)
    .where(inArray(agents.id, [...ids]))
  const names = (raw: string): string[] => {
    try {
      const parsed = JSON.parse(raw) as unknown
      if (!Array.isArray(parsed)) return []
      return parsed
        .map((entry) =>
          typeof entry === 'string'
            ? entry
            : typeof entry === 'object' &&
                entry !== null &&
                typeof (entry as { name?: unknown }).name === 'string'
              ? (entry as { name: string }).name
              : null,
        )
        .filter((name): name is string => name !== null)
    } catch {
      return []
    }
  }
  for (const row of rows)
    out.set(row.id, { inputs: names(row.inputs), outputs: names(row.outputs) })
  return out
}

export interface IntentDumpResult {
  manifest: IntentContextManifest
  seedFiles: SystemAgentSeedFile[]
  /** parentHandle → number of ACL-invisible closure members (no names). */
  hiddenDependencies: Array<{ parentHandle: string; count: number }>
  /** type → dropped row count when the inventory cap truncated the summary. */
  inventoryTruncated: Partial<Record<AclResourceType, number>>
  /**
   * RFC-291 面 C — mounted roots skipped this epoch (deleted, or no longer
   * visible to this actor). Handle + type only: the NAME of a resource the
   * actor cannot see is not theirs to read back.
   */
  unavailableMounts: Array<{ handle: string; resourceType: AclResourceType }>
  /** RFC-291 面 F — high-water mark to persist back onto the session row. */
  handleWatermark: IntentHandleWatermark
  /** RFC-348 — stored branch ports of every DUMPED agent (resourceId → ports), for draft validation. */
  agentBranchPorts: Map<string, string[]>
}

const sha256 = sha256Hex // RFC-284 T7：alias 到共享单点

/**
 * RFC-291 面 C — "this resource is gone / not visible to me", the only class of
 * materialisation failure a dump may skip over.
 *
 * Everything else propagates: a corrupt skill file or an unreadable store is a
 * real outage, and degrading it to "资源不可用" would hide it behind a message
 * that tells the user to re-mount something that is actually fine.
 */
const RESOURCE_GONE_CODES = new Set([
  'skill-not-found',
  'skill-changed',
  'agent-not-found',
  'mcp-not-found',
  'plugin-not-found',
  'workflow-not-found',
  'workgroup-not-found',
  'resource-not-found',
])

function isResourceGoneError(err: unknown): boolean {
  if (err instanceof NotFoundError) return true
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'string' && RESOURCE_GONE_CODES.has(code)
}

/** `res#agent#3` → `res.agent.3` (filesystem-safe dump basename). */
export function handleBasename(handle: string): string {
  return handle.replace(/#/g, '.')
}

function firstLine(text: string, cap = 160): string {
  const line = text.split('\n', 1)[0] ?? ''
  return line.length > cap ? `${line.slice(0, cap)}…` : line
}

interface VisibleCatalog {
  db: DbClient
  agents: Map<string, CatalogItem>
  skills: Map<string, CatalogItem>
  mcps: Map<string, CatalogItem>
  plugins: Map<string, CatalogItem>
  workflows: Map<string, CatalogItem>
  workgroups: Map<string, CatalogItem>
  details: {
    agents: Map<string, Promise<Agent | null>>
    mcps: Map<string, Promise<Mcp | null>>
    plugins: Map<string, Promise<Plugin | null>>
    workflows: Map<string, Promise<Workflow | null>>
    workgroups: Map<string, Promise<Workgroup | null>>
  }
}

interface CatalogItem {
  id: string
  name: string
  description: string | null
}

function summaryMap(): Map<string, CatalogItem> {
  return new Map()
}

async function loadVisibleCatalog(db: DbClient, actor: Actor): Promise<VisibleCatalog> {
  const maps: Record<CatalogSelectorKind, Map<string, CatalogItem>> = {
    agent: summaryMap(),
    skill: summaryMap(),
    mcp: summaryMap(),
    plugin: summaryMap(),
    workflow: summaryMap(),
    workgroup: summaryMap(),
  }
  for (const summary of await listAllVisibleResourceSummariesForActor(
    db,
    actor,
    resourceCatalogProjectionDependencies,
  )) {
    maps[summary.kind].set(summary.ref.id, {
      id: summary.ref.id,
      name: summary.name,
      description: summary.description,
    })
  }
  return {
    db,
    agents: maps.agent,
    skills: maps.skill,
    mcps: maps.mcp,
    plugins: maps.plugin,
    workflows: maps.workflow,
    workgroups: maps.workgroup,
    details: {
      agents: new Map(),
      mcps: new Map(),
      plugins: new Map(),
      workflows: new Map(),
      workgroups: new Map(),
    },
  }
}

function cachedDetail<T>(
  cache: Map<string, Promise<T | null>>,
  id: string,
  load: () => Promise<T | null>,
): Promise<T | null> {
  const current = cache.get(id)
  if (current !== undefined) return current
  const pending = load()
  cache.set(id, pending)
  return pending
}

const loadAgentDetail = (catalog: VisibleCatalog, id: string): Promise<Agent | null> =>
  cachedDetail(catalog.details.agents, id, () => getAgentById(catalog.db, id))

const loadMcpDetail = (catalog: VisibleCatalog, id: string): Promise<Mcp | null> =>
  cachedDetail(catalog.details.mcps, id, () => getMcpById(catalog.db, id))

const loadPluginDetail = (catalog: VisibleCatalog, id: string): Promise<Plugin | null> =>
  cachedDetail(catalog.details.plugins, id, () => getPlugin(catalog.db, id))

const loadWorkflowDetail = (catalog: VisibleCatalog, id: string): Promise<Workflow | null> =>
  cachedDetail(catalog.details.workflows, id, () => getWorkflow(catalog.db, id))

const loadWorkgroupDetail = (catalog: VisibleCatalog, id: string): Promise<Workgroup | null> =>
  cachedDetail(catalog.details.workgroups, id, () => getWorkgroupById(catalog.db, id))

/** BFS the dependency closure of one mounted root. Returns VISIBLE members
 *  (typed ids) + the count of invisible ones (no identity recorded). */
async function expandClosure(
  root: IntentMountRef,
  catalog: VisibleCatalog,
  /**
   * RFC-291 面 D — adjacency memo SHARED across roots.
   *
   * `expandClosure` runs once per mounted root, and a commit may mount up to
   * `INTENT_LIMITS.maxOps` (64) of them. Without this, a workflow referenced by
   * every root gets its out-edges recomputed 64 times; with a wide fan-out
   * definition that is enough to occupy the event loop before the model even
   * starts (design-gate P2-c). `seen` stays per-root because each root's
   * `hiddenCount` must reflect ITS OWN closure.
   */
  adjacency: Map<string, IntentMountRef[]>,
): Promise<{ members: IntentMountRef[]; hiddenCount: number }> {
  const members: IntentMountRef[] = []
  const seen = new Set<string>([`${root.resourceType}:${root.resourceId}`])
  let hiddenCount = 0
  // Cursor instead of `queue.shift()`: shift() is O(n) per call, so a large
  // frontier degrades to O(n²) copying for no reason.
  const queue: IntentMountRef[] = [root]
  let cursor = 0

  const push = (resourceType: AclResourceType, resourceId: string): void => {
    const key = `${resourceType}:${resourceId}`
    if (seen.has(key)) return
    seen.add(key)
    const visible =
      resourceType === 'agent'
        ? catalog.agents.has(resourceId)
        : resourceType === 'skill'
          ? catalog.skills.has(resourceId)
          : resourceType === 'mcp'
            ? catalog.mcps.has(resourceId)
            : resourceType === 'plugin'
              ? catalog.plugins.has(resourceId)
              : resourceType === 'workflow'
                ? catalog.workflows.has(resourceId)
                : catalog.workgroups.has(resourceId)
    if (!visible) {
      hiddenCount += 1
      return
    }
    const ref = { resourceType, resourceId }
    members.push(ref)
    queue.push(ref)
  }

  while (cursor < queue.length) {
    const cur = queue[cursor++] as IntentMountRef
    for (const edge of await outEdgesOf(cur, catalog, adjacency)) {
      push(edge.resourceType, edge.resourceId)
    }
  }
  return { members, hiddenCount }
}

/**
 * The out-edges of one resource, memoised per `(type, id)`.
 *
 * Edges are computed against the WHOLE catalog (not filtered by visibility) so
 * the memo is root-independent; `push` then applies the per-root visibility and
 * hidden-count bookkeeping.
 */
async function outEdgesOf(
  cur: IntentMountRef,
  catalog: VisibleCatalog,
  adjacency: Map<string, IntentMountRef[]>,
): Promise<IntentMountRef[]> {
  const memoKey = `${cur.resourceType}:${cur.resourceId}`
  const cached = adjacency.get(memoKey)
  if (cached !== undefined) return cached

  const edges: IntentMountRef[] = []
  const add = (resourceType: AclResourceType, resourceId: string): void => {
    if (typeof resourceId === 'string' && resourceId.length > 0) {
      edges.push({ resourceType, resourceId })
    }
  }

  if (cur.resourceType === 'agent') {
    const agent = await loadAgentDetail(catalog, cur.resourceId)
    if (agent !== null) {
      for (const dep of agent.dependsOn) add('agent', dep)
      for (const m of agent.mcp) add('mcp', m)
      for (const p of agent.plugins) add('plugin', p)
      for (const s of agent.skills) {
        if (s.kind === 'managed') add('skill', s.skillId)
      }
    }
  } else if (cur.resourceType === 'workflow') {
    const wf = await loadWorkflowDetail(catalog, cur.resourceId)
    if (wf !== null) {
      const definition = wf.definition as WorkflowDefinition
      // RFC-291 面 D — agent refs come from the AUTHORITATIVE extractor rather
      // than a fourth hand-written agent-node walker. (The dump RENDERER below
      // still matches the node kind literally — it has to, in order to rewrite
      // agentId into a handle — so the guard is "no hand-written walker in the
      // closure", not "that literal never appears in this file".)
      for (const agentId of extractWorkflowAgentRefs(definition)) add('agent', agentId)

      // RFC-291 面 D — the two edges that were missing entirely: a workflow that
      // CALLS another workflow / a workgroup pulled neither into the closure, so
      // mounting a parent to edit it left the callee invisible. Selectors are
      // names (+ an optional id cache), resolved by the SAME single decision
      // point the launch-time freeze uses — otherwise the dump could show one
      // row while the platform executes another.
      for (const ref of collectWorkflowCallRefs(definition)) {
        const target = pickCallTarget(
          {
            authoritativeName: ref.workflowName,
            ...(ref.workflowId === undefined ? {} : { idHint: ref.workflowId }),
          },
          [...catalog.workflows.values()],
        )
        // Unresolvable (deleted, or invisible to this actor) → let `push` count
        // it as a hidden dependency via the id it names, without leaking a name.
        if (target !== undefined) add('workflow', target.id)
      }
      for (const ref of collectWorkgroupCallRefs(definition)) {
        const target = pickCallTarget(
          {
            authoritativeName: ref.workgroupName,
            ...(ref.workgroupId === undefined ? {} : { idHint: ref.workgroupId }),
          },
          [...catalog.workgroups.values()],
        )
        if (target !== undefined) add('workgroup', target.id)
      }
    }
  } else if (cur.resourceType === 'workgroup') {
    const wg = await loadWorkgroupDetail(catalog, cur.resourceId)
    if (wg !== null) {
      for (const member of wg.members) {
        if (member.memberType === 'agent' && member.agentId != null && member.agentId !== '') {
          add('agent', member.agentId)
        }
      }
    }
    // skill / mcp / plugin are closure leaves.
  }
  adjacency.set(memoKey, edges)
  return edges
}

export async function buildIntentDump(input: IntentDumpInput): Promise<IntentDumpResult> {
  const { db, actor } = input
  const cap = input.inventoryCap ?? INTENT_INVENTORY_CAP
  const catalog = await loadVisibleCatalog(db, actor)
  const alloc = createHandleAllocator(input.priorManifest, input.handleWatermark)
  const nonce = input.envelopeNonce
  const rawSeedFiles: SystemAgentSeedFile[] = []
  const seedFiles = rawSeedFiles
  const manifest: IntentContextManifest = []
  const hiddenDependencies: Array<{ parentHandle: string; count: number }> = []
  const inventoryTruncated: Partial<Record<AclResourceType, number>> = {}
  const agentBranchPorts = new Map<string, string[]>()

  // ── resolve mounted roots + closure. A root that cannot be materialised
  // this epoch is SKIPPED and reported, not thrown (RFC-291 面 C). ──
  const detailRefs = new Map<
    string,
    { ref: IntentMountRef; root: boolean; parent?: IntentMountRef }
  >()
  /** RFC-291 面 D — out-edge memo shared by every root's closure walk. */
  const adjacency = new Map<string, IntentMountRef[]>()
  const unavailableRoots: IntentMountRef[] = []
  /** Closure members that vanished mid-dump, keyed by the root they came from. */
  const hiddenMembers: IntentMountRef[] = []
  for (const mount of input.mounts) {
    const rootKey = `${mount.resourceType}:${mount.resourceId}`
    const rootVisible = await expandClosure(mount, catalog, adjacency)
    const rootInCatalog =
      mount.resourceType === 'agent'
        ? catalog.agents.has(mount.resourceId)
        : mount.resourceType === 'skill'
          ? catalog.skills.has(mount.resourceId)
          : mount.resourceType === 'mcp'
            ? catalog.mcps.has(mount.resourceId)
            : mount.resourceType === 'plugin'
              ? catalog.plugins.has(mount.resourceId)
              : mount.resourceType === 'workflow'
                ? catalog.workflows.has(mount.resourceId)
                : catalog.workgroups.has(mount.resourceId)
    if (!rootInCatalog) {
      // RFC-291 面 C — a root whose resource was deleted (or is no longer
      // visible) used to throw and take the WHOLE turn down with it. Skip it
      // and report instead: the user can still see it in "已挂载元素" and
      // unmount it, and the model is told it is unavailable this epoch.
      //
      // The entry is re-emitted below (never dropped): losing it would make the
      // row vanish from the UI, break handle continuity for the conversation,
      // and let the ordinal be reused later (面 F).
      unavailableRoots.push(mount)
      continue
    }
    const existing = detailRefs.get(rootKey)
    detailRefs.set(rootKey, { ref: mount, root: true, ...(existing?.root ? { root: true } : {}) })
    for (const member of rootVisible.members) {
      const key = `${member.resourceType}:${member.resourceId}`
      // `parent` lets a member that vanishes mid-dump be reported under the
      // root it came from, same bucket as ACL-invisible dependencies.
      if (!detailRefs.has(key)) detailRefs.set(key, { ref: member, root: false, parent: mount })
    }
    if (rootVisible.hiddenCount > 0) {
      const parentHandle = allocateHandle(alloc, mount.resourceType, mount.resourceId)
      hiddenDependencies.push({ parentHandle, count: rootVisible.hiddenCount })
    }
  }

  // ── allocate handles: detail refs first (stable numbering for dumped docs),
  // then the whole visible inventory (referenceable summaries) ──
  for (const { ref } of detailRefs.values()) {
    allocateHandle(alloc, ref.resourceType, ref.resourceId)
  }
  const inventoryLists: Array<[AclResourceType, Array<{ id: string; name: string }>]> = [
    ['agent', [...catalog.agents.values()]],
    ['skill', [...catalog.skills.values()]],
    ['mcp', [...catalog.mcps.values()]],
    ['plugin', [...catalog.plugins.values()]],
    ['workflow', [...catalog.workflows.values()]],
    ['workgroup', [...catalog.workgroups.values()]],
  ]
  for (const [type, rows] of inventoryLists) {
    for (const row of [...rows].sort((a, b) => a.name.localeCompare(b.name)).slice(0, cap)) {
      allocateHandle(alloc, type, row.id)
    }
  }

  const handleFor = (type: AclResourceType, id: string): string => allocateHandle(alloc, type, id)

  // ── mounted/ dumps ──
  for (const { ref, root, parent } of detailRefs.values()) {
    const handle = handleFor(ref.resourceType, ref.resourceId)
    const base = `mounted/${handleBasename(handle)}`
    const entryBase = {
      handle,
      resourceType: ref.resourceType,
      resourceId: ref.resourceId,
      root,
      detail: true as const,
    }
    // RFC-291 面 C — the catalog above is a snapshot; materialising a resource
    // re-reads it (a skill re-queries the row and its files). A row deleted in
    // that window used to abort the whole turn. Treat only "it is gone /
    // invisible" as skippable; everything else (I/O corruption, serialization
    // faults) still fails loud — swallowing those would turn a real outage into
    // a silent "resource unavailable".
    try {
      if (ref.resourceType === 'agent') {
        const agent = await loadAgentDetail(catalog, ref.resourceId)
        if (agent === null) throw new NotFoundError('agent-not-found', 'agent not found')
        const skills: Array<AgentSkillSelector | string> = agent.skills.map((s) =>
          s.kind === 'managed'
            ? catalog.skills.has(s.skillId)
              ? handleFor('skill', s.skillId)
              : 'hidden-dependency'
            : ({ kind: 'project', name: s.name } as AgentSkillSelector),
        )
        const doc = serializeAgentMarkdown({
          name: agent.name,
          description: agent.description,
          ...(Object.keys(agent.permission).length > 0 ? { permission: agent.permission } : {}),
          skills: skills as AgentSkillSelector[] | string[],
          dependsOn: agent.dependsOn.map((id) =>
            catalog.agents.has(id) ? handleFor('agent', id) : 'hidden-dependency',
          ),
          mcp: agent.mcp.map((id) =>
            catalog.mcps.has(id) ? handleFor('mcp', id) : 'hidden-dependency',
          ),
          plugins: agent.plugins.map((id) =>
            catalog.plugins.has(id) ? handleFor('plugin', id) : 'hidden-dependency',
          ),
          ...(agent.inputs !== undefined && agent.inputs.length > 0
            ? { inputs: agent.inputs }
            : {}),
          outputs: agent.outputs,
          ...(agent.outputKinds !== undefined ? { outputKinds: agent.outputKinds } : {}),
          // RFC-348 D5 — RFC-306 branch ports were lifted on read but never dumped,
          // so an intent update could not echo them back.
          ...(agent.branchPorts !== undefined && agent.branchPorts.length > 0
            ? { branchPorts: agent.branchPorts }
            : {}),
          ...(agent.role !== undefined ? { role: agent.role } : {}),
          ...(agent.outputWrapperPortNames !== undefined
            ? { outputWrapperPortNames: agent.outputWrapperPortNames }
            : {}),
          ...(agent.runtime !== undefined ? { runtime: agent.runtime } : {}),
          ...(Object.keys(agent.frontmatterExtra).length > 0
            ? { frontmatterExtra: maskFreeJsonSecrets(agent.frontmatterExtra) }
            : {}),
          bodyMd: agent.bodyMd,
        })
        if (agent.branchPorts !== undefined)
          agentBranchPorts.set(ref.resourceId, [...agent.branchPorts])
        seedFiles.push({ path: `${base}.md`, content: doc })
        manifest.push({ ...entryBase, fence: buildAgentFence(agent), dumpHash: sha256(doc) })
      } else if (ref.resourceType === 'skill') {
        const content = await readSkillContent(db, { appHome: input.appHome }, ref.resourceId)
        const fmExtra = maskFreeJsonSecrets(content.frontmatterExtra)
        const skillMd = `---\n${stringifyYaml(
          {
            name: content.name,
            description: content.description,
            ...(Object.keys(fmExtra).length > 0 ? fmExtra : {}),
          },
          { lineWidth: 0 },
        )}---\n\n${content.bodyMd}\n`
        seedFiles.push({ path: `${base}/SKILL.md`, content: skillMd })
        let treeHash = skillMd
        const nodes = await listSkillFiles(db, { appHome: input.appHome }, ref.resourceId)
        for (const node of nodes) {
          if (node.type !== 'file') continue
          if (node.path === 'SKILL.md') continue
          if ((node.size ?? 0) > SKILL_DUMP_FILE_CAP_BYTES) {
            seedFiles.push({
              path: `${base}/files/${node.path}.omitted.md`,
              content: `File omitted from dump: ${node.path} exceeds ${SKILL_DUMP_FILE_CAP_BYTES} bytes.\n`,
            })
            continue
          }
          const fileContent = await readSkillFile(
            db,
            { appHome: input.appHome },
            ref.resourceId,
            node.path,
          )
          seedFiles.push({ path: `${base}/files/${node.path}`, content: fileContent })
          treeHash += `\n--- ${node.path} ---\n${fileContent}`
        }
        manifest.push({
          ...entryBase,
          fence: buildSkillFence({
            id: ref.resourceId,
            ...(content.token === undefined ? {} : { token: content.token }),
          }),
          dumpHash: sha256(treeHash),
        })
      } else if (ref.resourceType === 'mcp') {
        const mcp = await loadMcpDetail(catalog, ref.resourceId)
        if (mcp === null) throw new NotFoundError('mcp-not-found', 'mcp not found')
        const doc = serializeMcpDump({
          handle,
          type: mcp.type,
          name: mcp.name,
          description: mcp.description,
          enabled: mcp.enabled,
          config: mcp.config as Record<string, unknown>,
        })
        seedFiles.push({ path: `${base}.yaml`, content: doc })
        manifest.push({ ...entryBase, fence: buildMcpFence(mcp), dumpHash: sha256(doc) })
      } else if (ref.resourceType === 'plugin') {
        const plugin = await loadPluginDetail(catalog, ref.resourceId)
        if (plugin === null) throw new NotFoundError('plugin-not-found', 'plugin not found')
        const doc = serializePluginDump({
          handle,
          name: plugin.name,
          spec: plugin.spec,
          description: plugin.description,
          enabled: plugin.enabled,
          options: plugin.options,
        })
        seedFiles.push({ path: `${base}.yaml`, content: doc })
        manifest.push({ ...entryBase, fence: buildPluginFence(plugin), dumpHash: sha256(doc) })
      } else if (ref.resourceType === 'workflow') {
        const wf = await loadWorkflowDetail(catalog, ref.resourceId)
        if (wf === null) throw new NotFoundError('workflow-not-found', 'workflow not found')
        const def = wf.definition as { nodes?: Array<Record<string, unknown>> }
        const transformed = {
          ...(wf.definition as Record<string, unknown>),
          nodes: (def.nodes ?? []).map((node) => {
            if (node.kind === 'agent-single') {
              const { agentId, agentName: _agentName, ...rest } = node
              return typeof agentId === 'string' && catalog.agents.has(agentId)
                ? { ...rest, agentRef: handleFor('agent', agentId) }
                : { ...rest, agentRefHidden: true }
            }
            // RFC-291 面 E — call edges: strip the canonical id cache (a ULID
            // the model must never see, manifest.ts §handles) and replace it
            // with the handle of the row this edge ACTUALLY binds to, resolved
            // by the same single decision point the launch-time freeze uses.
            //
            // Without this the model saw only "a name + an opaque ULID" and
            // could not tell which mounted/ document an edge pointed at — and
            // with two same-named workflows that ambiguity is unresolvable.
            // The NAME stays: it is the authoritative selector the author wrote.
            if (node.kind === 'call-workflow') {
              const { workflowId: _drop, ...rest } = node
              const target = pickCallTarget(
                {
                  authoritativeName: String(node.workflowName ?? ''),
                  ...(typeof node.workflowId === 'string' ? { idHint: node.workflowId } : {}),
                },
                [...catalog.workflows.values()],
              )
              return target === undefined
                ? { ...rest, workflowRefHidden: true }
                : { ...rest, workflowRef: handleFor('workflow', target.id) }
            }
            if (node.kind === 'call-workgroup') {
              const { workgroupId: _drop, ...rest } = node
              const target = pickCallTarget(
                {
                  authoritativeName: String(node.workgroupName ?? ''),
                  ...(typeof node.workgroupId === 'string' ? { idHint: node.workgroupId } : {}),
                },
                [...catalog.workgroups.values()],
              )
              return target === undefined
                ? { ...rest, workgroupRefHidden: true }
                : { ...rest, workgroupRef: handleFor('workgroup', target.id) }
            }
            return node
          }),
        }
        const doc = stringifyYaml(
          {
            handle,
            name: wf.name,
            description: wf.description,
            // RFC-253 T28 — script-node env values are a closed secret carrier.
            //
            // RFC-270 (Codex impl-gate P1): "the definition otherwise rides
            // verbatim" was the leak. `intent:read` / `intent:write` are both in
            // USER_BASELINE, so ANY user could mount a visible workflow here and
            // have the script body, dependencies and the code-host
            // `params` / `request` written into the seed YAML — which is then fed
            // to the configured MODEL. That is a wider outlet than the REST reads
            // this RFC closed: it survives in whatever the conversation goes on to
            // do. The actor's privileged lens applies here for the same reason it
            // applies to `GET /api/workflows/:id`.
            definition: redactPrivilegedNodes(
              maskWorkflowScriptEnv(transformed),
              privilegedNodeLensFor(actor),
              // 用 intent 自己的标记而不是 REST 的 `***`：同一份 YAML 里出现两种
              // 遮蔽记号，读它的模型会以为那是两种不同的东西。
              INTENT_REDACTED,
            ),
          },
          { lineWidth: 0 },
        )
        seedFiles.push({ path: `${base}.yaml`, content: doc })
        manifest.push({ ...entryBase, fence: buildWorkflowFence(wf), dumpHash: sha256(doc) })
      } else {
        const wg = await loadWorkgroupDetail(catalog, ref.resourceId)
        if (wg === null) throw new NotFoundError('workgroup-not-found', 'workgroup not found')
        const leader = wg.members.find((m) => m.id === wg.leaderMemberId)
        const doc = serializeWorkgroupDump({
          handle,
          name: wg.name,
          description: wg.description,
          instructions: wg.instructions,
          mode: wg.mode,
          outputContract: resolveWorkgroupOutputContract(wg.outputContract),
          ...(leader === undefined ? {} : { leaderDisplayName: leader.displayName }),
          switches: wg.switches,
          maxRounds: wg.maxRounds,
          completionGate: wg.completionGate,
          ...(wg.clarifyBudget === undefined ? {} : { clarifyBudget: wg.clarifyBudget }),
          ...(wg.fanOut === undefined ? {} : { fanOut: wg.fanOut }),
          members: wg.members.map((m) =>
            m.memberType === 'agent'
              ? {
                  memberType: 'agent' as const,
                  ...(m.agentId != null && catalog.agents.has(m.agentId)
                    ? { agentHandle: handleFor('agent', m.agentId) }
                    : {}),
                  displayName: m.displayName,
                  roleDesc: m.roleDesc,
                }
              : { memberType: 'human' as const, displayName: m.displayName, roleDesc: m.roleDesc },
          ),
        })
        seedFiles.push({ path: `${base}.yaml`, content: doc })
        manifest.push({ ...entryBase, fence: buildWorkgroupFence(wg), dumpHash: sha256(doc) })
      }
    } catch (err) {
      if (!isResourceGoneError(err)) throw err
      if (root) unavailableRoots.push(ref)
      else if (parent !== undefined) hiddenMembers.push(parent)
    }
  }

  // ── inventory/ summaries + summary manifest entries ──
  const detailKeys = new Set(manifest.map((e) => `${e.resourceType}:${e.resourceId}`))
  for (const [type, rows] of inventoryLists) {
    const sorted = [...rows].sort((a, b) => a.name.localeCompare(b.name))
    const kept = sorted.slice(0, cap)
    const dropped = sorted.length - kept.length
    if (dropped > 0) inventoryTruncated[type] = dropped
    const lines: string[] = [
      `# ${type} inventory (${sorted.length} visible${dropped > 0 ? `; TRUNCATED — ${dropped} more not listed, ask the user to mount what you need` : ''})`,
      '',
    ]
    // RFC-348 D5c — agent rows carry their port names (capped ids only, one select).
    const ports =
      type === 'agent'
        ? await (input.loadAgentPorts ?? ((ids) => loadAgentPortsFromDb(db, ids)))(
            kept.map((row) => row.id),
          )
        : new Map<string, AgentPortNames>()
    for (const row of kept) {
      const handle = handleFor(type, row.id)
      const summary = summarizeInventoryRow(type, row.id, catalog)
      const agentPorts = ports.get(row.id)
      const portsText =
        agentPorts === undefined
          ? ''
          : ` · inputs:[${agentPorts.inputs.join(',')}] outputs:[${agentPorts.outputs.join(',')}]`
      lines.push(`- ${handle} \`${row.name}\`${summary === '' ? '' : ` — ${summary}`}${portsText}`)
      const key = `${type}:${row.id}`
      if (!detailKeys.has(key)) {
        manifest.push({
          handle,
          resourceType: type,
          resourceId: row.id,
          root: false,
          detail: false,
        })
        detailKeys.add(key)
      }
    }
    seedFiles.push({ path: `inventory/${type}s.md`, content: `${lines.join('\n')}\n` })
  }

  // ── RFC-348 D5b — inventory/runtimes.md: the names an agent `runtime` may pin.
  // Runtimes are not an ACL resource (no handle); names + protocol only — never
  // binaryPath / configDir / extraArgs. Format locked by design §4 / AC-6.
  const runtimeRows = [...(await listRuntimes(db))].sort((a, b) => a.name.localeCompare(b.name))
  const effectiveDefault: { name: string; protocol: string } =
    input.effectiveDefaultRuntime ?? (await fallbackDefaultRuntime(db))
  const runtimeLines: string[] = [
    `# runtimes (${runtimeRows.length})`,
    `Effective default: ${effectiveDefault.name} (${effectiveDefault.protocol})`,
    RUNTIME_INVENTORY_RULE,
    '',
  ]
  let sawDefault = false
  for (const row of runtimeRows) {
    const isDefault = row.name === effectiveDefault.name
    sawDefault ||= isDefault
    runtimeLines.push(
      `- ${row.name} — protocol ${row.protocol}${isDefault ? ' (default)' : ''}${row.enabled ? '' : ' (disabled)'}`,
    )
  }
  if (!sawDefault) {
    runtimeLines.push(
      `- ${effectiveDefault.name} — protocol ${effectiveDefault.protocol} (built-in, no profile row) (default)`,
    )
  }
  seedFiles.push({ path: 'inventory/runtimes.md', content: `${runtimeLines.join('\n')}\n` })

  // ── RFC-348 D3 — inventory/platform/<type>.md for the nine platform-only types.
  // A loader failure is a dump failure like any other read here (proposal §5):
  // the turn settles as a durable error rather than generating on a partial map.
  const platformInventory = input.platformInventory ?? createDefaultIntentPlatformInventory(db)
  for (const type of platformOnlyResourceTypes()) {
    seedFiles.push({
      path: `inventory/platform/${type}.md`,
      content: renderPlatformInventoryFile(type, await platformInventory.listRows(type, actor)),
    })
  }

  // One choke point: fence EVERY dumped body (mounted resources + inventory)
  // with the turn nonce and its source label, so untrusted resource text can
  // never be read as platform instructions (Codex impl-gate P1-4).
  const fencedSeedFiles: SystemAgentSeedFile[] =
    nonce === undefined
      ? rawSeedFiles
      : rawSeedFiles.map((file) => ({
          path: file.path,
          content: fenceUntrusted(file.path, file.content, nonce),
        }))
  // ── RFC-291 面 C — unavailable roots stay in the manifest ──
  //
  // They are NOT dumped and carry no fence, but the entry must survive: drop it
  // and the row disappears from 「已挂载元素」（the user can no longer even
  // unmount it）, the handle stops resolving for the conversation history, and
  // the freed ordinal can later be minted for a different resource (面 F).
  const unavailableMounts: Array<{ handle: string; resourceType: AclResourceType }> = []
  for (const ref of unavailableRoots) {
    const handle = handleFor(ref.resourceType, ref.resourceId)
    unavailableMounts.push({ handle, resourceType: ref.resourceType })
    manifest.push({
      handle,
      resourceType: ref.resourceType,
      resourceId: ref.resourceId,
      root: true,
      detail: false,
    })
  }
  // Members that vanished mid-dump join the ACL-invisible dependency count of
  // the root they hang off — same bucket, same id-only discretion.
  for (const parent of hiddenMembers) {
    const parentHandle = handleFor(parent.resourceType, parent.resourceId)
    const existing = hiddenDependencies.find((h) => h.parentHandle === parentHandle)
    if (existing === undefined) hiddenDependencies.push({ parentHandle, count: 1 })
    else existing.count += 1
  }

  return {
    // RFC-291 面 B — ONE place carries copy lineage across the rebuild. The
    // manifest above is reconstructed through three independent paths (detail
    // refs / inventory summaries / unavailable roots); without this pass the
    // `copiedFromResourceId` written at commit time would vanish on the next
    // turn and "keep only the newest copy" would hold for one epoch only.
    manifest: inheritCopyProvenance(manifest, input.priorManifest),
    seedFiles: fencedSeedFiles,
    hiddenDependencies,
    inventoryTruncated,
    unavailableMounts,
    agentBranchPorts,
    // RFC-291 面 F — monotonic: never hand back something lower than the
    // watermark we were seeded with, even if this epoch minted nothing.
    handleWatermark: mergeHandleWatermarks(input.handleWatermark, handleWatermarkOf(alloc)),
  }
}

function summarizeInventoryRow(type: AclResourceType, id: string, catalog: VisibleCatalog): string {
  const byType =
    type === 'agent'
      ? catalog.agents
      : type === 'skill'
        ? catalog.skills
        : type === 'mcp'
          ? catalog.mcps
          : type === 'plugin'
            ? catalog.plugins
            : type === 'workflow'
              ? catalog.workflows
              : catalog.workgroups
  return firstLine(byType.get(id)?.description ?? '')
}
