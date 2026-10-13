import { expect, spyOn, test } from 'bun:test'
import { ConfigSchema, DEFAULT_CONFIG } from '@agent-workflow/shared'
import { eq } from 'drizzle-orm'
import { createSecretBoxFromKey } from '@/auth/secretBox'
import { cachedRepos, recoveryEvents, tasks, workflows } from '@/db/schema'
import { composeSqliteRepositoryWorkspaceStore } from '@/modules/source-control/composition'
import { composeResourceLimitOperations } from '@/modules/system-operations/composition/resourceLimits'
import { refreshDueRepos } from '@/services/submoduleRefresh'
import { enforceLimits } from '@/services/limits'
import { notifyConfigApplied } from '@/services/configAppliedListeners'
import {
  bindBatchImportGcHostOwner,
  bindScheduledBackupHostOwner,
  bindSubmoduleRefreshHostOwner,
  bindResourceLimitsHostOwner,
} from '../src/cli/daemonHostExecutionOwners'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'
import { deferred } from './helpers/taskHostExecution'

function grant(harness: ProviderHarness) {
  let active = true
  const context = {
    generation: 'periodic-owner-generation',
    reference: Object.freeze({}),
    current() {
      expect(this).toBe(context)
      return active
    },
  }
  return {
    context,
    scope: {
      provider: harness.applicationBinding.provider,
      generationId: context.generation,
      operationId: 'periodic-owner',
    },
    lose() {
      active = false
    },
  }
}
const secretBox = createSecretBoxFromKey(Buffer.alloc(32, 11))
const appHome = '/fixture/not-used-for-backup-or-refresh'
const config = () => ({ ...ConfigSchema.parse(DEFAULT_CONFIG), backupIntervalMs: 123_456 })

async function seedLimitedTasks(harness: ProviderHarness) {
  const now = Date.now(),
    definition = '{"$schema_version":2,"inputs":[],"nodes":[],"edges":[]}'
  await harness.db.insert(workflows).values({
    id: 'host-limits-workflow',
    name: 'host limits',
    definition,
    createdAt: now,
    updatedAt: now,
  })
  for (const id of ['host-first', 'host-second'])
    await harness.db.insert(tasks).values({
      id,
      name: id,
      workflowId: 'host-limits-workflow',
      workflowSnapshot: definition,
      repoPath: '/fixture/repo',
      worktreePath: `/fixture/${id}`,
      baseBranch: 'main',
      branch: `aw/${id}`,
      status: 'running',
      inputs: '{}',
      startedAt: now - 60_000,
      runningSince: now - 60_000,
      runningMs: 0,
      maxDurationMs: 1,
      executionLineageId: id,
      lineageSlotPathJson: JSON.stringify([
        { stableNodeKey: 'task-root', frozenOccurrenceKey: id, workflowRevision: null },
      ]),
    })
}

