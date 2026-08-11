// RFC-282 B2 (§2.3) — the resource-resolution layer, moved home.
//
// `prepareNodeRunInjection` + `resolveSkills` lived in scheduler.ts (~200
// lines): dependsOn closure expansion, RFC-228 exact-identity fences, the
// RFC-223 PR-6 name-conflict gate and the RFC-170 skill quarantine gate. The
// logic moves VERBATIM except for one registered behavior change (§7-7):
//
//   skill quarantine / canonical-path violations were THROWS while the
//   mcp/plugin fences were typed results — the throw bubbled through runScope
//   into a TASK-level failure, eating the node-level attribution every other
//   resolution failure gets. Both gates now return `{kind:'failed'}` like the
//   rest, so the failing NODE fails and its siblings (incl. commit-push)
//   continue. rfc282-b2-resolve-injection.test.ts red→green documents the flip.
//
// The result is the runtime-neutral `AgentInjectionSpecV1` — the same shape
// `driver.buildAgentSpawn` consumes — so the scheduler hands one object to
// the runner instead of four parallel arrays.

import { eq } from 'drizzle-orm'
import { join as pathJoin } from 'node:path'
import type { Agent, AgentSkillRef, Mcp, Plugin } from '@agent-workflow/shared'
import { DISPATCH_CALL_POLICY } from '@agent-workflow/shared'
import type { DbClient } from '@/db/client'
import { skills } from '@/db/schema'
import type { Logger } from '@/util/log'
import { ConflictError, SkillQuarantinedError } from '@/util/errors'
import { resolveDependsClosure } from '@/services/agentDeps'
import { collectMcpIdsFromClosure, loadMcpsByIds } from '@/services/mcpClosure'
import { collectPluginIdsFromClosure, loadPluginsByIds } from '@/services/pluginClosure'
import { agentSkillRef, runtimeRefKey } from '@/services/ref/runtimeRef'
import {
  findManagedInjectionNameConflict,
  formatManagedInjectionNameConflict,
  type ManagedInjectionIdentity,
} from '@/services/runtime/injectionIdentity'
import { isSkillInjectableThisBoot } from '@/services/skillBootVerify'
import { skillFilesRel } from '@/services/skillIdentityPaths'
import type { AgentInjectionSpecV1, ResolvedSkill } from '@/services/runtime/types'

/** Advisory notes produced during resolution (reserved; the disabled-MCP skip
 *  is declared at the driver layer today — B3 may route table-sourced notes
 *  through here). */
export interface ResolutionNotice {
  readonly code: string
  readonly detail: string
}

/** The resolver's spec: every face PRESENT and mutable (callers thread the
 *  arrays straight into RunTaskOptions), structurally an AgentInjectionSpecV1. */
export interface ResolvedInjectionSpec extends AgentInjectionSpecV1 {
  agent: Agent
  dependents: Agent[]
  skills: ResolvedSkill[]
  mcps: Mcp[]
  plugins: Plugin[]
}

export type InjectionResolution =
  | { kind: 'ok'; spec: ResolvedInjectionSpec; notices: readonly ResolutionNotice[] }
  | { kind: 'failed'; summary: string; message: string }

export interface ResolveInjectionOpts {
  readonly appHome: string
  readonly log: Logger
  /**
   * design §9-5 — the writeSem-held call sites (commit-push / merge) thread
   * their scope signal so future DB/staging work inside this resolver can be
   * cancelled instead of blocking every writer for the task. Today's steps
   * are not yet cancellation-aware; the parameter is the contract.
   */
  readonly signal?: AbortSignal
}

/**
 * Resolve one agent's full injection closure → runtime-neutral spec.
 *
 * Fail shapes are `NodeStepResult`-compatible so every scheduler entry maps
 * them onto its normal NODE-level failure path (cycles, missing deps, missing
 * or ambiguous resources, disabled plugins, quarantined skills alike).
 */
