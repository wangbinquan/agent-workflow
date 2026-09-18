import {
  TERMINAL_TASK_STATUSES,
  type Agent,
  type AgentSkillRef,
  type AclResourceType,
} from '@agent-workflow/shared'
import { and, eq, inArray, notInArray } from 'drizzle-orm'

import { agents, mcps, plugins, scheduledTasks, skills, tasks, workflows } from '@/db/schema'
import {
  reconcileCreatedAgentExecutionContractPorts,
  reconcileUpdatedAgentExecutionContractPorts,
} from '@/modules/execution-contract/public/commands'
import type { ProviderNeutralDatabase } from '@/db/query'
import { ConflictError, ValidationError } from '@/util/errors'
import { isAgentLaunching } from '@/services/agentLaunchReservation'
import { scheduledRowsReferencing } from '@/services/scheduledTaskRefs'

import { assertAgentResourceIntegrity } from '../application/agents/agentResourceIntegrity'
import type { AgentResourceInventorySource } from '../application/agents/ports'
import type { ResourceAuthorizationApplication } from '../application/resourceAuthorization'
import {
  discloseRefsSync,
  discloseScheduleRefs,
  isVisibleRow,
  type AclRow,
} from '../domain/resourceAccess'
import { grantedResourceIdsFor } from './resourceVisibility'
import type { AgentOperationContext } from '../public/participants'
import {
  PLUGIN_DISABLED_ERROR_CODE,
  type AgentReferenceLabels,
  type AgentReferenceLabelsInput,
} from '../public/types'
import { extractWorkflowAgentRefs } from './legacy/resourceRefs'
import { agentsDependingOnIn } from '../application/agents/agentDependencyValidation'
import type { AgentPersistenceSemantics } from './agentRepository'
import { assertAgentDependencyTraversal } from './agentDependencyTraversal'
import { parseAgentDependencyIds } from './agentDependencyJson'
import { assertBranchPortsDeclared } from './agentBranchPorts'
import type { ResourceCatalogTransaction } from './resourceCatalogTransaction'

interface NamedAclRow extends AclRow {
  readonly id: string
  readonly name: string
  readonly ownerUserId: string | null
  readonly visibility: 'public' | 'private'
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))]
}

function managedSkillIds(refs: readonly AgentSkillRef[]): string[] {
  return unique(refs.flatMap((ref) => (ref.kind === 'managed' ? [ref.skillId] : [])))
}

async function rowsByIds(
  transaction: ResourceCatalogTransaction,
  type: Extract<AclResourceType, 'agent' | 'skill' | 'mcp' | 'plugin'>,
  ids: readonly string[],
): Promise<readonly NamedAclRow[]> {
  if (ids.length === 0) return []
  switch (type) {
    case 'agent':
      return transaction
        .select({
          id: agents.id,
          name: agents.name,
          ownerUserId: agents.ownerUserId,
          visibility: agents.visibility,
        })
        .from(agents)
        .where(inArray(agents.id, [...ids]))
    case 'skill':
      return transaction
        .select({
          id: skills.id,
          name: skills.name,
          ownerUserId: skills.ownerUserId,
          visibility: skills.visibility,
        })
        .from(skills)
        .where(and(inArray(skills.id, [...ids]), eq(skills.reservationState, 'ready')))
    case 'mcp':
      return transaction
        .select({
          id: mcps.id,
          name: mcps.name,
          ownerUserId: mcps.ownerUserId,
          visibility: mcps.visibility,
        })
        .from(mcps)
        .where(inArray(mcps.id, [...ids]))
    case 'plugin':
      return transaction
        .select({
          id: plugins.id,
          name: plugins.name,
          ownerUserId: plugins.ownerUserId,
          visibility: plugins.visibility,
        })
        .from(plugins)
        .where(and(inArray(plugins.id, [...ids]), eq(plugins.enabled, true)))
  }
}

