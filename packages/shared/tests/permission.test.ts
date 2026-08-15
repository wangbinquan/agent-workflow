// RFC-036 — permission catalog snapshot + role mapping invariants. These
// guard against the most common multi-user regression: silently adding a
// write permission to the `user` role (privilege escalation) or removing a
// read permission (UI breakage). Both directions are pinned.
//
// RFC-247 reshaped the catalog: `资源:write` → `:create` / `:update` / `:delete`
// (+ `:execute` where a route exists), and added the token-grant resolver. The
// role REACH is unchanged (D15 "等价照搬"); only the point shapes moved. The
// snapshots below are therefore the post-RFC-247 equivalents of the pre-RFC-247
// ones — if one of them reds, ask "did a role's reach change?", not "did a name
// change?".

import { describe, expect, test } from 'bun:test'
import {
  DELETE_POINTS,
  grantableMatrixPoints,
  MANAGER_PRESET_MISSING_PERMISSIONS,
  MATRIX_DOMAIN_POINTS,
  PERMISSIONS,
  presetHasPermission,
  RANGE_POINTS,
  READ_POINTS,
  resolveEffectiveAccountPermissions,
  resolveTokenPermissions,
  ROLE_PERMISSIONS,
  RoleSchema,
  ROUTE_BACKED_POINTS,
  SYSTEM_DOMAIN_POINTS,
  type Permission,
  USER_PRESET_MISSING_PERMISSIONS,
} from '../src/schemas/permission'

const accountPermissions = (role: 'admin' | 'manager' | 'user' | 'guest') =>
  resolveEffectiveAccountPermissions({ role, additionalPermissions: [] })

