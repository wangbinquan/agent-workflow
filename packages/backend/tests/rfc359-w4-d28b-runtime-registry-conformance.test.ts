// RFC-359 W4-D28b —— runtime 注册表：一份实现，两个引擎各跑一遍。
//
// 合一前是 247 行（SQLite，`dbTxSync`）对 336 行（PostgreSQL，`SET TRANSACTION ISOLATION LEVEL
// SERIALIZABLE` + 40001 重放）。十二个方法同名同序、业务判据逐行相同，连会话失效逻辑都各写了
// 一份（PG 把 `transitionRuntimeTests` 内联重写，与 `legacy/mcpRuntimeTestTransitions.ts` 的同步版
// 并存）——纯重复，正是「两种数据库两份实现，随时会漂」的形态。
//
// 这套用例锁的是**合一之后两个引擎的行为仍然逐条一致**，重点放在带事务判据的三个方法上：
//   · `setRuntimeEnabled` —— 默认 runtime 不许停用 / 幂等 unchanged / 真正翻面；
//   · `deleteRuntime` —— 最后一个不许删 / 被 agent 引用不许删 / 引用解除后放行；
//   · `updateRuntime(executionProfileChanged)` —— 画像变更要在同一笔事务里把活跃试跑会话拦下。
// 前两个在 PG 上跑在 SERIALIZABLE、在 SQLite 上跑在 BEGIN IMMEDIATE，判据仍必须相同。

import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { ProviderNeutralDatabase } from '@/db/query'
import { agents, mcps, mcpRuntimeTestSessions, runtimes, users } from '@/db/schema'
import type { RuntimeInsertRecord } from '@/platform/runtime-registry/application/runtimeRegistryOperations'
import { DrizzleRuntimeRegistryPersistence } from '@/platform/runtime-registry/infrastructure/runtimeRegistryPersistence'
import { describeEachProvider } from './helpers/eachProvider'

function insertRecord(name: string): RuntimeInsertRecord {
  return {
    id: ulid(),
    name,
    protocol: 'opencode',
    binaryPath: `/tmp/${name}`,
    configDirEnv: null,
    configDirName: null,
    extraArgsJson: null,
    isSandbox: false,
    lastProbeJson: null,
    createdBy: null,
  }
}

const NO_BUILTINS: ReadonlySet<string> = new Set<string>()

/** `mcp_runtime_test_sessions_hash_shape` 要求 64 位 hex（两个引擎上都是 CHECK 约束）。 */
const HASH = 'a'.repeat(64)

function registryOf(db: ProviderNeutralDatabase): DrizzleRuntimeRegistryPersistence {
  return new DrizzleRuntimeRegistryPersistence(db)
}

