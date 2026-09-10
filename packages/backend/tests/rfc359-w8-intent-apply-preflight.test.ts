// RFC-359 W8 —— Intent apply 归属预检的双引擎对拍（一份实现，两个 provider）。
//
// # 这条测试为什么存在
//
// `resolveIntentApplyResourcePreflight` 与它的三个 interface 此前在两个聚合适配器里各有一份
// **逐字相同**的副本，差别只有类型名上的 provider 前缀——是纯**命名分叉**：函数体只经
// `ResourceCatalogAclIdentityReadPort` 这个闭合端口取数，一行方言都没有。W8 把它们收成
// `modules/resource-catalog/infrastructure/aggregateAdapters/intentApplyResourcePreflight.ts`
// 的一份。
//
// 既有覆盖（`rfc271-intent-skill-plugin-update.test.ts` 的 T14/T15）把这条判据钉得很细，但**只在
// SQLite 上**：它用 `createInMemoryDb` + bun:sqlite 的同步 `.run()` 插数据。合一之后「两个 provider
// 共用」这句话本身需要一条证据——同一份实现分别喂两个引擎的 ACL 身份端口，决定必须逐字相同。
//
// 所以这里不重复 T14/T15 的语义细分，只锁**跨引擎一致性**这一件事：占用名集合（大小写归一）
// 与 copy-only 目标（含拒绝理由）在两个引擎上给出同一个答案。
import { expect, test } from 'bun:test'
import { ulid } from 'ulid'

import type { ProviderNeutralDatabase } from '../src/db/query'
import { agents, plugins, skills } from '../src/db/schema'
import { createResourceCatalogAclIdentityReadPort } from '../src/modules/resource-catalog/infrastructure/aclReadRepository'
import { resolveIntentApplyResourcePreflight } from '../src/modules/resource-catalog/infrastructure/aggregateAdapters/intentApplyResourcePreflight'
import { describeEachProvider } from './helpers/eachProvider'

const NOW = 1_788_278_400_000
const MINE = 'u-mine'
const THEIRS = 'u-theirs'

async function seedAgent(db: ProviderNeutralDatabase, name: string, owner: string) {
  const id = ulid()
  await db.insert(agents).values({
    id,
    name,
    description: '',
    body: '',
    ownerUserId: owner,
    visibility: 'private',
    createdAt: NOW,
    updatedAt: NOW,
  } as never)
  return id
}

async function seedSkill(db: ProviderNeutralDatabase, name: string, owner: string) {
  const id = ulid()
  await db.insert(skills).values({
    id,
    name,
    description: '',
    sourceKind: 'managed',
    ownerUserId: owner,
    visibility: 'private',
    createdAt: NOW,
    updatedAt: NOW,
  } as never)
  return id
}

async function seedPlugin(db: ProviderNeutralDatabase, name: string, owner: string) {
  const id = ulid()
  await db.insert(plugins).values({
    id,
    name,
    description: '',
    spec: 'left-pad@1.0.0',
    optionsJson: '{}',
    enabled: true,
    sourceKind: 'npm',
    cachedPath: '/tmp/never-read',
    resolvedVersion: '1.0.0',
    ownerUserId: owner,
    visibility: 'private',
    installedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  } as never)
  return id
}

describeEachProvider('RFC-359 W8 —— Intent apply 归属预检（一份实现，两个引擎）', (harness) => {
  test('占用名集合与 copy-only 目标在本引擎上逐字符合预期', async () => {
    const db = harness.db
    // 大小写混写：判据要求归一成小写，两个引擎都不许例外。
    await seedAgent(db, 'Alpha-Agent', MINE)
    await seedSkill(db, 'Beta-Skill', MINE)
    const myPlugin = await seedPlugin(db, 'gamma-plugin', MINE)
    const theirSkill = await seedSkill(db, 'their-skill', THEIRS)

    const preflight = await resolveIntentApplyResourcePreflight(
      createResourceCatalogAclIdentityReadPort(db),
      MINE,
      [
        { handle: 'res#plugin#1', resourceType: 'plugin', resourceId: myPlugin },
        { handle: 'res#skill#1', resourceType: 'skill', resourceId: theirSkill },
        { handle: 'res#skill#2', resourceType: 'skill', resourceId: ulid() },
      ],
      {
        ops: [
          { action: 'update', resourceType: 'plugin', target: 'res#plugin#1' },
          { action: 'update', resourceType: 'skill', target: 'res#skill#1' },
          // 不存在的资源：`getOwner` 给 undefined，不该被判成 copy-only。
          { action: 'update', resourceType: 'skill', target: 'res#skill#2' },
          // 非 update 的 op 与无 target 的 op 都不进判据。
          { action: 'create', resourceType: 'skill', target: 'res#skill#1' },
          { action: 'update', resourceType: 'skill' },
        ],
      },
    )

    expect([...(preflight.occupiedNames.get('agent') ?? [])]).toEqual(['alpha-agent'])
    expect([...(preflight.occupiedNames.get('skill') ?? [])].sort()).toEqual(['beta-skill'])
    expect([...(preflight.occupiedNames.get('plugin') ?? [])]).toEqual(['gamma-plugin'])
    // 别人的技能占用名不进我的集合。
    expect(preflight.occupiedNames.get('skill')?.has('their-skill')).toBe(false)

    expect([...preflight.copyOnlyTargets.entries()]).toEqual([
      ['res#skill#1', 'owned by another user or built-in'],
    ])
  })

  test('六类资源都被问过一遍占用名——空库上也返回六个空集合，不是缺键', async () => {
    const preflight = await resolveIntentApplyResourcePreflight(
      createResourceCatalogAclIdentityReadPort(harness.db),
      MINE,
      [],
      { ops: [] },
    )
    expect([...preflight.occupiedNames.keys()].sort()).toEqual([
      'agent',
      'mcp',
      'plugin',
      'skill',
      'workflow',
      'workgroup',
    ])
    expect([...preflight.occupiedNames.values()].every((set) => set.size === 0)).toBe(true)
    expect(preflight.copyOnlyTargets.size).toBe(0)
  })

  test('返回值是冻结的：两个引擎上调用方都改不动这份预检结论', async () => {
    const preflight = await resolveIntentApplyResourcePreflight(
      createResourceCatalogAclIdentityReadPort(harness.db),
      MINE,
      [],
      { ops: [] },
    )
    expect(Object.isFrozen(preflight)).toBe(true)
  })
})
