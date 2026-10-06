import { workflows as workflowsTable } from '../../src/db/schema'
import { createWorkflowValidationPort } from '@/modules/resource-catalog/infrastructure/workflowValidation'
import type { IntentWorkflowGraphValidationPort } from '@/modules/intent/application/ports/intentWorkflowGraphValidation'
import type { Actor } from '../../src/auth/actor'
// RFC-359 AC-6：整份夹具的 `db` 放宽到中立客户端——它转手给的那些工厂
// （`createWorkflowValidationPort` / 资源目录 / intent 装配）形参本来就是中立的。
import type { ProviderNeutralDatabase } from '../../src/db/query'
import { composeIdentityAccess } from '../../src/modules/identity-access/composition'
import type { DirectAuthenticatedAuthority } from '../../src/modules/identity-access/public/participants'
import { createResourceCatalogQuery } from '../../src/modules/resource-catalog/infrastructure/catalogQuery'
import { createMcpRepository } from '../../src/modules/resource-catalog/infrastructure/mcpRepository'
import { createPluginRepository } from '../../src/modules/resource-catalog/infrastructure/pluginRepository'
import { getAgentById } from '../../src/services/agent'
import { withMcpOperationConfigHash } from '../../src/services/mcpOperationRevision'
import { withPluginOperationConfigHash } from '../../src/services/pluginOperationRevision'
import {
  listSkillFiles,
  readSkillContent,
  readSkillFile,
} from '../../src/modules/resource-catalog/infrastructure/legacy/skill'
import { getWorkflow } from '../../src/services/workflow'
import { getWorkgroupById } from '../../src/services/workgroups'
import { Paths } from '../../src/util/paths'
import type {
  IntentResourceCatalogBinding,
  IntentResourceCatalogDetailQueries,
} from '@/modules/intent/application/resourceCatalog'
import { intentResourceVisibility } from '@/modules/intent/application/resourceCatalog'
import { buildIntentDump, type IntentDumpInput } from '@/modules/intent/application/dumpBuilder'
import {
  runIntentTurn,
  type IntentTurnConfig,
  type SelectedIntentTurnConfig,
  type RunIntentTurnDeps,
} from '@/modules/intent/application/turnEngine'
import { composeLocalSystemAgentRunFamily } from '@/modules/task-execution/composition/localSystemAgentRunFamily'
import type { SystemAgentRunOptions, SystemAgentRunResult } from '@/services/systemAgentRun'
import {
  dispatchIntentTurn,
  resumeQueuedIntentWorkingSets,
  type IntentDispatchDeps,
} from '@/modules/intent/application/dispatcher'
import {
  createIntentSession,
  createIntentSessionAndReserveTurn,
} from '@/modules/intent/application/session'
import {
  composeIntentPersistence,
  type IntentPersistence,
} from '../../src/modules/intent/composition/persistence'
import { composeIntentContextResourceAuthorizationFactory } from '../../src/modules/resource-catalog/composition/intentContextAuthorization'
import {
  composeIntentDumpAuxiliaryQueries,
  composeIntentTurnRuntimeResolver,
} from '../../src/modules/intent/composition/auxiliaryQueries'
import type {
  IntentDumpAuxiliaryQueries,
  IntentPlatformInventoryParticipant,
} from '../../src/modules/intent/application/ports/intentAuxiliaryQueries'
type AgentDetailInput = Parameters<IntentResourceCatalogDetailQueries['agents']['get']>[0]
type SkillContentInput = Parameters<IntentResourceCatalogDetailQueries['skills']['content']>[0]
type SkillFileListInput = Parameters<IntentResourceCatalogDetailQueries['skillFiles']['list']>[0]
type SkillFileReadInput = Parameters<IntentResourceCatalogDetailQueries['skillFiles']['read']>[0]
type McpDetailInput = Parameters<IntentResourceCatalogDetailQueries['mcps']['get']>[0]
type PluginDetailInput = Parameters<IntentResourceCatalogDetailQueries['plugins']['get']>[0]
type WorkflowDetailInput = Parameters<IntentResourceCatalogDetailQueries['workflows']['get']>[0]
type WorkgroupDetailInput = Parameters<IntentResourceCatalogDetailQueries['workgroups']['get']>[0]

const EMPTY_PLATFORM_INVENTORY: IntentPlatformInventoryParticipant = Object.freeze({
  listRows: async () => [],
})

