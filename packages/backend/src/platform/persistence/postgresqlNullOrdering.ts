// RFC-349 —— 让 PostgreSQL 的 NULL 排序与 SQLite 一致。
//
// 两个 provider 的默认**正好相反**（2026-09-03 实测，同一组 (2, NULL, 1)）：
//
//            ORDER BY x ASC      ORDER BY x DESC
//   SQLite   NULL, 1, 2          2, 1, NULL      ← NULL 视作最小
//   Postgres 1, 2, NULL          NULL, 2, 1      ← NULL 视作最大
//
// 纯展示排序差一位不致命；**认领 / 扫描类查询**会因此改变「先挑谁」，而这类查询往往
// 故意把 NULL 也放进候选集（NULL = 还没被认领过 / 还没扫过）。在 SQLite 上它们排最前、
// 优先被处理；换到 PostgreSQL 就排到最后，只要 due 的存量填满 LIMIT，新来的那些
// **永远轮不到** —— 是饿死，不是排序不好看。
//
// 因此这类 ORDER BY 在 PostgreSQL 适配器里必须显式写出 SQLite 的语义。SQLite 侧不动：
// `nulls first` 本来就是它 ASC 的默认，显式写反而可能扰动它的索引排序计划。
// 判据见 rfc349-null-ordering-parity.test.ts。

import { sql, type SQL, type SQLWrapper } from 'drizzle-orm'

/** `ORDER BY column ASC` with SQLite's NULL placement (NULLs first). */
export function ascNullsFirst(column: SQLWrapper): SQL {
  return sql`${column} asc nulls first`
}

/** `ORDER BY column DESC` with SQLite's NULL placement (NULLs last). */
export function descNullsLast(column: SQLWrapper): SQL {
  return sql`${column} desc nulls last`
}
