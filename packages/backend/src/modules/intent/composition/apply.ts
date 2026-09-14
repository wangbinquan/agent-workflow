import { join } from 'node:path'

import type { IntentWorkflowGraphValidationPort } from '@/modules/intent/application/ports/intentWorkflowGraphValidation'
import type { ProviderNeutralDatabase } from '@/db/query'
import {
  createPostgresqlIntentApplyOperations,
  type ApplyIntentFaults,
  type PostgresqlIntentApplyArtifactLifecycle,
  type PostgresqlIntentApplyOperations,
  type PostgresqlIntentApplyResourceBinding,
} from '../infrastructure/postgresqlIntentApplyOperations'
import { createPostgresqlIntentApplyArtifactLifecycle } from '../infrastructure/postgresqlIntentApplyArtifactLifecycle'
import {
  composeLegacyIntentSkillArtifactCompat,
  composePostgresqlIntentApplyResourceBinding,
  composePostgresqlSkillArtifactCompensation,
  createPostgresqlIntentPluginArtifactLifecycle,
  createPostgresqlIntentSkillArtifactLifecycle,
} from '@/modules/resource-catalog/composition/intentApply'
import { createResourceCatalogAclIdentityReadPort } from '@/modules/resource-catalog/infrastructure/aclReadRepository'
import type { ResourceCatalogAclIdentityReadPort } from '@/modules/resource-catalog/application/ports/providerResourceCatalogPersistence'
import { createMcpTransactionLifecycle } from '@/modules/resource-catalog/infrastructure/mcpTransactionLifecycle'

import type { IntentApplyOperations } from '../application/ports/intentApplyOperations'
import type { Actor } from '@/auth/actor'
import type { ResourceRequestContext } from '@/modules/resource-catalog/public/participants'
import type { Logger } from '@/util/log'

export type { ApplyIntentFaults } from '../infrastructure/postgresqlIntentApplyOperations'
export type { IntentApplyReceipt } from '../application/ports/intentApplyOperations'
export {
  __intentApplyLockCountForTests,
  __withSessionApplyLockForTests,
} from '../infrastructure/postgresqlIntentApplyOperations'

/**
 * RFC-359 —— Intent apply **一台引擎两个 provider**。
 *
 * 此前这里是两条并行的装配线：SQLite 根走 `composeSqliteIntentApplyOperations` +
 * legacy 资源会话（`sqliteIntentApplyOperations.ts` 762 行 +
 * `sqliteIntentApplyArtifactLifecycle.ts` 178 行 + `legacyIntentApplyResourceParticipants.ts`），
 * PostgreSQL 根走 `createPostgresqlIntentApplyOperations` + PG 资源会话。两条线做的是同一件
 * 事——claim → preflight → prepare → 图校验 → prestage → 大事务 → 前滚 → 收敛——而判据
 * 长期只喂其中一侧（`rfc294-apply-replay-recovery-parity` 的存在理由就是「两台 apply 引擎」）。
 *
 * 现在只剩一台：引擎与资源会话全部按 `ProviderNeutralDatabase` 取参，事务走
 * `databaseSessionFor(db).transaction(...)` 这一个中立原语，两个 provider 共用同一份装配。
 */
export interface IntentApplyCompositionDependencies {
  readonly db: ProviderNeutralDatabase
  readonly appHome: string
  /** ACL 归属读面。两个 bootstrap 根各自已有一份，测试装配可省略（按 db 现取）。 */
  readonly aclIdentities?: ResourceCatalogAclIdentityReadPort
  /** 已装配好的工件生命周期；省略时按 `db` + `appHome` 现装一份。 */
  readonly artifacts?: PostgresqlIntentApplyArtifactLifecycle
  /**
   * 已装配好的资源会话绑定；省略时按 `db` + `appHome` + `aclIdentities` 现装一份。
   * 用例用它在真实会话外面包一层观测（例：在 `prepare` 返回后放行一个并发 apply）。
   */
  readonly resources?: PostgresqlIntentApplyResourceBinding
  /** RFC-358 §7 —— 提交期工作流图校验（AC-6）。 */
  readonly graphValidation?: IntentWorkflowGraphValidationPort
  readonly id?: () => string
  readonly now?: () => number
}

/**
 * RFC-355 T6：技能工件的补偿原语归 resource-catalog 所有，intent 只消费端口。
 * 装配发生在 composition 层——engine / application / 兼容门面都不再自己拼 provider。
 */
