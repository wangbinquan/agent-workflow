// RFC-164 PR-3 — workgroup task launch (design §2/§3).
//
// A workgroup task satisfies tasks.workflow_id NOT NULL by pointing at the
// builtin host workflow row (lazily ensured at first launch) while its REAL frozen
// structure is the per-launch SYNTHESIZED snapshot below: three static host
// nodes —
//
//   __wg_leader__  (agent-single)  ← leader turns + fc gate runs
//   __wg_member__  (agent-single)  ← every member assignment / message turn
//                                    (agentOverrideName 借壳 + shardKey =
//                                    assignment id; RFC-127 / fanout 先例)
//   __wg_clarify__ (clarify)       ← wired to BOTH host nodes so member runs
//                                    can voluntarily <workflow-clarify>
//                                    (channel dispatched 'suppressed')
//
// Members are NOT snapshot nodes — adding/removing members mid-run never
// touches the snapshot (design §2). Launch enters at the SERVICE layer
// (fusion precedent): assertWorkflowLaunchable would 403 the builtin host,
// which is exactly the point — route-level launches cannot target it.

import {
  applySpaceFields,
  initialDwState,
  serializeWorkflowDefinitionStorageV1,
  StartTaskSchema,
  workgroupLaunchReadiness,
  WorkgroupRuntimeConfigSchema,
  type LaunchSpaceFields,
  type StartWorkgroupTask,
  type Task,
  type Workgroup,
  type WorkgroupRuntimeConfig,
} from '@agent-workflow/shared'
import { buildClarifyEdges } from '@agent-workflow/shared'
import { inArray } from 'drizzle-orm'
import { buildDynamicWorkflowGenerateSnapshot } from '@/services/orchestratorAgent'
import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import { agents, workflows } from '@/db/schema'
import { canViewResource } from '@/services/resourceAcl'
import { getWorkgroup } from '@/services/workgroups'
import { startTask, type StartTaskDeps } from '@/services/task'
import { ConflictError, NotFoundError, ValidationError } from '@/util/errors'

// RFC-217 T1 — sentinel constants moved to ./constants (zero-dep leaf; cycle
// fix). Re-exported here for existing test-side importers only; PRODUCTION
// code must import '@/services/workgroup/constants' directly.
export {
  WORKGROUP_HOST_WORKFLOW_ID,
  WORKGROUP_HOST_WORKFLOW_NAME,
  WG_LEADER_NODE_ID,
  WG_MEMBER_NODE_ID,
  WG_CLARIFY_NODE_ID,
} from './constants'
import {
  WORKGROUP_HOST_WORKFLOW_ID,
  WORKGROUP_HOST_WORKFLOW_NAME,
  WG_LEADER_NODE_ID,
  WG_MEMBER_NODE_ID,
  WG_CLARIFY_NODE_ID,
} from './constants'

/**
 * Synthesize the frozen workflow snapshot for a workgroup task. The host
 * agentName values are display placeholders — the engine passes the resolved
 * Agent object per run (agentOverrideName records the actual identity on the
 * row); the frontier never dispatches these nodes (runTask branches to the
 * workgroup engine before runScope).
 */
export function buildWorkgroupHostSnapshot(config: WorkgroupRuntimeConfig): {
  $schema_version: number
  inputs: unknown[]
  nodes: unknown[]
  edges: unknown[]
} {
  const leaderMember = config.members.find((m) => m.id === config.leaderMemberId)
  const firstAgent = config.members.find((m) => m.memberType === 'agent')
  const leaderAgentName = leaderMember?.agentName ?? firstAgent?.agentName ?? 'workgroup-member'
  const memberAgentName = firstAgent?.agentName ?? 'workgroup-member'
  return {
    $schema_version: 1,
    inputs: [],
    nodes: [
      { id: WG_LEADER_NODE_ID, kind: 'agent-single', agentName: leaderAgentName },
      { id: WG_MEMBER_NODE_ID, kind: 'agent-single', agentName: memberAgentName },
      { id: WG_CLARIFY_NODE_ID, kind: 'clarify', sessionMode: 'isolated' },
    ],
    edges: [
      ...buildClarifyEdges(WG_LEADER_NODE_ID, WG_CLARIFY_NODE_ID),
      ...buildClarifyEdges(WG_MEMBER_NODE_ID, WG_CLARIFY_NODE_ID),
    ],
  }
}

