// RFC-324 T-EQ —— 迁移零行为变化，是穷举出来的，不是声明出来的。
//
// 本 RFC 把两个各自独立的谓词（`isVisibleRow` / `isResourceOwner`）换成一条四值
// 梯子（`resolveResourceAccess` → own > write > read > none）。这类替换最危险的
// 失败形态不是"新功能不работает"，而是**旧分支在重排中悄悄改了含义**——比如把
// 「public 行的 owner 即使没有 account-range 私有点也算 owner」这条分支丢掉，
// 于是 guest 预设的 owner 突然管不了自己的公共资源，而所有新写的测试都照绿。
//
// 所以这里把 RFC-324 之前的两个谓词**逐字誊写**成 oracle（下面的 legacy*），
// 对 (bypass × 私有点 × 可见性 × 属主关系 × 授权) 的全组合逐条比对。迁移把存量
// 授权行全部落在 `read` 档，所以「零行为变化」的准确表述是：**当每条授权都是
// `read` 时，新梯子必须逐位复现旧谓词**。`write` 档是本 RFC 新增的语义，它只被
// 允许改变一件事——`canEditAccess`，可见性与治理判定必须原样不动，这也在下面锁住。

import { describe, expect, test } from 'bun:test'
import { buildActor, type Actor } from '../src/auth/actor'
import type { Permission, ResourceGrantLevel, ResourceVisibility } from '@agent-workflow/shared'
import {
  canEditAccess,
  canGovernAccess,
  canViewAccess,
  hasPrivateResourceAccess,
  hasResourceAclBypass,
  resolveResourceAccess,
  type AclRow,
} from '../src/modules/resource-catalog/domain/resourceAccess'

// ── oracle：RFC-324 之前的两个谓词，逐字誊自 services/resourceAcl.ts ──────────

/** 旧 `isVisibleRow`（bypass → public → 私有点 → owner → granted）。 */
function legacyIsVisible(actor: Actor, row: AclRow, granted: boolean): boolean {
  if (hasResourceAclBypass(actor)) return true
  if ((row.visibility ?? 'public') === 'public') return true
  if (!hasPrivateResourceAccess(actor)) return false
  if (row.ownerUserId != null && row.ownerUserId === actor.user.id) return true
  return granted
}

/** 旧 `isResourceOwner`（bypass → 私有行且无私有点则 false → owner 比对）。 */
function legacyIsResourceOwner(actor: Actor, row: AclRow): boolean {
  if (hasResourceAclBypass(actor)) return true
  if ((row.visibility ?? 'public') === 'private' && !hasPrivateResourceAccess(actor)) return false
  return row.ownerUserId != null && row.ownerUserId === actor.user.id
}

// ── 组合枚举 ────────────────────────────────────────────────────────────────

const SELF = 'user-self'
const OTHER = 'user-other'

/**
 * guest 预设既没有 `resource-acl:private` 也没有 `resource-acl:bypass`，是干净的
 * 零点基底；两个点各自用 additionalPermissions 显式加回，于是四种组合都能构造
 * ——包括「有 bypass 却没有私有点」这种任何角色预设都给不出、但判据必须答对的组合。
 */
function actorWith(bypass: boolean, privatePoint: boolean): Actor {
  const additional: Permission[] = []
  if (bypass) additional.push('resource-acl:bypass')
  if (privatePoint) additional.push('resource-acl:private')
  return buildActor({
    user: { id: SELF, username: 'self', displayName: 'Self', role: 'guest', status: 'active' },
    source: 'session',
    additionalPermissions: additional,
  })
}

const VISIBILITIES: ReadonlyArray<ResourceVisibility | undefined> = ['public', 'private', undefined]
const OWNERS: ReadonlyArray<{ label: string; ownerUserId: string | null }> = [
  { label: 'self', ownerUserId: SELF },
  { label: 'other', ownerUserId: OTHER },
  { label: 'none', ownerUserId: null },
]

interface Combo {
  readonly label: string
  readonly actor: Actor
  readonly row: AclRow
  readonly granted: boolean
}

function combos(): Combo[] {
  const out: Combo[] = []
  for (const bypass of [false, true]) {
    for (const privatePoint of [false, true]) {
      for (const visibility of VISIBILITIES) {
        for (const owner of OWNERS) {
          for (const granted of [false, true]) {
            out.push({
              label: `bypass=${bypass} private=${privatePoint} vis=${visibility ?? 'absent'} owner=${owner.label} grant=${granted ? 'read' : 'none'}`,
              actor: actorWith(bypass, privatePoint),
              row: {
                id: 'row-1',
                ownerUserId: owner.ownerUserId,
                ...(visibility ? { visibility } : {}),
              },
              granted,
            })
          }
        }
      }
    }
  }
  return out
}