describeEachProvider(
  'RFC-370 selected scheduled owners and actual provider operations',
  (harness) => {
    test.each(['backup', 'refresh', 'gc'] as const)(
      '%s loses authority during its configuration read before arming any timer',
      async (kind) => {
        const entered = deferred(),
          release = deferred<ReturnType<typeof config>>()
        const configuration = {
          read() {
            entered.resolve()
            return release.promise
          },
        }
        const owner =
          kind === 'backup'
            ? bindScheduledBackupHostOwner({
                configuration,
                appHome,
                createScheduledBackup: async () => {
                  throw new Error('unexpected backup')
                },
                onBackupSettled: () => {},
              })
            : kind === 'gc'
              ? bindBatchImportGcHostOwner(configuration)
              : bindSubmoduleRefreshHostOwner({
                  store: composeSqliteRepositoryWorkspaceStore(harness.db),
                  configuration,
                  notificationKey: 'host-refresh-late-config',
                  appHome,
                  secretBox,
                })
        const g = grant(harness),
          interval = spyOn(globalThis, 'setInterval'),
          timeout = spyOn(globalThis, 'setTimeout')
        try {
          const starting = owner.start(g)
          await entered.promise
          g.lose()
          release.resolve(config())
          await expect(starting).rejects.toThrow('execution-unavailable')
          expect(interval).not.toHaveBeenCalled()
          expect(timeout).not.toHaveBeenCalled()
        } finally {
          release.resolve(config())
          interval.mockRestore()
          timeout.mockRestore()
        }
      },
    )

    test('scheduled backup drains its actual request and fences a new prune wake after loss', async () => {
      const entered = deferred(),
        release = deferred()
      let requests = 0,
        wakes = 0
      const owner = bindScheduledBackupHostOwner({
        configuration: { read: config },
        appHome,
        async createScheduledBackup(input) {
          expect(input).toEqual({ kind: 'scheduled', appHome })
          requests++
          entered.resolve()
          await release.promise
        },
        onBackupSettled() {
          wakes++
        },
      })
      const interval = spyOn(globalThis, 'setInterval'),
        g = grant(harness)
      const handle = await owner.start(g)
      try {
        const index = interval.mock.calls.findIndex((args) => args[1] === 123_456)
        const args = interval.mock.calls[index],
          result = interval.mock.results[index]
        if (args === undefined || result?.type !== 'return' || typeof args[0] !== 'function')
          throw new Error('original backup timer missing')
        clearInterval(result.value)
        args[0](...args.slice(2))
        await entered.promise
        g.lose()
        await owner.quiesceAuthorityLoss({ context: g.context, handle })
        let drained = false
        const draining = Promise.resolve(
          owner.drainAuthorityLoss({ context: g.context, handle }),
        ).then(() => {
          drained = true
        })
        await Promise.resolve()
        expect(drained).toBe(false)
        await expect(owner.start(grant(harness))).rejects.toThrow('prior-lifetime-not-drained')
        release.resolve()
        await draining
        expect({ requests, wakes }).toEqual({ requests: 1, wakes: 0 })
      } finally {
        release.resolve()
        await handle.stop()
        await handle.drain()
        interval.mockRestore()
      }
    })

    test('a config change during preparation is applied when the actual lifetime activates', async () => {
      const active = deferred<boolean>(),
        configured = deferred()
      const g = grant(harness)
      let ready = false,
        reads = 0
      let live = { ...config(), submoduleAutoRefresh: { enabled: false, intervalMs: 60_000 } }
      const configuration = {
        read() {
          reads += 1
          if (reads === 2) configured.resolve()
          return live
        },
      }
      const notificationKey = `host-refresh-activation-${harness.applicationBinding.provider}`
      const owner = bindSubmoduleRefreshHostOwner({
        store: composeSqliteRepositoryWorkspaceStore(harness.db),
        configuration,
        notificationKey,
        appHome,
        secretBox,
      })
      const timeout = spyOn(globalThis, 'setTimeout')
      const handle = await owner.start({
        scope: g.scope,
        context: {
          ...g.context,
          current: g.context.current.bind(g.context),
          whenActive: active.promise,
          canDispatch: () => ready && g.context.current(),
        },
      })
      try {
        const before = timeout.mock.calls.length
        live = { ...live, submoduleAutoRefresh: { enabled: true, intervalMs: 60_000 } }
        await notifyConfigApplied(notificationKey, live)
        expect(reads).toBe(1)
        expect(timeout.mock.calls.length).toBe(before)
        ready = true
        active.resolve(true)
        await configured.promise
        expect(reads).toBe(2)
        expect(timeout.mock.calls.length).toBeGreaterThan(before)
      } finally {
        active.resolve(false)
        await handle.stop()
        await handle.drain()
        timeout.mockRestore()
      }
    })

    test('refresh owner unregisters notifications and waits for the already accepted hot configuration read', async () => {
      const release = deferred<ReturnType<typeof config>>(),
        entered = deferred()
      let reads = 0
      const live = { ...config(), submoduleAutoRefresh: { enabled: true, intervalMs: 60_000 } }
      const configuration = {
        read() {
          reads++
          if (reads === 1) return live
          entered.resolve()
          return release.promise
        },
      }
      const notificationKey = `host-refresh-notification-${harness.applicationBinding.provider}`
      const owner = bindSubmoduleRefreshHostOwner({
        store: composeSqliteRepositoryWorkspaceStore(harness.db),
        configuration,
        notificationKey,
        appHome,
        secretBox,
      })
      const g = grant(harness),
        timeout = spyOn(globalThis, 'setTimeout')
      const handle = await owner.start(g)
      try {
        const notification = notifyConfigApplied(notificationKey, live)
        await entered.promise
        const armed = timeout.mock.calls.length
        g.lose()
        await owner.quiesceAuthorityLoss({ context: g.context, handle })
        let drained = false
        const draining = Promise.resolve(
          owner.drainAuthorityLoss({ context: g.context, handle }),
        ).then(() => {
          drained = true
        })
        await notifyConfigApplied(notificationKey, live)
        expect(reads).toBe(2)
        expect(drained).toBe(false)
        release.resolve(live)
        await notification
        await draining
        expect(timeout.mock.calls).toHaveLength(armed)
      } finally {
        release.resolve(live)
        await handle.stop()
        await handle.drain()
        timeout.mockRestore()
      }
    })

    test('a held repository candidate read after loss never stamps unattempted mirrors as refreshed', async () => {
      const now = Date.now(),
        store = composeSqliteRepositoryWorkspaceStore(harness.db)
      await harness.db.insert(cachedRepos).values({
        id: 'host-unattempted-repo',
        urlHash: 'host-unattempted-hash',
        urlEnc: secretBox.seal('https://fixture.invalid/repo.git'),
        urlRedacted: 'https://fixture.invalid/repo.git',
        localPath: '/fixture/unattempted-repo',
        createdAt: now,
        lastFetchedAt: now,
        lastAutoRefreshAt: null,
      })
      const entered = deferred(),
        release = deferred()
      const list = store.listDueCachedRepos.bind(store)
      const query = spyOn(store, 'listDueCachedRepos').mockImplementation(async (input) => {
        const rows = await list(input)
        entered.resolve()
        await release.promise
        return rows
      })
      const stamp = spyOn(store, 'stampAutoRefreshed'),
        g = grant(harness)
      try {
        const refreshing = refreshDueRepos(
          store,
          { submoduleAutoRefresh: { enabled: true, intervalMs: 60_000 } },
          { execution: g.context, appHome, secretBox },
        )
        await entered.promise
        g.lose()
        release.resolve()
        expect(await refreshing).toEqual({ refreshed: 0, failed: 0 })
        expect(stamp).not.toHaveBeenCalled()
        expect((await harness.db.select().from(cachedRepos))[0]?.lastAutoRefreshAt).toBeNull()
      } finally {
        release.resolve()
        stamp.mockRestore()
        query.mockRestore()
      }
    })

    test('resource-limit owner stops before the next cancellation and drains the first actual reason and audit', async () => {
      await seedLimitedTasks(harness)
      const entered = deferred(),
        release = deferred(),
        canceled: string[] = []
      const operations = composeResourceLimitOperations({
        db: harness.db,
        async cancelTask(id) {
          canceled.push(id)
          entered.resolve()
          await release.promise
          await harness.db.update(tasks).set({ status: 'canceled' }).where(eq(tasks.id, id))
        },
      })
      const owner = bindResourceLimitsHostOwner({
          operations,
          onError(error) {
            throw error
          },
        }),
        g = grant(harness),
        timeout = spyOn(globalThis, 'setTimeout')
      const handle = await owner.start(g)
      try {
        for (let i = 0; i < 12; i++) await Promise.resolve()
        const args = timeout.mock.calls[0],
          result = timeout.mock.results[0]
        if (args === undefined || result?.type !== 'return' || typeof args[0] !== 'function')
          throw new Error('original limits polling timer missing')
        clearTimeout(result.value)
        args[0](...args.slice(2))
        await entered.promise
        g.lose()
        await owner.quiesceAuthorityLoss({ context: g.context, handle })
        let drained = false
        const draining = Promise.resolve(
          owner.drainAuthorityLoss({ context: g.context, handle }),
        ).then(() => {
          drained = true
        })
        await Promise.resolve()
        expect(drained).toBe(false)
        release.resolve()
        await draining
        expect(canceled).toHaveLength(1)
        const rows = await harness.db.select().from(tasks)
        expect(rows.filter((row) => row.status === 'running')).toHaveLength(1)
        expect(rows.find((row) => row.id === canceled[0])?.errorSummary).toBe(
          'task-time-limit-exceeded',
        )
        expect(await harness.db.select().from(recoveryEvents)).toMatchObject([
          { taskId: canceled[0], kind: 'limit-cancel' },
        ])
      } finally {
        release.resolve()
        await handle.stop()
        await handle.drain()
        timeout.mockRestore()
      }
    })

    test('loss while checking a task limit does not turn a late read into cancellation or audit', async () => {
      await seedLimitedTasks(harness)
      const entered = deferred(),
        release = deferred(),
        canceled: string[] = []
      const operations = composeResourceLimitOperations({
        db: harness.db,
        async cancelTask(id) {
          canceled.push(id)
        },
      })
      const read = operations.persistence.listCallRows.bind(operations.persistence)
      const held = spyOn(operations.persistence, 'listCallRows').mockImplementation(async (id) => {
        const rows = await read(id)
        entered.resolve()
        await release.promise
        return rows
      })
      const g = grant(harness)
      try {
        const checking = enforceLimits(operations, Date.now(), g.context)
        await entered.promise
        g.lose()
        release.resolve()
        expect((await checking).canceled).toEqual([])
        expect(canceled).toEqual([])
        expect(await harness.db.select().from(recoveryEvents)).toEqual([])
      } finally {
        release.resolve()
        held.mockRestore()
      }
    })
  },
)