/**
 * RFC-031 的 `plugin-disabled` 闸（RFC-359 §5fq 回补，2026-09-19）。
 *
 * D14 合一时这一档丢了顶层 code：合一前 SQLite 侧每次保存都对**全量** plugin 引用查
 * `enabled`，停用的报 `plugin-disabled` + 「agent references disabled plugin(s): …」；
 * 合一后逐类守卫只查 `onlyNew`（新增引用），于是「插件事后被停用」这一档落到 RFC-228 闭包
 * 预检手里，顶层 code 变成笼统的 `agent-resources-invalid`（`plugin-disabled` 只作为 issues
 * 里的一条）。两种情况下保存都会被拒，差别在**用户读到的是哪一句**——e2e RES-X3 断言的正是
 * 「拒了却不说是插件被停用 ⇒ 用户对着一条读不懂的报错，不知道该去开哪个开关」。
 *
 * 「只校验新增引用」这条规则不动：`enabled` 是**被引用资源的状态变化**，与「这条引用是不是
 * 新的」无关，所以按全量查——存在性 / ACL 仍然只查新增。
 */
async function assertPluginsEnabled(
  transaction: ResourceCatalogTransaction,
  ids: readonly string[],
): Promise<void> {
  const unique = [...new Set(ids.filter((id) => id.length > 0))]
  if (unique.length === 0) return
  const rows = await transaction
    .select({ id: plugins.id, enabled: plugins.enabled })
    .from(plugins)
    .where(inArray(plugins.id, unique))
  const disabled = rows.filter((row) => !row.enabled).map((row) => row.id)
  if (disabled.length > 0) {
    throw new ValidationError(
      PLUGIN_DISABLED_ERROR_CODE,
      `agent references disabled plugin(s): ${disabled.join(', ')}`,
      { disabled },
    )
  }
}

async function assertReferencesUsable(input: {
  readonly transaction: ResourceCatalogTransaction
  readonly authority: AgentOperationContext
  readonly type: Extract<AclResourceType, 'agent' | 'skill' | 'mcp' | 'plugin'>
  readonly ids: readonly string[]
  readonly missingCode: string
  readonly missingLabel: string
}): Promise<void> {
  const ids = unique(input.ids)
  if (ids.length === 0) return
  const [rows, grants] = await Promise.all([
    rowsByIds(input.transaction, input.type, ids),
    grantedResourceIdsFor(input.transaction, input.authority, input.type),
  ])
  const byId = new Map(rows.map((row) => [row.id, row]))
  const missing = ids.filter((id) => !byId.has(id))
  if (missing.length > 0) {
    throw new ValidationError(
      input.missingCode,
      `agent references unknown ${input.missingLabel}(s): ${missing.join(', ')}`,
      { notFound: missing },
    )
  }
  const hidden = ids.filter((id) => {
    const row = byId.get(id)
    return row !== undefined && !isVisibleRow(input.authority, row, grants)
  })
  if (hidden.length > 0) {
    throw new ValidationError(
      'acl-missing-refs',
      `you do not have access to: ${hidden.map((id) => `${input.type} '${id}'`).join(', ')}`,
      { missing: hidden.map((id) => ({ type: input.type, name: id })) },
    )
  }
}

async function assertRuntime(
  runtimeProfiles: AgentRuntimeProfileLookup,
  runtime: string | null | undefined,
  previous?: string,
): Promise<void> {
  if (runtime === null || runtime === undefined) return
  const profile = await runtimeProfiles.get(runtime)
  if (profile === null) {
    throw new ValidationError('runtime-not-found', `agent references unknown runtime: ${runtime}`, {
      notFound: [runtime],
    })
  }
  if (!profile.enabled && runtime !== previous) {
    throw new ValidationError(
      'runtime-disabled',
      `agent references disabled runtime: ${runtime}; enable it or pick another`,
      { disabled: [runtime] },
    )
  }
}

async function assertDependencyGraph(
  transaction: ResourceCatalogTransaction,
  candidateId: string,
  dependencyIds: readonly string[],
): Promise<void> {
  if (dependencyIds.includes(candidateId)) {
    throw new ValidationError('agent-dependency-self', 'agent cannot depend on itself')
  }
  await assertAgentDependencyTraversal(candidateId, unique(dependencyIds), async (id) => {
    const row = (
      await transaction
        .select({ dependsOn: agents.dependsOn })
        .from(agents)
        .where(eq(agents.id, id))
        .limit(1)
    )[0]
    if (row === undefined) return undefined
    return parseAgentDependencyIds(() => JSON.parse(row.dependsOn))
  })
}