export function composeIntentApplyArtifactLifecycle(input: {
  readonly db: ProviderNeutralDatabase
  readonly appHome: string
}): PostgresqlIntentApplyArtifactLifecycle {
  return createPostgresqlIntentApplyArtifactLifecycle({
    db: input.db,
    appHome: input.appHome,
    pluginsDir: join(input.appHome, 'plugins'),
    skillArtifacts: composePostgresqlSkillArtifactCompensation(),
    legacySkillArtifacts: composeLegacyIntentSkillArtifactCompat(),
  })
}

/** The single Intent apply composition. Both bootstrap roots call exactly this. */
export function composeIntentApplyOperations(
  dependencies: IntentApplyCompositionDependencies,
): PostgresqlIntentApplyOperations {
  const appHome = dependencies.appHome
  return createPostgresqlIntentApplyOperations({
    db: dependencies.db,
    resources:
      dependencies.resources ??
      composePostgresqlIntentApplyResourceBinding({
        db: dependencies.db,
        mcpLifecycle: createMcpTransactionLifecycle(),
        pluginArtifacts: createPostgresqlIntentPluginArtifactLifecycle({
          pluginsDir: join(appHome, 'plugins'),
        }),
        skillArtifacts: createPostgresqlIntentSkillArtifactLifecycle({ appHome }),
        aclIdentities:
          dependencies.aclIdentities ?? createResourceCatalogAclIdentityReadPort(dependencies.db),
      }),
    artifacts:
      dependencies.artifacts ??
      composeIntentApplyArtifactLifecycle({ db: dependencies.db, appHome }),
    ...(dependencies.graphValidation === undefined
      ? {}
      : { graphValidation: dependencies.graphValidation }),
    ...(dependencies.id === undefined ? {} : { id: dependencies.id }),
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
  })
}

/**
 * RFC-359 —— 两个根此前各有一个「把引擎包成窄端口」的适配函数
 * （`composeSqliteIntentApplyOperations` / `composePostgresqlIntentApplyOperations`）。
 * 引擎合一之后只剩这一个：`PostgresqlIntentApplyOperations` 本来就 extends
 * `IntentApplyOperations`，窄化是为了让路由层只看见 `apply`。
 */
export function narrowIntentApplyOperations(
  operations: PostgresqlIntentApplyOperations,
): IntentApplyOperations {
  return operations
}

/**
 * RFC-355 T7：原 `services/intent/applyChangeset.ts` 兼容门面的正身。历史调用方要的是
 * 「给我 db + appHome，替我把资源会话与工件生命周期装配好再跑 apply」——那是 composition
 * 的活，不是 service 层的活。门面已删除，调用方直接来这里。
 */
export interface ApplyIntentDeps {
  readonly db: ProviderNeutralDatabase
  readonly appHome: string
  readonly actor: Actor
  readonly authority: ResourceRequestContext
  readonly aclIdentities?: ResourceCatalogAclIdentityReadPort
  readonly faults?: ApplyIntentFaults
  readonly graphValidation?: IntentWorkflowGraphValidationPort
  readonly log?: Logger
}

export function applyIntentChangeset(
  dependencies: ApplyIntentDeps,
  input: Parameters<PostgresqlIntentApplyOperations['apply']>[0]['command'],
) {
  return composeIntentApplyOperations({
    db: dependencies.db,
    appHome: dependencies.appHome,
    ...(dependencies.aclIdentities === undefined
      ? {}
      : { aclIdentities: dependencies.aclIdentities }),
    ...(dependencies.graphValidation === undefined
      ? {}
      : { graphValidation: dependencies.graphValidation }),
  }).apply({
    actor: dependencies.actor,
    authority: dependencies.authority,
    command: input,
    ...(dependencies.faults === undefined ? {} : { faults: dependencies.faults }),
    ...(dependencies.log === undefined ? {} : { log: dependencies.log }),
  })
}

export function convergeIntentApplyJournal(
  db: ProviderNeutralDatabase,
  appHome: string,
  log?: Logger,
  options?: { readonly activeJournalIds?: readonly string[] },
) {
  return composeIntentApplyOperations({ db, appHome }).converge(log, options)
}

/**
 * RFC-355 T4b：会话事件的投递实现（进程内 WS）。三个 bootstrap 根共用这一个装配出口，
 * 免得各自 import 广播器再各拼一份。
 */
export { createIntentSessionWsPublisher } from '../infrastructure/intentSessionWsProjector'
