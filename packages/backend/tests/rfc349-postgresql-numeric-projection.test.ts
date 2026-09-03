// RFC-349 回归防护 —— PostgreSQL 的聚合结果必须落成 JS number，不能是字符串。
//
// 为什么这条测试存在（2026-09-03，对着真 PostgreSQL 实测）：`count(*)` 在 PostgreSQL 里
// 是 **int8**，`sum(bigint)` 是 **numeric**；这两种类型超出 IEEE754 安全整数范围，驱动
// 按规范把它们原样交回**字符串**。实测同一条连接：
//
//   count(*)          → string "100000"
//   count(*)::int     → number 100000
//   numeric / int8    → string        int2 / int4 / float8 → number
//
// 普通列不受影响：整数列在 PostgreSQL 投影里是 bigint，但 Drizzle 的
// `bigint({ mode: 'number' })` 有 mapper，读回来就是 number（实测 tasks 整行全部正确）。
// **裸 `sql<number>\`count(*)\`` 没有 mapper**——TypeScript 说是 number，运行时是字符串。
// SQLite 那边一直是 number，于是同一段代码在两个 provider 上行为不同：`total + 1` 变成
// 字符串拼接、JSON 响应里 `total` 从 3000 变成 "3000"、分页/配额判断被静默改写。
//
// 修法是走 Drizzle 自带的 `count()`（`sql\`count(*)\`.mapWith(Number)`），或给自定义聚合
// 显式 `.mapWith(Number)`。判据：PostgreSQL 适配器里的聚合投影必须带 mapper，除非在
// `DECODED_BY_CALLER` 里写明由哪个解码函数负责。

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { count } from 'drizzle-orm'

const srcRoot = resolve(import.meta.dir, '..', 'src')

/** `文件相对路径 -> 列名 -> 谁负责把驱动交回的字符串解码成 number`。 */
const DECODED_BY_CALLER: Record<string, Record<string, string>> = {
  'platform/persistence/postgresqlEventsArchive.ts': {
    value: '调用点用 numberValue() 解码；投影类型也刻意写成 sql<unknown> 提醒这一点',
  },
  'modules/system-operations/infrastructure/postgresqlResourceLimitPersistence.ts': {
    total: 'decodeResourceLimitTokenTotal() 显式接受 string / bigint / number 三种形态',
  },
  'modules/source-control/infrastructure/postgresqlRepositoryWorkspaceStore.ts': {
    all_count:
      'repositoryWorkspaceSqlStore.cachedRepoFacets 的调用点对 all/referenced/attention ' +
      '三个字段都套了 Number()（`unused` 也是由解码后的两个数相减）',
  },
}

const AGGREGATE = /\bsql(?:<[^>]*>)?`[^`]*\b(?:count|sum|avg|max|min)\(/gu

function postgresqlAdapterFiles(): string[] {
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry)
      if (statSync(path).isDirectory()) walk(path)
      else if (entry.startsWith('postgresql') && entry.endsWith('.ts')) files.push(path)
    }
  }
  walk(srcRoot)
  return files
}

describe('RFC-349 PostgreSQL aggregates come back as numbers', () => {
  test("drizzle's count() carries the Number mapper that a raw template lacks", () => {
    const decoder = (
      count() as unknown as { decoder: { mapFromDriverValue(value: unknown): unknown } }
    ).decoder
    expect(
      decoder.mapFromDriverValue('100000'),
      'count() 不再把驱动交回的字符串映射成 number ⇒ 本仓所有计数都会退回字符串',
    ).toBe(100000)
  })

  test('every aggregate projection in a PostgreSQL adapter has a mapper or a named decoder', () => {
    const unmapped: string[] = []
    const staleProofs = new Map<string, Set<string>>(
      Object.entries(DECODED_BY_CALLER).map(([file, proofs]) => [
        file,
        new Set(Object.keys(proofs)),
      ]),
    )

    for (const file of postgresqlAdapterFiles()) {
      const relative = file.slice(srcRoot.length + 1)
      const text = readFileSync(file, 'utf8')
      for (const match of text.matchAll(AGGREGATE)) {
        const start = match.index ?? 0
        // The template ends at the next backtick that closes it; `.mapWith(` must
        // follow immediately for the projection to decode.
        const closing = text.indexOf('`', text.indexOf('`', start) + 1)
        const tail = text.slice(closing + 1, closing + 12)
        if (tail.startsWith('.mapWith(')) continue
        const line = text.slice(0, start).split('\n').length
        // The projection key is the `name:` that introduces the expression, or —
        // for a raw template — the first `AS <alias>` inside it.
        const template = text.slice(closing === -1 ? start : start, closing)
        const key =
          /([A-Za-z_][A-Za-z0-9_]*)\s*:\s*$/u.exec(text.slice(0, start))?.[1] ??
          /\bAS\s+([A-Za-z_][A-Za-z0-9_]*)/iu.exec(template)?.[1] ??
          '?'
        const proof = DECODED_BY_CALLER[relative]?.[key]
        if (proof !== undefined) {
          staleProofs.get(relative)?.delete(key)
          continue
        }
        unmapped.push(`${relative}:${line} (${key})`)
      }
    }

    expect(
      unmapped,
      'PostgreSQL 适配器的聚合投影没有 mapper ⇒ count/sum 会以字符串返回，' +
        '算术变拼接、JSON 里数字变字符串。改用 drizzle 的 count()，或显式 .mapWith(Number)',
    ).toEqual([])

    const stale = [...staleProofs].flatMap(([file, keys]) =>
      [...keys].map((key) => `${file}#${key}`),
    )
    expect(stale, '这些解码说明已经没有对应的聚合投影了 ⇒ 删掉').toEqual([])
  })
})