function onlyNew(next: readonly string[], previous: readonly string[] | undefined): string[] {
  const existing = new Set(previous ?? [])
  return unique(next).filter((id) => !existing.has(id))
}

async function assertCandidate(input: {
  readonly transaction: ResourceCatalogTransaction
  readonly authority: AgentOperationContext
  readonly runtimeProfiles: AgentRuntimeProfileLookup
  readonly candidate: Agent
  readonly previous?: Agent
}): Promise<void> {
  assertBranchPortsDeclared(input.candidate)
  await assertRuntime(input.runtimeProfiles, input.candidate.runtime, input.previous?.runtime)
  await assertReferencesUsable({
    transaction: input.transaction,
    authority: input.authority,
    type: 'agent',
    ids: onlyNew(input.candidate.dependsOn, input.previous?.dependsOn),
    missingCode: 'agent-dependency-not-found',
    missingLabel: 'agent dependency',
  })
  await assertReferencesUsable({
    transaction: input.transaction,
    authority: input.authority,
    type: 'mcp',
    ids: onlyNew(input.candidate.mcp, input.previous?.mcp),
    missingCode: 'mcp-not-found',
    missingLabel: 'mcp',
  })
  await assertReferencesUsable({
    transaction: input.transaction,
    authority: input.authority,
    type: 'plugin',
    ids: onlyNew(input.candidate.plugins, input.previous?.plugins),
    missingCode: 'plugin-not-found',
    missingLabel: 'plugin',
  })
  await assertPluginsEnabled(input.transaction, input.candidate.plugins)
  await assertDependencyGraph(input.transaction, input.candidate.id, input.candidate.dependsOn)
}

/**
 * managed skill 的可用性围栏放在 RFC-228 结构化预检**之后**：合一前的 SQLite 路径没有逐类的 skill 存在性守卫，缺失的
 * managed skill 一律由预检以 `agent-resources-invalid` + issues 报出（rfc223-pr1-impl-gate 锁）；这里只兜授权与并发。
 */
async function assertSkillReferencesUsable(input: {
  readonly transaction: ResourceCatalogTransaction
  readonly authority: AgentOperationContext
  readonly candidate: Agent
  readonly previous?: Agent
}): Promise<void> {
  await assertReferencesUsable({
    transaction: input.transaction,
    authority: input.authority,
    type: 'skill',
    ids: onlyNew(
      managedSkillIds(input.candidate.skills),
      managedSkillIds(input.previous?.skills ?? []),
    ),
    missingCode: 'skill-not-found',
    missingLabel: 'managed skill',
  })
}

/**
 * 删除前的引用闸（RFC-359 §5fq 回补，2026-09-19）。
 *
 * D14（`a507b13ea`，2026-09-05）把 Agent 聚合合成「一份实现」时，这一组闸取的是**弱的那一
 * 半**：四条各自不同的拒绝退化成一条不带 details 的 `agent-in-use`，非终态任务、定时任务、
 * 启动占用三条闸整个消失。用户可见后果——跑着任务的代理能被删掉（任务当场失去它的定义）、
 * 被定时任务引用的代理能被删掉（到点在无人值守下失败）、拒绝理由不点名拦路者（详情页只剩
 * 一条笼统红条，用户不知道该去改哪个工作流 / 解哪条依赖）。
 *
 * 覆盖这些行为的 e2e（AGENT-09~12）都带 `@nightly`，推送档不跑，于是 e2e-full /
 * e2e-webkit 两条夜跑从 2026-09-06 起天天红、连红十三晚没人认领。按 §5fq「各取更强的一半
 * 合成一份」补回强的那一半，判据与次序照 legacy 的 `deleteAgent`（自 D14 起已无调用方）。
 */
