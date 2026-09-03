// RFC-353 T8（RFC-294 W4-E3）—— fusion 路由迁入 KE inbound 并收成 decode-call-map 后的回归锁。
//
// 这条测试存在的理由（重构时别删）：
//   ① 「谁看得见哪条融合」此前在 `routes/fusions.ts` 的三个 handler 里各手写一遍——
//      列表过滤一遍、待办计数一遍、详情 404 一遍。三份手抄的老问题是只要有人给其中一处
//      加了条件（例如「协作者也算」），另两处就悄悄不一致；而「列表里看得见、点进去 404」
//      恰恰是最难被用户报清楚、也最难被测试发现的那种不一致。
//   ② RFC-294 对 inbound 层的要求是只做解码、调用与映射。§「路由只 decode-call-map」
//      那几条源码断言锁的就是这件事：路由里不许再出现可见性判断。

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  canViewFusion,
  visibleFusions,
} from '@/modules/knowledge-evolution/domain/fusionVisibility'

const OWNER = { userId: 'usr_owner', aclBypass: false }
const STRANGER = { userId: 'usr_other', aclBypass: false }
const ADMIN = { userId: 'usr_admin', aclBypass: true }

describe('RFC-353 T8 融合可见性：一条判据，三处共用', () => {
  test('归属者看得见自己的', () => {
    expect(canViewFusion(OWNER, 'usr_owner')).toBe(true)
  })

  test('别人看不见——融合是私有的，没有 public 一档', () => {
    expect(canViewFusion(STRANGER, 'usr_owner')).toBe(false)
  })

  test('持 bypass 的操作者看得见全部', () => {
    expect(canViewFusion(ADMIN, 'usr_owner')).toBe(true)
    expect(canViewFusion(ADMIN, 'usr_other')).toBe(true)
  })

  test('列表过滤就是逐行套同一个判据（顺序不变、不去重、不改行）', () => {
    const rows = [
      { id: 'a', ownerUserId: 'usr_owner' },
      { id: 'b', ownerUserId: 'usr_other' },
      { id: 'c', ownerUserId: 'usr_owner' },
    ]
    expect(visibleFusions(OWNER, rows).map((r) => r.id)).toEqual(['a', 'c'])
    expect(visibleFusions(STRANGER, rows).map((r) => r.id)).toEqual(['b'])
    expect(visibleFusions(ADMIN, rows)).toEqual(rows)
    // 返回的是原对象，不是拷贝——上层还要读 diff 等字段。
    expect(visibleFusions(OWNER, rows)[0]).toBe(rows[0])
  })

  test('空集合与全不可见都返回空数组，不返回 undefined', () => {
    expect(visibleFusions(OWNER, [])).toEqual([])
    expect(visibleFusions(STRANGER, [{ ownerUserId: 'usr_owner' }])).toEqual([])
  })
})

describe('RFC-353 T8 路由只 decode-call-map', () => {
  const route = readFileSync(
    join(
      import.meta.dir,
      '..',
      'src',
      'modules',
      'knowledge-evolution',
      'inbound',
      'fusionRoutes.ts',
    ),
    'utf-8',
  )

  test('路由住在 knowledge-evolution 的 inbound 层，不再在 routes/ 平铺层', () => {
    expect(route).toContain('export function mountFusionRoutes(')
    // 旧位置必须真的没了（留 facade 就等于两处都能改，迁位形同虚设）。
    expect(() =>
      readFileSync(join(import.meta.dir, '..', 'src', 'routes', 'fusions.ts'), 'utf-8'),
    ).toThrow()
  })

  test('路由里不再有可见性判断——只解出 viewer 交给 application', () => {
    expect(route).toContain('function viewerOf(')
    expect(route).toContain('hasResourceAclBypass(actor)')
    // 判断本身（三处手抄）必须已经不在路由里。
    expect(route).not.toContain('ownerUserId === actor.user.id')
    expect(route).not.toContain('o.ownerUserId === actor.user.id')
    expect(route).not.toContain('f.ownerUserId === actor.user.id')
    expect(route).not.toMatch(/hasResourceAclBypass\(actor\)\s*\n?\s*\?/)
  })

  test('三个读路径都调 application 的带可见性版本', () => {
    expect(route).toContain('listVisibleFusionSummaries(')
    expect(route).toContain('countVisibleAwaitingApprovalFusions(')
    expect(route).toContain('getVisibleFusion(')
    // 不带可见性的裸查询不该再被路由直接调用。
    expect(route).not.toContain('await listFusionSummaries(')
    expect(route).not.toContain('await awaitingApprovalFusionOwners(')
    expect(route).not.toContain('await getFusion(')
  })

  test('详情仍以「不可见与不存在同形」收场（RFC-099 存在性隔离）', () => {
    expect(route).toContain("throw new NotFoundError('fusion-not-found'")
  })
})
