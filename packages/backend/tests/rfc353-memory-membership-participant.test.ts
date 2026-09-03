// RFC-353 T1（RFC-294 W4-E3）—— 融合成员关系判据的双 provider 等价 oracle。
//
// 为什么这条测试存在：融合把记忆写进技能（markFused）、技能回滚把记忆退回来
// （unfuseAboveVersion）这两个判据，今天在两个 provider 上**各写了一份**：
//
//   - SQLite：`unfuseMemoriesTx`（modules/memory/infrastructure/sqliteMemoryCatalog.ts）
//     先 SELECT 再逐行 UPDATE，返回 `rows.map(r => r.id)`——**SELECT 顺序**，无 ORDER BY；
//   - PostgreSQL：`postgresqlSkillMemoryFusionParticipant.ts` 一条 UPDATE ... RETURNING，
//     返回 `.sort()` 之后的 id。
//
// 两边选中的**集合**一样，返回的**顺序**不一样；而这个数组会经
// `skill-catalog.restore-skill-version.v1` 的 `unfusedMemoryIds` 直接上 wire。
// memory id 是 ULID、通常按时间递增，所以插入顺序≈字典序，日常看不出来——
// 只有当记忆不是按 id 顺序落库时才现形（跨机器生成、导入、测试夹具）。
// 这与 RFC-352 开局撞到的 canManage 双 provider 漂移是同一类：**同一判据两个来源**。
//
// 本文件锁三件事：
//   ① 判据本身收成一份纯函数（memory domain），选中规则与返回顺序都由它定；
//   ② 真 SQLite 上跑出来的结果与该纯函数逐字一致——**故意让记忆不按 id 顺序落库**；
//   ③ 两个 provider 的适配器都不再手写这条 WHERE / 顺序（源码层断言）。
//
// 先红后绿：在补出 participant 之前，②「顺序」这一条必红——SQLite 今天按插入顺序返回。

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { createInMemoryDb } from '../src/db/client'
import { memories } from '../src/db/schema'
import { dbTxSync } from '../src/db/txSync'
import {
  fusedProvenanceStamp,
  memoriesToUnfuseAbove,
} from '../src/modules/memory/domain/fusionMembership'
import { unfuseAboveVersionSync } from '../src/modules/memory/infrastructure/sqliteMemoryMembershipParticipant'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const SQLITE_ADAPTER = resolve(
  import.meta.dir,
  '..',
  'src',
  'modules',
  'memory',
  'infrastructure',
  'sqliteMemoryMembershipParticipant.ts',
)
const POSTGRESQL_ADAPTER = resolve(
  import.meta.dir,
  '..',
  'src',
  'modules',
  'memory',
  'infrastructure',
  'postgresqlSkillMemoryFusionParticipant.ts',
)

interface SeedRow {
  readonly id: string
  readonly status: 'approved' | 'fused' | 'archived'
  readonly skillId: string | null
  readonly version: number | null
}

/**
 * 造记忆行。**插入顺序故意与 id 的字典序相反**——SQLite 无 ORDER BY 的 SELECT
 * 按 rowid（即插入顺序）返回，只有这样才能把「顺序判据」的差异逼出来。
 */
function seed(db: ReturnType<typeof createInMemoryDb>, rows: readonly SeedRow[]): void {
  for (const row of rows) {
    db.insert(memories)
      .values({
        id: row.id,
        scopeType: 'global',
        scopeId: null,
        title: `m ${row.id}`,
        bodyMd: 'body',
        status: row.status,
        sourceKind: 'manual',
        tags: '[]',
        version: 1,
        fusedIntoSkillId: row.skillId,
        fusedIntoSkill: row.skillId === null ? null : 'skill-name',
        fusedIntoSkillVersion: row.version,
        fusedAt: row.version === null ? null : 1_700_000_000_000,
        createdAt: 1_700_000_000_000,
      })
      .run()
  }
}

/** 倒序插入的一组：id 字典序是 a<b<c<d，落库顺序是 d,c,b,a。 */
const OUT_OF_ORDER: readonly SeedRow[] = [
  { id: 'm_d', status: 'fused', skillId: 'skl_1', version: 3 },
  { id: 'm_c', status: 'fused', skillId: 'skl_1', version: 2 },
  { id: 'm_b', status: 'fused', skillId: 'skl_1', version: 3 },
  { id: 'm_a', status: 'fused', skillId: 'skl_1', version: 1 },
]

