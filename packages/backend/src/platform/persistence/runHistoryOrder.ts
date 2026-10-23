import { asc, desc, type AnyColumn } from 'drizzle-orm'
import type { PersistenceDb } from './persistenceDb'
import { engineOf } from './databaseTransaction'

/** II-a 的显示 / 历史顺序；NULL/ID 旧行兼容不作为业务选择判据。 */
export function runHistoryOrder(
  db: PersistenceDb,
  columns: { readonly seq: AnyColumn; readonly id: AnyColumn; readonly startedAt?: AnyColumn },
  order: 'seq' | 'api-timeline' = 'seq',
  direction: 'asc' | 'desc' = 'asc',
) {
  const nullable = direction === 'asc' ? engineOf(db).ascNullsFirst : engineOf(db).descNullsLast
  const required = direction === 'asc' ? asc : desc
  return [
    ...(order === 'api-timeline' && columns.startedAt !== undefined
      ? [nullable(columns.startedAt)]
      : []),
    nullable(columns.seq),
    required(columns.id),
  ]
}
