// flag-audit §8 决策（用户 2026-07-07）——node_run_outputs.kind 别名倒灌修复的回归锁。
//
// 病根（audit §3-11）：review.ts approve 路径持续向新行写 legacy 'markdown_file'，
// runner.ts 端口持久化则原样透传 agent frontmatter 声明（同样可能是别名），违反
// kindParser「仓库内部统一 path<md>、stringifyKind 永不输出别名」的约定。
// 用户拍板「改写入 + 迁移存量」：两个写入点 canonical 化 + migration 0075 清洗。

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Database } from 'bun:sqlite'
import { normalizeKindString } from '@agent-workflow/shared'

const SRC = (rel: string) => readFileSync(resolve(import.meta.dir, '..', 'src', rel), 'utf8')
const MIGRATION = readFileSync(
  resolve(import.meta.dir, '..', 'db', 'migrations', '0075_flag_audit_markdown_file_backfill.sql'),
  'utf8',
)

describe('normalizeKindString（持久化 canonical 口）', () => {
  test('别名折叠：markdown_file → path<md>；canonical 形态幂等', () => {
    expect(normalizeKindString('markdown_file')).toBe('path<md>')
    expect(normalizeKindString('path<md>')).toBe('path<md>')
    expect(normalizeKindString('list<path<md>>')).toBe('list<path<md>>')
    expect(normalizeKindString('markdown')).toBe('markdown')
  })

  test('解析不了的字符串原样透传（防御：行为不变）', () => {
    expect(normalizeKindString('___not-a-kind<<<')).toBe('___not-a-kind<<<')
    expect(normalizeKindString('')).toBe('')
  })
})

describe('写入点不再倒灌别名（源码锁）', () => {
  test('review.ts approve 路径写 canonical path<md>', () => {
    const src = SRC('services/review.ts')
    expect(src).toContain("hasSourcePath ? 'path<md>' : null")
    expect(src).not.toContain("hasSourcePath ? 'markdown_file'")
  })

  test('runner.ts 端口 kind 过 normalizeKindString', () => {
    expect(SRC('services/runner.ts')).toContain('normalizeKindString(rawKind)')
  })
})

describe('migration 0075 存量清洗语义', () => {
  test('对旧别名行执行迁移语句 → 翻为 path<md>，其余行不动', () => {
    const db = new Database(':memory:')
    db.run(`CREATE TABLE node_run_outputs (
      node_run_id TEXT NOT NULL,
      port_name TEXT NOT NULL,
      content TEXT NOT NULL,
      kind TEXT,
      PRIMARY KEY (node_run_id, port_name)
    )`)
    db.run(`INSERT INTO node_run_outputs VALUES
      ('r1','approved_doc','docs/a.md','markdown_file'),
      ('r2','out','hello','markdown'),
      ('r3','doc','docs/b.md','path<md>'),
      ('r4','x','y',NULL)`)
    // 执行迁移文件里的实际语句（剥掉注释行），锁定 SQL 语义本身。
    const stmt = MIGRATION.split('\n')
      .filter((l) => !l.trimStart().startsWith('--') && l.trim().length > 0)
      .join('\n')
    db.run(stmt)
    const kinds = db
      .query('SELECT node_run_id AS id, kind FROM node_run_outputs ORDER BY node_run_id')
      .all() as Array<{ id: string; kind: string | null }>
    expect(kinds).toEqual([
      { id: 'r1', kind: 'path<md>' },
      { id: 'r2', kind: 'markdown' },
      { id: 'r3', kind: 'path<md>' },
      { id: 'r4', kind: null },
    ])
  })
})
