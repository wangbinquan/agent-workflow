import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const sourceRoot = resolve(import.meta.dir, '../src/modules/resource-catalog')
const source = (path: string): string => readFileSync(resolve(sourceRoot, path), 'utf8')

describe('RFC-345 Intent context resource authorization seam', () => {
  test('public contract is closed and carries no provider or actor shape', () => {
    const participants = source('public/participants.ts')
    const contract = participants.slice(
      participants.indexOf('export interface IntentContextResourceReference'),
      participants.indexOf('export interface McpAclIdentityParticipant'),
    )

    expect(contract).toContain('resourceType: CatalogSelectorKind')
    expect(contract).toContain('resourceId: string')
    expect(contract).toContain('expectedName?: string')
    expect(contract).toContain('Promise<IntentContextResourceIdentity | null>')
    expect(contract).not.toContain('loadVisibleSync')
    expect(contract).not.toMatch(/DbClient|DbTxSync|Postgresql|drizzle|Actor/)
  })

  // RFC-359 W4-D20：异步读端口合成一份中立实现（此前 SQLite 的那份异步工厂零生产消费）。
  test('the async factory binds one neutral session to a caller-owned transaction', () => {
    const composition = source('composition/intentContextAuthorization.ts')
    const reads = source('infrastructure/intentContextResourceAuthorization.ts')

    expect(composition).toContain('composeIntentContextResourceAuthorizationFactory')
    expect(composition).not.toMatch(
      /composeSqliteIntentContextResourceAuthorizationFactory\b|composePostgresqlIntentContextResourceAuthorizationFactory/,
    )
    expect(composition).toContain('authority !== pair.authority')
    expect(composition).toContain('foreign-intent-context-resource-authority')
    expect(reads).toContain('ACL_TABLES[resourceType]')
    expect(reads).toContain('resourceGrants.resourceType')
    expect(reads).not.toMatch(
      /PostgresqlDatabaseClient|\bDbClient\b|runPostgresqlResourceCatalogTransaction/,
    )
    for (const retired of [
      'infrastructure/sqliteIntentContextResourceAuthorization.ts',
      'infrastructure/postgresqlIntentContextResourceAuthorization.ts',
    ]) {
      expect(() => source(retired), retired).toThrow()
    }
  })

  // RFC-359 W8：这条守卫此前钉的是**反向**的事实——「SQLite 另有一份 dbTxSync 同步会话」。
  // 那条链自己写下的退役条件（`infrastructure/intentContextResourceAuthorization.ts` 的注释：
  // 「随 Intent 宿主切到统一事务原语后退役」）在 W7 合掉 IntentSqlProgramRunner 后成立：两个 SQLite
  // bootstrap（`server.ts` / `cli/start.ts`）都改指了中立异步工厂，同步链生产消费者归零
  // （`tests/architecture/rfc359-w5-adapter-production-consumer.test.ts` 的「改指」账本记的就是它）。
  // 所以断言翻面：同步链的四个符号必须**都不在了**——留一个就是留一条只有 SQLite 能走的分叉。
  test('the SQLite dbTxSync synchronous session is retired, not merely unused', () => {
    const participants = source('public/participants.ts')
    const application = source('application/participants/intentContextResourceAuthorization.ts')
    const ports = source('application/ports/intentContextResourceAuthorization.ts')
    const composition = source('composition/intentContextAuthorization.ts')

    // 判的是**声明与调用**，不是提及：上面几个文件的注释里还留着这些名字，写清「它曾经在这里、
    // 为什么走了」正是退役该留的痕；把裸名字当复辟信号会逼着后来人把历史抹掉。
    expect(participants).not.toContain('IntentContextResourceAuthorizationSyncSession')
    expect(ports).not.toContain('export interface IntentContextResourceAuthorizationSyncReadPort')
    expect(application).not.toContain(
      'export function createIntentContextResourceAuthorizationSyncSession',
    )
    expect(application).not.toContain('loadVisibleSync(')
    expect(composition).not.toContain(
      'export interface SqliteIntentContextResourceAuthorizationSyncFactory',
    )
    expect(composition).not.toContain(
      'export function composeSqliteIntentContextResourceAuthorizationSyncFactory',
    )
    expect(composition).not.toContain('createIntentContextResourceAuthorizationSyncReadPort(')
    // 同步链一走，`dbTxSync` 的类型就不该再出现在这条 Intent 授权链的任何一层上。
    expect(composition).not.toMatch(/\bDbTxSync\b/)
    expect(source('infrastructure/intentContextResourceAuthorization.ts')).not.toMatch(
      /\bDbTxSync\b/,
    )
    expect(composition).not.toMatch(/deasync|as unknown|plain Actor fallback/)
  })

  test('application revalidates expected name and visibility before returning identity', () => {
    const application = source('application/participants/intentContextResourceAuthorization.ts')

    expect(application).toContain('row.name !== reference.expectedName')
    expect(application).toContain('resourceAclAudienceAuthority(actor)')
    expect(application).toContain('reads.loadGrantLevel(')
    expect(application).toContain('if (!canViewAccess(access)) return null')
    expect(application).not.toMatch(/from ['"].*(db|infrastructure)/)
    expect(application).not.toContain('as unknown')
  })
})