const ALL = combos()

describe('RFC-324 —— 四值梯子对旧谓词的逐分支等价（授权全为 read 时）', () => {
  test('语料自证：组合表覆盖 2×2×3×3×2 = 72 种，且确实同时含真/假两侧', () => {
    expect(ALL.length).toBe(72)
    // 一个恒真 / 恒假的 oracle 会让下面两条断言变成空转。
    expect(ALL.some((c) => legacyIsVisible(c.actor, c.row, c.granted))).toBe(true)
    expect(ALL.some((c) => !legacyIsVisible(c.actor, c.row, c.granted))).toBe(true)
    expect(ALL.some((c) => legacyIsResourceOwner(c.actor, c.row))).toBe(true)
    expect(ALL.some((c) => !legacyIsResourceOwner(c.actor, c.row))).toBe(true)
  })

  test('可见性：canViewAccess 与旧 isVisibleRow 逐条相同', () => {
    const drift = ALL.filter((c) => {
      const access = resolveResourceAccess(c.actor, c.row, c.granted ? 'read' : null)
      return canViewAccess(access) !== legacyIsVisible(c.actor, c.row, c.granted)
    }).map((c) => c.label)
    expect(drift, '这些组合下新梯子与迁移前的可见性判定不一致').toEqual([])
  })

  test('治理权：canGovernAccess 与旧 isResourceOwner 逐条相同', () => {
    const drift = ALL.filter((c) => {
      const access = resolveResourceAccess(c.actor, c.row, c.granted ? 'read' : null)
      return canGovernAccess(access) !== legacyIsResourceOwner(c.actor, c.row)
    }).map((c) => c.label)
    expect(drift, '这些组合下新梯子与迁移前的 owner 判定不一致').toEqual([])
  })

  test('read 档不给写权：迁移后的存量行谁都改不动（除 owner / bypass）', () => {
    const wrong = ALL.filter((c) => {
      const access = resolveResourceAccess(c.actor, c.row, c.granted ? 'read' : null)
      // 能改 ⇔ 旧判据认定他是 owner（含 bypass）。read 授权不添一分。
      return canEditAccess(access) !== legacyIsResourceOwner(c.actor, c.row)
    }).map((c) => c.label)
    expect(wrong, 'read 档不得带来任何写权——这是"迁移零行为变化"的另一半').toEqual([])
  })
})

describe('RFC-324 —— write 档只多给一件事', () => {
  const GRANTS: ReadonlyArray<ResourceGrantLevel | null> = [null, 'read', 'write']

  test('可见性与治理判定不随档位变化', () => {
    for (const c of ALL) {
      const byGrant = GRANTS.map((g) => resolveResourceAccess(c.actor, c.row, g))
      const views = new Set(byGrant.map(canViewAccess))
      const governs = new Set(byGrant.map(canGovernAccess))
      // 未授权的私有行：null 不可见而 read/write 可见——这是"有没有授权"的差别，
      // 不是"档位"的差别，所以只比对 read 与 write 两档。
      const grantedOnly = [byGrant[1]!, byGrant[2]!]
      expect(new Set(grantedOnly.map(canViewAccess)).size, `可见性随档位漂移：${c.label}`).toBe(1)
      expect(new Set(grantedOnly.map(canGovernAccess)).size, `治理权随档位漂移：${c.label}`).toBe(1)
      expect(views.size).toBeLessThanOrEqual(2)
      expect(governs.size).toBe(1)
    }
  })

  test('write 档给出写权——且仅当这条授权对该账户可见（需要账号级私有点）', () => {
    for (const c of ALL) {
      const access = resolveResourceAccess(c.actor, c.row, 'write')
      const expected = legacyIsResourceOwner(c.actor, c.row) || hasPrivateResourceAccess(c.actor)
      expect(canEditAccess(access), `write 档判定不符：${c.label}`).toBe(expected)
    }
  })

  test('梯子只产出四个值，且 own 蕴含 write 蕴含 read', () => {
    for (const c of ALL) {
      for (const g of GRANTS) {
        const access = resolveResourceAccess(c.actor, c.row, g)
        expect(['none', 'read', 'write', 'own']).toContain(access)
        if (canGovernAccess(access)) expect(canEditAccess(access)).toBe(true)
        if (canEditAccess(access)) expect(canViewAccess(access)).toBe(true)
      }
    }
  })
})