describe('PERMISSIONS catalog', () => {
  test('contains the documented 73 entries', () => {
    // RFC-222 added tasks:delete (33 → 34); RFC-234 added intent:read/write (→ 36).
    // RFC-247 split the five `:write` points into create/update/delete, gave the
    // previously-ungated domains (workgroups / scheduled-tasks) real points,
    // folded the five RFC-041 memory points into four verbs, retired
    // `tasks:launch` → `tasks:execute`, and DELETED the two dead cancel range
    // points, and did NOT mint agents:execute / workgroups:execute because
    // RFC-165 F15/N1 gates every launch endpoint uniformly on tasks:execute
    // (36 → 58).
    // RFC-248 加 `repos:update`（`PUT /api/repo-groups/:id` —— repos 域第一条
    // PUT/PATCH 路由）⇒ 59。
    // RFC-253 加 `scripts:author`（脚本节点正文 = 宿主代码执行；系统域点，
    // 永不进令牌，角色基线 admin + manager）⇒ 60。
    // RFC-257 加 webhook-triggers 四动词（owner 制行，路由粗门 + 服务行级判定，
    // 对齐 scheduled-tasks）与 `webhook-endpoints:manage`（入站验签 secret 面；
    // 系统域点，永不进令牌，默认只在 admin 预设）⇒ 65。
    // RFC-260 加 `webhook-endpoints:read`（端点/投递元数据只读，全员；URL 明文
    // 由响应分层保护——PAT 恒拿掩码）⇒ 66。
    // RFC-269 加 `code-host-calls:author`（代码平台调用节点 = 以管理员配置的
    // token 对 GitLab/GitHub 做写操作；与 scripts:author 同档的能力点：系统域、
    // 永不进令牌、角色基线 admin + manager）⇒ 67。
    // RFC-305 将五个存量角色旁路实体化为权限点 ⇒ 72；游客公共只读边界
    // 将私有 owner/grant 可见性实体化为 account-range 点 ⇒ 73。
    expect(PERMISSIONS.length).toBe(73)
  })

  test('admin role is the full PERMISSIONS set', () => {
    const adminSet = new Set<Permission>(ROLE_PERMISSIONS.admin)
    for (const p of PERMISSIONS) {
      expect(adminSet.has(p)).toBe(true)
    }
    expect(ROLE_PERMISSIONS.admin.length).toBe(PERMISSIONS.length)
  })

  test('user role contains exactly the documented baseline (49 entries)', () => {
    const expected: Permission[] = [
      // reads
      'agents:read',
      'skills:read',
      'mcps:read',
      'plugins:read',
      'workflows:read',
      'workgroups:read',
      'scheduled-tasks:read',
      'repos:read',
      'memory:read',
      'tasks:read',
      'runtime:read',
      // Private owner/grant visibility is explicit; guest omits this range.
      'resource-acl:private',
      // RFC-099 — resource writes are route-gate-open for all users; the
      // per-row owner/grant check lives in services/resourceAcl.ts.
      // RFC-247 — each former `:write` is now three points.
      'agents:create',
      'agents:update',
      'agents:delete',
      'skills:create',
      'skills:update',
      'skills:delete',
      'mcps:create',
      'mcps:update',
      'mcps:delete',
      'plugins:create',
      'plugins:update',
      'plugins:delete',
      'workflows:create',
      'workflows:update',
      'workflows:delete',
      // RFC-247 — workgroups had NO permission point at all before, i.e. every
      // logged-in user could use them. Same reach, now expressible.
      'workgroups:create',
      'workgroups:update',
      'workgroups:delete',
      // RFC-247 — schedule create/edit sat behind `tasks:launch` (RFC-165 N1-r3);
      // PUT/DELETE were ungated entirely.
      'scheduled-tasks:create',
      'scheduled-tasks:update',
      'scheduled-tasks:delete',
      // execute — formerly reached via `tasks:launch` or the resource's `:write`
      'mcps:execute',
      'plugins:execute',
      'workflows:execute',
      'scheduled-tasks:execute',
      'tasks:execute',
      'users:search',
      'tasks:read:own',
      'tasks:update',
      'account:self',
      // RFC-041 / RFC-099 (D12) — route gate open; per-row canManageMemory is
      // the real gate. RFC-247 folded the five old points into four verbs.
      'memory:create',
      'memory:update',
      'memory:delete',
      // RFC-234 — intent builder is open to every logged-in user (D22)
      'intent:read',
      'intent:write',
      // RFC-260/RFC-305 — webhook 读面全员开放；端点管理和 URL 明文由
      // `webhook-endpoints:manage` + session 响应分层控制。
      'webhook-triggers:read',
      'webhook-endpoints:read',
    ]
    expect([...ROLE_PERMISSIONS.user].sort()).toEqual(expected.sort())
    expect(ROLE_PERMISSIONS.user.length).toBe(49)
  })

  test('guest preset is exactly public-only reads for the six ACL resource domains', () => {
    expect(ROLE_PERMISSIONS.guest).toEqual([
      'agents:read',
      'skills:read',
      'mcps:read',
      'plugins:read',
      'workflows:read',
      'workgroups:read',
      'account:self',
    ])
    for (const permission of [
      'resource-acl:private',
      'agents:create',
      'agents:update',
      'tasks:read',
      'tasks:execute',
      'repos:read',
      'memory:read',
      'runtime:read',
    ] as const) {
      expect(presetHasPermission('guest', permission)).toBe(false)
    }
  })

  test('user preset excludes exactly its 24 individually grantable differences', () => {
    const userPresetMissing: Permission[] = [
      // RFC-099/RFC-305: repos stay OUT of the ownership ACL model — the repos
      // write verbs are absent from the user preset but individually grantable.
      'repos:create',
      // RFC-248: 仓库组的 PUT 引入了 repos 域的第一个 update 点，它与其余
      // repos 写动词同档——manager/admin 预设有、user 预设没有，但可逐项授予。
      'repos:update',
      'repos:delete',
      'repos:execute',
      'users:read',
      'users:write',
      'settings:read',
      'settings:write',
      'oidc:read',
      'oidc:configure',
      'backup:run',
      'tasks:read:all',
      // RFC-222 — task deletion is absent from manager/user default presets.
      'tasks:delete',
      // RFC-253 — 脚本正文编写默认也在 manager 预设，但不在 user 预设。
      'scripts:author',
      // RFC-269 — 代码平台调用节点的编写。与 scripts:author 完全同档：manager
      // 预设也有，user 预设没有（该节点携带的是平台配置的 token 对
      // GitLab/GitHub 的写权限，平台侧 ACL 约束不了它能碰到的仓库）。
      'code-host-calls:author',
      // RFC-257（UI 修订收紧）→ RFC-260（读面重新放开）：写动词与端点 manage
      // 默认只在 admin 预设；两个 read 点（webhook-triggers:read /
      // webhook-endpoints:read）自 RFC-260 起进 user 基线，已从本负向清单移除。
      'webhook-endpoints:manage',
      'webhook-triggers:create',
      'webhook-triggers:update',
      'webhook-triggers:delete',
      // RFC-305：原先位于角色判断中的五个能力现在全部是显式权限点。
      'resource-acl:bypass',
      'memory-distill-jobs:manage',
      'intent:audit',
      'mcp-runtime-tests:audit',
      'webhook-triggers:override-owner',
    ]
    for (const p of userPresetMissing) {
      expect(ROLE_PERMISSIONS.user.includes(p)).toBe(false)
    }
    // This is a preset difference, not a protected role class: RFC-305 makes
    // every member individually grantable to a user account.
    expect([...USER_PRESET_MISSING_PERMISSIONS].sort()).toEqual(userPresetMissing.sort())
  })

  test('presetHasPermission truth matrix', () => {
    expect(presetHasPermission('admin', 'agents:update')).toBe(true)
    expect(presetHasPermission('admin', 'oidc:configure')).toBe(true)
    expect(presetHasPermission('admin', 'users:read')).toBe(true)
    expect(presetHasPermission('user', 'agents:read')).toBe(true)
    // RFC-099: route-gate write open to users (row-level ACL is the real gate)
    expect(presetHasPermission('user', 'agents:create')).toBe(true)
    expect(presetHasPermission('user', 'agents:update')).toBe(true)
    expect(presetHasPermission('user', 'agents:delete')).toBe(true)
    expect(presetHasPermission('user', 'repos:create')).toBe(false)
    expect(presetHasPermission('user', 'settings:read')).toBe(false)
    expect(presetHasPermission('user', 'users:read')).toBe(false)
    expect(presetHasPermission('user', 'users:search')).toBe(true)
    expect(presetHasPermission('user', 'tasks:read:all')).toBe(false)
    expect(presetHasPermission('user', 'tasks:read:own')).toBe(true)
  })
})

