// RFC-099 ACL endpoints — cross-user enforcement for EVERY ACL'd resource type.
//
// WHY THIS EXISTS
// ---------------
// `GET/PUT /api/{resource}/:key/acl` is the write entry point for owner transfer
// and grant editing on six resource types. The 2026-07-21 test-guard audit found
// two compounding problems:
//
//   1. The endpoints are mounted through `mountAclEndpoints` with a COMPUTED
//      path, so the contract registry's route scanner (literal-only) never saw
//      them: all twelve were absent from the registry and had no 401 gate, no
//      shape check, nothing. Fixed in api-contract-coverage.test.ts + registry.
//   2. Behavioural coverage existed for exactly ONE of the six types (agents, in
//      rfc099-resource-routes.test.ts). skills / mcps / plugins / workflows /
//      workgroups had their ACL endpoints exercised only under the daemon token,
//      which resolves to a system admin and therefore short-circuits every check
//      being tested. A dropped `canViewResource` on any of those five would
//      expose private skill bodies, MCP credential shapes, plugin configs and
//      workgroup membership to every logged-in user — with the suite green.
//
// The fix shape follows the audit's prescription: replace per-resource ad-hoc
// tests with ONE table-driven matrix, so a SEVENTH ACL'd resource type is a
// single row here rather than a whole file somebody forgets to write. The table
// is cross-checked against the route sources at the top of the file, so adding
// `mountAclEndpoints` somewhere new fails here until it is enrolled.
//
// Rows are seeded straight into the DB rather than through each type's create
// endpoint: the ACL handlers only ever `load()` a row, and DB seeding keeps this
// file free of per-type creation quirks (skills touching the filesystem, plugins
// needing an install path) that have nothing to do with the boundary under test.
//
// See design/test-guard-audit-2026-07-21 Top-5 (B5-ACL-cluster) / 逃逸机制③.

import { beforeEach, describe, expect, test } from 'bun:test'
import { join, resolve } from 'node:path'
import type { Hono } from 'hono'
import { ulid } from 'ulid'
import { createSession } from '../src/auth/sessionStore'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import {
  actionTemplates,
  agents,
  automationPolicies,
  capabilityTemplates,
  developmentAdapterDefinitions,
  digitalEmployees,
  employeeDefinitions,
  mcps,
  plugins,
  skills,
  verificationProfiles,
  workflows,
  workgroups,
} from '../src/db/schema'
import { ACL_RESOURCE_TYPES } from '@agent-workflow/shared'
import { allRouteMeta } from '../src/routes/registry'
import { createApp } from '../src/server'
import { createUser } from '../src/services/users'

const DAEMON_TOKEN = 'a'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface Harness {
  db: DbClient
  app: Hono
  alice: { id: string; token: string } // owner (ordinary account)
  /** RFC-304 — a department-layer owner, for resources an ordinary user cannot create. */
  dept: { id: string; token: string }
  bob: { id: string; token: string } // grantee
  carol: { id: string; token: string } // stranger
  admin: { id: string; token: string }
}

/**
 * `needsDept` gates a FIFTH user, and it is gated for a reason: user creation
 * hashes a password, deliberately slowly. Building the department-layer actor
 * for all eight cases would make the seven that never use it pay for the one
 * that does, on every `beforeEach` — and this file already runs 33 tests.
 */
async function buildHarness(needsDept = false): Promise<Harness> {
  const db = createInMemoryDb(MIGRATIONS)
  const app = createApp({
    token: DAEMON_TOKEN,
    configPath: '/tmp/aw-rfc099-matrix-config-never-used.json',
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    db,
  })
  const mkUser = async (username: string, role: 'admin' | 'user' | 'manager') => {
    const u = await createUser(db, {
      username,
      displayName: username,
      role,
      password: 'longEnoughPassword',
    })
    const { token } = await createSession({ db, userId: u.id })
    return { id: u.id, token }
  }
  return {
    db,
    app,
    alice: await mkUser('alice', 'user'),
    // RFC-304 — a DEPARTMENT-layer owner. A capability framework cannot be
    // owned by an ordinary user at all: creating one needs a system-domain
    // point that is not in the user preset, so seeding `alice` as its owner
    // would test a state the API cannot produce. Every other actor in the
    // matrix stays an ordinary user, which is what the stranger and grantee
    // cases need.
    dept: needsDept ? await mkUser('dept', 'manager') : { id: '__unused__', token: '__unused__' },
    bob: await mkUser('bob', 'user'),
    carol: await mkUser('carol', 'user'),
    admin: await mkUser('root', 'admin'),
  }
}

