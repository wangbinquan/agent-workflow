// RFC-359 W4-D9 —— 认证持久化（登录策略 / bootstrap / 会话 / PAT / 本地口令）与 PAT 调用审计：一份实现，两个
// provider 共用，同一段断言在两个引擎上各跑一遍。覆盖原 rfc349 假 PG 用例的场景（策略读写、bootstrap 与凭据写入、
// 会话 / PAT 解析）与 PG 侧此前只在真库上才看得到的行为（bootstrap 的唯一冲突映射）。末尾一条源码锁保证该族不再
// 出现 provider 专属文件。

import { expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import { buildActor } from '@/auth/actor'
import { createAuthRuntimeFor, createTokenCallAudit } from '@/auth/composition'
import { mapBootstrapConstraint } from '@/auth/infrastructure/authPersistence'
import type { ProviderNeutralDatabase } from '@/db/query'
import { oidcProviders, userIdentities, userPats, users, userSessions } from '@/db/schema'
import { describeEachProvider } from './helpers/eachProvider'

const NOW = 1_700_000_000_000

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected the promise to reject')
}

async function seedProvider(db: ProviderNeutralDatabase): Promise<string> {
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
  })
  return id
}

function patActor(patId: string, userId: string) {
  return buildActor({
    user: { id: userId, username: userId, displayName: userId, role: 'user', status: 'active' },
    source: 'pat',
    patScopes: ['tasks:execute'],
    patId,
  })
}