export function intentPersistenceForTest(db: ProviderNeutralDatabase): IntentPersistence {
  return composeIntentPersistence({
    db,
    contextAuthorization: composeIntentContextResourceAuthorizationFactory(),
  })
}

export function createIntentSessionForTest(
  db: ProviderNeutralDatabase,
  actor: Actor,
  input: Parameters<typeof createIntentSession>[3],
  appHome: string = Paths.root,
): ReturnType<typeof createIntentSession> {
  const catalog = intentResourceCatalogBinding(db, actor, appHome)
  return createIntentSession(
    intentPersistenceForTest(db),
    intentResourceVisibility(catalog),
    actor,
    input,
  )
}

export function createIntentSessionAndReserveTurnForTest(
  db: ProviderNeutralDatabase,
  actor: Actor,
  input: Parameters<typeof createIntentSessionAndReserveTurn>[3],
  appHome: string = Paths.root,
): ReturnType<typeof createIntentSessionAndReserveTurn> {
  const catalog = intentResourceCatalogBinding(db, actor, appHome)
  return createIntentSessionAndReserveTurn(
    intentPersistenceForTest(db),
    intentResourceVisibility(catalog),
    actor,
    input,
  )
}

export function intentDumpAuxiliaryForTest(
  db: ProviderNeutralDatabase,
  platformInventory: IntentPlatformInventoryParticipant = EMPTY_PLATFORM_INVENTORY,
): IntentDumpAuxiliaryQueries {
  return composeIntentDumpAuxiliaryQueries({
    persistence: intentPersistenceForTest(db),
    platformInventory,
  })
}

/** Test-only composition of the same closed query/context pair injected by bootstrap. */
export function intentResourceCatalogBinding(
  db: ProviderNeutralDatabase,
  actor: Actor,
  appHome: string = Paths.root,
): IntentResourceCatalogBinding {
  const identityAccess = composeIdentityAccess(db)
  const context = identityAccess.contexts.queryFromAuthenticatedPrincipal(
    { userId: actor.user.id, source: actor.source },
    'http',
  )
  const mcps = createMcpRepository({
    db,
    lifecycle: Object.freeze({
      transitionMutation: async () => undefined,
      deletePrepared: async () => undefined,
    }),
  }).repository
  const plugins = createPluginRepository({ db }).repository
  const details: IntentResourceCatalogDetailQueries = Object.freeze({
    agents: Object.freeze({ get: (input: AgentDetailInput) => getAgentById(db, input.id) }),
    skills: Object.freeze({
      content: (input: SkillContentInput) => readSkillContent(db, { appHome }, input.id),
    }),
    skillFiles: Object.freeze({
      list: (input: SkillFileListInput) => listSkillFiles(db, { appHome }, input.id),
      async read(input: SkillFileReadInput) {
        return Object.freeze({
          path: input.path,
          content: await readSkillFile(db, { appHome }, input.id, input.path),
        })
      },
    }),
    mcps: Object.freeze({
      async get(input: McpDetailInput) {
        const mcp = await mcps.get(input.id)
        return mcp === null ? null : withMcpOperationConfigHash(mcp)
      },
    }),
    plugins: Object.freeze({
      async get(input: PluginDetailInput) {
        const plugin = await plugins.get(input.id)
        return plugin === null ? null : withPluginOperationConfigHash(plugin)
      },
    }),
    workflows: Object.freeze({
      get: (input: WorkflowDetailInput) => getWorkflow(db, input.id),
    }),
    workgroups: Object.freeze({
      get: (input: WorkgroupDetailInput) => getWorkgroupById(db, input.id),
    }),
  })
  return Object.freeze({
    context,
    currentAuthority: Object.freeze({
      authority: context.authority,
      actor: actor as DirectAuthenticatedAuthority,
    }),
    query: createResourceCatalogQuery(db, {
      resolveActor: (candidate) => {
        const principal = identityAccess.contexts.resolveQueryContext(candidate)
        if (principal.userId !== actor.user.id || principal.source !== actor.source) {
          throw new Error('intent-resource-catalog-test-context-mismatch')
        }
        return actor
      },
    }),
    details,
  })
}

