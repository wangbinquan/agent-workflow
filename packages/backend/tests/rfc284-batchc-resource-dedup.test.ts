// RFC-284 批 C（T9/T10/T11）——资源侧去重的行为锁与结构锁。
//
// T9  §2.1 反查泛型：四域（mcp/plugin/managed-skill/dependsOn）收编
//     resourceRefs.findAgentsReferencingIdInJsonColumn——命中/未命中/损坏行
//     fail-closed/LIKE 粗过滤误报被 matcher 拒绝 四路行为锁 + 「域文件不再自带
//     LIKE 扫描」结构锁。
// T9  §2.2 scheduled 引用扫描：三域收编 scheduledTaskRefs.scheduledRowsReferencing
//     ——kind 过滤/payload 键匹配/损坏 payload 跳过；叶子模块零 service 依赖
//     （workflow⇄scheduledTasks 成环的规避是该落位的存在理由）。
// T10 §2.3 grant 单点：grantsOfResourceWhere / listResourceGrantUserIds(InTx)
//     与直查等价；§2.4 快照式可见性 isVisibleToAudienceSnapshot 的
//     角色×关系×可见性 全矩阵（迁移前后判定不变的快照锁——admin 分支入函数，
//     ws/registry 对上游 aclBypassShortCircuit 的正确性依赖就此消除）。
// T11 §2.5 skill 唯一性：ownerScopedNameWhere 三态（占用/他人同名不占用/
//     NULL-owner 域隔离）+ isOwnerNameUniqueViolation 对新旧两代错误文案的识别。
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb } from '../src/db/client'
import { agents, resourceGrants, skills } from '../src/db/schema'
import { dbTxSync } from '../src/db/txSync'
import { findAgentsReferencingIdInJsonColumn } from '../src/modules/resource-catalog/infrastructure/legacy/resourceRefs'
import { listResourceGrantUserIds } from '../src/modules/resource-catalog/infrastructure/sqliteResourceGrantRepository'
import {
  findAgentsUsingManagedSkill,
  matchesManagedSkillReference,
} from '../src/modules/resource-catalog/infrastructure/legacy/skillReferenceGuard'
import { findAgentsDependingOn } from '../src/services/agentDeps'
import { isOwnerNameUniqueViolation } from '../src/services/ownerScopedName'
import {
  grantsOfResourceWhere,
  isVisibleToAudienceSnapshot,
  listResourceGrantUserIdsInTx,
} from '../src/services/resourceAcl'
import { scheduledRowsReferencing } from '../src/services/scheduledTaskRefs'
import { isSkillNameOccupiedForOwner } from '../src/modules/resource-catalog/infrastructure/legacy/skill'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const SRC = (p: string): string => readFileSync(resolve(import.meta.dir, '..', 'src', p), 'utf8')

function agentRow(overrides: Partial<typeof agents.$inferInsert>): typeof agents.$inferInsert {
  return {
    id: ulid(),
    name: `a-${ulid().slice(-8)}`,
    outputs: '[]',
    permission: '{}',
    skills: '[]',
    frontmatterExtra: '{}',
    bodyMd: '',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } as typeof agents.$inferInsert
}

function findArrayReferences(
  db: ReturnType<typeof createInMemoryDb>,
  column: Parameters<typeof findAgentsReferencingIdInJsonColumn>[1]['column'],
  id: string,
) {
  return findAgentsReferencingIdInJsonColumn(db, {
    column,
    id,
    matches: (parsed, expectedId) => Array.isArray(parsed) && parsed.includes(expectedId),
  })
}

