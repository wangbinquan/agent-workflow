// RFC-345 T4a / RFC-359 W4-D27 —— 任务执行资源快照：一份实现，两个引擎共用。
//
// 合一前 `legacyTaskExecutionResourceSnapshots.ts`（494 行，同步 `DbTxSync` + 注入 legacy 行映射器）
// 与 `postgresqlTaskExecutionResourceSnapshots.ts`（529 行）逐行同一套逻辑，差别只有三处：
// ①事务句柄与 await；②可见性判据 —— legacy 注入 `canViewResourceInTx`，PG 自己内联了一份等价查询；
// ③行映射 —— legacy 注入 `rowToAgent` / `rowToMcp` / `rowToPlugin` / `rowToWorkflowDetail` /
// `rowToWorkgroup`，PG 直接调 `*FromPersistenceRow`。逐条对账后取中立形态：可见性走中立异步
// `canViewResourceForTx`（与 legacy 的 `canViewResourceInTx` 同一条判据：audience → 私有才查授权
// → `resolveAccessFrom` → `canViewAccess`），行映射一律用 `*Persistence` 里的中立映射器
// （与 legacy 映射器逐字段等价，含 sidecar 提升与 runtime 列的规则）。
//
// Resource Catalog owns row lookup, visibility and runtime-resource hydration.
// 事务由 task-execution 侧的 `snapshotRead` 打开（PG: REPEATABLE READ READ ONLY；
// SQLite: BEGIN IMMEDIATE，与合一前 `dbTxSync` 同一条边界），闭包递归取数全绑在那一笔上。

import type {
  AclResourceType,
  Agent,
  Mcp,
  Plugin,
  WorkflowDetail,
  Workgroup,
} from '@agent-workflow/shared'
import { asc, eq, inArray } from 'drizzle-orm'

import type { Actor } from '@/auth/actor'
import { agents, mcps, plugins, skills, workflows, workgroupMembers, workgroups } from '@/db/schema'
import type { DatabaseTransaction } from '@/platform/persistence/databaseTransaction'
import { ConflictError, NotFoundError, SkillQuarantinedError, ValidationError } from '@/util/errors'
import { agentFromPersistenceRow } from '../agentPersistence'
import { mcpFromPersistenceRow } from '../mcpPersistence'
import { pluginFromPersistenceRow } from '../pluginPersistence'
import { workflowDetailOf, workflowFromPersistenceRow } from '../workflowPersistence'
import { workgroupFromRows } from '../workgroupRepository'
import { canViewResourceForTx } from '../resourceAclTransaction'
import type { TaskExecutionResourceSnapshotPorts } from '../../application/participants/taskExecutionResourceSnapshot'
import type { ResourceRequestContext } from '../../public/participants'
import type {
  FrozenTaskExecutionResourceSnapshot,
  TaskExecutionAgentSnapshot,
  TaskExecutionMcpSnapshot,
  TaskExecutionPluginSnapshot,
  TaskExecutionResourceRequest,
  TaskExecutionWorkflowSnapshot,
  TaskExecutionWorkgroupSnapshot,
} from '../../public/types'

type TaskExecutionSkillSnapshot = Extract<
  FrozenTaskExecutionResourceSnapshot,
  { readonly kind: 'agent-injection' }
>['skills'][number]

type WorkflowRow = typeof workflows.$inferSelect
type WorkgroupRow = typeof workgroups.$inferSelect
type ManagedInjectionNameConflict = Readonly<{
  readonly kind: 'agent' | 'managed-skill' | 'mcp'
  readonly name: string
  readonly firstId: string
  readonly secondId: string
}>

