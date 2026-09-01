import { and, count, eq, type SQL } from 'drizzle-orm'
import type { Actor } from '@/auth/actor'
import { agents, workflows } from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type { ResourceCatalogOverviewCountPort } from '../application/ports/resourceCatalogOverview'
import type { CatalogSelectorKind } from '../domain/resourceKinds'
import { POSTGRESQL_ACL_TABLES } from './postgresqlAclRegistry'
import { postgresqlVisibleRowsCondition } from './postgresqlResourceGrantRepository'

function builtinCondition(kind: CatalogSelectorKind, exclude: boolean): SQL<unknown> | undefined {
  if (!exclude) return undefined
  if (kind === 'agent') return eq(agents.builtin, false)
  if (kind === 'workflow') return eq(workflows.builtin, false)
  return undefined
}

export function createPostgresqlResourceCatalogOverviewCountPort(
  db: PostgresqlDatabaseClient,
): ResourceCatalogOverviewCountPort {
  return Object.freeze({
    async countVisible(
      actor: Actor,
      kind: CatalogSelectorKind,
      options: Readonly<{ excludeBuiltin: boolean }>,
    ): Promise<number> {
      const table = POSTGRESQL_ACL_TABLES[kind]
      const rows = await db
        .select({ total: count() })
        .from(table)
        .where(
          and(
            postgresqlVisibleRowsCondition(db, actor, kind, table),
            builtinCondition(kind, options.excludeBuiltin),
          ),
        )
        .all()
      return rows[0]?.total ?? 0
    },
  })
}