// RFC-247 — the retired point names. Reintroducing any of them means someone
// re-split a verb the routes do not distinguish, or resurrected a dead point.
describe('RFC-247 retired names stay retired', () => {
  const RETIRED = [
    'agents:write',
    'skills:write',
    'mcps:write',
    'plugins:write',
    'workflows:write',
    'repos:write',
    'tasks:launch',
    'tasks:cancel:own',
    'tasks:cancel:all',
    'memory:approve',
    'memory:archive',
    'memory:edit',
    'memory:write_feedback',
  ]

  test('no MATRIX-domain `:write` point survives — the split is complete', () => {
    // System-domain points keep their own vocabulary (`users:write`,
    // `settings:write`, `intent:write`); RFC-247 only reshaped the matrix domain.
    expect(MATRIX_DOMAIN_POINTS.filter((p) => p.endsWith(':write'))).toEqual([])
    // …and the surviving `:write` names are exactly the three system-domain ones.
    expect(PERMISSIONS.filter((p) => p.endsWith(':write')).sort()).toEqual([
      'intent:write',
      'settings:write',
      'users:write',
    ])
  })

  test('every retired name is absent', () => {
    for (const name of RETIRED) {
      expect((PERMISSIONS as readonly string[]).includes(name)).toBe(false)
    }
  })

  test('no `schedules:` variant — the resource key is `scheduled-tasks` (AC-47)', () => {
    expect(PERMISSIONS.filter((p) => p.startsWith('schedules:'))).toEqual([])
    expect(PERMISSIONS.filter((p) => p.startsWith('scheduled-tasks:')).length).toBe(5)
  })

  test('no point exists that no route could reference', () => {
    // Points a mechanical "every resource gets every verb" pass would have
    // minted, each of which would then sit on the account page's token matrix
    // advertising a capability that maps to no endpoint:
    //   skills:execute     — skills.ts has no execute-semantics route
    //   agents:execute     — RFC-165 F15/N1 gates agent launch on tasks:execute
    //   workgroups:execute — …and workgroup launch likewise
    //
    // `repos:update` USED to be on this list and no longer is: RFC-248 added
    // `PUT /api/repo-groups/:id`, the repos domain's first PUT/PATCH route.
    // The invariant this test protects is "no point without a route" — it is
    // satisfied by the point now HAVING one, not by keeping it out.
    for (const dead of ['skills:execute', 'agents:execute', 'workgroups:execute']) {
      expect((PERMISSIONS as readonly string[]).includes(dead)).toBe(false)
    }
  })
})

