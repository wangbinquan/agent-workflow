import type { DbClient } from '@/db/client'
import {
  applyIntentChangeset as applyIntentChangesetWithLifecycle,
  convergeIntentApplyJournal as convergeIntentApplyJournalWithLifecycle,
  type ApplyIntentDeps as ApplyIntentDepsWithLifecycle,
  type IntentApplyResourceBinding,
} from '../infrastructure/sqliteIntentApplyOperations'

export type {
  ApplyIntentFaults,
  IntentApplyReceipt,
  IntentApplyResourceBinding,
  IntentApplyResourceSession,
} from '../infrastructure/sqliteIntentApplyOperations'
export {
  __intentApplyLockCountForTests,
  __withSessionApplyLockForTests,
} from '../infrastructure/sqliteIntentApplyOperations'
import type { SqliteIntentApplyArtifactLifecycle } from '../infrastructure/sqliteIntentApplyArtifactLifecycle'

import { createSqliteIntentApplyArtifactLifecycle } from '../infrastructure/sqliteIntentApplyArtifactLifecycle'
import { composeSqliteSkillArtifactCompensation } from '@/modules/resource-catalog/composition/intentApply'

import type {
  IntentApplyOperations,
  IntentApplyInput,
} from '../application/ports/intentApplyOperations'
import type { Actor } from '@/auth/actor'
import type { ResourceRequestContext } from '@/modules/resource-catalog/public/participants'

/**
 * RFC-355 T6：技能工件的补偿原语归 resource-catalog 所有，intent 只消费端口。
 * 装配发生在 composition 层——engine / application / 兼容门面都不再自己拼 provider。
 */
export function composeSqliteIntentApplyArtifactLifecycle(input: {
  readonly db: DbClient
  readonly appHome: string
}): SqliteIntentApplyArtifactLifecycle {
  return createSqliteIntentApplyArtifactLifecycle({
    skillArtifacts: composeSqliteSkillArtifactCompensation(),
    db: input.db,
    appHome: input.appHome,
  })
}

export interface SqliteIntentApplyCompositionDependencies {
  readonly db: DbClient
  readonly appHome: string
  readonly resources: IntentApplyResourceBinding
  readonly artifacts: SqliteIntentApplyArtifactLifecycle
  readonly pluginInstallOpts?: {
    readonly pluginsDir?: string
    readonly npmBin?: string
    readonly timeoutMs?: number
  }
}

/** Legacy SQLite mechanism stays behind the same async command seam as PostgreSQL. */
export function composeSqliteIntentApplyOperations(
  dependencies: SqliteIntentApplyCompositionDependencies,
): IntentApplyOperations {
  return Object.freeze({
    async apply(input: {
      readonly actor: Actor
      readonly authority: ResourceRequestContext
      readonly command: IntentApplyInput
    }) {
      return await applyIntentChangesetWithLifecycle(
        {
          db: dependencies.db,
          appHome: dependencies.appHome,
          actor: input.actor,
          authority: input.authority,
          resourceApply: dependencies.resources,
          artifacts: dependencies.artifacts,
          ...(dependencies.pluginInstallOpts === undefined
            ? {}
            : { pluginInstallOpts: dependencies.pluginInstallOpts }),
        },
        {
          ...input.command,
          decisions: [...input.command.decisions],
        },
      )
    },
  })
}

export function composePostgresqlIntentApplyOperations(
  operations: IntentApplyOperations,
): IntentApplyOperations {
  return operations
}

/**
 * RFC-355 T7：原 `services/intent/applyChangeset.ts` 兼容门面的正身。历史 SQLite 调用方
 * 要的是「给我 db + appHome，替我把工件生命周期装配好再跑 apply」——那是 composition
 * 的活，不是 service 层的活。门面已删除，调用方直接来这里。
 */
export type ApplyIntentDeps = Omit<ApplyIntentDepsWithLifecycle, 'artifacts'>

export function applyIntentChangeset(
  dependencies: ApplyIntentDeps,
  input: Parameters<typeof applyIntentChangesetWithLifecycle>[1],
) {
  return applyIntentChangesetWithLifecycle(
    {
      ...dependencies,
      artifacts: composeSqliteIntentApplyArtifactLifecycle({
        db: dependencies.db,
        appHome: dependencies.appHome,
      }),
    },
    input,
  )
}

export function convergeIntentApplyJournal(
  db: ApplyIntentDeps['db'],
  appHome: string,
  log?: Parameters<typeof convergeIntentApplyJournalWithLifecycle>[2],
  options?: Parameters<typeof convergeIntentApplyJournalWithLifecycle>[3],
) {
  return convergeIntentApplyJournalWithLifecycle(
    db,
    composeSqliteIntentApplyArtifactLifecycle({ db, appHome }),
    log,
    options,
  )
}

/**
 * RFC-355 T4b：会话事件的投递实现（进程内 WS）。三个 bootstrap 根共用这一个装配出口，
 * 免得各自 import 广播器再各拼一份。
 */
export { createIntentSessionWsPublisher } from '../infrastructure/intentSessionWsProjector'
