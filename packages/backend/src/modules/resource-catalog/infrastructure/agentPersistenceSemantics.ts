import type { SubjectTaskReferencePort } from '../composition/required-ports'
import {
  createAgentDependencyReferenceLookup,
  createWorkflowAgentReferenceLookup,
} from './referenceLookup'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { agentReferenceIds, type Agent } from '@agent-workflow/shared'
import { inArray } from 'drizzle-orm'

import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { ConflictError } from '@/util/errors'
import { isAgentLaunching } from '../application/agents/agentLaunchReservation'
import { scheduledRowsReferencing } from '../domain/scheduledTaskRefs'

import type { ResourceAuthorizationApplication } from '../application/resourceAuthorization'
import { discloseRefsSync, discloseScheduleRefs } from '../domain/resourceAccess'
import { grantedResourceIdsFor } from './resourceVisibility'
import type { AgentOperationContext } from '../public/participants'
import type { AgentReferenceLabels, AgentReferenceLabelsInput } from '../public/types'
import type { AgentPersistenceSemantics } from './agentRepository'
import type { ResourceCatalogTransaction } from './resourceCatalogTransaction'

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))]
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
  taskReferences: SubjectTaskReferencePort,
): Promise<void> {
  // RFC-175 §2e：单代理启动正握着这个 id 时先拒。启动按**名字**从冻结快照里解析代理，
  // 删掉再同名重建会让任务跑上另一个代理（ABA）。同进程内存预订，与删除同一笔事务里查。
  if (isAgentLaunching(current.id)) {
    throw new ConflictError(
      'agent-launching',
      `agent '${current.name}' has a task launch in progress; retry after it completes`,
    )
  }
  const { scheduledTasks } = tablesOf(transaction)
  // RFC-285 B2 档位：agent 对**任务**引用零检查即是统一中档（任务快照冻结定义），这里
  // 的 agent-in-use 挡的是 **workflow 定义**引用——活的编辑面，删了就当场悬空。
  const referencingWorkflows = await createWorkflowAgentReferenceLookup(transaction).find(
    current.id,
  )
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
  const dependents = await createAgentDependencyReferenceLookup(transaction).find(current.id)
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
  const liveTasks = await taskReferences(transaction).nonTerminalTaskIds({
    kind: 'agent',
    sourceId: current.id,
  })
  if (liveTasks.length > 0) {
    throw new ConflictError(
      'agent-tasks-active',
      `agent '${current.name}' has ${liveTasks.length} non-terminal single-agent task(s); cancel or wait before deleting`,
      // 裸 id 数组、未经可见性过滤：按 ACL 铁律展示层只渲染计数，不点名（ErrorDetails.tsx）。
      { taskIds: liveTasks },
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

/**
 * Owner-native semantics for the Agent repository（RFC-359 W4-D14：一份实现，两个 provider 共用）。
 *
 * RFC-401 A1：创建 / 更新的规范化与校验迁入唯一的 agent 写入参与者（`agentMutationParticipant.ts`），Intent、资源包与
 * 模板共用；这里只剩普通 CRUD 独有的删除闸与引用标签。
 */
export function createAgentPersistenceSemantics(input: {
  readonly db: PersistenceDb
  readonly authorization: ResourceAuthorizationApplication
  readonly taskReferences: SubjectTaskReferencePort
}): AgentPersistenceSemantics {
  const labels = async (
    authority: AgentOperationContext,
    request: AgentReferenceLabelsInput,
  ): Promise<AgentReferenceLabels> => {
    const visibleAgents = new Set(request.visibleAgentIds)
    const selected = request.agents.filter((agent) => visibleAgents.has(agent.id))
    const skillIds = unique(selected.flatMap((agent) => agentReferenceIds(agent, 'skill')))
    const mcpIds = unique(selected.flatMap((agent) => agentReferenceIds(agent, 'mcp')))
    const pluginIds = unique(selected.flatMap((agent) => agentReferenceIds(agent, 'plugin')))
    const { skills } = tablesOf(input.db)
    const { mcps, plugins } = tablesOf(input.db)
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
    async assertDeleteInTransaction(transaction, authority, current) {
      await assertNotReferenced(transaction, authority, current, input.taskReferences)
    },
    referenceLabels: labels,
  })
}