// RFC-247 — point classification. A bug in any of these silently changes what
// every token in the system can do, so each derivation is pinned.
describe('RFC-247 point classification', () => {
  test('READ_POINTS never overlaps SYSTEM_DOMAIN_POINTS', () => {
    // Regression lock: an earlier draft hand-listed the system `:read` points to
    // exclude and missed `intent:read`, which then rode into "reads a token
    // always gets" — i.e. every token silently gained a system-domain read.
    const leak = READ_POINTS.filter((p) => SYSTEM_DOMAIN_POINTS.includes(p))
    expect(leak).toEqual([])
  })

  test('DELETE_POINTS is exactly the `:delete` suffix set', () => {
    expect([...DELETE_POINTS].sort()).toEqual(
      PERMISSIONS.filter((p) => p.endsWith(':delete')).sort(),
    )
    expect(DELETE_POINTS.length).toBe(11)
  })

  test('MATRIX_DOMAIN_POINTS = PERMISSIONS − SYSTEM_DOMAIN_POINTS', () => {
    expect(MATRIX_DOMAIN_POINTS.length).toBe(PERMISSIONS.length - SYSTEM_DOMAIN_POINTS.length)
    for (const p of MATRIX_DOMAIN_POINTS) expect(SYSTEM_DOMAIN_POINTS.includes(p)).toBe(false)
  })

  test('ROUTE_BACKED_POINTS excludes range points (they are handler-consumed)', () => {
    for (const p of RANGE_POINTS) expect(ROUTE_BACKED_POINTS.includes(p)).toBe(false)
    expect(ROUTE_BACKED_POINTS.length).toBe(MATRIX_DOMAIN_POINTS.length - RANGE_POINTS.length)
  })
})

// RFC-247 — the token grant formula. This is THE security-critical function:
// every API token in the system gets its capabilities from it.
describe('RFC-247 resolveTokenPermissions', () => {
  test('an empty matrix yields a READ-ONLY token, not the full role baseline', () => {
    // Pre-RFC-247 this was the docs/audit-backlog.md:61 hole: buildActor only
    // narrowed when `patScopes.length > 0`, so a scope-less PAT silently held
    // everything its owner's role held.
    for (const role of ['guest', 'user', 'manager', 'admin'] as const) {
      const granted = [
        ...resolveTokenPermissions({ accountPermissions: accountPermissions(role), matrix: [] }),
      ]
      expect(granted.length).toBeGreaterThan(0)
      for (const p of granted) expect(READ_POINTS.includes(p)).toBe(true)
    }
  })

  test('a token never exceeds its owner role', () => {
    const granted = resolveTokenPermissions({
      accountPermissions: accountPermissions('user'),
      matrix: ['repos:create', 'agents:create', 'settings:write'],
    })
    expect(granted.has('agents:create')).toBe(true)
    expect(granted.has('repos:create')).toBe(false) // not in the user baseline
    expect(granted.has('settings:write')).toBe(false) // system domain
  })

  test('system-domain points are stripped even for an admin owner', () => {
    const granted = resolveTokenPermissions({
      accountPermissions: accountPermissions('admin'),
      matrix: [...SYSTEM_DOMAIN_POINTS],
    })
    for (const p of SYSTEM_DOMAIN_POINTS) expect(granted.has(p)).toBe(false)
  })

  test('delete is opt-in per point, even for admin', () => {
    const withoutDelete = resolveTokenPermissions({
      accountPermissions: accountPermissions('admin'),
      matrix: ['agents:update'],
    })
    expect(withoutDelete.has('agents:update')).toBe(true)
    expect(withoutDelete.has('agents:delete')).toBe(false)

    const withDelete = resolveTokenPermissions({
      accountPermissions: accountPermissions('admin'),
      matrix: ['agents:update', 'agents:delete'],
    })
    expect(withDelete.has('agents:delete')).toBe(true)
    // ticking one delete point must not grant any other
    expect(withDelete.has('workflows:delete')).toBe(false)
    expect(withDelete.has('tasks:delete')).toBe(false)
  })

  test('no matrix can grant a token a delete point its role lacks', () => {
    const granted = resolveTokenPermissions({
      accountPermissions: accountPermissions('user'),
      matrix: ['tasks:delete'],
    })
    expect(granted.has('tasks:delete')).toBe(false)
  })
})

describe('RFC-247 grantableMatrixPoints', () => {
  test('never offers read points (reads are always on, not tickable)', () => {
    for (const role of ['guest', 'user', 'manager', 'admin'] as const) {
      for (const p of grantableMatrixPoints(accountPermissions(role))) {
        expect(READ_POINTS.includes(p)).toBe(false)
      }
    }
  })

  test('never offers a point the role lacks — a plain user sees no repos verb', () => {
    const userGrantable = grantableMatrixPoints(accountPermissions('user'))
    expect(userGrantable.filter((p) => p.startsWith('repos:'))).toEqual([])
    // RFC-248: create / update / delete / execute —— update 是新加的（仓库组的 PUT）。
    expect(
      grantableMatrixPoints(accountPermissions('manager')).filter((p) => p.startsWith('repos:'))
        .length,
    ).toBe(4)
  })

  test('never offers a system-domain point to anyone', () => {
    for (const role of ['guest', 'user', 'manager', 'admin'] as const) {
      for (const p of grantableMatrixPoints(accountPermissions(role))) {
        expect(SYSTEM_DOMAIN_POINTS.includes(p)).toBe(false)
      }
    }
  })

  test('everything offered is actually resolvable for that role', () => {
    for (const role of ['guest', 'user', 'manager', 'admin'] as const) {
      const permissions = accountPermissions(role)
      const offered = grantableMatrixPoints(permissions)
      const granted = resolveTokenPermissions({ accountPermissions: permissions, matrix: offered })
      for (const p of offered) expect(granted.has(p)).toBe(true)
    }
  })
})

