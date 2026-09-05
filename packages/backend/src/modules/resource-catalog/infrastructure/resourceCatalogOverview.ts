// RFC-359 W4-B2 —— 目录概览的可见计数：一份实现，两个 provider 共用。

import { and, count, eq, type SQL } from 'drizzle-orm'
import type { Actor } from '@/auth/actor'
import type { ProviderNeutralDatabase } from '@/db/query'
import { agents, workflows } from '@/db/schema'
import type { ResourceCatalogOverviewCountPort } from '../application/ports/resourceCatalogOverview'
import type { CatalogSelectorKind } from '../domain/resourceKinds'
import { ACL_TABLES, visibleRowsCondition } from './resourceVisibility'

function builtinCondition(kind: CatalogSelectorKind, exclude: boolean): SQL<unknown> | undefined {
  if (!exclude) return undefined
  if (kind === 'agent') return eq(agents.builtin, false)
  if (kind === 'workflow') return eq(workflows.builtin, false)
  return undefined
}

export function createResourceCatalogOverviewCountPort(
  db: ProviderNeutralDatabase,
): ResourceCatalogOverviewCountPort {
  return Object.freeze({
    async countVisible(
      actor: Actor,
      kind: CatalogSelectorKind,
      options: Readonly<{ excludeBuiltin: boolean }>,
    ): Promise<number> {
      const table = ACL_TABLES[kind]
      const rows = await db
        .select({ total: count() })
        .from(table)
        .where(
          and(
            visibleRowsCondition(db, actor, kind, table),
            builtinCondition(kind, options.excludeBuiltin),
          ),
        )
      return Number(rows[0]?.total ?? 0)
    },
  })
}
