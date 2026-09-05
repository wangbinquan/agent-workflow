// RFC-359 W4-D16 —— resource-catalog 的 Mcp 聚合：异步仓库与事务内运行时测试生命周期成为唯一实现，SQLite 装配也切到
// 这一份。同一段断言在两个引擎上各跑一遍：创建 / 同 owner 同名冲突 / OCC（configHash）/ 改名冲突 / 被 agent 引用时
// 删除只回引用、运行时测试会话在同一笔事务里写下失效意图（配置变更阻塞、停用结束、ACL 变更按可见性结束或阻塞）、
// 未安全停止的会话让删除失败；附源码锁。

import { expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CreateAgentSchema, type CreateMcp } from '@agent-workflow/shared'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { ProviderNeutralDatabase } from '@/db/query'
import { agents, mcpRuntimeTestSessions, users } from '@/db/schema'
import { createAgentPersistenceValues } from '@/modules/resource-catalog/infrastructure/agentPersistence'
import { mcpConfigHash } from '@/modules/resource-catalog/infrastructure/mcpPersistence'
import { createMcpRepository } from '@/modules/resource-catalog/infrastructure/mcpRepository'
import { transitionMcpAclRuntimeTests } from '@/modules/resource-catalog/infrastructure/mcpRuntimeTestTransitions'
import { createMcpTransactionLifecycle } from '@/modules/resource-catalog/infrastructure/mcpTransactionLifecycle'
import { staleConflictError } from '@/util/errors'
import { describeEachProvider } from './helpers/eachProvider'

const T0 = 1_700_000_000_000
const HASH = 'a'.repeat(64)

async function seedUser(
  db: ProviderNeutralDatabase,
  role: 'admin' | 'user' = 'user',
): Promise<string> {
  const id = ulid()
  await db.insert(users).values({
    id,
    username: `u-${id.slice(-8).toLowerCase()}`,
    displayName: id,
    role,
    status: 'active',
    createdAt: T0,
    updatedAt: T0,
  })
  return id
}

function remoteInput(name: string, overrides: Partial<CreateMcp> = {}): CreateMcp {
  return {
    name,
    description: '',
    type: 'remote',
    config: { url: 'https://example.test/mcp' },
    enabled: true,
    ...overrides,
  } as CreateMcp
}

async function seedSession(
  db: ProviderNeutralDatabase,
  input: { mcpId: string; ownerUserId: string; inFlightTurnId?: string | null },
): Promise<string> {
  const id = `session-${ulid()}`
  await db.insert(mcpRuntimeTestSessions).values({
    id,
    mcpId: input.mcpId,
    ownerUserId: input.ownerUserId,
    clientCreateId: `create-${id}`,
    clientCreateDigest: HASH,
    status: 'active',
    mcpConfigHash: HASH,
    runtimeRowId: 'runtime-opencode',
    runtimeName: 'opencode',
    runtimeProtocol: 'opencode',
    runtimeSnapshotJson: '{}',
    runtimeBinaryPath: '/mock/opencode',
    runtimeSessionId: `native-${id}`,
    nativeSessionState: 'ready',
    inFlightTurnId: input.inFlightTurnId ?? null,
    turnSeq: 1,
    sessionVersion: 1,
    idleDeadlineAt: input.inFlightTurnId ? null : 600_001,
    scratchRoot: `/tmp/${id}`,
    cleanupState: 'not-started',
    createdAt: T0,
    updatedAt: T0,
  })
  return id
}

async function sessionState(db: ProviderNeutralDatabase, id: string) {
  return (
    await db
      .select({
        status: mcpRuntimeTestSessions.status,
        endReason: mcpRuntimeTestSessions.endReason,
        blocked: mcpRuntimeTestSessions.continuationBlockedReason,
        sessionVersion: mcpRuntimeTestSessions.sessionVersion,
      })
      .from(mcpRuntimeTestSessions)
      .where(eq(mcpRuntimeTestSessions.id, id))
  )[0]
}

async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn()
    return '<no-throw>'
  } catch (error) {
    return (error as { code?: string }).code ?? '<no-code>'
  }
}