describeEachProvider('RFC-359 W4-D28b —— runtime 注册表合一后两引擎同规则', (harness) => {
  test('setRuntimeEnabled：默认 runtime 停不掉、同值幂等、异值才翻面', async () => {
    const registry = registryOf(harness.db)
    const name = `rt_${ulid()}`
    await registry.insertRuntime(insertRecord(name))

    // 默认 runtime 停用会让整个产品没有可用 runtime，两个引擎都必须当场拒绝。
    expect(
      await registry.setRuntimeEnabled({
        name,
        enabled: false,
        effectiveDefaultName: name,
        now: Date.now(),
      }),
    ).toEqual({ status: 'default-cannot-disable' })

    // 同值写入不该产生一次「变更」——否则每次轮询都会广播一条假事件。
    expect(
      await registry.setRuntimeEnabled({
        name,
        enabled: true,
        effectiveDefaultName: 'someone-else',
        now: Date.now(),
      }),
    ).toEqual({ status: 'unchanged' })

    expect(
      await registry.setRuntimeEnabled({
        name,
        enabled: false,
        effectiveDefaultName: 'someone-else',
        now: Date.now(),
      }),
    ).toEqual({ status: 'changed' })
    expect((await registry.getRuntime(name))?.enabled).toBe(false)

    expect(
      await registry.setRuntimeEnabled({
        name: `missing_${ulid()}`,
        enabled: false,
        effectiveDefaultName: 'someone-else',
        now: Date.now(),
      }),
    ).toEqual({ status: 'not-found' })
  })

  test('deleteRuntime：最后一个删不掉、被 agent 引用删不掉、解除引用后才放行', async () => {
    const registry = registryOf(harness.db)
    const only = `rt_${ulid()}`
    await registry.insertRuntime(insertRecord(only))

    // 删到零会让任务无处可跑——两个引擎都在同一笔事务里数完再判。
    expect(
      await registry.deleteRuntime({ name: only, refs: {}, builtinNames: NO_BUILTINS, now: 1 }),
    ).toEqual({ status: 'last-runtime' })

    const second = `rt_${ulid()}`
    await registry.insertRuntime(insertRecord(second))
    const agentName = `agent_${ulid()}`
    await harness.db.insert(agents).values({ id: ulid(), name: agentName, runtime: second })

    const inUse = await registry.deleteRuntime({
      name: second,
      refs: {},
      builtinNames: NO_BUILTINS,
      now: 1,
    })
    expect(inUse.status).toBe('in-use')
    // 报出**是谁**在引用，否则用户只知道删不掉、不知道去哪儿解引用。
    expect(inUse.status === 'in-use' ? inUse.references : []).toContain(`agent '${agentName}'`)

    // 配置项引用同样拦下（这条判据在两个引擎上都跑在同一笔序列化事务里）。
    expect(
      (
        await registry.deleteRuntime({
          name: second,
          refs: { commitPushRuntime: second },
          builtinNames: NO_BUILTINS,
          now: 1,
        })
      ).status,
    ).toBe('in-use')

    await harness.db.delete(agents).where(eq(agents.name, agentName))
    expect(
      await registry.deleteRuntime({ name: second, refs: {}, builtinNames: NO_BUILTINS, now: 1 }),
    ).toEqual({ status: 'deleted', binaryPath: `/tmp/${second}` })
    expect(await registry.getRuntime(second)).toBeNull()
  })

  test('updateRuntime(executionProfileChanged)：同一笔事务里把活跃试跑会话拦到本回合后', async () => {
    const registry = registryOf(harness.db)
    const name = `rt_${ulid()}`
    await registry.insertRuntime(insertRecord(name))

    // 会话行对 mcps / users 都是 RESTRICT 外键，PG 上真的会拦——各自播一行自有的。
    const ownerUserId = `u_${ulid()}`
    await harness.db.insert(users).values({
      id: ownerUserId,
      username: ownerUserId,
      displayName: 'd28b',
      role: 'admin',
      status: 'active',
      forcePasswordChange: false,
      createdAt: 1,
      updatedAt: 1,
    })
    const idle = `sess_${ulid()}`
    const busy = `sess_${ulid()}`
    for (const [id, inFlightTurnId] of [
      [idle, null],
      [busy, 'turn-1'],
    ] as const) {
      // `uniq_..._owner_mcp_live`：同一 (mcp, owner) 只能有一个活着的会话，各给一个 mcp。
      const mcpId = `mcp_${ulid()}`
      await harness.db
        .insert(mcps)
        .values({ id: mcpId, name: mcpId, type: 'local', createdAt: 1, updatedAt: 1 })
      await harness.db.insert(mcpRuntimeTestSessions).values({
        id,
        mcpId,
        ownerUserId,
        clientCreateId: `create-${id}`,
        clientCreateDigest: HASH,
        status: 'active',
        mcpConfigHash: HASH,
        runtimeRowId: `row-${id}`,
        runtimeName: name,
        runtimeProtocol: 'opencode',
        runtimeSnapshotJson: '{}',
        runtimeBinaryPath: '/mock/opencode',
        runtimeSessionId: `native-${id}`,
        nativeSessionState: 'ready',
        turnSeq: 1,
        sessionVersion: 1,
        // `*_status_shape` CHECK：active 行要么在跑一个回合（无 idle 期限），
        // 要么空闲待命（有 idle 期限 + ready + 未被阻塞）。两个引擎都拦。
        idleDeadlineAt: inFlightTurnId === null ? 600_001 : null,
        inFlightTurnId,
        scratchRoot: `/tmp/${id}`,
        cleanupState: 'not-started',
        createdAt: 1,
        updatedAt: 1,
      })
    }

    await registry.updateRuntime({
      name,
      patch: { updatedAt: 2, incrementProbeFence: false, model: 'gpt-5.6' },
      executionProfileChanged: true,
    })

    const rows = await harness.db
      .select({
        id: mcpRuntimeTestSessions.id,
        status: mcpRuntimeTestSessions.status,
        endReason: mcpRuntimeTestSessions.endReason,
        blocked: mcpRuntimeTestSessions.continuationBlockedReason,
      })
      .from(mcpRuntimeTestSessions)
      .where(eq(mcpRuntimeTestSessions.runtimeName, name))
    const byId = new Map(rows.map((row) => [row.id, row]))

    // 空闲会话当场结束；正在跑一个回合的只标阻塞，等它自己收场——否则会把用户
    // 正在看的那一轮输出拦腰截断。两个引擎必须同一规则。
    expect(byId.get(idle)).toMatchObject({
      status: 'ending',
      endReason: 'runtime-profile-changed',
      blocked: 'runtime-profile-changed',
    })
    expect(byId.get(busy)).toMatchObject({
      status: 'active',
      blocked: 'runtime-profile-changed',
    })
  })

  test('invalidateInheritedRuntimeProbeReceipts：只清继承型（无 binaryPath）那批', async () => {
    const registry = registryOf(harness.db)
    const inherited = `rt_${ulid()}`
    const explicit = `rt_${ulid()}`
    await registry.insertRuntime({ ...insertRecord(inherited), binaryPath: null })
    await registry.insertRuntime(insertRecord(explicit))

    expect(await registry.invalidateInheritedRuntimeProbeReceipts({ protocols: [], now: 1 })).toBe(
      0,
    )
    expect(
      await registry.invalidateInheritedRuntimeProbeReceipts({ protocols: ['opencode'], now: 2 }),
    ).toBe(1)

    const rows = await harness.db
      .select({ name: runtimes.name, fence: runtimes.probeFence })
      .from(runtimes)
    const fenceOf = new Map(rows.map((row) => [row.name, row.fence]))
    // 显式指定过 binaryPath 的 runtime 不该被协议侧变更牵连——它的探针结果仍然有效。
    expect(fenceOf.get(explicit)).toBe(0)
    expect(fenceOf.get(inherited)).toBe(1)
  })
})
