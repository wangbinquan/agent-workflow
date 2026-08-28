// RFC-312 —— 建号默认授权在**所有**入口都生效的回归锁。
//
// 为什么单独立一条：`createManagedUser`（HTTP/CLI）不是唯一建号入口。OIDC 自助建号走
// `services/userIdentities.ts` 的 `createUserWithIdentity → insertInitialUserAccessInTransaction`，
// 那条路径此前**一条 grant 都不插**（audit 的 addedPermissions 恒为 []）。
// 于是当管理员把 OIDC 默认角色配成 user 时，新账号是 active user 却拿不到 `users:presence`，
// 开着界面也不会被同事看到在线——功能在一整类部署上静默失效。
//
// 另一半是审计同源：grant 行与 audit 的 addedPermissions 必须出自同一个数组，
// 否则会出现"权限生效了、但审计里查不到是谁给的"。

import { describe, expect, test, beforeEach } from 'bun:test'
import { resolve } from 'node:path'
import { randomBytes } from 'node:crypto'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import { createUserWithIdentity } from '../src/services/userIdentities'
import { createOidcProvidersService } from '../src/services/oidcProviders'
import { createSecretBoxFromKey } from '../src/auth/secretBox'
import { initialGrantsForRole } from '../src/modules/identity-access/domain/initialGrants'
import type { Role } from '@agent-workflow/shared'
import { setOidcDefaultRole } from '../src/auth/loginPolicy'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function grantsOf(db: DbClient, userId: string): string[] {
  return (
    db.$client
      .query('SELECT permission FROM user_permission_grants WHERE user_id = ? ORDER BY permission')
      .all(userId) as Array<{ permission: string }>
  ).map((r) => r.permission)
}

function auditAddedOf(db: DbClient, userId: string): string[] {
  const row = db.$client
    .query(
      'SELECT added_permissions_json AS j FROM user_access_audit WHERE target_user_id = ? ORDER BY created_at LIMIT 1',
    )
    .get(userId) as { j: string } | null
  return row === null ? [] : (JSON.parse(row.j) as string[])
}

function grantedByOf(db: DbClient, userId: string, permission: string): string | null {
  const row = db.$client
    .query(
      'SELECT granted_by_user_id AS g FROM user_permission_grants WHERE user_id = ? AND permission = ?',
    )
    .get(userId, permission) as { g: string | null } | null
  return row?.g ?? null
}

describe('rfc312 默认授权覆盖 OIDC 自助建号', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  async function makeProvider() {
    const svc = createOidcProvidersService({
      db,
      secretBox: createSecretBoxFromKey(randomBytes(32)),
    })
    return svc.create({
      slug: 'idp',
      displayName: 'IdP',
      issuerUrl: 'https://idp.test',
      clientId: 'c',
      clientSecret: 's',
      scopes: 'read',
      provisioning: 'auto',
      allowedEmailDomains: [],
      iconUrl: null,
      enabled: true,
      usernameClaim: 'login',
      subjectClaim: null,
    })
  }

  async function provisionViaOidc(subject: string): Promise<string> {
    const provider = await makeProvider()
    const { userId } = await createUserWithIdentity(db, {
      username: 'oidc-user',
      displayName: 'OIDC User',
      gitName: 'OIDC Git User',
      email: null,
      identity: {
        providerId: provider.id,
        subject,
        email: null,
        emailVerified: false,
        displayName: 'OIDC User',
        gitName: 'OIDC Git User',
        preferredSnapshot: '',
        expectedSubjectClaim: null,
      },
    })
    return userId
  }

  test('默认角色档（当前为 guest）：按策略不给，且审计与之一致', async () => {
    const userId = await provisionViaOidc('s-guest')
    const role = (
      db.$client.query('SELECT role FROM users WHERE id = ?').get(userId) as { role: string }
    ).role as Role

    // 与策略逐格对齐：无论 OIDC 默认角色配成哪档，这条断言都有力
    const expected = [...initialGrantsForRole(role)]
    expect(grantsOf(db, userId)).toEqual(expected)
    // 审计与 grant 行**同源**——否则查不到"这权限是谁给的"
    expect(auditAddedOf(db, userId)).toEqual(expected)
    for (const p of expected) {
      // 系统默认授予：归属为 null，与"某个管理员显式点的"可区分
      expect(grantedByOf(db, userId, p)).toBeNull()
    }
    // 并给当前默认角色一条具体断言，防策略被改空后本用例退化成永远绿
    if (role === 'user' || role === 'manager') {
      expect(expected).toContain('users:presence')
    } else {
      expect(expected).toEqual([])
    }
  })

  test('**管理员把 OIDC 默认角色配成 user 时**，新账号必须拿到 users:presence', async () => {
    // 这就是设计门点名的真实故障：这条路径此前一条 grant 都不插，
    // 于是这类部署下新用户开着界面也不会被同事看到在线，而且完全没有报错。
    setOidcDefaultRole(db, 'user')
    const userId = await provisionViaOidc('s-user')

    const role = (
      db.$client.query('SELECT role FROM users WHERE id = ?').get(userId) as { role: string }
    ).role
    expect(role).toBe('user')
    expect(grantsOf(db, userId)).toEqual(['users:presence'])
    expect(auditAddedOf(db, userId)).toEqual(['users:presence'])
    expect(grantedByOf(db, userId, 'users:presence')).toBeNull()
  })
})