// RFC-222/RFC-305 — the `manager` preset. Both preset membership and its
// differences from admin are pinned; these are defaults, not role-only classes.
describe('RFC-222 manager role', () => {
  test('RoleSchema accepts exactly the four permission presets', () => {
    expect(RoleSchema.options).toEqual(['admin', 'user', 'manager', 'guest'])
    expect(RoleSchema.safeParse('manager').success).toBe(true)
    expect(RoleSchema.safeParse('guest').success).toBe(true)
    expect(RoleSchema.safeParse('auditor').success).toBe(false)
  })

  test('manager = user baseline + manager capabilities', () => {
    const expected: Permission[] = [
      ...ROLE_PERMISSIONS.user,
      'repos:create',
      // RFC-248 设计门二轮 G4：repos 域不在 ACL 模型里，能力全靠这张手工表
      // 授予——漏了 manager 就「建得了仓库组、改不了」且无法给 PAT 授权。
      'repos:update',
      'repos:delete',
      'repos:execute',
      'tasks:read:all',
      // RFC-253 D19 — 脚本正文编写下放到 manager（资源管理员），但依然是
      // 系统域点，任何 PAT 都拿不到。
      'scripts:author',
      // RFC-269 Q3 — 代码平台调用节点的编写同样下放到 manager，同样是系统域点。
      'code-host-calls:author',
      // RFC-283 — 方法粗门对 manager 开放，路由内仍只允许自己的规则。
      'webhook-triggers:create',
      'webhook-triggers:update',
      'webhook-triggers:delete',
      // RFC-305 — the manager preset retains its historical ACL and distill
      // reach through explicit permissions.
      'resource-acl:bypass',
      'memory-distill-jobs:manage',
    ]
    expect([...ROLE_PERMISSIONS.manager].sort()).toEqual([...new Set(expected)].sort())
  })

  test('manager positive resource-domain points', () => {
    for (const p of [
      'agents:create',
      'agents:update',
      'agents:delete',
      'skills:update',
      'mcps:update',
      'plugins:update',
      'workflows:update',
      'workgroups:update',
      'repos:create',
      'repos:delete',
      'tasks:read:all',
      'memory:create',
      'memory:delete',
      'webhook-triggers:create',
      'webhook-triggers:update',
      'webhook-triggers:delete',
    ] as const) {
      expect(presetHasPermission('manager', p)).toBe(true)
    }
  })

  test('manager preset differences are ∈ admin and ∉ manager (and ∉ user)', () => {
    expect([...MANAGER_PRESET_MISSING_PERMISSIONS].sort()).toEqual(
      [
        'users:read',
        'users:write',
        'settings:read',
        'settings:write',
        'oidc:read',
        'oidc:configure',
        'backup:run',
        'tasks:delete',
        'webhook-endpoints:manage',
        'intent:audit',
        'mcp-runtime-tests:audit',
        'webhook-triggers:override-owner',
      ].sort(),
    )
    for (const p of MANAGER_PRESET_MISSING_PERMISSIONS) {
      expect(presetHasPermission('admin', p)).toBe(true)
      expect(presetHasPermission('manager', p)).toBe(false)
      expect(presetHasPermission('user', p)).toBe(false)
    }
  })

  test('tasks:delete belongs only to the admin default preset', () => {
    expect(presetHasPermission('admin', 'tasks:delete')).toBe(true)
    expect(presetHasPermission('manager', 'tasks:delete')).toBe(false)
    expect(presetHasPermission('user', 'tasks:delete')).toBe(false)
  })

  test('resource ACL bypass is a preset permission, not a role predicate', () => {
    expect(presetHasPermission('admin', 'resource-acl:bypass')).toBe(true)
    expect(presetHasPermission('manager', 'resource-acl:bypass')).toBe(true)
    expect(presetHasPermission('user', 'resource-acl:bypass')).toBe(false)
  })
})
