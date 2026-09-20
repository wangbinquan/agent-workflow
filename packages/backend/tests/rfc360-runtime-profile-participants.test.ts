// RFC-360: profile writes and Resource Catalog participants must share one real transaction.
// Inject a failure after the real session write: neither context may commit alone.
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { agents, mcps, mcpRuntimeTestSessions, users } from '@/db/schema'
import { composeRuntimeProfileParticipants } from '@/modules/resource-catalog/composition/runtimeProfileParticipants'
import { DrizzleRuntimeRegistryPersistence } from '@/modules/runtime-management/infrastructure/runtimeRegistryPersistence'
import { describeEachProvider } from './helpers/eachProvider'

describeEachProvider('RFC-360 runtime profile transaction participants', (harness) => {
  async function fixture() {
    const participants = composeRuntimeProfileParticipants()
    const store = new DrizzleRuntimeRegistryPersistence(harness.db, participants)
    const name = 'participant-runtime'
    for (const runtimeName of [name, 'other-runtime']) {
      await store.insertRuntime({
        id: ulid(),
        name: runtimeName,
        protocol: 'opencode',
        binaryPath: null,
        configDirEnv: null,
        configDirName: null,
        extraArgsJson: null,
        isSandbox: false,
        lastProbeJson: '{}',
        createdBy: null,
      })
    }
    const ownerUserId = ulid()
    await harness.db.insert(users).values({
      id: ownerUserId,
      username: ownerUserId,
      displayName: 'runtime participant',
      role: 'admin',
      status: 'active',
      forcePasswordChange: false,
      createdAt: 1,
      updatedAt: 1,
    })
    const mcpId = ulid()
    const sessionId = ulid()
    await harness.db.insert(mcps).values({ id: mcpId, name: mcpId, type: 'local' })
    await harness.db.insert(mcpRuntimeTestSessions).values({
      id: sessionId,
      mcpId,
      ownerUserId,
      clientCreateId: sessionId,
      clientCreateDigest: 'a'.repeat(64),
      status: 'active',
      mcpConfigHash: 'a'.repeat(64),
      runtimeRowId: (await store.getRuntime(name))!.id,
      runtimeName: name,
      runtimeProtocol: 'opencode',
      runtimeSnapshotJson: '{}',
      runtimeBinaryPath: '/mock/opencode',
      runtimeSessionId: ulid(),
      nativeSessionState: 'ready',
      turnSeq: 1,
      sessionVersion: 1,
      idleDeadlineAt: 600001,
      inFlightTurnId: null,
      scratchRoot: `/tmp/${sessionId}`,
      cleanupState: 'not-started',
      createdAt: 1,
      updatedAt: 1,
    })
    async function session() {
      return (
        await harness.db
          .select()
          .from(mcpRuntimeTestSessions)
          .where(eq(mcpRuntimeTestSessions.id, sessionId))
      )[0]
    }
    return { participants, store, name, session }
  }

  test.each(['update', 'disable', 'delete', 'inherited'] as const)(
    '%s rolls back both the profile and actual MCP session when invalidation fails',
    async (operation) => {
      const f = await fixture()
      const before = { runtime: await f.store.getRuntime(f.name), session: await f.session() }
      let called = false
      const store = new DrizzleRuntimeRegistryPersistence(harness.db, {
        usage: f.participants.usage,
        testInvalidation: {
          async invalidate(transaction, input) {
            await f.participants.testInvalidation.invalidate(transaction, input)
            const changed = (
              await transaction
                .select()
                .from(mcpRuntimeTestSessions)
                .where(eq(mcpRuntimeTestSessions.runtimeName, f.name))
            )[0]
            expect(changed?.sessionVersion).toBe(2)
            called = true
            throw new Error('injected-after-real-invalidation')
          },
        },
      })
      const mutation = () => {
        switch (operation) {
          case 'update':
            return store.updateRuntime({
              name: f.name,
              patch: { model: 'changed', incrementProbeFence: true, updatedAt: 2 },
              executionProfileChanged: true,
            })
          case 'disable':
            return store.setRuntimeEnabled({
              name: f.name,
              enabled: false,
              effectiveDefaultName: 'other-runtime',
              now: 2,
            })
          case 'delete':
            return store.deleteRuntime({
              name: f.name,
              refs: {},
              builtinNames: new Set(),
              now: 2,
            })
          case 'inherited':
            return store.invalidateInheritedRuntimeProbeReceipts({
              protocols: ['opencode'],
              now: 2,
            })
        }
      }
      await expect(mutation()).rejects.toThrow('injected-after-real-invalidation')
      expect(called).toBe(true)
      expect({ runtime: await f.store.getRuntime(f.name), session: await f.session() }).toEqual(
        before,
      )
    },
  )

  test('reference inspection sees an uncommitted agent in the same transaction and preserves its name', async () => {
    const f = await fixture()
    const agentId = ulid()
    await expect(
      harness.session.serializable(async (transaction) => {
        await transaction
          .insert(agents)
          .values({ id: agentId, name: 'new-reference', runtime: f.name })
        expect(
          await f.store.deleteRuntime({
            name: f.name,
            refs: {},
            builtinNames: new Set(),
            now: 2,
          }),
        ).toEqual({ status: 'in-use', references: ["agent 'new-reference'"] })
        throw new Error('rollback-reference')
      }),
    ).rejects.toThrow('rollback-reference')
    expect(await harness.db.select().from(agents).where(eq(agents.id, agentId))).toEqual([])
    expect(await f.store.getRuntime(f.name)).not.toBeNull()
    expect((await f.session())?.status).toBe('active')
  })
})