describe('rfc284 批C T9 §2.1 — 反查泛型四域行为锁', () => {
  test('mcp/plugin 数组域：命中、未命中、损坏行 fail-closed、结构误报被 matcher 拒', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const hit = agentRow({ name: 'hit', mcp: '["M1","M2"]', plugins: '["P1"]' })
    const miss = agentRow({ name: 'miss', mcp: '["M9"]', plugins: '["P9"]' })
    // 损坏 JSON：LIKE 命中但 parse 抛 → fail-closed 空处理
    const corrupt = agentRow({ name: 'corrupt', mcp: '"M1"广告[', plugins: '{"P1"广告' })
    // LIKE 命中（子串 "P1" 在场）但形状不是数组 → matcher 拒
    const shapeMiss = agentRow({ name: 'shape', plugins: '{"x":"P1"}' })
    await db.insert(agents).values([hit, miss, corrupt, shapeMiss])

    const mcpRefs = await findArrayReferences(db, agents.mcp, 'M1')
    expect(mcpRefs.map((r) => r.name)).toEqual(['hit'])
    // 统一行形状（RFC-284 T9：ReferencingAgentRow 单点）
    expect(mcpRefs[0]).toEqual({
      id: hit.id,
      name: 'hit',
      ownerUserId: null,
      visibility: 'public',
    })

    const pluginRefs = await findArrayReferences(db, agents.plugins, 'P1')
    expect(pluginRefs.map((r) => r.name)).toEqual(['hit'])
  })

  test('managed-skill 对象域：skillId 精确匹配；非 managed 或它键同值不命中（LIKE 误报拒）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const hit = agentRow({
      name: 'hit',
      skills: '[{"kind":"managed","skillId":"S1"}]',
    })
    // note 值里出现 "S1"（LIKE 预过滤必命中），但 skillId 是别的 → 必须拒
    const likeTrap = agentRow({
      name: 'trap',
      skills: '[{"kind":"managed","skillId":"S2","note":"S1"}]',
    })
    const projectKind = agentRow({
      name: 'proj',
      skills: '[{"kind":"project","skillId":"S1"}]',
    })
    await db.insert(agents).values([hit, likeTrap, projectKind])
    const refs = await findAgentsUsingManagedSkill(
      {
        find: (skillId) =>
          findAgentsReferencingIdInJsonColumn(db, {
            column: agents.skills,
            id: skillId,
            matches: matchesManagedSkillReference,
          }),
      },
      'S1',
    )
    expect(refs.map((r) => r.name)).toEqual(['hit'])
  })

  test('dependsOn 字符串数组域：includes 精确匹配（前缀相似 id 不误报）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const hit = agentRow({ name: 'hit', dependsOn: '["A1","A2"]' })
    // "A1x" 含子串 A1 但整串不等 → 不误报（LIKE `%"A1"%` 也不命中该行，属双保险）
    const near = agentRow({ name: 'near', dependsOn: '["A1x"]' })
    await db.insert(agents).values([hit, near])
    expect(
      await findAgentsDependingOn(
        {
          findDependents: async (agentId) =>
            (await findArrayReferences(db, agents.dependsOn, agentId)).map(({ id, name }) => ({
              id,
              name,
            })),
        },
        'A1',
      ),
    ).toEqual([{ id: hit.id, name: 'hit' }])
  })

  test('结构锁：mcp/plugin provider 只做粗过滤，精确解析仍是单一 matcher', () => {
    for (const f of [
      'modules/resource-catalog/infrastructure/legacy/skillReferenceGuard.ts',
      'services/agentDeps.ts',
    ]) {
      expect(SRC(f)).not.toContain('like(agents.')
    }
    for (const [f, column, collector] of [
      [
        'modules/resource-catalog/infrastructure/sqliteMcpRepository.ts',
        'mcp',
        'collectMcpAgentReferences',
      ],
      [
        'modules/resource-catalog/infrastructure/postgresqlMcpRepository.ts',
        'mcp',
        'collectMcpAgentReferences',
      ],
      [
        'modules/resource-catalog/infrastructure/sqlitePluginRepository.ts',
        'plugins',
        'collectPluginAgentReferences',
      ],
      [
        'modules/resource-catalog/infrastructure/postgresqlPluginRepository.ts',
        'plugins',
        'collectPluginAgentReferences',
      ],
    ] as const) {
      const source = SRC(f)
      expect(source).toContain(`like(agents.${column},`)
      expect(source).toContain(`${collector}(`)
    }
    expect(SRC('services/resourceRefs.ts')).toContain(
      "export * from '@/modules/resource-catalog/infrastructure/legacy/resourceRefs'",
    )
    expect(SRC('modules/resource-catalog/infrastructure/legacy/resourceRefs.ts')).toContain(
      'export async function findAgentsReferencingIdInJsonColumn',
    )
    expect(existsSync(resolve(import.meta.dir, '..', 'src', 'services/mcp.ts'))).toBe(false)
    expect(existsSync(resolve(import.meta.dir, '..', 'src', 'services/plugin.ts'))).toBe(false)
  })
})

