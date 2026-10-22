import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ulid } from 'ulid'
import { nodeRuns, tasks } from '@/db/schema'
import type { InventorySnapshot } from '@agent-workflow/shared'
import { composeStreamTaskRuntimeInventoryContent } from '@/modules/task-execution/composition/taskRuntimeInventoryContent'
import { describeEachProvider } from './helpers/eachProvider'
import { createProviderHttpApplication } from './helpers/providerHttpApplication'
import { DESIGNER, freshTaskId, seedTask } from './helpers/questionDispatchFixture'

describeEachProvider('RFC-370 selected runtime inventory read', (harness) => {
  test('PostgreSQL reads hosted inventory; SQLite rejects its required provider', async () => {
    const taskId = freshTaskId(),
      nodeRunId = ulid(),
      appHome = mkdtempSync(join(tmpdir(), 'aw-inventory-content-'))
    let application: Awaited<ReturnType<typeof createProviderHttpApplication>> | undefined
    const stream = composeStreamTaskRuntimeInventoryContent()
    let snapshot: InventorySnapshot | null = null,
      reads = 0
    const input = {
      requiredProvider: 'postgresql' as const,
      token: 'tok',
      appHome,
      configPath: join(appHome, 'config.json'),
      opencodeVersion: '1.14.25',
      dbVersion: 17,
      runtimeInventoryContent: {
        async readLive(identity: { taskId: string; nodeRunId: string }) {
          expect(identity).toEqual({ taskId, nodeRunId })
          reads++
          return snapshot ?? stream.readLive(identity)
        },
      },
    }
    try {
      if (harness.applicationBinding.provider === 'sqlite') {
        await expect(createProviderHttpApplication(harness, input)).rejects.toThrow(
          'hosted-deployment-requires-postgresql',
        )
        expect(reads).toBe(0)
        return
      }
      await seedTask(harness.db, taskId)
      await harness.db.update(tasks).set({ status: 'running' }).where(eq(tasks.id, taskId))
      await harness.db.insert(nodeRuns).values({
        id: nodeRunId,
        taskId,
        nodeId: DESIGNER,
        runtime: 'opencode',
        status: 'running',
        iteration: 0,
        retryIndex: 0,
        startedAt: 1,
      })
      application = await createProviderHttpApplication(harness, input)
      const path = `/api/tasks/${taskId}/node-runs/${nodeRunId}/inventory`
      const read = () =>
        application!.app.request(path, { headers: { Authorization: 'Bearer tok' } })
      const pending = await read()
      expect(pending.status).toBe(200)
      expect(await pending.json()).toMatchObject({
        observation: { state: 'not-produced', reason: 'in-flight' },
      })
      expect(reads).toBe(1)
      snapshot = {
        captured: true,
        schemaVersion: 1,
        capturedAt: 1234,
        agents: [],
        skills: [],
        mcps: [{ name: 'remote', type: 'remote', status: 'connected', hint: null }],
        plugins: [],
      }
      const live = await read()
      expect(await live.json()).toMatchObject({
        observation: {
          state: 'captured',
          faces: { mcps: [{ name: 'remote', status: 'connected' }] },
        },
      })
      expect(reads).toBe(2)
      await harness.db
        .update(nodeRuns)
        .set({
          runtimeInventoryJson: JSON.stringify({
            state: 'malformed',
            reason: 'hosted-inventory-invalid',
            message: null,
          }),
        })
        .where(eq(nodeRuns.id, nodeRunId))
      await application.dispose()
      application = undefined
      application = await createProviderHttpApplication(harness, {
        ...input,
        runtimeInventoryContent: {
          async readLive() {
            throw new Error('stored observation must not read any file')
          },
        },
      })
      const stored = await read()
      expect(stored.status).toBe(200)
      expect(await stored.json()).toMatchObject({
        observation: { state: 'malformed', reason: 'hosted-inventory-invalid' },
      })
    } finally {
      await application?.dispose()
      rmSync(appHome, { recursive: true, force: true })
    }
  })
})
