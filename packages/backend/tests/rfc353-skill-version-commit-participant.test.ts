// RFC-353 T6（RFC-294 W4-E3）—— 技能版本提交的判据与写入计划收成一份之后的回归锁。
//
// 这条测试存在的理由（别在重构时顺手删掉）：
//   ① 在它之前，「推进一个技能版本」在仓里有三处手抄——RC 的 `commitSkillVersionInTx`、
//      knowledge-evolution 融合 `apply()` 的 SQLite 与 PostgreSQL 各一份。三份字段集合本来
//      一致，但融合那两份的复合前置条件**只比了 `contentVersion` / `metaRevision` 两项**，
//      RC 自己那份比六项。同一判据抄多份必漂，`docs/dev-gotchas.md` 已记过一次。
//   ② RFC-353 AC-4 要求融合适配器不再直写 `skills` / `skill_versions` / `memories`。
//      §「AC-4 写入面」那两条源码层断言就是这条验收的锁——它比行为断言更难被绕过：
//      任何人往融合适配器里再写一句 `tx.insert(skillVersions)` 都会当场变红。
//   ③ 判据收成一份**不得改动用户可见的文案**：融合 approve 撞栅栏时那句
//      「fusion target skill changed; reload and retry」逐字不变（`staleMessage`）。

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  planSkillVersionCommit,
  skillVersionCompositeDrifted,
  skillVersionCompositeFenceRequested,
  type SkillVersionCompositeLive,
} from '@/modules/resource-catalog/domain/skillVersionCommit'

const LIVE: SkillVersionCompositeLive = {
  id: 'skl_1',
  contentVersion: 7,
  metaRevision: 3,
  ownerUserId: 'usr_1',
  aclRevision: 11,
  visibility: 'private',
}

describe('RFC-353 T6 复合前置条件：六项判据只此一份', () => {
  test('六项全空 = 调用方没要栅栏，连 live 行都不必读', () => {
    expect(skillVersionCompositeFenceRequested({})).toBe(false)
    // 没要栅栏时即便 live 行不存在也不算漂——否则 `initial` / 系统路径会被误伤。
    expect(skillVersionCompositeDrifted(null, {})).toBe(false)
  })

  test.each([
    ['expectedSkillId', { expectedSkillId: 'skl_1' }, { expectedSkillId: 'skl_2' }],
    ['expectedVersion', { expectedVersion: 7 }, { expectedVersion: 6 }],
    ['expectedMetaRevision', { expectedMetaRevision: 3 }, { expectedMetaRevision: 4 }],
    ['expectedOwnerUserId', { expectedOwnerUserId: 'usr_1' }, { expectedOwnerUserId: 'usr_2' }],
    ['expectedAclRevision', { expectedAclRevision: 11 }, { expectedAclRevision: 12 }],
    ['expectedVisibility', { expectedVisibility: 'private' }, { expectedVisibility: 'public' }],
  ] as const)('%s 逐项都设栅栏：吻合不漂、不吻合就漂', (_name, matching, drifting) => {
    expect(skillVersionCompositeFenceRequested(matching)).toBe(true)
    expect(skillVersionCompositeDrifted(LIVE, matching)).toBe(false)
    expect(skillVersionCompositeDrifted(LIVE, drifting)).toBe(true)
  })

  test('技能在事务里已经不见了，只要设了栅栏就算漂', () => {
    expect(skillVersionCompositeDrifted(null, { expectedVersion: 7 })).toBe(true)
    expect(skillVersionCompositeDrifted(undefined, { expectedVersion: 7 })).toBe(true)
  })

  test('owner 允许为 null，且 null 与「不设栅栏」不是一回事', () => {
    const ownerless = { ...LIVE, ownerUserId: null }
    expect(skillVersionCompositeDrifted(ownerless, { expectedOwnerUserId: null })).toBe(false)
    expect(skillVersionCompositeDrifted(ownerless, { expectedOwnerUserId: 'usr_1' })).toBe(true)
    expect(skillVersionCompositeDrifted(LIVE, { expectedOwnerUserId: null })).toBe(true)
    // 不给这一项 = 不比它，哪怕 live 是 null。
    expect(skillVersionCompositeFenceRequested({ expectedVersion: 7 })).toBe(true)
    expect(skillVersionCompositeDrifted(ownerless, { expectedVersion: 7 })).toBe(false)
  })

  test('staleMessage 只决定文案，不参与判据', () => {
    expect(skillVersionCompositeFenceRequested({ staleMessage: 'x' })).toBe(false)
    expect(skillVersionCompositeDrifted(LIVE, { staleMessage: 'x' })).toBe(false)
  })
})

