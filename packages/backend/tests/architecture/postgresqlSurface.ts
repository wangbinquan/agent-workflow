// RFC-349 守卫语料的单一事实源：**哪些源文件会在 PostgreSQL 上执行 SQL**。
//
// 为什么需要它：RFC-349 落下的四条陷阱守卫各自用
// `readdirSync` + `entry.startsWith('postgresql')` 取语料。那条判据把语料等同于
// **文件名前缀**，于是三类文件整体逃出所有守卫：
//
//   ① 双 provider **共用一份实现**的文件——PG 侧只是一个具名工厂转调它。
//      实例：`modules/task-execution/infrastructure/taskIdleTimeoutPersistence.ts`
//      （RFC-350），db 形参类型是 `BaseSQLiteDatabase<'sync' | 'async', …>`，
//      两个 provider 跑的是同一段 SQL，而文件名不带前缀。
//   ② 直接吃 `PostgresqlDatabaseClient` / PG 事务、但按领域命名的文件
//      （`retentionSweeper.ts` / `employeePlatformWorkItemPersistence.ts` … 等）。
//   ③ 组合根自己内联的 SQL（`cli/postgresqlDaemonApplication.ts` 恰好带前缀，
//      但 `server.ts` 不带）。
//
// 2026-09-04 实测：按类型判定得到的执行面比「文件名前缀」多出 27 个文件。这些文件里
// 任何一处 `like(` / 裸 `count(*)` / 可空列裸 `desc()` 都不会被任何守卫看见。
//
// 判据改成**类型可达**而不是命名约定：一个文件在 PG 上执行 SQL，当且仅当它
// (a) 含 Drizzle 查询构造，且 (b) 拿得到 PG 客户端 / PG 事务 / 双 provider 共用句柄。
// 命名前缀仍然算——PG 适配器按约定就是那个名字，且它们未必显式 import 客户端类型。

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/** Drizzle 查询构造的痕迹。纯类型 / 纯常量文件不该进语料。 */
const BUILDS_SQL = /\.(from|insert|update|delete|selectDistinct)\(|\bsql\s*(<[^>]*>)?`/u

/**
 * 拿得到 PostgreSQL 执行句柄的痕迹：
 * - `PostgresqlDatabaseClient` / `PostgresqlTransaction`：PG 专属客户端与事务；
 * - `BaseSQLiteDatabase<'sync' | 'async'`：drizzle 里同时覆盖 bun:sqlite（同步）与
 *   sqlite-proxy（异步，即本仓的 PG 客户端）的基类——双 provider 共用实现的标记；
 * - `ProviderNeutralDatabase` / `DatabaseTransaction` / `databaseSessionFor(`：RFC-359 的中立句柄与
 *   统一事务原语——W4 起「一份实现、两个 provider 共用」的适配器只拿这些类型，不再出现
 *   provider 名，但它们的每一句 SQL 都同样在 PostgreSQL 上执行（2026-09-05 实测：前三批合一
 *   后按旧判据执行面从 204 掉到 191，掉出去的正是这些中立文件——陷阱守卫对它们全盲）。
 */
const TOUCHES_POSTGRESQL =
  /PostgresqlDatabaseClient|PostgresqlTransaction|BaseSQLiteDatabase<\s*'sync'\s*\|\s*'async'|ProviderNeutralDatabase|\bDatabaseTransaction\b|databaseSessionFor\(/u

export interface PostgresqlSurfaceFile {
  /** 相对 `packages/backend/src` 的路径，永远用 `/` 分隔（Windows 上也一样）。 */
  readonly path: string
  readonly absolute: string
  readonly text: string
  /** 命名前缀命中（`postgresqlFoo.ts`）还是类型可达命中。 */
  readonly reason: 'named-adapter' | 'typed-handle'
}

/**
 * 单个文件的归类判据，**纯函数**——守卫的负样本靠它对着捏造的源码验「判据真的会命中 /
 * 真的会放过」，不必在磁盘上造文件。
 */
export function classifyPostgresqlSurfaceFile(
  fileName: string,
  text: string,
): PostgresqlSurfaceFile['reason'] | null {
  if (fileName.startsWith('postgresql')) return 'named-adapter'
  if (BUILDS_SQL.test(text) && TOUCHES_POSTGRESQL.test(text)) return 'typed-handle'
  return null
}

function walk(dir: string, out: string[]): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) walk(path, out)
    else if (entry.endsWith('.ts')) out.push(path)
  }
  return out
}

/**
 * 会在 PostgreSQL 上执行 SQL 的全部后端源文件。
 *
 * 故意**不**吞异常：`srcRoot` 写错时 `readdirSync` 直接抛，而不是安静地返回空语料
 * ——空语料会让每一条基于它的断言永久假绿（`rfc317-guard-corpus-floor` 的立意）。
 */
export function postgresqlExecutionSurface(srcRoot: string): PostgresqlSurfaceFile[] {
  const files: PostgresqlSurfaceFile[] = []
  for (const absolute of walk(srcRoot, []).sort()) {
    const name = absolute.slice(absolute.lastIndexOf(sep) + 1)
    const text = readFileSync(absolute, 'utf8')
    const reason = classifyPostgresqlSurfaceFile(name, text)
    if (reason === null) continue
    files.push({
      path: relative(srcRoot, absolute).split(sep).join('/'),
      absolute,
      text,
      reason,
    })
  }
  return files
}