async function assertNotReferenced(
  transaction: ResourceCatalogTransaction,
  authority: AgentOperationContext,
  current: Agent,
): Promise<void> {
  // RFC-175 §2e：单代理启动正握着这个 id 时先拒。启动按**名字**从冻结快照里解析代理，
  // 删掉再同名重建会让任务跑上另一个代理（ABA）。同进程内存预订，与删除同一笔事务里查。
  if (isAgentLaunching(current.id)) {
    throw new ConflictError(
      'agent-launching',
      `agent '${current.name}' has a task launch in progress; retry after it completes`,
    )
  }
  // RFC-285 B2 档位：agent 对**任务**引用零检查即是统一中档（任务快照冻结定义），这里
  // 的 agent-in-use 挡的是 **workflow 定义**引用——活的编辑面，删了就当场悬空。
  const workflowRows = await transaction
    .select({
      id: workflows.id,
      name: workflows.name,
      definition: workflows.definition,
      ownerUserId: workflows.ownerUserId,
      visibility: workflows.visibility,
    })
    .from(workflows)
  const referencingWorkflows = workflowRows.filter((row) => {
    try {
      const decoded: unknown = JSON.parse(row.definition)
      return extractWorkflowAgentRefs(
        typeof decoded === 'object' && decoded !== null
          ? (decoded as { readonly nodes?: ReadonlyArray<Record<string, unknown>> })
          : {},
      ).has(current.id)
    } catch {
      // 坏 JSON 按「无引用」算：保存期的工作流校验器才是它的归口。
      return false
    }
  })
  if (referencingWorkflows.length > 0) {
    throw new ConflictError(
      'agent-in-use',
      `agent '${current.name}' is referenced by ${referencingWorkflows.length} workflow(s)`,
      discloseRefsSync(
        authority,
        referencingWorkflows,
        await grantedResourceIdsFor(transaction, authority, 'workflow'),
      ),
    )
  }
  // RFC-022 反向依赖闸：别的代理的 dependsOn 闭包里还提到它就拒，逼调用方先解上游，
  // 免得运行期才炸 `agent-dependency-not-found`。
  const agentRows = await transaction
    .select({
      id: agents.id,
      name: agents.name,
      dependsOn: agents.dependsOn,
      ownerUserId: agents.ownerUserId,
      visibility: agents.visibility,
    })
    .from(agents)
  const dependents = agentsDependingOnIn(
    agentRows.filter((row) => row.id !== current.id),
    current.id,
  )
  if (dependents.length > 0) {
    throw new ConflictError(
      'agent-dependency-still-referenced',
      `agent '${current.name}' is referenced by ${dependents.length} other agent(s)' dependsOn`,
      discloseRefsSync(
        authority,
        dependents,
        await grantedResourceIdsFor(transaction, authority, 'agent'),
      ),
    )
  }
  // RFC-165 §4：还有**非终态**单代理任务就拒——删了它们会半途失去定义。终态任务是接受的
  // 限制（其 retry/resume 之后以 agent-not-found 收场）。RFC-223 PR-3a R3-3：按启动时冻结的
  // 规范 `source_agent_id` 匹配，不按名字——否则 PR-8 放开全局同名后，**别人**的同名任务会
  // 挡住这次删除。0091 之前的 legacy 任务 source_agent_id 为 NULL、本身已不可 resume，不拦。
  const liveTasks = await transaction
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        eq(tasks.sourceAgentId, current.id),
        notInArray(tasks.status, [...TERMINAL_TASK_STATUSES]),
      ),
    )
  if (liveTasks.length > 0) {
    throw new ConflictError(
      'agent-tasks-active',
      `agent '${current.name}' has ${liveTasks.length} non-terminal single-agent task(s); cancel or wait before deleting`,
      // 裸 id 数组、未经可见性过滤：按 ACL 铁律展示层只渲染计数，不点名（ErrorDetails.tsx）。
      { taskIds: liveTasks.map((row) => row.id) },
    )
  }
  const scheduledRows = await transaction
    .select({
      id: scheduledTasks.id,
      name: scheduledTasks.name,
      launchKind: scheduledTasks.launchKind,
      launchPayload: scheduledTasks.launchPayload,
      ownerUserId: scheduledTasks.ownerUserId,
    })
    .from(scheduledTasks)
  const scheduledRefs = scheduledRowsReferencing(scheduledRows, {
    launchKind: 'agent',
    payloadKey: 'agentId',
    id: current.id,
  })
  if (scheduledRefs.length > 0) {
    throw new ConflictError(
      'agent-scheduled-referenced',
      `agent '${current.name}' is the target of ${scheduledRefs.length} scheduled task(s); delete or repoint them first`,
      discloseScheduleRefs(authority, scheduledRefs),
    )
  }
}

/** Closed runtime-registry projection required by Agent persistence semantics. */
export interface AgentRuntimeProfileLookup {
  get(name: string): Promise<Readonly<{ enabled: boolean }> | null>
}