describe('RFC-353 T6 写入计划：两条写只此一份', () => {
  const base = {
    versionRowId: 'ver_1',
    skillId: 'skl_1',
    versionIndex: 8,
    contentHash: 'deadbeef',
    filesPath: 'skills/skl_1/versions/v8/files',
    source: 'fusion',
    summary: 'merged',
    fusionId: 'fus_1',
    restoredFromVersion: null,
    authorUserId: 'usr_1',
    now: 1_700_000_000_000,
  } as const

  test('skills 补丁：推进版本号 + 快照即权威（RFC-170 invariant④），描述默认不动', () => {
    const plan = planSkillVersionCommit(base)
    expect(plan.skillPatch).toEqual({
      contentVersion: 8,
      updatedAt: base.now,
      versionState: 'snapshot-authoritative',
    })
    expect('description' in plan.skillPatch).toBe(false)
  })

  test('setDescription 给了才折进同一事务', () => {
    const plan = planSkillVersionCommit({ ...base, setDescription: '新描述' })
    expect(plan.skillPatch.description).toBe('新描述')
    // 快照即权威这一条不是可选项，加了描述也不变。
    expect(plan.skillPatch.versionState).toBe('snapshot-authoritative')
  })

  test('skill_versions 行：字段逐项来自入参，createdAt 与 skills.updatedAt 同一个 now', () => {
    const plan = planSkillVersionCommit(base)
    expect(plan.versionRow).toEqual({
      id: 'ver_1',
      skillId: 'skl_1',
      versionIndex: 8,
      filesPath: 'skills/skl_1/versions/v8/files',
      source: 'fusion',
      summary: 'merged',
      fusionId: 'fus_1',
      restoredFromVersion: null,
      authorUserId: 'usr_1',
      contentHash: 'deadbeef',
      createdAt: base.now,
    })
    expect(plan.versionRow.createdAt).toBe(plan.skillPatch.updatedAt)
  })

  test('回滚来源：restoredFromVersion 与 fusionId 各自独立带出去', () => {
    const plan = planSkillVersionCommit({
      ...base,
      source: 'restore',
      fusionId: null,
      restoredFromVersion: 5,
      summary: null,
    })
    expect(plan.versionRow.source).toBe('restore')
    expect(plan.versionRow.fusionId).toBeNull()
    expect(plan.versionRow.restoredFromVersion).toBe(5)
    expect(plan.versionRow.summary).toBeNull()
  })
})

describe('RFC-353 AC-4 写入面：融合适配器不再直写 resource-catalog / memory 的表', () => {
  const root = join(
    import.meta.dir,
    '..',
    'src',
    'modules',
    'knowledge-evolution',
    'infrastructure',
  )
  const adapters = ['sqliteFusionRepository.ts', 'postgresqlFusionRepository.ts'] as const

  test.each(adapters)('%s 里没有对 skills / skillVersions / memories 的写', (file) => {
    const source = readFileSync(join(root, file), 'utf-8')
    const writes = source.match(
      /\.(?:update|insert|delete)\(\s*(?:skills|skillVersions|memories)\s*\)/g,
    )
    expect(writes).toBeNull()
  })

  test.each(adapters)('%s 经 participant 提交版本，并逐字保留融合自己的栅栏文案', (file) => {
    const source = readFileSync(join(root, file), 'utf-8')
    expect(source).toContain('skillVersionCommit')
    expect(source).toContain("staleMessage: 'fusion target skill changed; reload and retry'")
  })

  test('legacy 的复合前置条件已改为委托，判据不再有第二份拷贝', () => {
    const legacy = readFileSync(
      join(
        import.meta.dir,
        '..',
        'src',
        'modules',
        'resource-catalog',
        'infrastructure',
        'legacy',
        'skillVersion.ts',
      ),
      'utf-8',
    )
    expect(legacy).toContain('assertSkillVersionCompositeFenceSync')
    // 六项比对的字面量只应出现在 domain 那一份里。
    expect(legacy).not.toContain('live.aclRevision !== commit.expectedAclRevision')
  })
})