describe('rfc284 批C T9 §2.2 — scheduled 引用扫描单点', () => {
  const rows = [
    { id: 's1', launchKind: 'agent', launchPayload: '{"agentId":"A1"}' },
    { id: 's2', launchKind: 'workflow', launchPayload: '{"workflowId":"W1"}' },
    { id: 's3', launchKind: 'workgroup', launchPayload: '{"workgroupId":"G1"}' },
    { id: 's4', launchKind: 'agent', launchPayload: '{"agentId":"A2"}' },
    { id: 's5', launchKind: 'agent', launchPayload: '{broken' },
    // kind 错位：payload 有 agentId 但 kind 是 workflow → 不命中
    { id: 's6', launchKind: 'workflow', launchPayload: '{"agentId":"A1"}' },
  ]

  test('kind 过滤 + payload 键匹配 + 损坏 payload 跳过', () => {
    expect(
      scheduledRowsReferencing(rows, { launchKind: 'agent', payloadKey: 'agentId', id: 'A1' }).map(
        (r) => r.id,
      ),
    ).toEqual(['s1'])
    expect(
      scheduledRowsReferencing(rows, {
        launchKind: 'workflow',
        payloadKey: 'workflowId',
        id: 'W1',
      }).map((r) => r.id),
    ).toEqual(['s2'])
    expect(
      scheduledRowsReferencing(rows, {
        launchKind: 'workgroup',
        payloadKey: 'workgroupId',
        id: 'G1',
      }).map((r) => r.id),
    ).toEqual(['s3'])
    expect(
      scheduledRowsReferencing(rows, { launchKind: 'agent', payloadKey: 'agentId', id: 'NOPE' }),
    ).toEqual([])
  })

  test('结构锁：叶子模块零依赖（workflow⇄scheduledTasks 成环规避）+ 三域已委托', () => {
    const leaf = SRC('services/scheduledTaskRefs.ts')
    expect(leaf).not.toContain("from '@/services")
    expect(leaf).not.toContain("from './")
    for (const f of [
      'modules/resource-catalog/infrastructure/legacy/agent.ts',
      'modules/resource-catalog/infrastructure/legacy/workflow.ts',
      'modules/resource-catalog/infrastructure/legacy/workgroups.ts',
    ]) {
      expect(SRC(f)).toContain('scheduledRowsReferencing(')
      expect(SRC(f)).toContain("from '@/services/scheduledTaskRefs'")
    }
    // scheduledTasks.ts 保留 design 命名的导出面（薄再导出）
    expect(SRC('services/scheduledTasks.ts')).toContain(
      "export { scheduledRowsReferencing } from './scheduledTaskRefs'",
    )
  })
})

describe('rfc284 批C T10 §2.3 — grant 单点等价', () => {
  test('listResourceGrantUserIds 与 InTx 双形态、跨类型隔离', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    // FK：user_id → users.id（cascade），先立最小用户行
    const { users } = await import('../src/db/schema')
    await db.insert(users).values(
      ['u1', 'u2', 'u3', 'u4'].map(
        (id) =>
          ({
            id,
            username: id,
            displayName: id,
            passwordHash: 'x',
            role: 'user',
            status: 'active',
            createdAt: 0,
            updatedAt: 0,
          }) as typeof users.$inferInsert,
      ),
    )
    const g = (resourceType: 'workflow' | 'mcp', resourceId: string, userId: string) =>
      ({
        resourceType,
        resourceId,
        userId,
        addedBy: 'test',
        addedAt: 0,
      }) as typeof resourceGrants.$inferInsert
    await db.insert(resourceGrants).values([
      g('workflow', 'W1', 'u1'),
      g('workflow', 'W1', 'u2'),
      g('workflow', 'W2', 'u3'),
      g('mcp', 'W1', 'u4'), // 同 id 异类型
    ])
    expect((await listResourceGrantUserIds(db, 'workflow', 'W1')).sort()).toEqual(['u1', 'u2'])
    expect(await listResourceGrantUserIds(db, 'workflow', 'W9')).toEqual([])
    dbTxSync(db, (tx) => {
      expect(listResourceGrantUserIdsInTx(tx, 'workflow', 'W1').sort()).toEqual(['u1', 'u2'])
      expect(listResourceGrantUserIdsInTx(tx, 'mcp', 'W1')).toEqual(['u4'])
    })
    // where 形状可组合（canView 点查在用）——直接消费不抛即可
    expect(grantsOfResourceWhere('workflow', 'W1')).toBeDefined()
  })
})

