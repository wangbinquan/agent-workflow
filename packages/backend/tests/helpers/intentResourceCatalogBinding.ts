import type { Actor } from '../../src/auth/actor'
import type { DbClient } from '../../src/db/client'
import { composeIdentityAccess } from '../../src/modules/identity-access/composition'
import type { DirectAuthenticatedAuthority } from '../../src/modules/identity-access/public/participants'
import { createSqliteResourceCatalogQuery } from '../../src/modules/resource-catalog/infrastructure/sqliteCatalogQuery'
import { createSqliteMcpRepository } from '../../src/modules/resource-catalog/infrastructure/sqliteMcpRepository'
import { createSqlitePluginRepository } from '../../src/modules/resource-catalog/infrastructure/sqlitePluginRepository'
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
} from '../../src/services/intent/resourceCatalog'
import { intentResourceVisibility } from '../../src/services/intent/resourceCatalog'
import { buildIntentDump, type IntentDumpInput } from '../../src/services/intent/dumpBuilder'
import { runIntentTurn, type RunIntentTurnDeps } from '../../src/services/intent/turnEngine'
import { dispatchIntentTurn, type IntentDispatchDeps } from '../../src/services/intent/dispatcher'
import {
  createIntentSession,
  createIntentSessionAndReserveTurn,
} from '../../src/services/intent/session'
import {
  composeSqliteIntentPersistence,
  type IntentPersistence,
} from '../../src/modules/intent/composition/persistence'
import { composeSqliteIntentContextResourceAuthorizationSyncFactory } from '../../src/modules/resource-catalog/composition/intentContextAuthorization'
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

export function intentPersistenceForTest(db: DbClient): IntentPersistence {
  return composeSqliteIntentPersistence({
    db,
    contextAuthorization: composeSqliteIntentContextResourceAuthorizationSyncFactory(),
  })
}

export function createIntentSessionForTest(
  db: DbClient,
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
  db: DbClient,
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
  db: DbClient,
  platformInventory: IntentPlatformInventoryParticipant = EMPTY_PLATFORM_INVENTORY,
): IntentDumpAuxiliaryQueries {
  return composeIntentDumpAuxiliaryQueries({
    persistence: intentPersistenceForTest(db),
    platformInventory,
  })
}

/** Test-only composition of the same closed query/context pair injected by bootstrap. */
export function intentResourceCatalogBinding(
  db: DbClient,
  actor: Actor,
  appHome: string = Paths.root,
): IntentResourceCatalogBinding {
  const identityAccess = composeIdentityAccess(db)
  const context = identityAccess.contexts.queryFromAuthenticatedPrincipal(
    { userId: actor.user.id, source: actor.source },
    'http',
  )
  const mcps = createSqliteMcpRepository({
    db,
    lifecycle: Object.freeze({
      transitionMutation: () => undefined,
      deletePrepared: () => undefined,
    }),
  }).repository
  const plugins = createSqlitePluginRepository(db).repository
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
    query: createSqliteResourceCatalogQuery(db, {
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
      db: DbClient
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
  deps: Pick<RunIntentTurnDeps, 'appHome' | 'config'> &
    Partial<Omit<RunIntentTurnDeps, 'appHome' | 'config' | 'resourceCatalog'>> &
    Readonly<{
      db: DbClient
      platformInventory?: IntentPlatformInventoryParticipant
    }>,
  input: Parameters<typeof runIntentTurn>[1],
): ReturnType<typeof runIntentTurn> {
  const persistence = deps.persistence ?? intentPersistenceForTest(deps.db)
  return runIntentTurn(
    {
      persistence,
      appHome: deps.appHome,
      config: deps.config,
      dumpAuxiliary:
        deps.dumpAuxiliary ??
        composeIntentDumpAuxiliaryQueries({
          persistence,
          platformInventory: deps.platformInventory ?? EMPTY_PLATFORM_INVENTORY,
        }),
      resourceCatalog: intentResourceCatalogBinding(deps.db, input.actor, deps.appHome),
      ...(deps.runFn === undefined ? {} : { runFn: deps.runFn }),
      ...(deps.onSessionEvent === undefined ? {} : { onSessionEvent: deps.onSessionEvent }),
      ...(deps.log === undefined ? {} : { log: deps.log }),
    },
    input,
  )
}

export function intentTurnRuntimeResolverForTest(db: DbClient) {
  return composeIntentTurnRuntimeResolver(intentPersistenceForTest(db))
}

export function dispatchIntentTurnForTest(
  deps: Omit<IntentDispatchDeps, 'resourceCatalogFor'> & Readonly<{ db: DbClient }>,
  ...args: Parameters<typeof dispatchIntentTurn> extends [IntentDispatchDeps, ...infer Rest]
    ? Rest
    : never
): ReturnType<typeof dispatchIntentTurn> {
  return dispatchIntentTurn(
    {
      ...deps,
      resourceCatalogFor: (actor) => intentResourceCatalogBinding(deps.db, actor, deps.appHome),
    },
    ...args,
  )
}
