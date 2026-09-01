import { and, count, eq, type SQL } from 'drizzle-orm'
import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import { agents, workflows } from '@/db/schema'
import type { ResourceCatalogOverviewCountPort } from '../application/ports/resourceCatalogOverview'
import type { CatalogSelectorKind } from '../domain/resourceKinds'
import { SQLITE_ACL_TABLES } from './sqliteAclRegistry'
import { visibleRowsCondition } from './sqliteResourceGrantRepository'

function builtinCondition(kind: CatalogSelectorKind, exclude: boolean): SQL<unknown> | undefined {
  if (!exclude) return undefined
  if (kind === 'agent') return eq(agents.builtin, false)
  if (kind === 'workflow') return eq(workflows.builtin, false)
  return undefined
}

export function createSqliteResourceCatalogOverviewCountPort(
  db: DbClient,
): ResourceCatalogOverviewCountPort {
  return Object.freeze({
    async countVisible(
      actor: Actor,
      kind: CatalogSelectorKind,
      options: Readonly<{ excludeBuiltin: boolean }>,
    ): Promise<number> {
      const table = SQLITE_ACL_TABLES[kind]
      const rows = await db
        .select({ total: count() })
        .from(table)
        .where(
          and(
            visibleRowsCondition(db, actor, kind, table),
            builtinCondition(kind, options.excludeBuiltin),
          ),
        )
      return rows[0]?.total ?? 0
    },
  })
}