/** Freeze the resource-level group into the task-owned runtime config copy. */
export function buildWorkgroupRuntimeConfig(
  group: Workgroup,
  goal: string,
): WorkgroupRuntimeConfig {
  return WorkgroupRuntimeConfigSchema.parse({
    workgroupId: group.id,
    workgroupName: group.name,
    mode: group.mode,
    leaderMemberId: group.leaderMemberId,
    switches: group.switches,
    maxRounds: group.maxRounds,
    completionGate: group.completionGate,
    clarifyBudget: group.clarifyBudget,
    fanOut: group.fanOut,
    instructions: group.instructions,
    goal,
    members: group.members.map((m) => ({
      id: m.id,
      memberType: m.memberType,
      agentName: m.agentName,
      // RFC-223 (PR-3a): freeze the CANONICAL agent id into the task config so
      // the engine resolves each member by id (rename/ABA-safe). The resource
      // member already carries the id (stamped at save, PR-2); the launcher's
      // ACL scope authorized it. `null` for human members / a soft roster ref
      // that never resolved — launch readiness (below) rejects the latter.
      agentId: m.agentId ?? null,
      userId: m.userId,
      displayName: m.displayName,
      roleDesc: m.roleDesc,
    })),
  })
}

/**
 * Lazily seed the builtin host workflow row (FK anchor for workgroup tasks).
 * NOT a migration seed — a migration-seeded row would surface in every fresh
 * DB and break empty-fixture expectations; idempotent via onConflictDoNothing.
 */
export async function ensureWorkgroupHostWorkflow(db: DbClient): Promise<void> {
  await db
    .insert(workflows)
    .values({
      id: WORKGROUP_HOST_WORKFLOW_ID,
      name: WORKGROUP_HOST_WORKFLOW_NAME,
      description: 'RFC-164 workgroup host anchor — do not launch directly',
      definition: serializeWorkflowDefinitionStorageV1({
        $schema_version: 4,
        inputs: [],
        nodes: [],
        edges: [],
      }),
      builtin: true,
    })
    .onConflictDoNothing({ target: workflows.id })
}

/**
 * PR-5 (T24): the task collaborators for a workgroup launch = explicitly-passed
 * collaborators ∪ the group's human members (so the room / answer boundary
 * includes them, proposal 目标 6). Deduped; order-stable (explicit first).
 * Pure — unit-tested without a real launch (which would need a repo source and
 * couple the test to the concurrent RFC-165 space-schema migration).
 */
export function resolveWorkgroupCollaborators(
  explicit: readonly string[] | undefined,
  members: ReadonlyArray<{ memberType: 'agent' | 'human'; userId: string | null }>,
): string[] {
  const humanUserIds = members
    .filter((m) => m.memberType === 'human' && m.userId !== null)
    .map((m) => m.userId as string)
  return [...new Set([...(explicit ?? []), ...humanUserIds])]
}

/**
 * Launch a workgroup task. ACL: the launcher must be able to VIEW the group
 * (missing and invisible are the identical 404, D1); the member-agent closure
 * is implicitly authorized (RFC-099 D3 — same rule as workflow launches).
 * Readiness (≥1 agent member; lw has a designated leader) is enforced HERE,
 * not at save time (决策 #21).
 */