async function req(
  app: Hono,
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${token}`)
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json')
  return app.request(path, { ...init, headers })
}

const KEY = 'acl-matrix-subject'

interface ResourceCase {
  type: string
  base: string
  /** Route param: the key used in the URL. */
  keyOf: (seeded: { id: string; name: string }) => string
  missingKey: string
  /**
   * Which harness actor owns the seeded row.
   *
   * `user` for every resource an ordinary account may create. `dept` for the
   * capability framework, whose write points are system-domain — an ordinary
   * user cannot create one, so an ordinary-user owner is an unreachable state.
   */
  ownerActor?: 'alice' | 'dept'
  seed: (db: DbClient, ownerUserId: string) => Promise<{ id: string; name: string }>
}

const now = 1_700_000_000_000

const CASES: ResourceCase[] = [
  {
    type: 'agent',
    base: '/api/agents',
    keyOf: (s) => s.id,
    missingKey: ulid(),
    seed: async (db, ownerUserId) => {
      const row = { id: ulid(), name: KEY }
      await db.insert(agents).values({
        ...row,
        description: 'acl matrix subject',
        outputs: JSON.stringify(['answer']),
        ownerUserId,
        visibility: 'private',
      })
      return row
    },
  },
  {
    type: 'skill',
    base: '/api/skills',
    keyOf: (s) => s.id,
    missingKey: ulid(),
    seed: async (db, ownerUserId) => {
      const row = { id: ulid(), name: KEY }
      await db.insert(skills).values({
        ...row,
        description: 'acl matrix subject',
        managedPath: `skills/${KEY}/files/`,
        ownerUserId,
        visibility: 'private',
      })
      return row
    },
  },
  {
    type: 'mcp',
    base: '/api/mcps',
    keyOf: (s) => s.id,
    missingKey: ulid(),
    seed: async (db, ownerUserId) => {
      const row = { id: ulid(), name: KEY }
      await db.insert(mcps).values({
        ...row,
        description: 'acl matrix subject',
        type: 'local',
        config: JSON.stringify({ command: ['echo'] }),
        enabled: true,
        ownerUserId,
        visibility: 'private',
      })
      return row
    },
  },
  {
    type: 'plugin',
    base: '/api/plugins',
    keyOf: (s) => s.id,
    missingKey: ulid(),
    seed: async (db, ownerUserId) => {
      const row = { id: ulid(), name: KEY }
      await db.insert(plugins).values({
        ...row,
        description: 'acl matrix subject',
        spec: 'fake-plugin@0.0.1',
        optionsJson: '{}',
        sourceKind: 'npm',
        cachedPath: join('/tmp', 'aw-acl-matrix-plugin'),
        resolvedVersion: '0.0.1',
        installedAt: now,
        enabled: true,
        ownerUserId,
        visibility: 'private',
      })
      return row
    },
  },
  {
    type: 'workflow',
    base: '/api/workflows',
    keyOf: (s) => s.id,
    missingKey: ulid(),
    seed: async (db, ownerUserId) => {
      const row = { id: ulid(), name: KEY }
      await db.insert(workflows).values({
        ...row,
        description: 'acl matrix subject',
        definition: JSON.stringify({ $schema_version: 2, inputs: [], nodes: [], edges: [] }),
        ownerUserId,
        visibility: 'private',
      })
      return row
    },
  },
  {
    // RFC-304 → RFC-309 — the capability template. Enrolled here rather than
    // trusted to its own file: this matrix is what checks 404-not-403 for a
    // non-owner, owner transfer, and grant editing, and those are exactly the
    // properties a resource type is most likely to get subtly wrong.
    //
    // One row now, not two. The pair existed because the department layer's
    // ACL had to be independent of the group layer's; after the merge the
    // dangerous half is a FIELD behind `scripts:author`, not a second row with
    // its own owner.
    type: 'capability_template',
    base: '/api/capability-templates',
    keyOf: (s) => s.id,
    missingKey: ulid(),
    ownerActor: 'dept',
    seed: async (db, ownerUserId) => {
      const row = { id: ulid(), name: KEY }
      await db.insert(capabilityTemplates).values({
        ...row,
        description: 'acl matrix subject',
        capability: 'mr-review',
        scriptsJson: '{}',
        hooksJson: '[]',
        paramSchemaJson: '[]',
        paramDefaultsJson: '{}',
        agentBySlotJson: '{}',
        promptBySlotJson: '{}',
        paramsJson: '{}',
        stageContractVer: 1,
        ownerUserId,
        visibility: 'private',
        createdAt: now,
        updatedAt: now,
      })
      return row
    },
  },
  {
    type: 'workgroup',
    base: '/api/workgroups',
    keyOf: (s) => s.id,
    missingKey: ulid(),
    seed: async (db, ownerUserId) => {
      const row = { id: ulid(), name: KEY }
      await db.insert(workgroups).values({
        ...row,
        description: 'acl matrix subject',
        mode: 'free_collab',
        ownerUserId,
        visibility: 'private',
        createdAt: now,
        updatedAt: now,
      })
      return row
    },
  },
  // RFC-317 T9b —— RFC-310 的五类配置资源。它们从落地起就挂着 /acl 端点，却因为
  // 上面那条入网守卫是**字符串字面量正则**（要求 `type: '<literal>'`）而结构上不
  // 可见：developmentConfig.ts 用工厂 `type: cfg.aclType` 挂载，正则永远匹配不到，
  // 于是这五类的跨用户 ACL 端点行为**零覆盖**，而守卫全绿（findings.md ACL-03）。
  // 五张表共用 developmentResourceIdentityColumns，种子形状一致。
  {
    type: 'action_template',
    base: '/api/code/action-templates',
    keyOf: (s) => s.id,
    missingKey: ulid(),
    seed: async (db, ownerUserId) => {
      const row = { id: ulid(), name: KEY }
      await db.insert(actionTemplates).values({
        ...row,
        capabilityId: 'acl-matrix-capability',
        draftJson: '{}',
        publishedRevision: null,
        ownerUserId,
        visibility: 'private',
        createdAt: now,
        updatedAt: now,
      })
      return row
    },
  },
  {
    type: 'verification_profile',
    base: '/api/code/verification-profiles',
    keyOf: (s) => s.id,
    missingKey: ulid(),
    seed: async (db, ownerUserId) => {
      const row = { id: ulid(), name: KEY }
      await db.insert(verificationProfiles).values({
        ...row,
        draftJson: '{}',
        publishedRevision: null,
        ownerUserId,
        visibility: 'private',
        createdAt: now,
        updatedAt: now,
      })
      return row
    },
  },
  {
    type: 'digital_employee',
    base: '/api/code/digital-employees',
    keyOf: (s) => s.id,
    missingKey: ulid(),
    seed: async (db, ownerUserId) => {
      const row = { id: ulid(), name: KEY }
      await db.insert(digitalEmployees).values({
        ...row,
        draftJson: '{}',
        publishedRevision: null,
        ownerUserId,
        visibility: 'private',
        createdAt: now,
        updatedAt: now,
      })
      return row
    },
  },
  {
    type: 'automation_policy',
    base: '/api/code/automation-policies',
    keyOf: (s) => s.id,
    missingKey: ulid(),
    seed: async (db, ownerUserId) => {
      const row = { id: ulid(), name: KEY }
      await db.insert(automationPolicies).values({
        ...row,
        draftJson: '{}',
        publishedRevision: null,
        ownerUserId,
        visibility: 'private',
        createdAt: now,
        updatedAt: now,
      })
      return row
    },
  },
  {
    // RFC-317 T8 —— 第 13 类：数字员工 OS 的员工定义。权限点复用 digital-employees:*
    // （与 RFC-310 的 digital_employee 配置资源同前缀，用户裁决），base 不同故不冲突。
    type: 'employee_definition',
    base: '/api/digital-employees',
    keyOf: (s) => s.id,
    missingKey: ulid(),
    seed: async (db, ownerUserId) => {
      const row = { id: ulid(), name: KEY }
      await db.insert(employeeDefinitions).values({
        ...row,
        typeId: 'acl-matrix-type',
        typeRevision: 1,
        configurationJson: '{}',
        currentRevision: null,
        ownerUserId,
        visibility: 'private',
        createdAt: now,
        updatedAt: now,
      })
      return row
    },
  },
  {
    type: 'development_adapter',
    base: '/api/integrations/development-adapters',
    keyOf: (s) => s.id,
    missingKey: ulid(),
    seed: async (db, ownerUserId) => {
      const row = { id: ulid(), name: KEY }
      await db.insert(developmentAdapterDefinitions).values({
        ...row,
        purpose: 'requirement-source',
        draftJson: '{}',
        publishedRevision: null,
        ownerUserId,
        visibility: 'private',
        createdAt: now,
        updatedAt: now,
      })
      return row
    },
  },
]

// RFC-317 T9b —— 入网守卫从**源码正则**换成**运行时预言**。
//
// 旧版扫 `routes/*.ts` 找 `mountAclEndpoints(app, deps, { … type: '<literal>' … })`。
// 它有一个结构性盲区：`routes/developmentConfig.ts` 用工厂挂载
// （`type: cfg.aclType`，一个**变量**），正则永远匹配不到。实测旧正则恰好命中 7 类，
// 而当时 CASES 也恰好是那 7 行 ⇒ 断言两边相等、全绿，而 RFC-310 的五类配置资源
// **跨用户 ACL 端点行为零覆盖**（findings.md ACL-03）。这条守卫的文件头写着
// 「so adding mountAclEndpoints somewhere new fails here until it is enrolled」——
// 它相信自己在做一件它结构上做不到的事。
//
// 新版起真 app，从**框架实际注册的路由表**（`allRouteMeta()`）观察 `/acl` 端点，
// 与挂载写法无关；再与 `ACL_RESOURCE_TYPES` 和 CASES 三方对齐。
describe('RFC-099 / RFC-317 T9b ACL endpoint matrix — enrolment（运行时预言）', () => {
  test('每个 AclResourceType 都有一对真正注册上的 /acl 端点', async () => {
    const h = await buildHarness()
    void h
    const aclPaths = allRouteMeta()
      .filter((meta) => meta.path.endsWith('/acl'))
      .map((meta) => `${meta.method} ${meta.path}`)
    // 语料非空：读到 0 条说明 app 没起来或路由表口径变了，此刻零预言力。
    expect(
      aclPaths.length,
      'allRouteMeta 里读到 0 个 /acl 端点——本用例此刻零预言力',
    ).toBeGreaterThan(0)

    const basesWithAcl = new Set(
      allRouteMeta()
        .filter((meta) => meta.path.endsWith('/acl'))
        .map((meta) => meta.path.replace(/\/:[^/]+\/acl$/, '')),
    )
    expect(
      basesWithAcl.size,
      `注册上的 /acl 基路径数应等于 ACL 资源类型数；实际基路径=${[...basesWithAcl].sort().join(', ')}`,
    ).toBe(ACL_RESOURCE_TYPES.length)

    // GET 与 PUT 成对，缺一不可。
    const pairs = new Map<string, Set<string>>()
    for (const meta of allRouteMeta()) {
      if (!meta.path.endsWith('/acl')) continue
      const base = meta.path.replace(/\/:[^/]+\/acl$/, '')
      if (!pairs.has(base)) pairs.set(base, new Set())
      pairs.get(base)!.add(meta.method.toUpperCase())
    }
    const incomplete = [...pairs.entries()]
      .filter(([, methods]) => !(methods.has('GET') && methods.has('PUT')))
      .map(([base, methods]) => `${base} → ${[...methods].sort().join(',')}`)
    expect(incomplete, '每个 ACL 资源都要有 GET+PUT 一对 /acl 端点').toEqual([])
  })

  test('CASES 覆盖全部 AclResourceType（新增一类而不写行 ⇒ 红）', () => {
    expect([...CASES.map((c) => c.type)].sort()).toEqual([...ACL_RESOURCE_TYPES].sort())
  })

  test('CASES 的 base 与真实注册的 /acl 基路径逐条对上', async () => {
    const h = await buildHarness()
    void h
    const registered = new Set(
      allRouteMeta()
        .filter((meta) => meta.path.endsWith('/acl'))
        .map((meta) => meta.path.replace(/\/:[^/]+\/acl$/, '')),
    )
    const missing = CASES.map((c) => c.base).filter((base) => !registered.has(base))
    expect(missing, 'CASES 写的 base 在真实路由表里找不到对应的 /acl 端点').toEqual([])
  })
})

for (const rc of CASES) {
  describe(`RFC-099 ACL endpoints — ${rc.type}`, () => {
    let h: Harness
    let key: string
    /** The actor that owns the seeded row for THIS case. */
    let owner: Harness['alice']

    beforeEach(async () => {
      h = await buildHarness(rc.ownerActor === 'dept')
      owner = rc.ownerActor === 'dept' ? h.dept : h.alice
      key = rc.keyOf(await rc.seed(h.db, owner.id))
    })

    const aclPath = (k: string): string => `${rc.base}/${k}/acl`
    const mutation = (
      body: Record<string, unknown>,
      expectedAclRevision = 0,
    ): Record<string, unknown> => ({
      ...body,
      expectedResourceId: key,
      expectedAclRevision,
    })

    test('a stranger gets a 404 byte-identical to a non-existent resource (no existence oracle)', async () => {
      const invisible = await req(h.app, h.carol.token, aclPath(key))
      const missing = await req(h.app, h.carol.token, aclPath(rc.missingKey))
      expect(invisible.status).toBe(404)
      expect(missing.status).toBe(404)
      // Identical modulo the echoed key, not merely "both 404". The key itself
      // is attacker-supplied so echoing it reveals nothing; ANY other
      // difference — a distinct `code`, a "you lack access" phrasing, extra
      // fields — is precisely the oracle that tells an attacker which private
      // resources exist. Normalising just the key keeps the assertion strict
      // about everything else.
      const normalise = (text: string, k: string): string => text.split(k).join('<KEY>')
      expect(normalise(await invisible.text(), key)).toBe(
        normalise(await missing.text(), rc.missingKey),
      )
    })

    test('a stranger cannot grant themselves access, and the ACL is unchanged', async () => {
      const body = JSON.stringify(mutation({ userIds: [h.carol.id], visibility: 'public' }))
      const attack = await req(h.app, h.carol.token, aclPath(key), { method: 'PUT', body })
      // Indistinguishable from the SAME request against an id that does not
      // exist — which is the actual invariant, and stricter than pinning one
      // status. Pinning 404 encoded an implementation detail (that the handler
      // refuses before the method gate does), and it is not true for every
      // resource: a capability framework's write point is system-domain, so an
      // ordinary account is turned away at the gate with 403 for ANY id. That
      // is not a weaker answer — the response does not vary with existence,
      // which is the whole property. What would be a leak is the two differing.
      const missing = await req(h.app, h.carol.token, aclPath(rc.missingKey), {
        method: 'PUT',
        body,
      })
      expect(attack.status).toBe(missing.status)
      const normalise = (text: string, k: string): string => text.split(k).join('<KEY>')
      expect(normalise(await attack.clone().text(), key)).toBe(
        normalise(await missing.text(), rc.missingKey),
      )
      // …and it is still a refusal, not a quiet success.
      expect(attack.status).toBeGreaterThanOrEqual(400)

      // Asserting the status alone would still pass if the handler wrote first
      // and threw afterwards — re-read as the owner and prove nothing moved.
      const acl = (await (await req(h.app, owner.token, aclPath(key))).json()) as {
        ownerUserId: string
        visibility: string
        users: Array<{ id: string }>
      }
      expect(acl.ownerUserId).toBe(owner.id)
      expect(acl.visibility).toBe('private')
      expect(acl.users).toEqual([])
      // …and the stranger still cannot see it.
      expect((await req(h.app, h.carol.token, aclPath(key))).status).toBe(404)
    })

    test('owner and admin can read the ACL; owner can grant, grantee can read but not manage', async () => {
      // Positive controls: without these, a handler that refused everyone would
      // satisfy every negative case above and this matrix would have no teeth.
      expect((await req(h.app, owner.token, aclPath(key))).status).toBe(200)
      expect((await req(h.app, h.admin.token, aclPath(key))).status).toBe(200)

      const grant = await req(h.app, owner.token, aclPath(key), {
        method: 'PUT',
        body: JSON.stringify(mutation({ userIds: [h.bob.id] })),
      })
      expect(grant.status).toBe(200)

      const asBob = (await (await req(h.app, h.bob.token, aclPath(key))).json()) as {
        ownerUserId: string
        users: Array<{ id: string }>
        canManage: boolean
      }
      expect(asBob.ownerUserId).toBe(owner.id)
      expect(asBob.users.map((u) => u.id)).toEqual([h.bob.id])
      expect(asBob.canManage).toBe(false)

      const bobEscalates = await req(h.app, h.bob.token, aclPath(key), {
        method: 'PUT',
        body: JSON.stringify(mutation({ visibility: 'public' }, 1)),
      })
      expect(bobEscalates.status).toBe(403)

      // A grant must not make the resource visible to everyone else.
      expect((await req(h.app, h.carol.token, aclPath(key))).status).toBe(404)
    })

    test('granting an unknown or system user is refused with a typed 422', async () => {
      const unknown = await req(h.app, owner.token, aclPath(key), {
        method: 'PUT',
        body: JSON.stringify(mutation({ userIds: ['01HFAKEUSERID0000000000000'] })),
      })
      expect(unknown.status).toBe(422)
      expect(((await unknown.json()) as { code: string }).code).toBe('acl-user-invalid')

      const system = await req(h.app, owner.token, aclPath(key), {
        method: 'PUT',
        body: JSON.stringify(mutation({ userIds: ['__system__'] })),
      })
      expect(system.status).toBe(422)
    })
  })
}
