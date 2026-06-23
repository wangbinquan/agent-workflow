// RFC-103 T10 (调研报告 12-RES MISSED, Codex) — skill-sources 列表 ACL 过滤。
//
// 为什么这条测试存在：GET /api/skill-sources 原本无 actor 过滤，任何认证用户都能
// 读到所有 source 的本机绝对路径 + label + 统计。修复后只对 admin / 该 source 的
// registrar(created_by) 可见；RFC-099 之前的 source(created_by NULL)仅 admin 可见
// （与 requireSourceRegistrar 同一鉴权规则）。本测试锁定纯函数 filterVisibleSkillSources
// 的可见性矩阵 + 路由确实用它过滤。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { filterVisibleSkillSources } from '../src/services/skill-source'

const SOURCES = [
  { id: 's1', createdBy: 'alice', path: '/home/alice/skills' },
  { id: 's2', createdBy: 'bob', path: '/home/bob/skills' },
  { id: 's3', createdBy: null, path: '/legacy/skills' }, // 预 RFC-099，仅 admin
]

describe('RFC-103 T10 filterVisibleSkillSources 可见性矩阵', () => {
  test('admin 看到全部（含 legacy NULL）', () => {
    const got = filterVisibleSkillSources({ isAdmin: true, userId: 'admin' }, SOURCES)
    expect(got.map((s) => s.id)).toEqual(['s1', 's2', 's3'])
  })

  test('registrar 只看到自己创建的 source', () => {
    expect(
      filterVisibleSkillSources({ isAdmin: false, userId: 'alice' }, SOURCES).map((s) => s.id),
    ).toEqual(['s1'])
    expect(
      filterVisibleSkillSources({ isAdmin: false, userId: 'bob' }, SOURCES).map((s) => s.id),
    ).toEqual(['s2'])
  })

  test('非 registrar 看不到他人 source 的绝对路径（列表不含该项）', () => {
    const got = filterVisibleSkillSources({ isAdmin: false, userId: 'carol' }, SOURCES)
    expect(got).toHaveLength(0)
  })

  test('legacy created_by=NULL 的 source 非 admin 不可见', () => {
    const got = filterVisibleSkillSources({ isAdmin: false, userId: 'alice' }, SOURCES)
    expect(got.map((s) => s.id)).not.toContain('s3')
  })

  test('userId 为 null（无用户态）非 admin 看不到任何 created_by 行', () => {
    expect(filterVisibleSkillSources({ isAdmin: false, userId: null }, SOURCES)).toHaveLength(0)
  })
})

describe('RFC-103 T10 源码层：路由用 filterVisibleSkillSources 过滤', () => {
  const routeSrc = readFileSync(join(import.meta.dir, '../src/routes/skill-sources.ts'), 'utf8')
  test('GET /api/skill-sources 不再裸返回全表', () => {
    expect(routeSrc).toContain('filterVisibleSkillSources(')
    // 旧写法（裸 listSkillSourcesWithStats 直接进 c.json）已不存在。
    expect(routeSrc).not.toMatch(/const sources = await listSkillSourcesWithStats\(deps\.db\)/)
  })
})