export async function resolveInjection(
  db: DbClient,
  agent: Agent,
  opts: ResolveInjectionOpts,
): Promise<InjectionResolution> {
  const { appHome, log } = opts
  const closure = await resolveDependsClosure(db, agent, { call: DISPATCH_CALL_POLICY }).catch(
    (err: Error & { code?: string; details?: unknown }) => {
      // resolveDependsClosure throws DomainError for missing deps. Surface
      // the code via NodeStepResult so the caller's normal failure path
      // handles it — no separate exception path needed.
      log.warn('dependsOn resolve failed', {
        agent: agent.name,
        code: err.code,
        message: err.message,
      })
      return { ok: false as const, cyclePath: [] as string[], error: err }
    },
  )
  if ('error' in closure) {
    return {
      kind: 'failed',
      summary: `agent '${agent.name}' depends on missing agent`,
      message: closure.error.code ?? 'agent-dependency-not-found',
    }
  }
  if (closure.ok === false) {
    log.warn('dependsOn cycle detected', {
      agent: agent.name,
      cyclePath: closure.cyclePath,
    })
    return {
      kind: 'failed',
      summary: `agent '${agent.name}' dependsOn forms a cycle`,
      message: `agent-dependency-cycle: ${closure.cyclePath.join(' → ')}`,
    }
  }
  const dependents = closure.agents.slice(1) // [0] is the root
  // RFC-223 (PR-1): skills are typed refs (managed{skillId} / project{name}).
  // Union across the closure de-duped by ref identity (first-seen order).
  // RFC-271 T6f：去重键走 canonical `runtimeRefKey`（类型进 key 的 JSON 元组），
  // 不再是手写的 `m:`/`p:` 前缀串——自造命名空间只要来第三类引用就会撞车。
  const skillsUnion: AgentSkillRef[] = []
  const seenSkills = new Set<string>()
  for (const ref of [...agent.skills, ...dependents.flatMap((a) => a.skills)]) {
    const key = runtimeRefKey(agentSkillRef(ref))
    if (seenSkills.has(key)) continue
    seenSkills.add(key)
    skillsUnion.push(ref)
  }
  const skillResolution = await resolveSkills(db, appHome, skillsUnion)
  if (skillResolution.kind === 'failed') {
    return {
      kind: 'failed',
      summary: `agent '${agent.name}' ${skillResolution.summarySuffix}`,
      message: skillResolution.message,
    }
  }
  const { resolvedSkills, managedSkillIdentities } = skillResolution
  // RFC-228: exact-set checks are the final race fence. A resource can become
  // unavailable after launch validation; never run a reduced capability set.
  const requestedManagedSkillIds = skillsUnion.flatMap((ref) =>
    ref.kind === 'managed' ? [ref.skillId] : [],
  )
  const resolvedManagedSkillIds = new Set(managedSkillIdentities.map((skill) => skill.id))
  const missingSkillIds = requestedManagedSkillIds.filter(
    (skillId) => !resolvedManagedSkillIds.has(skillId),
  )
  if (missingSkillIds.length > 0) {
    return {
      kind: 'failed',
      summary: `agent '${agent.name}' references a missing managed Skill`,
      message: 'skill-not-found',
    }
  }

  // RFC-028: union MCP ids across the full closure (root first, then BFS).
  const mcpIds = collectMcpIdsFromClosure(closure.agents)
  const mcps = await loadMcpsByIds(db, mcpIds)
  const loadedMcpIds = new Set(mcps.map((mcp) => mcp.id))
  if (mcpIds.some((mcpId) => !loadedMcpIds.has(mcpId))) {
    return {
      kind: 'failed',
      summary: `agent '${agent.name}' references a missing MCP`,
      message: 'mcp-not-found',
    }
  }
  // RFC-223 PR-6: the external runtimes still key these three managed
  // namespaces by display name. Detect two canonical ids sharing one key at
  // the common hydration boundary, before either runtime stages a skill or
  // assembles a spawn. Disabled MCPs are intentionally outside the injected
  // set; repo-local project skills are self-discovered and outside this guard.
  const nameConflict = findManagedInjectionNameConflict({
    agents: closure.agents,
    managedSkills: managedSkillIdentities,
    mcps,
  })
  if (nameConflict !== null) {
    const message = formatManagedInjectionNameConflict(nameConflict)
    log.warn('managed injection name conflict', {
      agent: agent.name,
      kind: nameConflict.kind,
      name: nameConflict.name,
      ids: [nameConflict.firstId, nameConflict.secondId],
    })
    return {
      kind: 'failed',
      summary: `managed injection name '${nameConflict.name}' is ambiguous`,
      message,
    }
  }
  // RFC-031/RFC-228: same exact closure + hydrate fence for plugins.
  const pluginIds = collectPluginIdsFromClosure(closure.agents)
  const plugins = await loadPluginsByIds(db, pluginIds)
  const loadedPluginIds = new Set(plugins.map((plugin) => plugin.id))
  if (pluginIds.some((pluginId) => !loadedPluginIds.has(pluginId))) {
    return {
      kind: 'failed',
      summary: `agent '${agent.name}' references a missing Plugin`,
      message: 'plugin-not-found',
    }
  }
  if (plugins.some((plugin) => !plugin.enabled)) {
    // DISABLED_RESOURCE_POLICY.plugin — fail-closed (v2: value unchanged; the
    // policy table indexes this emitter).
    return {
      kind: 'failed',
      summary: `agent '${agent.name}' references a disabled Plugin`,
      message: 'plugin-disabled',
    }
  }
  return {
    kind: 'ok',
    spec: { mcps, agent, dependents, plugins: [...plugins], skills: resolvedSkills },
    notices: [],
  }
}