describeEachProvider('RFC-359 W4-D16 —— Mcp 仓库', (harness) => {
  test('创建 / 读 / 列表；同 owner 同名冲突映射成 mcp-name-in-use；OCC 按 configHash；改名撞名冲突', async () => {
    const { repository, projection } = createMcpRepository({
      db: harness.db,
      lifecycle: createMcpTransactionLifecycle(),
    })
    const owner = await seedUser(harness.db)
    const name = `mcp-${ulid().slice(-6).toLowerCase()}`
    const record = (id: string, mcpName: string) => ({
      id,
      input: remoteInput(mcpName),
      ownerUserId: owner,
      visibility: 'private' as const,
      aclRevision: 0 as const,
      now: T0,
    })
    const created = await repository.create(record(`mcp-${ulid()}`, name))
    expect(created).toMatchObject({ name, ownerUserId: owner, enabled: true })
    expect((await repository.get(created.id))?.id).toBe(created.id)
    expect((await repository.list()).map((row) => row.id)).toContain(created.id)
    expect(await codeOf(() => repository.create(record(`mcp-${ulid()}`, name)))).toBe(
      'mcp-name-in-use',
    )
    const sibling = await repository.create(record(`mcp-${ulid()}`, `${name}-b`))

    const hash = projection.configHashOf(created)
    expect(hash).toBe(mcpConfigHash(created))
    expect(
      await codeOf(() =>
        repository.update({
          id: created.id,
          expectedConfigHash: 'stale',
          set: { updatedAt: T0 + 1 },
        }),
      ),
    ).toBe(staleConflictError('mcp', 'x').code)
    const updated = await repository.update({
      id: created.id,
      expectedConfigHash: hash,
      set: { description: 'v2', updatedAt: T0 + 1 },
    })
    expect(updated).toMatchObject({ description: 'v2', updatedAt: T0 + 1 })
    expect(
      await codeOf(() =>
        repository.rename({
          id: created.id,
          newName: sibling.name,
          expectedConfigHash: projection.configHashOf(updated),
          updatedAt: T0 + 2,
        }),
      ),
    ).toBe('mcp-name-in-use')
    const renamed = await repository.rename({
      id: created.id,
      newName: `${name}-renamed`,
      expectedConfigHash: projection.configHashOf(updated),
      updatedAt: T0 + 2,
    })
    expect(renamed.name).toBe(`${name}-renamed`)
    expect(
      await codeOf(() =>
        repository.update({ id: 'missing', expectedConfigHash: hash, set: { updatedAt: T0 } }),
      ),
    ).toBe('mcp-not-found')
  })

  test('删除：被 agent 引用时只回引用、不删；无引用时删除并清掉已结束的测试会话；未安全停止的会话让删除失败', async () => {
    const { repository, projection } = createMcpRepository({
      db: harness.db,
      lifecycle: createMcpTransactionLifecycle(),
    })
    const owner = await seedUser(harness.db)
    const created = await repository.create({
      id: `mcp-${ulid()}`,
      input: remoteInput(`mcp-${ulid().slice(-6).toLowerCase()}`),
      ownerUserId: owner,
      visibility: 'private',
      aclRevision: 0,
      now: T0,
    })
    const agentId = ulid()
    await harness.db.insert(agents).values(
      createAgentPersistenceValues({
        id: agentId,
        agent: CreateAgentSchema.parse({
          name: `agent-${ulid().slice(-6).toLowerCase()}`,
          mcp: [created.id],
        }),
        ownerUserId: owner,
        now: T0,
      }),
    )
    expect((await repository.findAgentReferences(created.id)).map((ref) => ref.id)).toEqual([
      agentId,
    ])
    const blocked = await repository.delete({
      id: created.id,
      expectedConfigHash: projection.configHashOf(created),
    })
    expect(blocked.map((ref) => ref.id)).toEqual([agentId])
    expect(await repository.get(created.id)).not.toBeNull()
    await harness.db.delete(agents).where(eq(agents.id, agentId))

    const active = await seedSession(harness.db, { mcpId: created.id, ownerUserId: owner })
    expect(
      await codeOf(() =>
        repository.delete({ id: created.id, expectedConfigHash: projection.configHashOf(created) }),
      ),
    ).toBe('mcp-test-cleanup-incomplete')
    await harness.db
      .update(mcpRuntimeTestSessions)
      .set({
        status: 'ended',
        endReason: 'user',
        cleanupState: 'complete',
        idleDeadlineAt: null,
        endedAt: T0 + 5,
        updatedAt: T0 + 5,
      })
      .where(eq(mcpRuntimeTestSessions.id, active))
    expect(
      await repository.delete({
        id: created.id,
        expectedConfigHash: projection.configHashOf(created),
      }),
    ).toEqual([])
    expect(await repository.get(created.id)).toBeNull()
    expect(await sessionState(harness.db, active)).toBeUndefined()
  })

  test('运行时测试会话在同一笔事务里写下失效意图：配置变更阻塞（空闲即结束）、停用结束、ACL 变更按可见性结束或阻塞', async () => {
    const { repository, projection } = createMcpRepository({
      db: harness.db,
      lifecycle: createMcpTransactionLifecycle(),
    })
    const owner = await seedUser(harness.db)
    const viewer = await seedUser(harness.db)
    const created = await repository.create({
      id: `mcp-${ulid()}`,
      input: remoteInput(`mcp-${ulid().slice(-6).toLowerCase()}`),
      ownerUserId: owner,
      visibility: 'private',
      aclRevision: 0,
      now: T0,
    })
    const idle = await seedSession(harness.db, { mcpId: created.id, ownerUserId: owner })
    // 同一 (mcp, owner) 只允许一条存活会话（uniq_mcp_runtime_test_sessions_owner_mcp_live），忙碌会话挂在另一位用户名下。
    const busy = await seedSession(harness.db, {
      mcpId: created.id,
      ownerUserId: viewer,
      inFlightTurnId: 'turn-1',
    })
    const afterConfig = await repository.update({
      id: created.id,
      expectedConfigHash: projection.configHashOf(created),
      set: { config: { url: 'https://example.test/mcp-v2' }, updatedAt: T0 + 1 },
    })
    expect(await sessionState(harness.db, idle)).toMatchObject({
      status: 'ending',
      endReason: 'mcp-config-changed',
      blocked: 'mcp-config-changed',
      sessionVersion: 2,
    })
    expect(await sessionState(harness.db, busy)).toMatchObject({
      status: 'active',
      endReason: null,
      blocked: 'mcp-config-changed',
      sessionVersion: 2,
    })
    await repository.update({
      id: created.id,
      expectedConfigHash: projection.configHashOf(afterConfig),
      set: { enabled: false, updatedAt: T0 + 2 },
    })
    expect(await sessionState(harness.db, busy)).toMatchObject({
      status: 'ending',
      endReason: 'mcp-disabled',
    })

    // ACL 变更：owner 仍可见 → 阻塞到本回合后；失去授权的观众 → access-revoked（此前只有 SQLite 有这条判定）。
    // 上面的会话已进入 ending，仍占着存活唯一键，ACL 阶段换一个 MCP 承载。
    const aclMcp = await repository.create({
      id: `mcp-${ulid()}`,
      input: remoteInput(`mcp-${ulid().slice(-6).toLowerCase()}`),
      ownerUserId: owner,
      visibility: 'private',
      aclRevision: 0,
      now: T0,
    })
    const ownerSession = await seedSession(harness.db, {
      mcpId: aclMcp.id,
      ownerUserId: owner,
      inFlightTurnId: 'turn-2',
    })
    const viewerSession = await seedSession(harness.db, { mcpId: aclMcp.id, ownerUserId: viewer })
    await harness.session.transaction((tx) =>
      transitionMcpAclRuntimeTests(tx, {
        mcpId: aclMcp.id,
        ownerUserId: owner,
        visibility: 'private',
        grantedUserIds: new Set<string>(),
        now: T0 + 3,
      }),
    )
    expect(await sessionState(harness.db, ownerSession)).toMatchObject({
      status: 'active',
      blocked: 'mcp-config-changed',
    })
    expect(await sessionState(harness.db, viewerSession)).toMatchObject({
      status: 'ending',
      endReason: 'access-revoked',
    })
  })
})