export interface TaskExecutionResourceDependencies {
  readonly assertNotBuiltin: (
    type: AclResourceType,
    row: Readonly<{ readonly builtin?: boolean | null }>,
  ) => void
  readonly isSkillInjectableThisBoot: (skill: {
    readonly id: string
    readonly sourceKind: 'managed' | 'project'
  }) => boolean
  readonly skillFilesRel: (skillId: string) => string
  readonly findManagedInjectionNameConflict: (input: {
    readonly agents: readonly Readonly<{ readonly id: string; readonly name: string }>[]
    readonly managedSkills: readonly Readonly<{ readonly id: string; readonly name: string }>[]
    readonly mcps: readonly Readonly<{
      readonly id: string
      readonly name: string
      readonly enabled: boolean
    }>[]
  }) => ManagedInjectionNameConflict | null
  readonly formatManagedInjectionNameConflict: (conflict: ManagedInjectionNameConflict) => string
  readonly pluginDisabledErrorCode: string
  readonly pickCallTarget: <T extends Readonly<{ readonly id: string; readonly name: string }>>(
    selector: Readonly<{ readonly authoritativeName: string; readonly idHint?: string }>,
    candidates: readonly T[],
  ) => T | undefined
}

export interface TaskExecutionResourceOptions {
  readonly tx: DatabaseTransaction
  readonly authority: ResourceRequestContext
  readonly actor: Actor
}

function workflowSnapshot(workflow: WorkflowDetail): TaskExecutionWorkflowSnapshot {
  return Object.freeze({
    id: workflow.id,
    name: workflow.name,
    version: workflow.version,
    definition: workflow.definition,
  })
}

function agentSnapshot(agent: Agent): TaskExecutionAgentSnapshot {
  return Object.freeze({
    id: agent.id,
    name: agent.name,
    description: agent.description,
    outputs: agent.outputs,
    outputKinds: agent.outputKinds,
    branchPorts: agent.branchPorts,
    inputs: agent.inputs,
    outputWrapperPortNames: agent.outputWrapperPortNames,
    role: agent.role,
    syncOutputsOnIterate: agent.syncOutputsOnIterate,
    runtime: agent.runtime,
    permission: agent.permission,
    skills: agent.skills,
    dependsOn: agent.dependsOn,
    mcp: agent.mcp,
    plugins: agent.plugins,
    frontmatterExtra: agent.frontmatterExtra,
    bodyMd: agent.bodyMd,
    schemaVersion: agent.schemaVersion,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
  })
}

function mcpSnapshot(mcp: Mcp): TaskExecutionMcpSnapshot {
  return Object.freeze({
    id: mcp.id,
    name: mcp.name,
    description: mcp.description,
    type: mcp.type,
    config: mcp.config,
    enabled: mcp.enabled,
    schemaVersion: mcp.schemaVersion,
    createdAt: mcp.createdAt,
    updatedAt: mcp.updatedAt,
  }) as TaskExecutionMcpSnapshot
}

function pluginSnapshot(plugin: Plugin): TaskExecutionPluginSnapshot {
  return Object.freeze({
    id: plugin.id,
    name: plugin.name,
    options: plugin.options,
    enabled: plugin.enabled,
    runtimeSpecifier: plugin.cachedPath.startsWith('file://')
      ? plugin.cachedPath
      : `file://${plugin.cachedPath}`,
    resolvedVersion: plugin.resolvedVersion,
  })
}

function workgroupSnapshot(workgroup: Workgroup): TaskExecutionWorkgroupSnapshot {
  return Object.freeze({
    id: workgroup.id,
    name: workgroup.name,
    description: workgroup.description,
    instructions: workgroup.instructions,
    mode: workgroup.mode,
    outputContract: workgroup.outputContract,
    leaderMemberId: workgroup.leaderMemberId,
    switches: workgroup.switches,
    maxRounds: workgroup.maxRounds,
    completionGate: workgroup.completionGate,
    clarifyBudget: workgroup.clarifyBudget,
    fanOut: workgroup.fanOut,
    members: workgroup.members,
    version: workgroup.version,
  })
}

function requestFailure(code: string, message: string, runtimeMessage?: string): never {
  throw new ValidationError(
    code,
    message,
    runtimeMessage === undefined ? undefined : { runtimeMessage },
  )
}

