import type { DbClient } from '@/db/client'
import {
  applyIntentChangeset,
  type IntentApplyResourceBinding,
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
      return await applyIntentChangeset(
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
