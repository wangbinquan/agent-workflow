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

// RFC-359 AC-1（plan §5hn 批次二 ⑧）：`startWorkgroupTask` 整份删除——它是 legacy 启动路的
// 工作组入口，门面（`services/execution/executor.ts`）退役后生产零消费者。工作组启动现在只有
// 一条：启动参与者的工作组臂 → 根启动内核（两个引擎共用）。本文件剩下的是**合成宿主快照**与
// 运行期配置那几件事，启动路与测试都还在用。
import {
  resolveWorkgroupOutputContract,
  serializeWorkflowDefinitionStorageV1,
  WorkgroupRuntimeConfigSchema,
  type Workgroup,
  type WorkgroupRuntimeConfig,
  WORKFLOW_SCHEMA_VERSION,
} from '@agent-workflow/shared'
import { buildClarifyEdges } from '@agent-workflow/shared'
import type { ProviderNeutralDatabase } from '@/db/query'
import { workflows } from '@/db/schema'
import { initialBuiltinResourceAcl } from '@/modules/resource-catalog/application/resourceDefaults'

// RFC-217 T1 — sentinel constants moved to ./constants (zero-dep leaf; cycle
// fix). Re-exported here for existing test-side importers only; PRODUCTION
// code must import '@/modules/resource-catalog/infrastructure/legacy/workgroup/constants' directly.
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
    $schema_version: WORKFLOW_SCHEMA_VERSION,
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
/** Exactly the fields the runtime config is derived from. A frozen call-closure
 *  snapshot (RFC-345 `TaskExecutionWorkgroupSnapshot`) carries these and no row
 *  metadata, so the frozen launch face must not demand the full `Workgroup`. */
export type WorkgroupRuntimeConfigSource = Pick<
  Workgroup,
  | 'id'
  | 'name'
  | 'mode'
  | 'outputContract'
  | 'leaderMemberId'
  | 'switches'
  | 'maxRounds'
  | 'completionGate'
  | 'clarifyBudget'
  | 'fanOut'
  | 'instructions'
  | 'members'
>

export function buildWorkgroupRuntimeConfig(
  group: WorkgroupRuntimeConfigSource,
  goal: string,
): WorkgroupRuntimeConfig {
  return WorkgroupRuntimeConfigSchema.parse({
    workgroupId: group.id,
    workgroupName: group.name,
    mode: group.mode,
    outputContract: resolveWorkgroupOutputContract(group.outputContract),
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
 *
 * RFC-359：形参收成 `ProviderNeutralDatabase`。函数体本来就只有一条带
 * `onConflictDoNothing` 的 insert（中立面广泛支持），此前写成 bun:sqlite 专有的 `DbClient`
 * 纯属未收敛——代价是任何想调它的用例都被钉死在 SQLite 上。
 */
export async function ensureWorkgroupHostWorkflow(db: ProviderNeutralDatabase): Promise<void> {
  await db
    .insert(workflows)
    .values({
      id: WORKGROUP_HOST_WORKFLOW_ID,
      name: WORKGROUP_HOST_WORKFLOW_NAME,
      description: 'RFC-164 workgroup host anchor — do not launch directly',
      definition: serializeWorkflowDefinitionStorageV1({
        $schema_version: WORKFLOW_SCHEMA_VERSION,
        inputs: [],
        nodes: [],
        edges: [],
      }),
      ...initialBuiltinResourceAcl(null),
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