describe('rfc284 批C T10 §2.4 — 快照式可见性全矩阵（迁移快照锁）', () => {
  const snap = (
    visibility: 'public' | 'private',
    ownerUserId: string | null,
    granted: string[],
  ) => ({
    visibility,
    ownerUserId,
    grantedUserIds: new Set(granted),
  })

  test('持有 resource-acl:bypass 恒可见（registry 不依赖上游捷径保正确性）', () => {
    expect(
      isVisibleToAudienceSnapshot(
        'stranger',
        { bypass: true, private: false },
        snap('private', 'owner', []),
      ),
    ).toBe(true)
  })

  test('无 bypass 的矩阵：public 恒见；private 看 owner/grant；旁人不可见', () => {
    // public × 当事人/旁人
    expect(
      isVisibleToAudienceSnapshot(
        'owner',
        { bypass: false, private: false },
        snap('public', 'owner', []),
      ),
    ).toBe(true)
    expect(
      isVisibleToAudienceSnapshot(
        'stranger',
        { bypass: false, private: false },
        snap('public', 'owner', []),
      ),
    ).toBe(true)
    // private × owner
    expect(
      isVisibleToAudienceSnapshot(
        'owner',
        { bypass: false, private: true },
        snap('private', 'owner', []),
      ),
    ).toBe(true)
    // private × grant
    expect(
      isVisibleToAudienceSnapshot(
        'g1',
        { bypass: false, private: true },
        snap('private', 'owner', ['g1']),
      ),
    ).toBe(true)
    // private × 旁人
    expect(
      isVisibleToAudienceSnapshot(
        'stranger',
        { bypass: false, private: true },
        snap('private', 'owner', ['g1']),
      ),
    ).toBe(false)
    // NULL owner（系统行）：不因 null 比较意外放行
    expect(
      isVisibleToAudienceSnapshot(
        'stranger',
        { bypass: false, private: true },
        snap('private', null, []),
      ),
    ).toBe(false)
    expect(
      isVisibleToAudienceSnapshot(
        'owner',
        { bypass: false, private: false },
        snap('private', 'owner', ['owner']),
      ),
    ).toBe(false)
  })

  test('迁移结构锁：registry 两处受众判定与 mcpRuntimeTestTransitions 均已委托；status 检查留调用方', () => {
    const registry = SRC('ws/registry.ts')
    expect(registry.split('isVisibleToAudienceSnapshot(').length - 1).toBeGreaterThanOrEqual(2)
    const trans = SRC('services/mcpRuntimeTestTransitions.ts')
    expect(trans).toContain("accountPermissions.has('resource-acl:bypass')")
    expect(trans).toContain("account?.status === 'active' &&")
  })
})

describe('rfc284 批C T11 — skill 唯一性三态 + 错误识别收编', () => {
  test('占用/他人同名不占用/NULL-owner 域隔离', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await db.insert(skills).values([
      {
        id: ulid(),
        name: 'dup',
        ownerUserId: 'u1',
        contentVersion: 1,
        createdAt: 0,
        updatedAt: 0,
      } as typeof skills.$inferInsert,
      {
        id: ulid(),
        name: 'sysdup',
        ownerUserId: null,
        contentVersion: 1,
        createdAt: 0,
        updatedAt: 0,
      } as typeof skills.$inferInsert,
    ])
    expect(await isSkillNameOccupiedForOwner(db, 'dup', 'u1')).toBe(true) // 占用
    expect(await isSkillNameOccupiedForOwner(db, 'dup', 'u2')).toBe(false) // 他人域自由
    expect(await isSkillNameOccupiedForOwner(db, 'dup', null)).toBe(false) // NULL 域自由
    expect(await isSkillNameOccupiedForOwner(db, 'sysdup', null)).toBe(true) // NULL 域占用
    expect(await isSkillNameOccupiedForOwner(db, 'free', 'u1')).toBe(false)
  })

  test('isOwnerNameUniqueViolation 识别新（表达式索引）旧（单列）两代文案、拒无关错误', () => {
    expect(
      isOwnerNameUniqueViolation(
        new Error('UNIQUE constraint failed: index skills_owner_name_unique'),
        'skills',
        'skills_owner_name_unique',
      ),
    ).toBe(true)
    expect(
      isOwnerNameUniqueViolation(
        new Error('UNIQUE constraint failed: skills.name'),
        'skills',
        'skills_owner_name_unique',
      ),
    ).toBe(true)
    expect(
      isOwnerNameUniqueViolation(
        new Error('FOREIGN KEY constraint failed'),
        'skills',
        'skills_owner_name_unique',
      ),
    ).toBe(false)
    // skill.ts 两处 catch 均已收编（结构锁）
    const src = SRC('modules/resource-catalog/infrastructure/legacy/skill.ts')
    expect(src).not.toContain('skills_owner_name_unique|UNIQUE constraint failed')
    expect(
      src.split("isOwnerNameUniqueViolation(err, 'skills', 'skills_owner_name_unique')").length - 1,
    ).toBe(2)
  })
})