export function buildIntentDumpForTest(
  input: Omit<
    IntentDumpInput,
    'resourceCatalog' | 'runtimeInventory' | 'loadAgentPorts' | 'platformInventory'
  > &
    Readonly<{
      db: ProviderNeutralDatabase
      runtimeInventory?: IntentDumpInput['runtimeInventory']
      loadAgentPorts?: IntentDumpInput['loadAgentPorts']
      platformInventory?: IntentDumpInput['platformInventory']
    }>,
): ReturnType<typeof buildIntentDump> {
  const auxiliary = intentDumpAuxiliaryForTest(input.db, input.platformInventory)
  return buildIntentDump({
    ...input,
    resourceCatalog: intentResourceCatalogBinding(input.db, input.actor, input.appHome),
    runtimeInventory: input.runtimeInventory ?? auxiliary.runtimeInventory,
    loadAgentPorts: input.loadAgentPorts ?? auxiliary.loadAgentPorts,
    platformInventory: input.platformInventory ?? auxiliary.platformInventory,
  })
}

export function runIntentTurnForTest(
  deps: Pick<RunIntentTurnDeps, 'appHome'> &
    Partial<Omit<RunIntentTurnDeps, 'appHome' | 'config' | 'resourceCatalog' | 'systemAgents'>> &
    Readonly<{
      db: ProviderNeutralDatabase
      config: IntentTurnConfig
      runFn?: (opts: SystemAgentRunOptions) => Promise<SystemAgentRunResult>
      platformInventory?: IntentPlatformInventoryParticipant
    }>,
  input: Parameters<typeof runIntentTurn>[1],
): ReturnType<typeof runIntentTurn> {
  const persistence = deps.persistence ?? intentPersistenceForTest(deps.db)
  let home: string
  const binding = composeLocalSystemAgentRunFamily({ appHome: () => home })
  function selectedConfig(config: IntentTurnConfig): SelectedIntentTurnConfig {
    const descriptors: PropertyDescriptorMap = {}
    for (const field of [
      'lang',
      'timeoutMs',
      'stdoutCapBytes',
      'maxGenerateRounds',
      'maxQuestionRounds',
      'extraInstructions',
      'scratchRetentionHours',
      'effectiveDefaultRuntime',
    ] as const) {
      descriptors[field] = { enumerable: true, get: () => config[field] }
    }
    descriptors.runtime = { enumerable: true, get: () => binding.bindRuntime(config.runtime) }
    return Object.defineProperties({}, descriptors) as SelectedIntentTurnConfig
  }
  return runIntentTurn(
    {
      persistence,
      appHome: (home = deps.appHome),
      config: selectedConfig(deps.config),
      dumpAuxiliary:
        deps.dumpAuxiliary ??
        composeIntentDumpAuxiliaryQueries({
          persistence,
          platformInventory: deps.platformInventory ?? EMPTY_PLATFORM_INVENTORY,
        }),
      resourceCatalog: intentResourceCatalogBinding(deps.db, input.actor, deps.appHome),
      graphValidation: deps.graphValidation ?? intentGraphValidationForTest(deps.db),
      systemAgents:
        deps.runFn === undefined ? binding.family : binding.withFixture(deps.runFn).family,
      ...(deps.onSessionEvent === undefined ? {} : { onSessionEvent: deps.onSessionEvent }),
      ...(deps.log === undefined ? {} : { log: deps.log }),
    },
    input,
  )
}

/**
 * RFC-358 —— 测试用的**真实**图校验端口。
 *
 * 刻意不 stub：意图测试的 fixture 定义会真的过一遍工作流校验器，既覆盖了新链路，
 * 也让「某个 fixture 其实是张坏图」这种事在它被当作正例用之前就暴露出来。
 */
