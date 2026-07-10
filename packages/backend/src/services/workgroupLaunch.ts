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
import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import { workflows } from '@/db/schema'
import { canViewResource } from '@/services/resourceAcl'
import { getWorkgroup } from '@/services/workgroups'
import { startTask, type StartTaskDeps } from '@/services/task'
import { NotFoundError, ValidationError } from '@/util/errors'

/** Fixed ULID-shaped id of the builtin host workflow (lazy seed, ensureWorkgroupHostWorkflow). */
export const WORKGROUP_HOST_WORKFLOW_ID = '00000000000000WORKGROUP00'
export const WORKGROUP_HOST_WORKFLOW_NAME = '__workgroup_host__'

export const WG_LEADER_NODE_ID = '__wg_leader__'
export const WG_MEMBER_NODE_ID = '__wg_member__'
export const WG_CLARIFY_NODE_ID = '__wg_clarify__'

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
    instructions: group.instructions,
    goal,
    members: group.members.map((m) => ({
      id: m.id,
      memberType: m.memberType,
      agentName: m.agentName,
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
      definition: '{"$schema_version":1,"inputs":[],"nodes":[],"edges":[]}',
      builtin: true,
    })
    .onConflictDoNothing({ target: workflows.id })
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

  const readiness = workgroupLaunchReadiness(group)
  if (!readiness.ready) {
    throw new ValidationError('workgroup-not-ready', 'workgroup is not launch-ready', {
      reasons: readiness.reasons,
    })
  }

  // PR-5 (T24): human members are first-class — they auto-join the task as
  // collaborators so the room/answer boundary includes them (proposal 目标 6).
  const humanUserIds = group.members
    .filter((m) => m.memberType === 'human' && m.userId !== null)
    .map((m) => m.userId as string)

  await ensureWorkgroupHostWorkflow(db)
  const config = buildWorkgroupRuntimeConfig(group, input.goal)
  const snapshot = buildWorkgroupHostSnapshot(config)

  // Compose the full StartTask candidate and validate through StartTaskSchema
  // so repo-source cross-field rules stay single-sourced (schemas/task.ts).
  // RFC-165: the SPACE fields go through `applySpaceFields` — the shared
  // assembly point — so a schema-only space change can never silently drop a
  // field here again (design F2; RFC-125 lesson).
  const candidate = applySpaceFields(
    {
      workflowId: WORKGROUP_HOST_WORKFLOW_ID,
      name: input.name,
      inputs: {},
      ...(input.collaboratorUserIds !== undefined
        ? { collaboratorUserIds: input.collaboratorUserIds }
        : {}),
      ...(input.gitUserName !== undefined ? { gitUserName: input.gitUserName } : {}),
      ...(input.gitUserEmail !== undefined ? { gitUserEmail: input.gitUserEmail } : {}),
      ...(input.workingBranch !== undefined ? { workingBranch: input.workingBranch } : {}),
      ...(input.autoCommitPush !== undefined ? { autoCommitPush: input.autoCommitPush } : {}),
      ...(input.maxDurationMs !== undefined ? { maxDurationMs: input.maxDurationMs } : {}),
      ...(input.maxTotalTokens !== undefined ? { maxTotalTokens: input.maxTotalTokens } : {}),
    },
    {
      scratch: input.scratch,
      repoUrl: input.repoUrl,
      ref: input.ref,
      repos: input.repos as LaunchSpaceFields['repos'],
    },
  )
  const parsed = StartTaskSchema.safeParse(candidate)
  if (!parsed.success) {
    throw new ValidationError('workgroup-launch-invalid', 'invalid workgroup launch payload', {
      issues: parsed.error.issues,
    })
  }

  return startTask(parsed.data, {
    ...deps,
    workgroupLaunch: {
      workgroupId: group.id,
      configJson: JSON.stringify(config),
      snapshotJson: JSON.stringify(snapshot),
    },
  })
}
