import type { DbClient } from '@/db/client'
import {
  applyIntentChangeset,
  type IntentApplyResourceBinding,
} from '../infrastructure/sqliteIntentApplyOperations'
import type { SqliteIntentApplyArtifactLifecycle } from '../infrastructure/sqliteIntentApplyArtifactLifecycle'

export { createSqliteIntentApplyArtifactLifecycle } from '../infrastructure/sqliteIntentApplyArtifactLifecycle'

import type {
  IntentApplyOperations,
  IntentApplyInput,
} from '../application/ports/intentApplyOperations'
import type { Actor } from '@/auth/actor'
import type { ResourceRequestContext } from '@/modules/resource-catalog/public/participants'

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
