// RFC-353 T9（RFC-294 W4-E3）—— 技能来源追溯 `GET /api/skills/:id/provenance` 的锁。
//
// 这条测试存在的理由（重构时别删）：这条投影有四个各自都容易漂的判断——
//   ① 非 fusion 版本（restore / editor / import / initial）恒无记忆；
//   ② 已被回滚退回的记忆不再计入（来源面板反映**当前真相**，不是历史流水）；
//   ③ 当前用户看不见的记忆直接不出现，且**不留计数**；
//   ④ 版本倒序，与 `GET /api/skills/:id/versions` 一致（并排展示时顺序必须一样）。
// 写在路由 handler 里这四条谁都锁不住；抽成纯函数后每条都能直接断言。

import { describe, expect, test } from 'bun:test'

import { getSkillProvenance } from '@/modules/knowledge-evolution/application/skillProvenanceQuery'
import { projectSkillProvenance } from '@/modules/knowledge-evolution/domain/skillProvenance'
import { countsAsFusedInto, fusedIntoSkill } from '@/modules/memory/domain/fusedProvenanceRows'

const version = (
  versionIndex: number,
  source: 'fusion' | 'restore' | 'editor' | 'import' | 'initial',
  extra: Partial<{ fusionId: string | null; restoredFromVersion: number | null }> = {},
) => ({
  id: `ver_${versionIndex}`,
  skillName: 'lint',
  versionIndex,
  source,
  summary: null,
  fusionId: extra.fusionId ?? (source === 'fusion' ? `fus_${versionIndex}` : null),
  restoredFromVersion: extra.restoredFromVersion ?? null,
  authorUserId: 'usr_1',
  contentHash: 'hash',
  createdAt: 1_700_000_000_000 + versionIndex,
})

const memory = (id: string, atVersion: number) => ({
  id,
  title: `t-${id}`,
  scopeType: 'global' as const,
  scopeId: null,
  fusedIntoSkillVersion: atVersion,
})

describe('RFC-353 T9 memory 侧：哪几行算这个技能的来源', () => {
  const row = {
    id: 'm1',
    title: 't',
    scopeType: 'global' as const,
    scopeId: null,
    status: 'fused',
    fusedIntoSkillId: 'skl_1',
    fusedIntoSkillVersion: 2,
  }

  test('status=fused + provenance 指向本技能 + 有版本号，三条齐了才算', () => {
    expect(countsAsFusedInto(row, 'skl_1')).toBe(true)
    expect(countsAsFusedInto({ ...row, status: 'approved' }, 'skl_1')).toBe(false)
    expect(countsAsFusedInto({ ...row, fusedIntoSkillId: 'skl_2' }, 'skl_1')).toBe(false)
    expect(countsAsFusedInto({ ...row, fusedIntoSkillVersion: null }, 'skl_1')).toBe(false)
  })

  test('被回滚退回的记忆不再计入——即便旧 id 还留在行上（RFC-223 脏数据形态）', () => {
    // 退回时清的是 status 与 provenance；历史行可能仍带旧 skillId。
    const unfused = { ...row, status: 'approved', fusedIntoSkillVersion: null }
    expect(countsAsFusedInto(unfused, 'skl_1')).toBe(false)
    expect(fusedIntoSkill([unfused, row], 'skl_1').map((r) => r.id)).toEqual(['m1'])
  })

  test('返回按 id 字典序——rowid 顺序是存储副产物，两个 provider 上会漂', () => {
    const rows = ['m3', 'm1', 'm2'].map((id) => ({ ...row, id }))
    expect(fusedIntoSkill(rows, 'skl_1').map((r) => r.id)).toEqual(['m1', 'm2', 'm3'])
  })
})

describe('RFC-353 T9 投影：版本 × 记忆', () => {
  test('版本倒序，与 /versions 一致', () => {
    const out = projectSkillProvenance(
      'skl_1',
      [version(1, 'initial'), version(3, 'fusion'), version(2, 'restore')],
      [],
    )
    expect(out.versions.map((v) => v.versionIndex)).toEqual([3, 2, 1])
    expect(out.skillId).toBe('skl_1')
  })

  test('记忆按 fusedIntoSkillVersion 归到对应版本', () => {
    const out = projectSkillProvenance(
      'skl_1',
      [version(2, 'fusion'), version(3, 'fusion')],
      [memory('m1', 2), memory('m2', 3), memory('m3', 2)],
    )
    expect(out.versions[0]!.versionIndex).toBe(3)
    expect(out.versions[0]!.memories.map((m) => m.id)).toEqual(['m2'])
    expect(out.versions[1]!.memories.map((m) => m.id)).toEqual(['m1', 'm3'])
  })

  test('非 fusion 版本恒为空——脏数据把记忆指过去也不渲染', () => {
    const out = projectSkillProvenance(
      'skl_1',
      [version(2, 'restore', { restoredFromVersion: 1 }), version(1, 'initial')],
      [memory('m1', 2), memory('m2', 1)],
    )
    expect(out.versions.every((v) => v.memories.length === 0)).toBe(true)
    expect(out.versions[0]!.restoredFromVersion).toBe(1)
    expect(out.versions[0]!.fusionId).toBeNull()
  })

  test('归不到任何版本的记忆被丢弃，不额外造一行', () => {
    const out = projectSkillProvenance('skl_1', [version(1, 'fusion')], [memory('m1', 9)])
    expect(out.versions).toHaveLength(1)
    expect(out.versions[0]!.memories).toEqual([])
  })

  test('没有版本时返回空列表，不是 null', () => {
    expect(projectSkillProvenance('skl_1', [], [])).toEqual({ skillId: 'skl_1', versions: [] })
  })

  test('fusion 版本带出 fusionId', () => {
    const out = projectSkillProvenance('skl_1', [version(2, 'fusion')], [])
    expect(out.versions[0]!.fusionId).toBe('fus_2')
    expect(out.versions[0]!.source).toBe('fusion')
  })
})

describe('RFC-353 T9 编排：可见性过滤在拼装之前', () => {
  test('看不见的记忆直接不出现，且不留计数', async () => {
    const out = await getSkillProvenance(
      {
        listVersions: async () => [version(2, 'fusion')],
        listFusedInto: async () => [memory('m1', 2), memory('m2', 2)],
        // 只有 m1 可见。
        filterVisible: async (rows) => rows.filter((r) => r.id === 'm1'),
      },
      'skl_1',
    )
    expect(out.versions[0]!.memories.map((m) => m.id)).toEqual(['m1'])
    expect(JSON.stringify(out)).not.toContain('hidden')
    expect(JSON.stringify(out)).not.toContain('m2')
  })

  test('一条融合记录都没有时不去问可见性（省一次 scope 解析）', async () => {
    let asked = 0
    const out = await getSkillProvenance(
      {
        listVersions: async () => [version(1, 'initial')],
        listFusedInto: async () => [],
        filterVisible: async (rows) => {
          asked += 1
          return [...rows]
        },
      },
      'skl_1',
    )
    expect(asked).toBe(0)
    expect(out.versions[0]!.memories).toEqual([])
  })
})