type SkillsResolution =
  | {
      kind: 'ok'
      resolvedSkills: ResolvedSkill[]
      managedSkillIdentities: ManagedInjectionIdentity[]
    }
  | { kind: 'failed'; summarySuffix: string; message: string }

// RFC-223 (PR-1): resolve typed skill refs to injectable skills. A `managed`
// ref is looked up BY ID; the injection NAME (opencode's registry key — AC7)
// and disk path come from the row. A `project` ref names a repo-local skill
// (RFC-178, no DB row) that opencode self-discovers — passed through by name.
// A managed ref whose id no longer resolves is omitted from this low-level
// result; resolveInjection performs RFC-228 exact-set comparison and fails
// before any runtime spawn.
//
// RFC-282 §7-7 — the RFC-170 T9 quarantine gate and the RFC-223 PR-5
// canonical-path gate return typed failures now (they were the only THROWS in
// this resolver; a throw escaped runScope into a task-level failure).
async function resolveSkills(
  db: DbClient,
  appHome: string,
  refs: AgentSkillRef[],
): Promise<SkillsResolution> {
  const out: ResolvedSkill[] = []
  const managedSkillIdentities: ManagedInjectionIdentity[] = []
  for (const ref of refs) {
    if (ref.kind === 'project') {
      out.push({ name: ref.name, sourceKind: 'project' })
      continue
    }
    const rows = await db.select().from(skills).where(eq(skills.id, ref.skillId)).limit(1)
    const row = rows[0]
    if (!row) continue // exact-set caller converts this into skill-not-found
    // RFC-170 T9 (§invariant④): fail-closed if this managed skill did not verify
    // this boot (snapshot unverified/quarantined) — never stage corrupt/missing
    // content into a spawn. Inactive before the boot reverify (tests/pre-HTTP).
    if (!isSkillInjectableThisBoot({ id: row.id, sourceKind: 'managed' })) {
      return {
        kind: 'failed',
        summarySuffix: `references quarantined Skill '${row.name}'`,
        message: new SkillQuarantinedError(row.name).code,
      }
    }
    // RFC-223 PR-5: DB/FS identity is the immutable id; name survives only as
    // the runtime-visible injection key. The boot barrier guarantees this exact
    // path, and the scheduler refuses any bypassed/inconsistent row.
    const expectedPath = skillFilesRel(row.id)
    if (row.managedPath !== expectedPath) {
      return {
        kind: 'failed',
        summarySuffix: `references Skill '${row.name}' pending identity migration`,
        message: new ConflictError(
          'skill-path-not-canonical',
          `skill '${row.name}' has not completed its identity migration`,
        ).code,
      }
    }
    const skillPath = pathJoin(appHome, expectedPath)
    out.push({
      name: row.name,
      sourceKind: 'managed',
      sourcePath: skillPath,
      skillId: row.id,
      contentVersion: row.contentVersion,
      readContentVersion: async () => {
        const current = await db
          .select({ contentVersion: skills.contentVersion })
          .from(skills)
          .where(eq(skills.id, row.id))
          .limit(1)
        return current[0]?.contentVersion ?? -1
      },
    })
    managedSkillIdentities.push({ id: row.id, name: row.name })
  }
  return { kind: 'ok', resolvedSkills: out, managedSkillIdentities }
}