export async function startWorkgroupTask(
  db: DbClient,
  actor: Actor,
  workgroupName: string,
  input: StartWorkgroupTask,
  deps: StartTaskDeps,
): Promise<Task> {
  const group = await getWorkgroup(db, workgroupName)
  if (group === null || !(await canViewResource(db, actor, 'workgroup', group))) {
    throw new NotFoundError('workgroup-not-found', `workgroup '${workgroupName}' not found`)
  }

  // RFC-175 (§2b/§2d-1): immediate-submit OCC guard for relaunch. When the
  // relaunch carries `expectedWorkgroupId`, reject if the current same-named
  // group is a DIFFERENT resource (a delete+recreate-same-name replacement).
  // Compared AFTER the ACL-404 gate above so a mismatch never leaks a private
  // group name's existence as a 409-vs-404 probe (R3-F5). Immediate-launch only
  // (never persisted into a scheduled payload — §2d).
  if (input.expectedWorkgroupId !== undefined && group.id !== input.expectedWorkgroupId) {
    throw new ConflictError(
      'workgroup-id-mismatch',
      `workgroup '${workgroupName}' is not the expected resource (it may have been replaced)`,
    )
  }

  const readiness = workgroupLaunchReadiness(group)
  if (!readiness.ready) {
    throw new ValidationError('workgroup-not-ready', 'workgroup is not launch-ready', {
      reasons: readiness.reasons,
    })
  }

  // PR-5 (T24): human members auto-join as task collaborators (proposal 目标 6).
  const collaboratorUserIds = resolveWorkgroupCollaborators(
    input.collaboratorUserIds,
    group.members,
  )

  const config = buildWorkgroupRuntimeConfig(group, input.goal)
  // RFC-167: a dynamic_workflow group launches into the GENERATE phase — the
  // snapshot is a single built-in orchestrator node (swapped for the generated
  // DAG on human confirm), and the config carries the `dw` state slot beside
  // the runtime config (the lw `gate` free-slot pattern). Turn-engine modes
  // keep the three-node chatroom host snapshot.
  const isDynamic = group.mode === 'dynamic_workflow'
  const snapshot = isDynamic
    ? buildDynamicWorkflowGenerateSnapshot()
    : buildWorkgroupHostSnapshot(config)
  // RFC-217 T2 — the config column is a PURE frozen config again; the dw
  // checkpoint seeds workgroup_task_state via startTaskImpl (same tx).
  const configJson = JSON.stringify(config)

  // Compose the full StartTask candidate and validate through StartTaskSchema
  // so repo-source cross-field rules stay single-sourced (schemas/task.ts).
  // Space fields (RFC-165 modern set: repoUrl+ref / repos[] / scratch) go
  // through applySpaceFields — the ONE assembly point every launch face
  // shares, so adding a space field can't silently skip this endpoint. The
  // cast is safe: StartWorkgroupTaskSchema keeps repos[] shape-lenient and
  // the composed candidate is deep-validated by StartTaskSchema right below.
  const candidate = applySpaceFields(
    {
      workflowId: WORKGROUP_HOST_WORKFLOW_ID,
      name: input.name,
      inputs: {},
      ...(collaboratorUserIds.length > 0 ? { collaboratorUserIds } : {}),
      ...(input.gitUserName !== undefined ? { gitUserName: input.gitUserName } : {}),
      ...(input.gitUserEmail !== undefined ? { gitUserEmail: input.gitUserEmail } : {}),
      ...(input.workingBranch !== undefined ? { workingBranch: input.workingBranch } : {}),
      ...(input.autoCommitPush !== undefined ? { autoCommitPush: input.autoCommitPush } : {}),
      ...(input.maxDurationMs !== undefined ? { maxDurationMs: input.maxDurationMs } : {}),
      ...(input.maxTotalTokens !== undefined ? { maxTotalTokens: input.maxTotalTokens } : {}),
    },
    input as LaunchSpaceFields,
  )
  const parsed = StartTaskSchema.safeParse(candidate)
  if (!parsed.success) {
    throw new ValidationError('workgroup-launch-invalid', 'invalid workgroup launch payload', {
      issues: parsed.error.issues,
    })
  }

  // Save-time leniency lets a roster survive an agent deletion, but launch must
  // fail before task/worktree materialization. Without this gate leader_worker
  // fails only after spending setup work, while free_collab can repeatedly wake
  // an unresolvable member without a run, cursor advance, or visible error.
  //
  // RFC-223 (PR-2): validate the roster by CANONICAL agent id (frozen at save,
  // beside the display name). This makes a member survive a rename (the id is
  // stable, no rename guard shields a workgroup member) and refuses to silently
  // bind a delete+recreate-same-name replacement (ABA). A member with no frozen
  // id (a soft reference to an agent that did not exist at save) or whose id no
  // longer resolves is reported missing — re-save the roster to (re-)bind it.
  const agentMembers = group.members.filter((m) => m.memberType === 'agent')
  const rosterAgentIds = [
    ...new Set(agentMembers.flatMap((m) => (typeof m.agentId === 'string' ? [m.agentId] : []))),
  ]
  const existingAgentIds =
    rosterAgentIds.length === 0
      ? new Set<string>()
      : new Set(
          (
            await db
              .select({ id: agents.id })
              .from(agents)
              .where(inArray(agents.id, rosterAgentIds))
          ).map((row) => row.id),
        )
  const missingAgentNames = [
    ...new Set(
      agentMembers
        .filter((m) => typeof m.agentId !== 'string' || !existingAgentIds.has(m.agentId))
        .map((m) => m.agentName ?? '(unnamed)'),
    ),
  ]
  if (missingAgentNames.length > 0) {
    throw new ValidationError('workgroup-not-ready', 'workgroup is not launch-ready', {
      reasons: ['agent-missing'],
      missingAgentNames,
    })
  }

  await ensureWorkgroupHostWorkflow(db)

  return startTask(parsed.data, {
    ...deps,
    workgroupLaunch: {
      workgroupId: group.id,
      configJson,
      snapshotJson: JSON.stringify(snapshot),
      ...(isDynamic ? { dw: initialDwState() } : {}),
    },
  })
}