describe('RFC-353 T1 — 解融合判据（纯函数）', () => {
  test('只选中「本技能 + 已融合 + 融入版本 > 目标版本」的行', () => {
    const rows = [
      { id: 'm_a', status: 'fused', fusedIntoSkillId: 'skl_1', fusedIntoSkillVersion: 1 },
      { id: 'm_b', status: 'fused', fusedIntoSkillId: 'skl_1', fusedIntoSkillVersion: 2 },
      { id: 'm_c', status: 'fused', fusedIntoSkillId: 'skl_2', fusedIntoSkillVersion: 9 },
      { id: 'm_d', status: 'approved', fusedIntoSkillId: 'skl_1', fusedIntoSkillVersion: 9 },
      { id: 'm_e', status: 'fused', fusedIntoSkillId: 'skl_1', fusedIntoSkillVersion: null },
    ]
    expect(memoriesToUnfuseAbove(rows, { skillId: 'skl_1', aboveVersion: 1 })).toEqual(['m_b'])
  })

  test('边界是严格大于：等于目标版本的不退（融进目标版本的知识仍在技能里）', () => {
    const rows = [
      { id: 'm_eq', status: 'fused', fusedIntoSkillId: 'skl_1', fusedIntoSkillVersion: 2 },
      { id: 'm_gt', status: 'fused', fusedIntoSkillId: 'skl_1', fusedIntoSkillVersion: 3 },
    ]
    expect(memoriesToUnfuseAbove(rows, { skillId: 'skl_1', aboveVersion: 2 })).toEqual(['m_gt'])
  })

  test('返回顺序是确定的字典序，与入参顺序无关', () => {
    const forward = [
      { id: 'm_a', status: 'fused', fusedIntoSkillId: 's', fusedIntoSkillVersion: 5 },
      { id: 'm_b', status: 'fused', fusedIntoSkillId: 's', fusedIntoSkillVersion: 5 },
    ]
    expect(memoriesToUnfuseAbove(forward, { skillId: 's', aboveVersion: 1 })).toEqual([
      'm_a',
      'm_b',
    ])
    expect(
      memoriesToUnfuseAbove([...forward].reverse(), { skillId: 's', aboveVersion: 1 }),
    ).toEqual(['m_a', 'm_b'])
  })

  test('解融合会把 provenance 清空——清哪几列由一份 stamp 决定', () => {
    expect(fusedProvenanceStamp(null)).toEqual({
      status: 'approved',
      fusedIntoSkillId: null,
      fusedIntoSkill: null,
      fusedIntoSkillVersion: null,
      fusedAt: null,
      fusedByUserId: null,
      fusedFusionId: null,
    })
  })

  test('融合会把同一组列写满——两个 provider 不许各写各的', () => {
    expect(
      fusedProvenanceStamp({
        skillId: 'skl_1',
        skillName: 'my-skill',
        skillVersion: 4,
        fusionId: 'fus_1',
        actorUserId: 'u_1',
        now: 1_700_000_000_000,
      }),
    ).toEqual({
      status: 'fused',
      fusedIntoSkillId: 'skl_1',
      fusedIntoSkill: 'my-skill',
      fusedIntoSkillVersion: 4,
      fusedAt: 1_700_000_000_000,
      fusedByUserId: 'u_1',
      fusedFusionId: 'fus_1',
    })
  })
})

