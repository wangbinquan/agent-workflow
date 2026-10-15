// RFC-359 W4-B2 批 c —— MCP playground 的会话 / 轮次 / 事件持久化与原生会话租约两对合一（约两千三百行，
// 差异全是同步 / 异步形态），两个引擎各跑一遍：会话与轮次读取、事件追加与序号、租约的认领 / 预占 / 释放 /
// 收割后修复。全量行为仍由 runtime-session-lease / rfc238 两个 SQLite 套件锁住。

import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { ulid } from 'ulid'

import type { ProviderNeutralDatabase } from '@/db/query'
import { mcpRuntimeTestSessions, mcpRuntimeTestTurns, mcps, users } from '@/db/schema'
import { createMcpRuntimeTestLeaseOperations } from '@/modules/resource-catalog/infrastructure/mcpRuntimeTestLease'
import { createMcpRuntimeTestPersistence } from '@/modules/resource-catalog/infrastructure/mcpRuntimeTestPersistence'
import { describeEachProvider } from './helpers/eachProvider'

const HASH = 'a'.repeat(64)

async function seedSessionWithTurn(db: ProviderNeutralDatabase) {
  const suffix = ulid().toLowerCase()
  const userId = `u-lease-${suffix}`
  const mcpId = `mcp-lease-${suffix}`
  const sessionId = `ts-${suffix}`
  const turnId = `turn-${suffix}`
  await db.insert(users).values({
    id: userId,
    username: userId,
    displayName: 'Lease User',
    createdAt: 1,
    updatedAt: 1,
  })
  await db.insert(mcps).values({
    id: mcpId,
    name: mcpId,
    type: 'local',
    config: '{}',
    ownerUserId: userId,
    visibility: 'private',
  })
  await db.insert(mcpRuntimeTestSessions).values({
    id: sessionId,
    mcpId,
    ownerUserId: userId,
    clientCreateId: `create-${suffix}`,
    clientCreateDigest: HASH,
    status: 'active',
    mcpConfigHash: HASH,
    runtimeRowId: `runtime-${suffix}`,
    runtimeName: 'opencode',
    runtimeProtocol: 'opencode',
    runtimeSnapshotJson: '{}',
    runtimeBinaryPath: '/mock/opencode',
    runtimeSessionId: `native-${suffix}`,
    nativeSessionState: 'ready',
    inFlightTurnId: turnId,
    turnSeq: 1,
    sessionVersion: 1,
    scratchRoot: `/tmp/${sessionId}`,
    cleanupState: 'not-started',
    createdAt: 1,
    updatedAt: 1,
  })
  await db.insert(mcpRuntimeTestTurns).values({
    id: turnId,
    sessionId,
    seq: 1,
    clientMessageId: `message-${suffix}`,
    promptText: 'first',
    status: 'running',
    hardDeadlineAt: 10_000,
    captureState: 'live',
    startedAt: 1,
    createdAt: 1,
  })
  return { userId, mcpId, sessionId, turnId, runtimeSessionId: `native-${suffix}` }
}

describeEachProvider('RFC-359 W4-B2c —— MCP playground 持久化', (harness) => {
  test('会话 / 轮次读取与事件序号', async () => {
    const db = harness.db
    const seeded = await seedSessionWithTurn(db)
    const persistence = createMcpRuntimeTestPersistence(db)
    const session = await persistence.loadSession(seeded.sessionId)
    expect(session?.id).toBe(seeded.sessionId)
    expect(await persistence.loadSession('missing')).toBeNull()
    expect((await persistence.loadTurn(seeded.turnId))?.id).toBe(seeded.turnId)
    expect((await persistence.listTurns(seeded.sessionId)).map((turn) => turn.id)).toEqual([
      seeded.turnId,
    ])
    expect(await persistence.latestEventSequence(seeded.sessionId)).toBe(0)
    expect(await persistence.loadRuntimeSessionId(seeded.sessionId)).toBe(seeded.runtimeSessionId)
    expect((await persistence.findLatestSession(seeded.mcpId, seeded.userId))?.id).toBe(
      seeded.sessionId,
    )
    expect(await persistence.listEvents(seeded.sessionId)).toEqual([])
  })
})

describeEachProvider('RFC-359 W4-B2c —— 原生会话租约', (harness) => {
  test('认领 → 释放；预占同一原生会话再释放；收割后修复', async () => {
    const db = harness.db
    const seeded = await seedSessionWithTurn(db)
    const leases = createMcpRuntimeTestLeaseOperations(db)
    const input = {
      protocol: 'opencode' as const,
      runtimeSessionId: seeded.runtimeSessionId,
      testSessionId: seeded.sessionId,
      turnId: seeded.turnId,
      leaseNonceDigest: HASH,
    }
    const first = await leases.claimNew(input)
    expect(first.runtimeSessionId).toBe(seeded.runtimeSessionId)
    expect(await leases.release(first)).toBe(true)
    // 已释放的 token 不能再释放。
    expect(await leases.release(first)).toBe(false)
    const second = await leases.preclaim(input)
    expect(second.testSessionId).toBe(seeded.sessionId)
    // 同一轮次再预占撞上持有者。
    await expect(leases.preclaim(input)).rejects.toBeDefined()
    // 收割后修复：释放该轮次遗留的持有者；再修复一次已无持有者。
    expect(await leases.repairAfterReap(seeded.sessionId, seeded.turnId, true)).toBe(true)
    expect(await leases.repairAfterReap(seeded.sessionId, seeded.turnId, true)).toBe(false)
    expect(await leases.release(second)).toBe(false)
  })
})

test('源码锁：provider 命名的孪生实现不得复活', () => {
  const infra = resolve(
    import.meta.dir,
    '..',
    'src',
    'modules',
    'resource-catalog',
    'infrastructure',
  )
  for (const stem of ['McpRuntimeTestPersistence', 'McpRuntimeTestLease']) {
    for (const provider of ['sqlite', 'postgresql']) {
      expect(existsSync(resolve(infra, `${provider}${stem}.ts`))).toBe(false)
    }
  }
})