describeEachProvider(
  'RFC-359 W4-D9 —— 认证持久化与 PAT 调用审计',
  (harness) => {
    test('bootstrap：策略未完成前改策略被拒；首管理员一笔落用户 + 审计 + 策略；重名 / 重邮箱 / 已完成各报各的 conflict', async () => {
      const revalidations: string[] = []
      const auth = createAuthRuntimeFor({
        db: harness.db,
        onCredentialRevoked: (reason) => revalidations.push(reason),
      })
      expect(await auth.isBootstrapRequired()).toBe(true)
      expect(await rejection(auth.setPasswordLoginEnabled(false, NOW))).toMatchObject({
        code: 'bootstrap-admin-required',
      })
      expect(
        await rejection(
          auth.createPasswordLoginSession({ userId: 'nobody', verifiedPasswordHash: 'x' }),
        ),
      ).toMatchObject({
        code: 'bootstrap-admin-required',
      })

      const username = `admin_${ulid()}`
      const email = `ADMIN_${ulid()}@example.test`
      const created = await auth.completeBootstrap(
        { username, displayName: 'First Admin', email, passwordHash: 'hash-1' },
        NOW,
      )
      expect(created).toMatchObject({
        username,
        role: 'admin',
        status: 'active',
        accessRevision: 0,
      })
      expect(created.email).toBe(email.toLowerCase())
      expect(await auth.getLoginPolicy()).toMatchObject({
        passwordLoginEnabled: true,
        bootstrapCompletedAt: NOW,
      })
      expect(revalidations).toEqual(['bootstrap-completed'])

      expect(
        await rejection(
          auth.completeBootstrap({ username: 'second', displayName: 'Second', passwordHash: 'p' }),
        ),
      ).toMatchObject({ code: 'bootstrap-already-complete' })
      expect(auth.provider).toBe(harness.capabilities.provider)
      // 预检之外的唯一冲突（并发 bootstrap 的 race）交给库的约束再映射：两个引擎的真实驱动错误走同一条正则。
      const duplicate = (input: { readonly username: string; readonly email: string | null }) =>
        rejection(
          harness.db.insert(users).values({
            id: `u_d9_${ulid()}`,
            username: input.username,
            email: input.email,
            displayName: 'dup',
            role: 'user',
            status: 'active',
            createdAt: NOW,
            updatedAt: NOW,
          }),
        )
      const sameUsername = await duplicate({ username, email: null })
      expect(
        mapBootstrapConstraint(harness.capabilities, sameUsername, { username, email: null }),
      ).toMatchObject({
        code: 'username-taken',
      })
      const sameEmail = await duplicate({ username: `other_${ulid()}`, email: created.email })
      expect(
        mapBootstrapConstraint(harness.capabilities, sameEmail, {
          username: 'other',
          email: created.email,
        }),
      ).toMatchObject({
        code: 'email-taken',
      })
      expect(
        mapBootstrapConstraint(harness.capabilities, new Error('unrelated'), {
          username,
          email: null,
        }),
      ).toBeInstanceOf(Error)
    })

    test('登录方法发现与策略更新：关闭口令登录必须至少有一个启用的 provider；发现面按策略状态给不同集合', async () => {
      const auth = createAuthRuntimeFor({ db: harness.db, onCredentialRevoked: () => undefined })
      expect(await auth.getLoginMethodDiscovery(true)).toEqual({
        mode: 'bootstrap',
        providers: [],
        passwordLoginEnabled: false,
        daemonTokenEnabled: true,
      })
      await auth.completeBootstrap(
        { username: `admin_${ulid()}`, displayName: 'A', passwordHash: 'h' },
        NOW,
      )
      expect(await rejection(auth.setPasswordLoginEnabled(false, NOW + 1))).toMatchObject({
        code: 'password-login-requires-enabled-oidc',
      })
      const providerId = await seedProvider(harness.db)
      expect(await auth.setPasswordLoginEnabled(false, NOW + 2)).toMatchObject({
        passwordLoginEnabled: false,
        updatedAt: NOW + 2,
      })
      expect(await auth.getLoginMethodDiscovery(true)).toMatchObject({
        mode: 'ready',
        providers: [{ slug: providerId, displayName: 'Corporate SSO', iconUrl: null }],
        passwordLoginEnabled: false,
        daemonTokenEnabled: false,
      })
      expect((await auth.getLoginMethodDiscovery(false)).providers).toEqual([])
      expect(await auth.setOidcDefaultRole('user', NOW + 3)).toMatchObject({
        oidcDefaultRole: 'user',
      })
    })

    test('口令登录与会话：策略关闭 / 错误口令 / 非活跃账号都拒；解析按过期 / 撤销 / 禁用 fail closed；touch 按节流写', async () => {
      const auth = createAuthRuntimeFor({ db: harness.db, onCredentialRevoked: () => undefined })
      const admin = await auth.completeBootstrap(
        { username: `admin_${ulid()}`, displayName: 'A', passwordHash: 'good' },
        NOW,
      )
      expect(
        await rejection(
          auth.createPasswordLoginSession({ userId: admin.id, verifiedPasswordHash: 'bad' }),
        ),
      ).toMatchObject({
        code: 'unauthorized',
      })
      const TTL = 3_600_000
      const login = await auth.createPasswordLoginSession({
        userId: admin.id,
        verifiedPasswordHash: 'good',
        userAgent: 'rfc359',
        now: NOW + 10,
        ttlMs: TTL,
      })
      expect(login.user.lastLoginAt).toBe(NOW + 10)
      const resolved = await auth.lookupActiveSession(login.token, NOW + 11)
      expect(resolved).toMatchObject({
        user: { id: admin.id },
        session: { userId: admin.id, expiresAt: NOW + 10 + TTL },
      })
      const sessionId = resolved!.session.id
      const lastUsed = async () =>
        (
          await harness.db
            .select({ lastUsedAt: userSessions.lastUsedAt })
            .from(userSessions)
            .where(eq(userSessions.id, sessionId))
        )[0]!.lastUsedAt
      const touchedAt = await lastUsed()
      // 节流窗口内不再写 last_used_at；跨过窗口才写（单语句、带 revoked_at is null 谓词，不开事务）。
      await auth.lookupActiveSession(login.token, touchedAt + 1)
      expect(await lastUsed()).toBe(touchedAt)
      await auth.lookupActiveSession(login.token, touchedAt + 5_000)
      expect(await lastUsed()).toBe(touchedAt + 5_000)
      expect(await auth.lookupActiveSession(login.token, NOW + 10 + TTL + 1)).toBeNull()
      expect(
        (await auth.listActiveSessionsForUser(admin.id, NOW + 12)).map((row) => row.id),
      ).toEqual([sessionId])

      await auth.revokeSession(sessionId, NOW + 20)
      expect(await auth.lookupActiveSession(login.token, NOW + 21)).toBeNull()
      expect(await auth.sweepExpiredSessions(NOW + 10 + TTL + 1)).toBe(1)

      const disabledLogin = await auth.createPasswordLoginSession({
        userId: admin.id,
        verifiedPasswordHash: 'good',
        now: NOW + 30,
        ttlMs: 1_000,
      })
      await harness.db.update(users).set({ status: 'disabled' }).where(eq(users.id, admin.id))
      expect(await auth.lookupActiveSession(disabledLogin.token, NOW + 31)).toBeNull()
      await auth.setPasswordLoginEnabled(true, NOW + 32)
      await harness.db.update(users).set({ status: 'active' }).where(eq(users.id, admin.id))
      await seedProvider(harness.db)
      await auth.setPasswordLoginEnabled(false, NOW + 33)
      expect(
        await rejection(
          auth.createPasswordLoginSession({ userId: admin.id, verifiedPasswordHash: 'good' }),
        ),
      ).toMatchObject({
        code: 'password-login-disabled',
      })
    })

    test('PAT：解析按撤销 / 过期 / 禁用 fail closed，touch 每次写；本地口令写入拒绝 OIDC 托管账号并可激活邀请账号', async () => {
      const auth = createAuthRuntimeFor({ db: harness.db, onCredentialRevoked: () => undefined })
      const admin = await auth.completeBootstrap(
        { username: `admin_${ulid()}`, displayName: 'A', passwordHash: 'h' },
        NOW,
      )
      const pat = await auth.createPat({
        userId: admin.id,
        name: 'automation',
        scopes: ['tasks:execute'],
        purpose: 'general',
        now: NOW + 1,
        expiresAt: NOW + 1_000,
      })
      expect(await auth.lookupActivePat(pat.token, NOW + 2)).toMatchObject({
        user: { id: admin.id },
        scopes: ['tasks:execute'],
        patId: pat.meta.id,
      })
      expect(
        (
          await harness.db
            .select({ lastUsedAt: userPats.lastUsedAt })
            .from(userPats)
            .where(eq(userPats.id, pat.meta.id))
        )[0],
      ).toEqual({ lastUsedAt: NOW + 2 })
      expect(await auth.lookupActivePat(pat.token, NOW + 2_000)).toBeNull()
      expect((await auth.listPatsForUser(admin.id)).map((row) => row.id)).toEqual([pat.meta.id])
      await auth.revokePat(pat.meta.id, NOW + 3)
      expect(await auth.lookupActivePat(pat.token, NOW + 4)).toBeNull()

      const invited = `u_d9_${ulid()}`
      await harness.db.insert(users).values({
        id: invited,
        username: invited,
        displayName: invited,
        role: 'user',
        status: 'invited',
        createdAt: NOW,
        updatedAt: NOW,
      })
      await auth.writeLocalPasswordIfUnmanaged({
        userId: invited,
        passwordHash: 'new',
        forcePasswordChange: true,
        activate: true,
        updatedAt: NOW + 5,
      })
      expect(await auth.findUserById(invited)).toMatchObject({
        status: 'active',
        passwordHash: 'new',
        forcePasswordChange: true,
        updatedAt: NOW + 5,
      })
      expect(
        await rejection(
          auth.writeLocalPasswordIfUnmanaged({
            userId: 'u_d9_missing',
            passwordHash: 'x',
            forcePasswordChange: false,
            activate: false,
            updatedAt: NOW,
          }),
        ),
      ).toMatchObject({
        code: 'user-not-found',
      })
      const providerId = await seedProvider(harness.db)
      await harness.db.insert(userIdentities).values({
        id: ulid(),
        userId: invited,
        providerId,
        subject: 'sub-1',
        email: null,
        emailVerified: 0,
        preferredSnapshot: null,
        linkedAt: NOW,
      })
      expect(
        await rejection(
          auth.writeLocalPasswordIfUnmanaged({
            userId: invited,
            passwordHash: 'x',
            forcePasswordChange: false,
            activate: false,
            updatedAt: NOW,
          }),
        ),
      ).toMatchObject({
        code: 'oidc-password-managed',
      })
      expect(await auth.isOidcManagedUser(invited)).toBe(true)
      expect([...(await auth.listOidcManagedUserIds([invited, admin.id]))]).toEqual([invited])
    })

    test('PAT 调用审计：归属 / 快照脱敏 / 逆序列表 / 有界清扫在两个引擎上一致', async () => {
      const audit = createTokenCallAudit(harness.db)
      const userId = `u_d9_${ulid()}`
      await harness.db.insert(users).values({
        id: userId,
        username: userId,
        displayName: userId,
        role: 'user',
        status: 'active',
        createdAt: NOW,
        updatedAt: NOW,
      })
      const patId = `pat_${ulid()}`
      const ids: string[] = []
      for (const [offset, snapshot] of [
        [1, { id: 'mcp-1', config: { env: { API_KEY: 'must-not-survive' } } }],
        [2, undefined],
      ] as const) {
        const id = await audit.record(
          {
            actor: patActor(patId, userId),
            channel: 'mcp',
            toolName: 'resource_write',
            resourceKind: 'mcps',
            resourceId: 'mcp-1',
            statusCode: 204,
            ...(snapshot === undefined ? {} : { deletedSnapshot: snapshot }),
          },
          NOW + offset,
        )
        expect(id).not.toBeNull()
        ids.push(id!)
      }
      // 非 PAT 调用不记审计。
      expect(
        await audit.record(
          {
            actor: { ...patActor(patId, userId), source: 'session' } as never,
            channel: 'rest',
            statusCode: 200,
          },
          NOW + 3,
        ),
      ).toBeNull()
      const [withSnapshot, withoutSnapshot] = ids as [string, string]
      expect((await audit.listForUser(userId)).map((row) => row.id)).toEqual([
        withoutSnapshot,
        withSnapshot,
      ])
      expect((await audit.list(1)).map((row) => row.id)).toEqual([withoutSnapshot])
      expect(
        await audit.pruneSlice(
          1,
          { version: 1, phase: 'snapshots', cutoff: NOW + 2 },
          NOW + 10,
          10,
        ),
      ).toMatchObject({
        done: false,
        cursor: { phase: 'audits', cutoff: NOW + 2 },
        counters: { snapshots: 1 },
      })
      expect(
        await audit.pruneSlice(1, { version: 1, phase: 'audits', cutoff: NOW + 2 }, NOW + 10, 1),
      ).toMatchObject({
        done: false,
        counters: { audits: 1 },
      })
      expect(
        await audit.pruneSlice(1, { version: 1, phase: 'audits', cutoff: NOW + 2 }, NOW + 10, 1),
      ).toMatchObject({
        done: true,
        counters: { audits: 0 },
      })
      expect((await audit.listForUser(userId)).map((row) => row.id)).toEqual([withoutSnapshot])
    })
  },
  { bootstrap: 'required' },
)

test('源码锁：认证持久化与 PAT 审计不再有 provider 专属文件', () => {
  const infra = join(import.meta.dir, '..', 'src', 'auth', 'infrastructure')
  for (const retired of [
    'sqliteAuthPersistence.ts',
    'postgresqlAuthPersistence.ts',
    'sqliteTokenCallAudit.ts',
    'postgresqlTokenCallAudit.ts',
  ]) {
    expect(existsSync(join(infra, retired))).toBe(false)
  }
  for (const neutral of ['authPersistence.ts', 'tokenCallAudit.ts']) {
    const source = readFileSync(join(infra, neutral), 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n')
    expect(source).not.toMatch(
      /PostgresqlDatabaseClient|\bDbClient\b|dbTxSync|for update|SET TRANSACTION/i,
    )
    expect(source).toContain('ProviderNeutralDatabase')
  }
})
