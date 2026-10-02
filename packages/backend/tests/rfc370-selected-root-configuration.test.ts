// RFC-370: both real provider roots must share the selected asynchronous live
// configuration query. Scheduled writes/launch wait for it; read failure does
// not silently switch to the file query. No worker or real task is started.
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { DEFAULT_CONFIG, type Config } from '@agent-workflow/shared'
import type { ApplicationConfigurationQueries } from '@/modules/system-operations/public/queries'
import { createSession } from './helpers/auth/sessionStore'
import { createUser } from '@/services/users'
import { createWorkflow } from '@/services/workflow'
import { scheduledTasks } from '@/db/schema'
import { describeEachProviderHttpApplication } from './helpers/providerHttpApplicationScope'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

describeEachProviderHttpApplication(
  'RFC-370 selected live configuration roots',
  {
    token: 'selected-config-daemon',
    dbVersion: 1,
    opencodeVersion: '1.15.0',
    tempPrefix: 'aw-selected-config-',
  },
  (scope) => {
    test('discovery reads fresh selected values with the query receiver', async () => {
      let current: Config = {
        ...structuredClone(DEFAULT_CONFIG),
        publicBaseUrl: 'https://selected.example/aw',
        mcpSurfaceEnabled: false,
      }
      let reads = 0
      const configuration: ApplicationConfigurationQueries = {
        async read() {
          expect<unknown>(this).toBe(configuration)
          reads += 1
          return structuredClone(current)
        },
      }
      const opened = await scope.open({ configuration })
      const afterBoot = reads
      const first = await opened.app.request('/.well-known/mcp')
      expect(first.status).toBe(200)
      expect(await first.json()).toMatchObject({
        endpoint: 'https://selected.example/aw/api/mcp',
        enabled: false,
      })
      current = { ...current, publicBaseUrl: 'https://edited.example', mcpSurfaceEnabled: true }
      const second = await opened.app.request('/.well-known/mcp')
      expect(second.status).toBe(200)
      expect(await second.json()).toMatchObject({
        endpoint: 'https://edited.example/api/mcp',
        enabled: true,
      })
      expect(reads).toBeGreaterThanOrEqual(afterBoot + 2)
    })

    test('scheduled create/update/run await current configuration and reject without file fallback', async () => {
      let gate: {
        entered: ReturnType<typeof deferred<void>>
        release: ReturnType<typeof deferred<void>>
      } | null = null
      let failure: Error | null = null
      let reads = 0
      const configuration: ApplicationConfigurationQueries = {
        async read() {
          expect<unknown>(this).toBe(configuration)
          reads += 1
          const currentGate = gate
          currentGate?.entered.resolve()
          if (currentGate !== null) await currentGate.release.promise
          if (failure !== null) throw failure
          return structuredClone(DEFAULT_CONFIG)
        },
      }
      let launches = 0
      const opened = await scope.open({
        configuration,
        buildScheduleLaunch: () => async () => {
          launches += 1
          return { id: 'selected-config-task' }
        },
      })
      const user = await createUser(scope.harness.db, {
        username: 'selected-config-admin',
        displayName: 'Selected Config Admin',
        role: 'admin',
        password: 'selected-config-fixture-password',
      })
      const session = await createSession({ db: scope.harness.db, userId: user.id })
      const workflow = await createWorkflow(
        scope.harness.db,
        {
          name: 'Selected config workflow',
          description: '',
          definition: { $schema_version: 1, inputs: [], nodes: [], edges: [] },
        },
        { ownerUserId: user.id },
      )
      const headers = {
        Authorization: `Bearer ${session.token}`,
        'Content-Type': 'application/json',
      }
      const body = {
        name: 'selected configuration schedule',
        launchKind: 'workflow',
        launchPayload: {
          workflowId: workflow.id,
          name: 'selected task',
          repoUrl: 'https://git.invalid/repo.git',
          ref: 'main',
          inputs: {},
        },
        scheduleSpec: { kind: 'daily', at: '09:00', timezone: 'UTC' },
        enabled: true,
      }
      const rows = (name: string) =>
        scope.harness.db.select().from(scheduledTasks).where(eq(scheduledTasks.name, name))
      const waitForRead = () => {
        const next = { entered: deferred<void>(), release: deferred<void>() }
        gate = next
        return next
      }

      reads = 0
      const createGate = waitForRead()
      const create = Promise.resolve(
        opened.app.request('/api/scheduled-tasks', {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        }),
      )
      let scheduleId = ''
      try {
        await Promise.race([
          createGate.entered.promise,
          create.then((response) => {
            throw new Error(`create returned ${response.status} before reading configuration`)
          }),
        ])
        expect(await rows(body.name)).toEqual([])
        expect(launches).toBe(0)
        createGate.release.resolve()
        const response = await create
        expect(response.status).toBe(201)
        const created = (await response.json()) as { id: string; name: string }
        scheduleId = created.id
        expect(created.name).toBe(body.name)
        expect(reads).toBe(1)
      } finally {
        createGate.release.resolve()
        await create
        gate = null
      }

      reads = 0
      const updateGate = waitForRead()
      const update = Promise.resolve(
        opened.app.request(`/api/scheduled-tasks/${scheduleId}`, {
          method: 'PUT',
          headers,
          body: JSON.stringify({ name: 'updated selected schedule' }),
        }),
      )
      try {
        await Promise.race([
          updateGate.entered.promise,
          update.then((response) => {
            throw new Error(`update returned ${response.status} before reading configuration`)
          }),
        ])
        expect(await rows(body.name)).toHaveLength(1)
        expect(await rows('updated selected schedule')).toEqual([])
        updateGate.release.resolve()
        expect((await update).status).toBe(200)
        expect(reads).toBe(1)
      } finally {
        updateGate.release.resolve()
        await update
        gate = null
      }

      reads = 0
      const runGate = waitForRead()
      const run = Promise.resolve(
        opened.app.request(`/api/scheduled-tasks/${scheduleId}/run-now`, {
          method: 'POST',
          headers,
          body: '{}',
        }),
      )
      try {
        await Promise.race([
          runGate.entered.promise,
          run.then((response) => {
            throw new Error(`run returned ${response.status} before reading configuration`)
          }),
        ])
        expect(launches).toBe(0)
        runGate.release.resolve()
        const response = await run
        expect(response.status).toBe(201)
        expect(await response.json()).toMatchObject({ taskId: 'selected-config-task' })
        expect(launches).toBe(1)
        expect(reads).toBe(1)
      } finally {
        runGate.release.resolve()
        await run
        gate = null
      }

      failure = new Error('selected configuration unavailable')
      reads = 0
      const failedName = 'unacknowledged configuration schedule'
      const failed = await opened.app.request('/api/scheduled-tasks', {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...body, name: failedName }),
      })
      expect(failed.status).toBe(500)
      expect(await rows(failedName)).toEqual([])
      expect(launches).toBe(1)
      expect(reads).toBe(1)
    })
  },
)