/** Owner-native semantics for the Agent repository（RFC-359 W4-D14：一份实现，两个 provider 共用）。 */
export function createAgentPersistenceSemantics(input: {
  readonly db: ProviderNeutralDatabase
  readonly authorization: ResourceAuthorizationApplication
  readonly resourceInventory: AgentResourceInventorySource
  readonly runtimeProfiles: AgentRuntimeProfileLookup
}): AgentPersistenceSemantics {
  const labels = async (
    authority: AgentOperationContext,
    request: AgentReferenceLabelsInput,
  ): Promise<AgentReferenceLabels> => {
    const visibleAgents = new Set(request.visibleAgentIds)
    const selected = request.agents.filter((agent) => visibleAgents.has(agent.id))
    const skillIds = managedSkillIds(selected.flatMap((agent) => agent.skills))
    const mcpIds = unique(selected.flatMap((agent) => agent.mcp))
    const pluginIds = unique(selected.flatMap((agent) => agent.plugins))
    const [skillRows, mcpRows, pluginRows] = await Promise.all([
      skillIds.length === 0
        ? Promise.resolve([])
        : input.db
            .select({
              id: skills.id,
              name: skills.name,
              ownerUserId: skills.ownerUserId,
              visibility: skills.visibility,
            })
            .from(skills)
            .where(inArray(skills.id, skillIds)),
      mcpIds.length === 0
        ? Promise.resolve([])
        : input.db
            .select({
              id: mcps.id,
              name: mcps.name,
              ownerUserId: mcps.ownerUserId,
              visibility: mcps.visibility,
            })
            .from(mcps)
            .where(inArray(mcps.id, mcpIds)),
      pluginIds.length === 0
        ? Promise.resolve([])
        : input.db
            .select({
              id: plugins.id,
              name: plugins.name,
              ownerUserId: plugins.ownerUserId,
              visibility: plugins.visibility,
            })
            .from(plugins)
            .where(inArray(plugins.id, pluginIds)),
    ])
    const [visibleSkills, visibleMcps, visiblePlugins] = await Promise.all([
      input.authorization.filterVisibleRows(authority, 'skill', skillRows),
      input.authorization.filterVisibleRows(authority, 'mcp', mcpRows),
      input.authorization.filterVisibleRows(authority, 'plugin', pluginRows),
    ])
    const project = (rows: readonly { readonly id: string; readonly name: string }[]) =>
      Object.freeze(rows.map((row) => Object.freeze({ id: row.id, name: row.name })))
    return Object.freeze({
      skills: project(visibleSkills),
      mcps: project(visibleMcps),
      plugins: project(visiblePlugins),
    })
  }

  return Object.freeze<AgentPersistenceSemantics>({
    async canonicalizeCreate(_authority, submitted, _id) {
      return reconcileCreatedAgentExecutionContractPorts(submitted)
    },
    async canonicalizeUpdate(_authority, current, patch) {
      return reconcileUpdatedAgentExecutionContractPorts(current, patch)
    },
    // 次序与合一前的 SQLite 路径一致：逐类守卫（依赖 / mcp / plugin / runtime）→ RFC-228 闭包预检
    // （`agent-resources-invalid` + issues，缺失的 managed skill 在这里报）→ managed skill 的授权围栏。
    async assertCreateInTransaction(transaction, authority, candidate) {
      await assertCandidate({
        transaction,
        authority,
        runtimeProfiles: input.runtimeProfiles,
        candidate,
      })
      await assertAgentResourceIntegrity(input.resourceInventory, [candidate.id], {
        overrides: [candidate],
      })
      await assertSkillReferencesUsable({ transaction, authority, candidate })
    },
    async assertUpdateInTransaction(transaction, authority, current, candidate) {
      await assertCandidate({
        transaction,
        authority,
        runtimeProfiles: input.runtimeProfiles,
        candidate,
        previous: current,
      })
      await assertAgentResourceIntegrity(input.resourceInventory, [candidate.id], {
        overrides: [candidate],
      })
      await assertSkillReferencesUsable({ transaction, authority, candidate, previous: current })
    },
    async assertDeleteInTransaction(transaction, authority, current) {
      await assertNotReferenced(transaction, authority, current)
    },
    referenceLabels: labels,
  })
}
