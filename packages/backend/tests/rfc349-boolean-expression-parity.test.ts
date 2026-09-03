// RFC-349 回归防护 —— 布尔列的 SQL 表达式不能用 0/1 冒充。
//
// 为什么这条测试存在（2026-09-03，对着真 PostgreSQL 实测）：SQLite 没有布尔类型，`0` / `1`
// 就是 false / true；RFC-349 把这些列投影成 PostgreSQL 的 `boolean`，于是把整数混进布尔
// 表达式会被直接拒绝：
//
//   select case when 1 >= 2 then 0 else enabled end from scheduled_tasks
//   ERROR:  CASE types boolean and integer cannot be matched      ← SQLSTATE 42804
//
// 命中的是定时任务的失败自停用：`recordFailure` 用
// `CASE WHEN consecutive_failures + 1 >= max_failures THEN 0 ELSE enabled END` 自动停用连
// 续失败的调度。在 PostgreSQL 上整条 UPDATE 抛错——失败次数攒不上去，任务也就**永远不会**
// 被自动停用，而且每次失败上报本身都失败。
//
// `false` / `true` 两个 dialect 都认（SQLite 3.23+ 把它们当 0/1，实测写进去就是 integer 0），
// 所以两侧共用同一份写法，不需要分叉。
//
// 判据：任何布尔列被赋一段裸 `sql` 表达式时，里面不得出现独立的 0 / 1 字面量。

import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const srcRoot = resolve(import.meta.dir, '..', 'src')

/** `prop: integer('x', { mode: 'boolean' })` 声明出来的属性名。 */
function booleanProperties(): Set<string> {
  const schema = readFileSync(join(srcRoot, 'db/schema.ts'), 'utf8')
  const properties = new Set<string>()
  for (const match of schema.matchAll(
    /(\w+)\s*:\s*integer\('[a-z_]+',\s*\{\s*mode:\s*'boolean'\s*\}\)/gu,
  )) {
    properties.add(match[1]!)
  }
  return properties
}

function sourceFiles(): string[] {
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry)
      if (statSync(path).isDirectory()) walk(path)
      else if (entry.endsWith('.ts')) files.push(path)
    }
  }
  walk(srcRoot)
  return files
}

describe('RFC-349 boolean columns never take an integer expression', () => {
  test('the premise: SQLite accepts `false` and stores it as integer 0', () => {
    const db = new Database(':memory:')
    db.run('create table t(enabled integer not null)')
    db.run('insert into t values (1)')
    db.run('update t set enabled = case when 1 >= 1 then false else enabled end')
    const row = db
      .query<{ enabled: number; ty: string }, []>('select enabled, typeof(enabled) ty from t')
      .get()
    expect(row?.enabled, 'SQLite 不再认 false ⇒ 两侧就没法共用同一份写法了').toBe(0)
    expect(row?.ty).toBe('integer')
    db.close()
  })

  test('no boolean column is assigned a raw SQL expression containing 0 or 1', () => {
    const properties = booleanProperties()
    expect(properties.size, '布尔列一个都没找到 ⇒ 扫描判据失效了').toBeGreaterThan(20)
    const offenders: string[] = []

    for (const file of sourceFiles()) {
      const text = readFileSync(file, 'utf8')
      for (const property of properties) {
        for (const match of text.matchAll(
          new RegExp('\\b' + property + '\\s*:\\s*sql`([^`]*)`', 'gu'),
        )) {
          // Placeholders (`${...}`) are drizzle columns/params, not literals.
          // Only the value the expression *yields* has to be boolean: an integer
          // literal inside the condition (`failures + 1 >= max`) is ordinary
          // arithmetic and stays legal on both providers.
          const literals = match[1]!.replace(/\$\{[^}]*\}/gu, ' ')
          const yieldsInteger =
            /\b(?:then|else)\s+[01]\b/iu.test(literals) || /^\s*[01]\s*$/u.test(literals)
          if (!yieldsInteger) continue
          const line = text.slice(0, match.index).split('\n').length
          offenders.push(`${file.slice(srcRoot.length + 1)}:${line} ${property}`)
        }
      }
    }

    expect(
      offenders,
      '布尔列被赋了含 0/1 的 SQL 表达式 ⇒ PostgreSQL 会以 ' +
        '"CASE types boolean and integer cannot be matched"(42804) 拒绝整条语句。用 false / true',
    ).toEqual([])
  })

  test('the scheduled-task auto-disable keeps the boolean literal on both providers', () => {
    for (const provider of ['postgresql', 'sqlite']) {
      const source = readFileSync(
        join(srcRoot, `modules/integration/infrastructure/${provider}ScheduledTaskPersistence.ts`),
        'utf8',
      )
      // 只把那一行摘出来断言：整份源码进断言会让失败输出淹没在几百行里。
      const line = source.split('\n').find((candidate) => candidate.includes('CASE WHEN')) ?? ''
      expect(
        line,
        `${provider} 的失败自停用回到 THEN 0 ⇒ PostgreSQL 上 recordFailure 整条抛错`,
      ).toContain('THEN false ELSE')
    }
  })
})
