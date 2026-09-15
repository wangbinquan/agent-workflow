// RFC-349 — the exhaustive per-provider decision table.
//
// Before this table, every provider-specific decision was an inline
// `if (provider === 'postgresql') … else …`. That shape has no forcing function:
// a third provider silently takes the `else` branch and inherits SQLite's
// behaviour. Measured on `1e5a47893`: adding a third member to
// `DatabaseProvider` produced 4 compile errors, all in the schema projection —
// none from the 31 provider forks. Two of those forks were already the exact
// defect class RFC-349 spent a session fixing on PostgreSQL:
//   - boolean DDL defaults rendered as SQLite's '1'/'0'
//   - retryable-write classification using SQLite error codes
//
// `satisfies Record<DatabaseProvider, DatabaseProviderTraits>` turns both into a
// compile error the moment a provider is added: the new provider cannot be
// declared without answering every field here.

import { postgresqlSerializationFailureCode } from '@/platform/persistence/postgresqlSerializationRetry'
import { retryableSqliteWriteErrorCode } from '@/platform/persistence/sqliteWriteRetry'

import { type DatabaseProvider } from './databaseProviders'

/**
 * How the daemon relates to the store. `embedded-file` means the daemon owns a
 * file it can stat, vacuum and back up in-process; `external-server` means a
 * separate server process the daemon only connects to.
 *
 * Ask this instead of `provider === 'sqlite'` whenever the question is really
 * "is there a local file?" — a new provider then answers correctly by
 * declaration rather than by falling through a branch.
 */
export type DatabaseStorageShape = 'embedded-file' | 'external-server'

export interface DatabaseProviderTraits {
  readonly storage: DatabaseStorageShape
  /**
   * Renders a boolean literal for DDL defaults. SQLite has no boolean type and
   * takes 1/0; PostgreSQL rejects those for a `boolean` column.
   */
  readonly booleanLiteral: (value: boolean) => string
  /**
   * Maps an error to a retryable-write code, or `undefined` when the write must
   * not be retried. Provider-specific: SQLite reports lock contention, and
   * PostgreSQL reports serialization/deadlock failures instead.
   */
  readonly classifyRetryable: (error: unknown) => string | undefined
  /**
   * This provider's side of the RFC-349 logical migration.
   *
   * `source` is the store a generation starts in — it still physically holds the
   * ARCHIVE_THEN_OMIT tables and its generation carries no migration operation.
   * `target` is a store a generation was migrated INTO — its active schema omits
   * the archived tables and its generation must reference the verified manifest
   * that produced it.
   *
   * Seven sites used to spell this axis as `provider === 'sqlite'` /
   * `=== 'postgresql'` independently. Declaring it once means a new provider has
   * to state which side it is on, instead of silently inheriting whichever branch
   * happened to be the `else`.
   */
  readonly migrationRole: 'source' | 'target'

  /**
   * `db info` 在拿不到服务端版本号时显示什么。
   *
   * RFC-359 AC-10：原来写成 `provider === 'sqlite' ? 'embedded SQLite' : 'unavailable'`——
   * 一个纯展示文案的品牌三元，第三个 provider 会静默拿到 `'unavailable'`。
   * 这不是「能力」而是「这个引擎怎么称呼自己」，但判据一样：值由各引擎各自声明一次。
   */
  readonly serverVersionFallback: string

  /**
   * provider 自检失败时，给用户的下一步提示；没有可给的就是 `null`。
   *
   * RFC-359 AC-10：原来写成 `storage === 'embedded-file' ? ' — recover: …' : ''`。
   * 「本地文件能用备份恢复」是真的能力差异，但它的答案是**一句话**，所以直接把那句话
   * 声明出来，而不是让调用方再问一次存储形态再自己拼。
   */
  readonly failureRecoveryHint: string | null

  /**
   * `db compact` 对这个引擎能不能做事；不能做就**直接给出要对用户说的话**。
   *
   * RFC-359 AC-10：原来写成 `storage !== 'embedded-file'` 再由调用方自己拼一段写死
   * 「PostgreSQL」的文案。`storage` 比品牌名好一档，但它仍是**两值枚举**（同一张真值表的
   * 另一种拼法），第三个 provider 照样只能落进其中一边。这里改成让答案本身被声明出来：
   * 能压缩就是 `{ supported: true }`，不能就连解释一起给。
   */
  readonly offlineCompaction:
    | { readonly supported: true }
    | { readonly supported: false; readonly explain: (generationId: string) => string }

  /**
   * 这个引擎「本地库文件还不存在」时，`doctor` 该报的那句话；没有本地库文件的引擎是 `null`。
   *
   * RFC-359 AC-10：原来写成 `storage === 'embedded-file' && !existsSync(Paths.db)`，
   * 并且那句话里还写死了「SQLite」。`null` 同时表达了「这个引擎没有本地文件这回事」，
   * 于是调用方连 `existsSync` 都不必做——判据与文案是同一件事，一起声明。
   */
  readonly absentLocalStoreMessage: string | null
}

export const DATABASE_PROVIDER_TRAITS = {
  sqlite: {
    storage: 'embedded-file',
    booleanLiteral: (value) => (value ? '1' : '0'),
    classifyRetryable: retryableSqliteWriteErrorCode,
    migrationRole: 'source',
    serverVersionFallback: 'embedded SQLite',
    failureRecoveryHint: ' — recover: agent-workflow restore <backup>',
    offlineCompaction: { supported: true },
    absentLocalStoreMessage: 'SQLite (no database yet)',
  },
  postgresql: {
    storage: 'external-server',
    booleanLiteral: (value) => (value ? 'TRUE' : 'FALSE'),
    classifyRetryable: postgresqlSerializationFailureCode,
    migrationRole: 'target',
    serverVersionFallback: 'unavailable',
    failureRecoveryHint: null,
    offlineCompaction: {
      supported: false,
      // 逐字保留原文案（`rfc349-db-compact-provider` 对它做整串断言）。
      explain: (generationId) =>
        `live database is PostgreSQL generation ${generationId}; ` +
        '`db compact` is SQLite-only. PostgreSQL storage reclamation is owned by autovacuum/operator policy.\n',
    },
    absentLocalStoreMessage: null,
  },
} as const satisfies Record<DatabaseProvider, DatabaseProviderTraits>

export function databaseProviderTraits(provider: DatabaseProvider): DatabaseProviderTraits {
  return DATABASE_PROVIDER_TRAITS[provider]
}