describe('RFC-353 T1 — 真 SQLite 与纯函数逐字一致', () => {
  test('乱序落库时返回的仍是确定顺序（今天按插入顺序返回 ⇒ 本条先红）', () => {
    const db = createInMemoryDb(MIGRATIONS)
    seed(db, OUT_OF_ORDER)
    const expected = memoriesToUnfuseAbove(
      OUT_OF_ORDER.map((r) => ({
        id: r.id,
        status: r.status,
        fusedIntoSkillId: r.skillId,
        fusedIntoSkillVersion: r.version,
      })),
      { skillId: 'skl_1', aboveVersion: 1 },
    )
    const actual = dbTxSync(db, (tx) =>
      unfuseAboveVersionSync(tx, { skillId: 'skl_1', aboveVersion: 1 }),
    )
    expect(expected).toEqual(['m_b', 'm_c', 'm_d'])
    expect(actual).toEqual(expected)
  })

  test('全矩阵等价：真库选中的集合与顺序都等于纯函数的裁定', () => {
    // 覆盖：别的技能 / 未融合 / 版本为 null / 等于目标版本 / 大于目标版本，且乱序落库。
    const matrix: readonly SeedRow[] = [
      { id: 'm_z', status: 'fused', skillId: 'skl_1', version: 5 },
      { id: 'm_y', status: 'fused', skillId: 'skl_2', version: 5 },
      { id: 'm_x', status: 'approved', skillId: null, version: null },
      { id: 'm_w', status: 'fused', skillId: 'skl_1', version: 2 },
      { id: 'm_v', status: 'fused', skillId: 'skl_1', version: 3 },
      // 注意：DB 有 CHECK `(status='fused') = (fused_into_skill IS NOT NULL)`，
      // 所以「archived 却带着融合 provenance」这种行**造不出来**——不变式由库保证，
      // 判据不需要（也不应该）替它防守。这里只放合法形状。
      { id: 'm_u', status: 'archived', skillId: null, version: null },
    ]
    const db = createInMemoryDb(MIGRATIONS)
    seed(db, matrix)
    const expected = memoriesToUnfuseAbove(
      matrix.map((r) => ({
        id: r.id,
        status: r.status,
        fusedIntoSkillId: r.skillId,
        fusedIntoSkillVersion: r.version,
      })),
      { skillId: 'skl_1', aboveVersion: 2 },
    )
    const actual = dbTxSync(db, (tx) =>
      unfuseAboveVersionSync(tx, { skillId: 'skl_1', aboveVersion: 2 }),
    )
    expect(expected).toEqual(['m_v', 'm_z'])
    expect(actual).toEqual(expected)
  })

  test('被选中的行状态与 provenance 真的按 stamp 清空了', () => {
    const db = createInMemoryDb(MIGRATIONS)
    seed(db, OUT_OF_ORDER)
    dbTxSync(db, (tx) => unfuseAboveVersionSync(tx, { skillId: 'skl_1', aboveVersion: 1 }))
    const rows = db.select().from(memories).all()
    const byId = new Map(rows.map((r) => [r.id, r]))
    for (const id of ['m_b', 'm_c', 'm_d']) {
      const row = byId.get(id)!
      expect(row.status).toBe('approved')
      expect(row.fusedIntoSkillId).toBeNull()
      expect(row.fusedIntoSkillVersion).toBeNull()
      expect(row.fusedAt).toBeNull()
    }
    // v1 融进去的不动——它的知识还在回滚后的技能里。
    expect(byId.get('m_a')!.status).toBe('fused')
    expect(byId.get('m_a')!.fusedIntoSkillVersion).toBe(1)
  })
})

describe('RFC-353 T1 — 顺序只有一个来源', () => {
  test('两个适配器都 import domain 判据，且不自带第二个 .sort()', () => {
    // 只锁**顺序**与**判据来源**，不禁止 SQL 里出现 WHERE：
    // 选中规则留在 SQL 才用得上索引，它与纯函数的等价性由上面那组真库行为测试锁死
    // （同一批行、同一个 selector，真库结果必须逐字等于纯函数结果），
    // 那比文本匹配强——文本能绕过，行为不能。
    for (const file of [SQLITE_ADAPTER, POSTGRESQL_ADAPTER]) {
      const source = readFileSync(file, 'utf8')
      const body = source
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('//') && !line.trimStart().startsWith('*'))
        .join('\n')
      const name = file.split('/').pop()
      expect({
        name,
        importsDomain: body.includes('fusionMembership'),
        // 清空 provenance 的那一组列也只能来自同一份 stamp——
        // 少清一列就会留下「状态是 approved、却仍指着某个技能版本」的幽灵行，
        // 而这种行在另一个 provider 上可能因为 NULL 语义不同而表现完全不一样。
        usesStamp: body.includes('fusedProvenanceStamp'),
        ownSort: /\.sort\(\)/.test(body),
      }).toEqual({ name, importsDomain: true, usesStamp: true, ownSort: false })
    }
  })
})
