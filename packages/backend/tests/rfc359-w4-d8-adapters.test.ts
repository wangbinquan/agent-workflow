// RFC-359 W4-D8 —— identity-access 账户 / 授权持久化与 OIDC 身份关联：一份实现，两个 provider 共用，同一段
// 断言在两个引擎上各跑一遍。覆盖原 rfc349 假 PG 用例的全部场景（目录搜索 / 查找顺序、围栏预热、同步决策 +
// CAS 落库、未声明读 fail closed、唯一冲突映射、选择器漂移回滚、建号一笔提交），外加旧 SQLite 版只在真库上
// 才暴露的行为（并发同名 → username-taken 而不是裸驱动错误）。末尾一条源码锁保证该族不再出现 provider 专属文件。

import { expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { eq, sql } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { ProviderNeutralDatabase } from '@/db/query'
import {
  authLoginPolicy,
  oidcProviders,
  userAccessAudit,
  userIdentities,
  userPermissionGrants,
  users,
} from '@/db/schema'
import { createIdentityAccessRuntime } from '@/modules/identity-access/composition'
import { composeOidcIdentityOperations } from '@/modules/identity-access/infrastructure/oidcIdentityCrossContext'
import {
  AuthorityFenceCache,
  createUserAccessRepository,
  createUserAccessTransactionRunner,
} from '@/modules/identity-access/infrastructure/userAccessPersistence'
import { UserAccessError } from '@/modules/identity-access/public/types'
import { DomainError } from '@/util/errors'
import { describeEachProvider } from './helpers/eachProvider'

const NOW = 1_700_000_000_000

async function seedUser(
  db: ProviderNeutralDatabase,
  input: {
    readonly username?: string
    readonly email?: string | null
    readonly role?: 'admin' | 'manager' | 'user' | 'guest'
    readonly status?: 'active' | 'disabled' | 'invited'
    readonly createdAt?: number
  } = {},
): Promise<string> {
  const id = `u_d8_${ulid()}`
  await db.insert(users).values({
    id,
    username: input.username ?? id,
    email: input.email ?? null,
    displayName: input.username ?? id,
    role: input.role ?? 'user',
    status: input.status ?? 'active',
    createdAt: input.createdAt ?? NOW,
    updatedAt: input.createdAt ?? NOW,
  })
  return id
}

async function seedProvider(
  db: ProviderNeutralDatabase,
  selectors: {
    readonly subjectClaim?: string
    readonly usernameClaim?: string
    readonly gitNameClaim?: string
    readonly emailClaim?: string
  } = {},
): Promise<string> {
  const id = `provider_${ulid()}`
  await db.insert(oidcProviders).values({
    id,
    slug: id,
    displayName: 'Corporate SSO',
    issuerUrl: 'https://idp.example.test',
    clientId: 'client',
    clientSecretEnc: 'sealed',
    scopes: 'openid',
    provisioning: 'invite',
    allowedEmailDomainsJson: '[]',
    iconUrl: null,
    enabled: true,
    userinfoRequestStyle: 'get_bearer',
    trustEmailVerified: false,
    createdAt: 1,
    updatedAt: 1,
    schemaVersion: 1,
    ...selectors,
  })
  return id
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected the promise to reject')
}

const CLAIMS = {
  subjectClaim: 'sub',
  usernameClaim: 'preferred_username',
  gitNameClaim: 'name',
  emailClaim: 'email',
}

const EXPECTED_CLAIMS = {
  expectedSubjectClaim: 'sub',
  expectedUsernameClaim: 'preferred_username',
  expectedGitNameClaim: 'name',
  expectedEmailClaim: 'email',
}

describeEachProvider('RFC-359 W4-D8 —— identity-access 账户 / 授权持久化', (harness) => {
  test('目录：搜索按前缀不分大小写、排除 id 时略过禁用账号、状态过滤在截断之前；lookup 按请求顺序回', async () => {
    const repository = createUserAccessRepository(harness.db, new AuthorityFenceCache())
    const alice = await seedUser(harness.db, { username: 'Alice', createdAt: 1 })
    const archived = await seedUser(harness.db, {
      username: 'archived',
      status: 'disabled',
      createdAt: 2,
    })
    const anna = await seedUser(harness.db, { username: 'anna', createdAt: 3 })

    expect(
      await repository.search({ q: 'a', limit: 10, excludeIds: ['other'], status: undefined }),
    ).toEqual([
      { id: alice, username: 'Alice', displayName: 'Alice', role: 'user', status: 'active' },
      { id: anna, username: 'anna', displayName: 'anna', role: 'user', status: 'active' },
    ])
    expect(
      (await repository.search({ q: 'a', limit: 1, excludeIds: [alice], status: 'active' })).map(
        (row) => row.id,
      ),
    ).toEqual([anna])
    expect(
      (await repository.search({ q: 'arch', limit: 10, excludeIds: [], status: undefined })).map(
        (row) => row.id,
      ),
    ).toEqual([archived])
    expect((await repository.lookup([archived, 'missing', alice])).map((row) => row.id)).toEqual([
      archived,
      alice,
    ])
    expect((await repository.findByUsername('Alice'))?.id).toBe(alice)
    expect(await repository.findByUsername('nobody')).toBeNull()
  })

  test('围栏：授权读预热缓存、本进程写提交后刷新；SQLite 同步读连跨事务写者都立即可见，PG 退回缓存', async () => {
    const fenceCache = new AuthorityFenceCache()
    const repository = createUserAccessRepository(harness.db, fenceCache)
    const runner = createUserAccessTransactionRunner(harness.db, fenceCache)
    const id = await seedUser(harness.db)
    // 能力矩阵说了算：驱动能同步读则围栏读的是行本身，否则围栏就是缓存（未预热 ⇒ null，fail closed）。
    const syncReads =
      harness.capabilities.readRowSync(harness.db, sql`select 1 as one`) !== undefined

    expect(repository.readAuthorityFence(id)).toEqual(
      syncReads ? { status: 'active', accessRevision: 0 } : null,
    )
    expect(repository.readAuthorityFence('missing')).toBeNull()
    await expect(repository.findAccessSnapshot(id)).resolves.toMatchObject({
      user: { id, status: 'active', accessRevision: 0 },
      grants: [],
    })
    expect(repository.readAuthorityFence(id)).toEqual({ status: 'active', accessRevision: 0 })

    await runner.run({ userIds: [id] }, (transaction) => {
      const current = transaction.findUser(id)!
      expect(
        transaction.updateUserConditional({
          id,
          expectedAccessRevision: current.accessRevision,
          accessChanged: true,
          values: { status: 'disabled', accessRevision: 5, updatedAt: 2 },
        }),
      ).toBe(true)
    })
    expect(repository.readAuthorityFence(id)).toEqual({ status: 'disabled', accessRevision: 5 })

    // 旁路写者（另一个进程 / CLI 直写库）：SQLite 的同步读看得见，PG 只能等下一次授权读预热。
    await harness.db.update(users).set({ accessRevision: 9 }).where(eq(users.id, id))
    expect(repository.readAuthorityFence(id)).toEqual({
      status: 'disabled',
      accessRevision: syncReads ? 9 : 5,
    })
    await repository.findAccessSnapshot(id)
    expect(repository.readAuthorityFence(id)).toEqual({ status: 'disabled', accessRevision: 9 })
  })

  test('事务：同步决策 + CAS 落库一笔提交；未声明的读 fail closed 且不留副作用；stale 修订判假', async () => {
    const runner = createUserAccessTransactionRunner(harness.db, new AuthorityFenceCache())
    const id = await seedUser(harness.db)

    expect(
      await runner.run({ userIds: [id] }, (transaction) => {
        const current = transaction.findUser(id)!
        expect(
          transaction.updateUserConditional({
            id,
            expectedAccessRevision: current.accessRevision,
            accessChanged: true,
            values: { displayName: 'Updated', accessRevision: 5, updatedAt: 2 },
          }),
        ).toBe(true)
        return 'committed'
      }),
    ).toBe('committed')
    expect((await harness.db.select().from(users).where(eq(users.id, id)))[0]).toMatchObject({
      displayName: 'Updated',
      accessRevision: 5,
      updatedAt: 2,
    })

    await expect(
      runner.run({ userIds: [id] }, (transaction) => {
        transaction.updateUserConditional({
          id,
          expectedAccessRevision: 5,
          accessChanged: false,
          values: { displayName: 'Never', updatedAt: 3 },
        })
        return transaction.findUserByEmail('alice@example.test')
      }),
    ).rejects.toThrow('was not declared in the transaction read-set')
    expect(
      (
        await harness.db
          .select({ displayName: users.displayName })
          .from(users)
          .where(eq(users.id, id))
      )[0],
    ).toEqual({ displayName: 'Updated' })

    expect(
      await runner.run({ userIds: [id] }, (transaction) =>
        transaction.updateUserConditional({
          id,
          expectedAccessRevision: 4,
          accessChanged: true,
          values: { accessRevision: 6, updatedAt: 4 },
        }),
      ),
    ).toBe(false)
  })

  test('唯一冲突映射：并发同名 → username-taken；抢别人的邮箱 → profile-email-conflict / oidc-email-conflict', async () => {
    const runner = createUserAccessTransactionRunner(harness.db, new AuthorityFenceCache())
    const alice = await seedUser(harness.db, { username: 'alice', email: 'alice@example.test' })
    const bob = await seedUser(harness.db, { username: 'bob' })

    // 读集里没装载 alice ⇒ 内存判不出重名，交给库的唯一约束——两个引擎都要映射回同一个 code。
    const duplicate = await rejection(
      runner.run({ operation: 'create-managed-user', userIds: [bob] }, (transaction) => {
        transaction.insertUser({
          id: `u_d8_${ulid()}`,
          username: 'alice',
          email: null,
          displayName: 'Duplicate',
          gitName: 'Duplicate',
          passwordHash: null,
          role: 'user',
          status: 'active',
          forcePasswordChange: false,
          createdBy: bob,
          createdAt: 2,
          updatedAt: 2,
          lastLoginAt: null,
          schemaVersion: 1,
          accessRevision: 0,
        })
      }),
    )
    expect(duplicate).toBeInstanceOf(UserAccessError)
    expect(duplicate).toMatchObject({ kind: 'conflict', code: 'username-taken' })
    expect(
      await harness.db.select({ id: users.id }).from(users).where(eq(users.username, 'alice')),
    ).toHaveLength(1)

    for (const [operation, code] of [
      ['update-own-profile', 'profile-email-conflict'],
      ['sync-oidc-profile', 'oidc-email-conflict'],
    ] as const) {
      const conflict = await rejection(
        runner.run({ operation, userIds: [bob] }, (transaction) => {
          transaction.updateUserConditional({
            id: bob,
            expectedAccessRevision: 0,
            accessChanged: false,
            values: { email: 'alice@example.test', updatedAt: 2 },
          })
        }),
      )
      expect(conflict).toBeInstanceOf(UserAccessError)
      expect(conflict).toMatchObject({ kind: 'conflict', code })
    }
    expect(
      (await harness.db.select({ email: users.email }).from(users).where(eq(users.id, bob)))[0],
    ).toEqual({ email: null })
    void alice
  })

  test('OIDC：选择器漂移在任何副作用之前回滚——没有身份行、用户不变', async () => {
    const providerId = await seedProvider(harness.db, { subjectClaim: 'uid' })
    const userId = await seedUser(harness.db)
    const oidc = composeOidcIdentityOperations({
      db: harness.db,
      identityAccess: createIdentityAccessRuntime({ db: harness.db }),
    })

    const error = await rejection(
      oidc.createIdentity({
        userId,
        providerId,
        subject: 'subject-1',
        email: null,
        emailVerified: false,
        displayName: 'Alice',
        gitName: 'Alice Git',
        preferredSnapshot: 'Alice',
        expectedSubjectClaim: 'sub',
      }),
    )
    expect(error).toBeInstanceOf(DomainError)
    expect(error).toMatchObject({ code: 'provider-config-changed' })
    expect(await oidc.findByProviderSubject(providerId, 'subject-1')).toBeNull()
    expect(
      await harness.db
        .select()
        .from(userAccessAudit)
        .where(eq(userAccessAudit.targetUserId, userId)),
    ).toEqual([])
  })

  test('OIDC：建号一笔提交用户 / 默认授权 / 审计 / 身份 / profile 快照；重名与重复主体各报各的 conflict', async () => {
    const providerId = await seedProvider(harness.db, CLAIMS)
    await harness.db
      .update(authLoginPolicy)
      .set({ oidcDefaultRole: 'user' })
      .where(eq(authLoginPolicy.id, 'global'))
    const runtime = createIdentityAccessRuntime({ db: harness.db })
    const oidc = composeOidcIdentityOperations({ db: harness.db, identityAccess: runtime })
    const username = `alice_${ulid()}`

    const created = await oidc.createUserWithIdentity({
      username,
      displayName: 'Alice',
      gitName: 'Alice Git',
      email: null,
      now: NOW,
      identity: {
        providerId,
        subject: 'subject-1',
        email: null,
        emailVerified: false,
        displayName: 'Alice',
        gitName: 'Alice Git',
        // 故意过期：事务内的 profile 参与者要在关联之后再补一笔身份更新。
        preferredSnapshot: '',
        ...EXPECTED_CLAIMS,
      },
    })
    expect(created.userId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(
      (await harness.db.select().from(users).where(eq(users.id, created.userId)))[0],
    ).toMatchObject({ username, role: 'user', status: 'active', accessRevision: 0, createdAt: NOW })
    expect(
      (
        await harness.db
          .select({ permission: userPermissionGrants.permission })
          .from(userPermissionGrants)
          .where(eq(userPermissionGrants.userId, created.userId))
      ).map((row) => row.permission),
    ).toEqual(['users:presence'])
    expect(
      await harness.db
        .select({
          actorKind: userAccessAudit.actorKind,
          added: userAccessAudit.addedPermissionsJson,
        })
        .from(userAccessAudit)
        .where(eq(userAccessAudit.targetUserId, created.userId)),
    ).toEqual([{ actorKind: 'system', added: '["users:presence"]' }])
    expect(await oidc.findByProviderSubject(providerId, 'subject-1')).toMatchObject({
      userId: created.userId,
      preferredSnapshot: 'Alice',
    })
    expect((await oidc.listIdentitiesForUser(created.userId)).map((row) => row.subject)).toEqual([
      'subject-1',
    ])

    // 独立事务的 profile 同步经运行时的命令（同一份 runner）：显示名变了就刷新并落审计。
    await expect(
      oidc.syncPreferredSnapshot({
        providerId,
        subject: 'subject-1',
        userId: created.userId,
        displayName: 'Alice Renamed',
        gitName: 'Alice Git',
        email: null,
        emailVerified: true,
        ...EXPECTED_CLAIMS,
      }),
    ).resolves.toEqual({
      displayNameRefreshed: true,
      gitNameRefreshed: false,
      emailRefreshed: false,
    })
    expect(
      (
        await harness.db
          .select({ displayName: users.displayName })
          .from(users)
          .where(eq(users.id, created.userId))
      )[0],
    ).toEqual({ displayName: 'Alice Renamed' })

    const sameUsername = await rejection(
      oidc.createUserWithIdentity({
        username,
        displayName: 'Alice',
        gitName: 'Alice Git',
        email: null,
        identity: { providerId, subject: 'subject-2', email: null, emailVerified: false },
      }),
    )
    expect(sameUsername).toBeInstanceOf(DomainError)
    expect(sameUsername).toMatchObject({ code: 'username-taken' })
    const other = await seedUser(harness.db)
    const sameSubject = await rejection(
      oidc.createIdentity({
        userId: other,
        providerId,
        subject: 'subject-1',
        email: null,
        emailVerified: false,
      }),
    )
    expect(sameSubject).toBeInstanceOf(DomainError)
    expect(sameSubject).toMatchObject({ code: 'identity-already-linked' })
  })

  test('OIDC：绑定邀请用户即激活；解绑判存在；用户不存在报 user-not-found', async () => {
    const providerId = await seedProvider(harness.db, CLAIMS)
    const invited = await seedUser(harness.db, { status: 'invited' })
    const oidc = composeOidcIdentityOperations({
      db: harness.db,
      identityAccess: createIdentityAccessRuntime({ db: harness.db }),
    })

    await oidc.bindInvitedUserWithIdentity({
      userId: invited,
      now: NOW,
      identity: { providerId, subject: 'invited-subject', email: null, emailVerified: true },
    })
    expect(
      (
        await harness.db
          .select({ status: users.status, updatedAt: users.updatedAt })
          .from(users)
          .where(eq(users.id, invited))
      )[0],
    ).toEqual({ status: 'active', updatedAt: NOW })
    const [identity] = await oidc.listIdentitiesForUser(invited)
    expect(identity).toMatchObject({ subject: 'invited-subject', emailVerified: true })

    await oidc.unlinkIdentity(identity!.id)
    expect(
      await harness.db.select().from(userIdentities).where(eq(userIdentities.id, identity!.id)),
    ).toEqual([])
    const missing = await rejection(oidc.unlinkIdentity(identity!.id))
    expect(missing).toMatchObject({ code: 'identity-not-found' })

    const ghost = await rejection(
      oidc.bindInvitedUserWithIdentity({
        userId: 'u_d8_missing',
        identity: { providerId, subject: 'ghost', email: null, emailVerified: false },
      }),
    )
    expect(ghost).toBeInstanceOf(DomainError)
    expect(ghost).toMatchObject({ code: 'user-not-found' })
    expect(await oidc.findByProviderSubject(providerId, 'ghost')).toBeNull()
  })
})

test('源码锁：identity-access 的账户 / OIDC 持久化不再有 provider 专属文件', () => {
  const infra = join(import.meta.dir, '..', 'src', 'modules', 'identity-access', 'infrastructure')
  for (const retired of [
    'sqliteUserAccessRepository.ts',
    'postgresqlUserAccessRepository.ts',
    'sqliteOidcIdentityCrossContext.ts',
    'postgresqlOidcIdentityCrossContext.ts',
    'sqliteUserAccessAuditRepository.ts',
  ]) {
    expect(existsSync(join(infra, retired))).toBe(false)
  }
  for (const neutral of ['userAccessPersistence.ts', 'oidcIdentityCrossContext.ts']) {
    const source = readFileSync(join(infra, neutral), 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n')
    expect(source).not.toMatch(
      /PostgresqlDatabaseClient|\bDbClient\b|dbTxSync|for update|\$client/i,
    )
    expect(source).toContain('ProviderNeutralDatabase')
  }
})