export function createTaskExecutionResourceSnapshotPorts(
  options: TaskExecutionResourceOptions,
  dependencies: TaskExecutionResourceDependencies,
): TaskExecutionResourceSnapshotPorts {
  const { tx } = options
  const actorFor = (authority: ResourceRequestContext): Actor => {
    if (authority !== options.authority) throw new Error('foreign-task-execution-authority')
    return options.actor
  }

  const loadWorkflowLaunch = async (
    authority: ResourceRequestContext,
    workflowId: string,
  ): Promise<TaskExecutionWorkflowSnapshot> => {
    const actor = actorFor(authority)
    const row = await tx.select().from(workflows).where(eq(workflows.id, workflowId)).get()
    if (row === undefined || !(await canViewResourceForTx(tx, actor, 'workflow', row))) {
      throw new NotFoundError('workflow-not-found', `workflow '${workflowId}' not found`)
    }
    dependencies.assertNotBuiltin('workflow', row)
    return workflowSnapshot(workflowDetailOf(workflowFromPersistenceRow(row)))
  }

  const visibleWorkflowTarget = async (
    authority: ResourceRequestContext,
    request: Extract<TaskExecutionResourceRequest, { readonly kind: 'call-workflow' }>,
  ): Promise<TaskExecutionWorkflowSnapshot> => {
    const actor = actorFor(authority)
    const rows = await tx
      .select()
      .from(workflows)
      .where(eq(workflows.name, request.name))
      .orderBy(asc(workflows.id))
      .all()
    const hinted =
      request.idHint === undefined
        ? undefined
        : await tx.select().from(workflows).where(eq(workflows.id, request.idHint)).get()
    const byId = new Map<string, WorkflowRow>()
    for (const row of [...rows, ...(hinted === undefined ? [] : [hinted])]) {
      if (!(await canViewResourceForTx(tx, actor, 'workflow', row))) continue
      if (!byId.has(row.id)) byId.set(row.id, row)
    }
    const row = dependencies.pickCallTarget(
      {
        authoritativeName: request.name,
        ...(request.idHint === undefined ? {} : { idHint: request.idHint }),
      },
      [...byId.values()],
    )
    if (row === undefined) {
      return requestFailure(
        'workflow-call-ref-missing',
        `a call node references workflow '${request.name}' which does not exist or is not visible to the launcher`,
      )
    }
    try {
      return workflowSnapshot(workflowDetailOf(workflowFromPersistenceRow(row)))
    } catch {
      return requestFailure(
        'workflow-call-ref-missing',
        `referenced workflow '${row.id}' has an unreadable definition`,
      )
    }
  }

  const visibleWorkgroupTarget = async (
    authority: ResourceRequestContext,
    request: Extract<TaskExecutionResourceRequest, { readonly kind: 'call-workgroup' }>,
  ): Promise<TaskExecutionWorkgroupSnapshot> => {
    const actor = actorFor(authority)
    const rows = await tx
      .select()
      .from(workgroups)
      .where(eq(workgroups.name, request.name))
      .orderBy(asc(workgroups.id))
      .all()
    const hinted =
      request.idHint === undefined
        ? undefined
        : await tx.select().from(workgroups).where(eq(workgroups.id, request.idHint)).get()
    const byId = new Map<string, WorkgroupRow>()
    for (const row of [...rows, ...(hinted === undefined ? [] : [hinted])]) {
      if (!(await canViewResourceForTx(tx, actor, 'workgroup', row))) continue
      if (!byId.has(row.id)) byId.set(row.id, row)
    }
    const row = dependencies.pickCallTarget(
      {
        authoritativeName: request.name,
        ...(request.idHint === undefined ? {} : { idHint: request.idHint }),
      },
      [...byId.values()],
    )
    if (row === undefined) {
      return requestFailure(
        'workflow-call-ref-missing',
        `a call node references workgroup '${request.name}' which does not exist or is not visible to the launcher`,
      )
    }
    const members = await tx
      .select()
      .from(workgroupMembers)
      .where(eq(workgroupMembers.workgroupId, row.id))
      .all()
    try {
      return workgroupSnapshot(workgroupFromRows(row, members))
    } catch {
      return requestFailure(
        'workflow-call-ref-missing',
        `referenced workgroup '${row.id}' could not be loaded`,
      )
    }
  }

  const loadAgentInjection = async (
    authority: ResourceRequestContext,
    agentId: string,
  ): Promise<
    Extract<FrozenTaskExecutionResourceSnapshot, { readonly kind: 'agent-injection' }>
  > => {
    actorFor(authority)
    const rootRow = await tx.select().from(agents).where(eq(agents.id, agentId)).get()
    if (rootRow === undefined) {
      return requestFailure('agent-not-found', `agent '${agentId}' not found`)
    }
    const root = agentFromPersistenceRow(rootRow)
    const ordered: Agent[] = [root]
    const seen = new Set<string>([root.id])
    const queue = root.dependsOn.map((id) => ({ id, path: [root.id] }))
    while (queue.length > 0) {
      const entry = queue.shift()
      if (entry === undefined) break
      const cycleAt = entry.path.indexOf(entry.id)
      if (cycleAt >= 0) {
        const cycle = [...entry.path.slice(cycleAt), entry.id]
        return requestFailure(
          'agent-dependency-cycle',
          `agent '${root.name}' dependsOn forms a cycle: ${cycle.join(' → ')}`,
        )
      }
      if (seen.has(entry.id)) continue
      const row = await tx.select().from(agents).where(eq(agents.id, entry.id)).get()
      if (row === undefined) {
        return requestFailure(
          'agent-dependency-not-found',
          `agent '${root.name}' depends on missing agent`,
        )
      }
      const agent = agentFromPersistenceRow(row)
      seen.add(agent.id)
      ordered.push(agent)
      for (const next of agent.dependsOn) queue.push({ id: next, path: [...entry.path, entry.id] })
    }

    const skillRefs: Agent['skills'] = []
    const seenSkillRefs = new Set<string>()
    for (const ref of ordered.flatMap((agent) => agent.skills)) {
      const key = ref.kind === 'managed' ? `managed:${ref.skillId}` : `project:${ref.name}`
      if (seenSkillRefs.has(key)) continue
      seenSkillRefs.add(key)
      skillRefs.push(ref)
    }
    const skillSnapshots: TaskExecutionSkillSnapshot[] = []
    const managedSkillIdentities: Array<{ id: string; name: string }> = []
    for (const ref of skillRefs) {
      if (ref.kind === 'project') {
        skillSnapshots.push(Object.freeze({ kind: 'project', name: ref.name }))
        continue
      }
      const row = await tx.select().from(skills).where(eq(skills.id, ref.skillId)).get()
      if (row === undefined) {
        return requestFailure(
          'skill-not-found',
          `agent '${root.name}' references a missing managed Skill`,
        )
      }
      if (!dependencies.isSkillInjectableThisBoot({ id: row.id, sourceKind: 'managed' })) {
        return requestFailure(
          new SkillQuarantinedError(row.name).code,
          `agent '${root.name}' references quarantined Skill '${row.name}'`,
        )
      }
      if (row.managedPath !== dependencies.skillFilesRel(row.id)) {
        return requestFailure(
          new ConflictError(
            'skill-path-not-canonical',
            `skill '${row.name}' has not completed its identity migration`,
          ).code,
          `agent '${root.name}' references Skill '${row.name}' pending identity migration`,
        )
      }
      skillSnapshots.push(
        Object.freeze({
          kind: 'managed',
          skillId: row.id,
          name: row.name,
          contentVersion: row.contentVersion,
        }),
      )
      managedSkillIdentities.push({ id: row.id, name: row.name })
    }

    const collectIds = (select: (agent: Agent) => readonly string[]): string[] => {
      const ids: string[] = []
      const seenIds = new Set<string>()
      for (const id of ordered.flatMap((agent) => [...select(agent)])) {
        if (seenIds.has(id)) continue
        seenIds.add(id)
        ids.push(id)
      }
      return ids
    }
    const mcpIds = collectIds((agent) => agent.mcp)
    const mcpRows =
      mcpIds.length === 0 ? [] : await tx.select().from(mcps).where(inArray(mcps.id, mcpIds)).all()
    const mcpById = new Map(mcpRows.map((row) => [row.id, mcpFromPersistenceRow(row)]))
    if (mcpIds.some((id) => !mcpById.has(id))) {
      return requestFailure('mcp-not-found', `agent '${root.name}' references a missing MCP`)
    }
    const resolvedMcps = mcpIds.flatMap((id) => {
      const value = mcpById.get(id)
      return value === undefined ? [] : [value]
    })

    const conflict = dependencies.findManagedInjectionNameConflict({
      agents: ordered,
      managedSkills: managedSkillIdentities,
      mcps: resolvedMcps,
    })
    if (conflict !== null) {
      return requestFailure(
        'agent-injection-name-conflict',
        `managed injection name '${conflict.name}' is ambiguous`,
        dependencies.formatManagedInjectionNameConflict(conflict),
      )
    }

    const pluginIds = collectIds((agent) => agent.plugins)
    const pluginRows =
      pluginIds.length === 0
        ? []
        : await tx.select().from(plugins).where(inArray(plugins.id, pluginIds)).all()
    const pluginById = new Map(pluginRows.map((row) => [row.id, pluginFromPersistenceRow(row)]))
    if (pluginIds.some((id) => !pluginById.has(id))) {
      return requestFailure('plugin-not-found', `agent '${root.name}' references a missing Plugin`)
    }
    const resolvedPlugins = pluginIds.flatMap((id) => {
      const value = pluginById.get(id)
      return value === undefined ? [] : [value]
    })
    if (resolvedPlugins.some((plugin) => !plugin.enabled)) {
      return requestFailure(
        dependencies.pluginDisabledErrorCode,
        `agent '${root.name}' references a disabled Plugin`,
      )
    }

    return Object.freeze({
      kind: 'agent-injection',
      root: agentSnapshot(root),
      dependents: Object.freeze(ordered.slice(1).map(agentSnapshot)),
      skills: Object.freeze(skillSnapshots),
      mcps: Object.freeze(resolvedMcps.map(mcpSnapshot)),
      plugins: Object.freeze(resolvedPlugins.map(pluginSnapshot)),
    })
  }

  return Object.freeze({
    async workflowLaunch(
      authority: ResourceRequestContext,
      request: Extract<TaskExecutionResourceRequest, { readonly kind: 'workflow-launch' }>,
    ) {
      return Object.freeze({
        kind: 'workflow-launch',
        workflow: await loadWorkflowLaunch(authority, request.workflowId),
      })
    },
    async agentInjection(
      authority: ResourceRequestContext,
      request: Extract<TaskExecutionResourceRequest, { readonly kind: 'agent-injection' }>,
    ) {
      return await loadAgentInjection(authority, request.agentId)
    },
    async callWorkflow(
      authority: ResourceRequestContext,
      request: Extract<TaskExecutionResourceRequest, { readonly kind: 'call-workflow' }>,
    ) {
      return Object.freeze({
        kind: 'call-workflow',
        sourceWorkflowId: request.sourceWorkflowId,
        nodeId: request.nodeId,
        workflow: await visibleWorkflowTarget(authority, request),
      })
    },
    async callWorkgroup(
      authority: ResourceRequestContext,
      request: Extract<TaskExecutionResourceRequest, { readonly kind: 'call-workgroup' }>,
    ) {
      return Object.freeze({
        kind: 'call-workgroup',
        sourceWorkflowId: request.sourceWorkflowId,
        nodeId: request.nodeId,
        workgroup: await visibleWorkgroupTarget(authority, request),
      })
    },
  })
}