test('源码锁：Mcp 聚合没有 provider 命名的仓库 / 生命周期孪生，bootstrap 只经 composition 装配', () => {
  const root = join(import.meta.dir, '..', 'src', 'modules', 'resource-catalog')
  for (const retired of [
    'infrastructure/sqliteMcpRepository.ts',
    'infrastructure/postgresqlMcpRepository.ts',
    'infrastructure/postgresqlMcpTransactionLifecycle.ts',
  ]) {
    expect(existsSync(join(root, retired)), retired).toBe(false)
  }
  expect(
    existsSync(join(import.meta.dir, '..', 'src', 'services', 'mcpRuntimeTestTransitions.ts')),
  ).toBe(false)
  for (const neutral of [
    'infrastructure/mcpRepository.ts',
    'infrastructure/mcpTransactionLifecycle.ts',
    'infrastructure/mcpRuntimeTestTransitions.ts',
    'composition/mcpOperations.ts',
    'composition/mcpProbeStore.ts',
    'composition/mcpRuntimeTestPersistence.ts',
  ]) {
    const source = readFileSync(join(root, neutral), 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n')
    expect(source, neutral).not.toMatch(
      /PostgresqlDatabaseClient|\bDbClient\b|\bdbTxSync\b|DbTxSync/,
    )
  }
  for (const file of [
    'src/server.ts',
    'src/cli/start.ts',
    'src/cli/postgresqlDaemonApplication.ts',
  ]) {
    const source = readFileSync(join(import.meta.dir, '..', file), 'utf8')
    expect(source, file).toContain('lifecycle: mcpAclRuntimeTestLifecycle()')
    expect(source, file).toContain('createMcpTransactionLifecycle()')
    expect(source, file).not.toMatch(
      /mcpRuntimeTestTransitions'|composeSqliteMcp|composePostgresqlMcp/,
    )
  }
})
