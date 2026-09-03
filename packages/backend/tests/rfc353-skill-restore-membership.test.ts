// RFC-353 T7（RFC-294 W4-E3）—— 技能回滚的成员关系协调归位后的回归锁。
//
// 这条测试存在的理由（重构时别删）：
//   ① 「回滚到 v{target} 时该退回哪些记忆」此前没有归属——SQLite 侧由
//      `resource-catalog/infrastructure/sqliteSkillRepository.ts` 直接
//      `import { unfuseAboveVersionSync } from '@/modules/memory/infrastructure/...'`
//      （跨 context **内部** import，RFC-317 R2 明令禁止），PostgreSQL 侧由 RC 的
//      composition 直接注入 memory 的 participant 工厂，两条路径各写一遍同一句 aboveVersion。
//   ② RFC-294 的目标边表里只有 `knowledge-evolution → resource-catalog`，**没有反向边**。
//      所以 RC 不能 import KE，协调器只能在 bootstrap 装配。§「装配面」那几条源码断言锁的
//      就是这件事：谁都不许把它改回 RC 直接去取。
//   ③ v1 已知缺口（先回滚到 v1、再向前回滚到 v2 会留一条 approved 的记忆）随判据一起迁到
//      KE domain，注释也一并迁走——缺口的描述必须跟判据待在同一处，否则下次修它的人找不到。

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { memoriesToUnfuseOnRestore } from '@/modules/knowledge-evolution/domain/skillRestore'
import {
  createAsyncSkillRestoreMembership,
  createSyncSkillRestoreMembership,
} from '@/modules/knowledge-evolution/public/participants'

const SRC = join(import.meta.dir, '..', 'src')
const read = (...parts: string[]): string => readFileSync(join(SRC, ...parts), 'utf-8')

describe('RFC-353 T7 回滚判据：只此一份，且严格大于 target', () => {
  test('退回的是「融入版本严格大于 target」的那批', () => {
    expect(memoriesToUnfuseOnRestore({ skillId: 'skl_1', targetVersion: 3 })).toEqual({
      skillId: 'skl_1',
      aboveVersion: 3,
    })
  })

  test('回滚到 v1 也不会把 v1 自己吃进去的记忆退回（严格大于，不是大于等于）', () => {
    expect(memoriesToUnfuseOnRestore({ skillId: 'skl_1', targetVersion: 1 }).aboveVersion).toBe(1)
  })

  test('v1 已知缺口的说明与判据同处一室', () => {
    const domain = read('modules', 'knowledge-evolution', 'domain', 'skillRestore.ts')
    expect(domain).toContain('v1 已知缺口')
    expect(domain).toContain('design §10')
    // 迁走之后 RC 那边不该再留一份描述，否则又是两份会漂的文字。
    const legacy = read(
      'modules',
      'resource-catalog',
      'infrastructure',
      'legacy',
      'skillVersion.ts',
    )
    expect(legacy).not.toContain('KNOWN v1 LIMITATION')
    expect(legacy).toContain('memoriesToUnfuseOnRestore')
  })
})

describe('RFC-353 T7 协调器：两个 provider 走同一条判据', () => {
  test('同步版把判据算好再交给 memory 的写入面，并原样带回 id', () => {
    const seen: unknown[] = []
    const coordinator = createSyncSkillRestoreMembership<string>((tx, selector) => {
      seen.push({ tx, selector })
      return ['m_b', 'm_a']
    })
    const ids = coordinator.unfuseForRestore('TX', { skillId: 'skl_1', targetVersion: 2 })
    expect(seen).toEqual([{ tx: 'TX', selector: { skillId: 'skl_1', aboveVersion: 2 } }])
    // 顺序归 memory domain 单一裁定，协调器不再排一次。
    expect(ids).toEqual(['m_b', 'm_a'])
  })

  test('异步版把同一个 selector 交给 memory 的 tx-bound participant', async () => {
    const seen: unknown[] = []
    const coordinator = createAsyncSkillRestoreMembership<string>({
      inTransaction(transaction: string) {
        return {
          async unfuseAboveVersion(selector: unknown) {
            seen.push({ transaction, selector })
            return Object.freeze(['m_a'])
          },
          markFused: async () => Object.freeze([]),
          reassignFusedSkill: async () => {},
        } as never
      },
    })
    const ids = await coordinator.unfuseForRestore('TX', { skillId: 'skl_1', targetVersion: 2 })
    expect(seen).toEqual([{ transaction: 'TX', selector: { skillId: 'skl_1', aboveVersion: 2 } }])
    expect(ids).toEqual(['m_a'])
  })
})

describe('RFC-353 T7 装配面：resource-catalog 不认识 memory，也不认识 knowledge-evolution', () => {
  test.each([
    ['sqliteSkillRepository.ts', ['infrastructure', 'sqliteSkillRepository.ts']],
    [
      'postgresqlSkillContentLifecycle.ts',
      ['infrastructure', 'postgresqlSkillContentLifecycle.ts'],
    ],
    ['postgresqlClassicCatalogs.ts', ['composition', 'postgresqlClassicCatalogs.ts']],
    ['composition/skillOperations.ts', ['composition', 'skillOperations.ts']],
  ] as const)('%s 既不 import memory 也不 import knowledge-evolution', (_name, parts) => {
    const source = read('modules', 'resource-catalog', ...parts)
    expect(source).not.toContain('modules/memory')
    // 反向边不存在（RFC-294 目标边表只有 knowledge-evolution → resource-catalog）。
    expect(source).not.toContain('modules/knowledge-evolution')
  })

  test.each([
    ['cli/start.ts', ['cli', 'start.ts'], 'createSyncSkillRestoreMembership'],
    ['server.ts', ['server.ts'], 'createSyncSkillRestoreMembership'],
    [
      'cli/postgresqlDaemonApplication.ts',
      ['cli', 'postgresqlDaemonApplication.ts'],
      'createAsyncSkillRestoreMembership',
    ],
  ] as const)('%s 在 bootstrap 把 KE 的协调器交给 resource-catalog', (_name, parts, factory) => {
    const source = read(...parts)
    expect(source).toContain(factory)
    expect(source).toContain('restoreMembership')
  })
})