export function intentGraphValidationForTest(
  db: ProviderNeutralDatabase,
): IntentWorkflowGraphValidationPort {
  // 测试里没有启动期复核，skill 只按 reservation ready 算可用（与旧 SQLite 校验器在测试里的行为一致）。
  const port = createWorkflowValidationPort({ db, skillContent: { isAvailable: async () => true } })
  const graph: IntentWorkflowGraphValidationPort = {
    async validate(input) {
      const validated = await port.validate({
        definition: input.definition,
        currentWorkflow: input.currentWorkflow,
        ...(input.overlays === undefined ? {} : { overlays: input.overlays }),
      })
      return Object.freeze({ ok: validated.result.ok, issues: validated.result.issues })
    },
    async workflowsUsingAgents(input) {
      const wanted = new Set(input.agentIds)
      const byAgent = new Map<string, { readonly id: string; readonly name: string }[]>()
      if (wanted.size === 0) return byAgent
      for (const row of await db.select().from(workflowsTable)) {
        let nodes: Array<{ agentId?: unknown }> = []
        try {
          nodes =
            (JSON.parse(row.definition) as { nodes?: Array<{ agentId?: unknown }> }).nodes ?? []
        } catch {
          continue
        }
        for (const node of nodes) {
          if (typeof node.agentId !== 'string' || !wanted.has(node.agentId)) continue
          const list = byAgent.get(node.agentId) ?? []
          if (!list.some((each) => each.id === row.id)) list.push({ id: row.id, name: row.name })
          byAgent.set(node.agentId, list)
        }
      }
      return byAgent
    },
  }
  return Object.freeze(graph)
}

// RFC-359 AC-6：这个形参的 `ProviderNeutralDatabase` 纯属未收敛——它只把库转手给
// `intentPersistenceForTest`，而那个早就是中立面了。收成中立面，调用方即可用 harness.db。
export function intentTurnRuntimeResolverForTest(db: ProviderNeutralDatabase) {
  return intentSystemAgentBindingForTest(intentPersistenceForTest(db)).runtimeResolver
}

/** Explicit legacy test input projection, reusing the original two-query resolver. */
export function composeNativeIntentTurnRuntimeResolverForTest(persistence: IntentPersistence) {
  return composeIntentTurnRuntimeResolver(persistence, (runtime) => runtime)
}

export function intentSystemAgentBindingForTest(
  persistence: IntentPersistence,
  appHome: string = Paths.root,
) {
  const binding = composeLocalSystemAgentRunFamily({ appHome: () => appHome })
  return {
    systemAgents: binding.family,
    runtimeResolver: composeIntentTurnRuntimeResolver(persistence, binding.bindRuntime),
  }
}

export function dispatchIntentTurnForTest(
  deps: Omit<IntentDispatchDeps, 'resourceCatalogFor' | 'systemAgents' | 'runtimeResolver'> &
    Readonly<{
      db: ProviderNeutralDatabase
      runtimeResolver: ReturnType<typeof composeNativeIntentTurnRuntimeResolverForTest>
      runFn?: (opts: SystemAgentRunOptions) => Promise<SystemAgentRunResult>
    }>,
  ...args: Parameters<typeof dispatchIntentTurn> extends [IntentDispatchDeps, ...infer Rest]
    ? Rest
    : never
): ReturnType<typeof dispatchIntentTurn> {
  const native = { ...deps }
  const binding = composeLocalSystemAgentRunFamily({ appHome: () => native.appHome })
  return dispatchIntentTurn(
    {
      ...native,
      runtimeResolver: {
        async resolve(input) {
          const result = await native.runtimeResolver.resolve(input)
          return { ...result, runtime: binding.bindRuntime(result.runtime) }
        },
      },
      get systemAgents() {
        return native.runFn === undefined
          ? binding.family
          : binding.withFixture(native.runFn).family
      },
      resourceCatalogFor: (actor) => intentResourceCatalogBinding(deps.db, actor, deps.appHome),
    },
    ...args,
  )
}

/** Boot fixtures select the same complete native family as ordinary dispatch.
 * The original queued recovery implementation and native resolver remain the
 * authorities for DB queries, admission, events and fixture outcomes. */
export function resumeQueuedIntentWorkingSetsForTest(
  deps: Omit<IntentDispatchDeps, 'systemAgents' | 'runtimeResolver'> &
    Readonly<{
      runtimeResolver: ReturnType<typeof composeNativeIntentTurnRuntimeResolverForTest>
      runFn?: (opts: SystemAgentRunOptions) => Promise<SystemAgentRunResult>
    }>,
): ReturnType<typeof resumeQueuedIntentWorkingSets> {
  const native = { ...deps }
  const binding = composeLocalSystemAgentRunFamily({ appHome: () => native.appHome })
  return resumeQueuedIntentWorkingSets({
    ...native,
    runtimeResolver: {
      async resolve(input) {
        const result = await native.runtimeResolver.resolve(input)
        return { ...result, runtime: binding.bindRuntime(result.runtime) }
      },
    },
    get systemAgents() {
      return native.runFn === undefined ? binding.family : binding.withFixture(native.runFn).family
    },
  })
}
