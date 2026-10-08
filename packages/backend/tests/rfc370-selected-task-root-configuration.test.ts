// RFC-370: exercise both real provider roots, not a stand-in coordinator. Capture
// the real Task run binding request after live settings ACK and keep original files.
import { expect, test } from 'bun:test'
import { DEFAULT_CONFIG, type Config, REPO_PREP_NODE_ID } from '@agent-workflow/shared'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq, and } from 'drizzle-orm'
import { ulid } from 'ulid'
import { tasks, nodeRuns, memories, fusions } from '@/db/schema'
import { createUser } from '@/services/users'
import {
  composeApplicationConfigurationBinding,
  type ApplicationConfigurationBinding,
} from '@/modules/system-operations/composition/applicationConfiguration'
import type { TaskDriveRequest } from '@/modules/task-execution/application/ports/taskExecutionTopology'
import type { TaskRunRootSelection } from '@/modules/task-execution/composition/taskRunSelection'
import { describeEachProviderHttpApplication } from './helpers/providerHttpApplicationScope'
import { createSession } from './helpers/auth/sessionStore'
import { chosenTaskRuns, unusedTaskRunContents } from './helpers/taskRunSelection'
import { composeRuntimeRegistryOperations } from './helpers/runtimeRegistryComposition'
import { awaitTaskDriverIdle } from '@/modules/task-execution/infrastructure/taskDriverLifecycle'
import { ownershipTokenKey } from '@/modules/task-execution/domain/ownership'

function held() {
  return { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() }
}
class SelectedTaskConfiguration {
  current: Config = {
    ...structuredClone(DEFAULT_CONFIG),
    defaultRuntime: 'claude-code',
    commitPushRuntime: 'opencode',
    maxConcurrentNodes: 3,
    defaultNodeRetries: 0,
    sessionRestartBudget: 0,
    gitCloneTimeoutMs: 500,
    gitBaselineSyncWindowMs: 0,
    subagentLiveCapture: { pollMs: 321, consecutiveFailureLimit: 4 },
  }
  gate: ReturnType<typeof held> | undefined
  readonly receivers: unknown[] = []
  async load() {
    this.receivers.push(this)
    const gate = this.gate
    gate?.entered.resolve()
    if (gate !== undefined) await gate.release.promise
    return structuredClone(this.current)
  }
  async previewPatch() {
    return structuredClone(this.current)
  }
  async applyPatch() {
    return structuredClone(this.current)
  }
}

describeEachProviderHttpApplication(
  'RFC-370 selected Task runtime in actual HTTP roots',
  {
    token: 'rfc370-selected-task-root',
    dbVersion: 1,
    opencodeVersion: '1.15.0',
    tempPrefix: 'aw-selected-task-root-',
  },
  (scope) => {
    async function setup(applicationConfiguration?: ApplicationConfigurationBinding) {
      const storage = new SelectedTaskConfiguration()
      await composeRuntimeRegistryOperations(scope.harness.db).seedBuiltinRuntimes()
      const drives: TaskDriveRequest[] = []
      const chosen = chosenTaskRuns(unusedTaskRunContents())
      const selection: TaskRunRootSelection = {
        ...chosen.selection,
        configurationFor(request) {
          drives.push(request)
          return chosen.selection.configurationFor(request)
        },
      }
      const opened = await scope.open({
        applicationConfiguration:
          applicationConfiguration ??
          composeApplicationConfigurationBinding({
            kind: 'selected',
            persistence: storage,
            notificationKey: `selected-task-${ulid()}`,
          }),
        taskRunSelection: selection,
        configuration: { read: () => structuredClone(DEFAULT_CONFIG) },
        config: {
          defaultRuntime: 'opencode',
          defaultNodeRetries: 8,
          gitBaselineSyncWindowMs: 60_000,
        },
      })
      const user = await createUser(scope.harness.db, {
        username: `task-live-${ulid().toLowerCase()}`,
        displayName: 'Live Task Configuration',
        email: 'task-config@fixtures.invalid',
        role: 'admin',
        password: 'rfc370-selected-task-fixture',
      })
      const session = await createSession({ db: scope.harness.db, userId: user.id })
      async function request(path: string, body?: unknown, method = 'POST') {
        return await opened.app.request(path, {
          method,
          headers: { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
      }
      const created = await request('/api/workflows', {
        name: `live-task-${ulid()}`,
        description: '',
        definition: { $schema_version: 1, inputs: [], nodes: [], edges: [] },
      })
      expect(created.status, await created.clone().text()).toBe(201)
      const workflowId = ((await created.json()) as { id: string }).id
      const file = join(opened.appHome, 'config.json'),
        fileBefore = readFileSync(file, 'utf8')
      storage.receivers.length = 0
      async function waitTask(id: string, status: string) {
        const deadline = Date.now() + 12_000
        for (;;) {
          const row = (
            await scope.harness.db.select().from(tasks).where(eq(tasks.id, id)).limit(1)
          )[0]
          if (row?.status === status) {
            if (opened.taskExecution.provider === 'postgresql') {
              const registry = opened.taskExecution.selected.executionModule.runtimeRegistry
              const token = registry.tokenForTask(id)
              if (token !== null) {
                const stopped = await registry.awaitStopped({
                  token,
                  tokenKey: ownershipTokenKey(token),
                })
                if (stopped.kind === 'unreaped') {
                  throw new Error(`task ${id} stopped with unreaped work: ${stopped.code}`)
                }
              }
            } else {
              await awaitTaskDriverIdle(id)
            }
            return row
          }
          if (Date.now() >= deadline)
            throw new Error(`task ${id} did not reach ${status}: ${row?.status}`)
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
      }
      function expectSelectedDrive(index: number, runtime: string) {
        const drive = drives[index]
        expect(drive).toBeDefined()
        expect(drive?.defaultRuntime).toBe(runtime)
        expect(drive?.defaultNodeRetries).toBe(0)
        expect(drive?.sessionRestartBudget).toBe(0)
        expect(drive?.commitPushRuntime).toBe('opencode')
        expect(drive?.maxConcurrentNodes).toBe(3)
        expect(drive?.subagentLiveCapture).toEqual(storage.current.subagentLiveCapture)
        expect(storage.receivers.every((receiver) => receiver === storage)).toBe(true)
        expect(readFileSync(file, 'utf8')).toBe(fileBefore)
      }
      return {
        storage,
        drives,
        opened,
        request,
        workflowId,
        waitTask,
        expectSelectedDrive,
        file,
        fileBefore,
      }
    }

    test('an explicit file binding supplies live Task settings instead of the root default file', async () => {
      const home = mkdtempSync(join(tmpdir(), 'aw-explicit-task-config-')),
        selectedFile = join(home, 'selected-config.json')
      let f: Awaited<ReturnType<typeof setup>> | undefined
      const first = {
        ...structuredClone(DEFAULT_CONFIG),
        defaultRuntime: 'claude-code',
        commitPushRuntime: 'opencode',
        defaultNodeRetries: 0,
        sessionRestartBudget: 0,
        maxConcurrentNodes: 5,
        gitCloneTimeoutMs: 1_234,
        gitBaselineSyncWindowMs: 0,
        subagentLiveCapture: { pollMs: 111, consecutiveFailureLimit: 2 },
      }
      writeFileSync(selectedFile, JSON.stringify(first))
      try {
        f = await setup(
          composeApplicationConfigurationBinding({ kind: 'file', configPath: selectedFile }),
        )
        expect(f.file).not.toBe(selectedFile)
        for (const [index, config] of [
          first,
          {
            ...first,
            defaultRuntime: 'opencode',
            maxConcurrentNodes: 7,
            gitCloneTimeoutMs: 2_345,
            subagentLiveCapture: { pollMs: 222, consecutiveFailureLimit: 3 },
          },
        ].entries()) {
          writeFileSync(selectedFile, JSON.stringify(config))
          const response = await f.request('/api/tasks', {
            workflowId: f.workflowId,
            name: `explicit file ${index}`,
            scratch: true,
          })
          expect(response.status, await response.clone().text()).toBe(201)
          await f.waitTask(((await response.json()) as { id: string }).id, 'done')
          const drive = f.drives[index]
          if (drive === undefined) throw new Error('real Task driver did not receive its settings')
          expect(drive.defaultRuntime).toBe(config.defaultRuntime)
          expect(drive.defaultNodeRetries).toBe(0)
          expect(drive.sessionRestartBudget).toBe(0)
          expect(drive.maxConcurrentNodes).toBe(config.maxConcurrentNodes)
          expect(drive.subagentLiveCapture).toEqual(config.subagentLiveCapture)
          expect(readFileSync(f.file, 'utf8')).toBe(f.fileBefore)
        }
        expect(f.storage.receivers).toEqual([])
      } finally {
        await f?.opened.dispose()
        rmSync(home, { recursive: true, force: true })
      }
    }, 30_000)

    test('manual launch waits for selected ACK and the next launch sees changed settings in the real driver', async () => {
      const f = await setup(),
        gate = held()
      f.storage.gate = gate
      let settled = false
      const pending = f
        .request('/api/tasks', {
          workflowId: f.workflowId,
          name: 'live manual',
          scratch: true,
        })
        .then((response) => {
          settled = true
          return response
        })
      try {
        await gate.entered.promise
        expect(settled).toBe(false)
        expect(f.drives).toEqual([])
        gate.release.resolve()
        const response = await pending
        expect(response.status, await response.clone().text()).toBe(201)
        const first = (await response.json()) as { id: string }
        await f.waitTask(first.id, 'done')
        f.expectSelectedDrive(0, 'claude-code')
        f.storage.gate = undefined
        f.storage.current = { ...f.storage.current, defaultRuntime: 'opencode' }
        const second = await f.request('/api/tasks', {
          workflowId: f.workflowId,
          name: 'live manual after',
          scratch: true,
        })
        expect(second.status, await second.clone().text()).toBe(201)
        await f.waitTask(((await second.json()) as { id: string }).id, 'done')
        f.expectSelectedDrive(1, 'opencode')
      } finally {
        gate.release.resolve()
        await pending
      }
    }, 30_000)

    test('the real Fusion route waits for the same selected reader without constructing a Task or reading its file', async () => {
      const f = await setup(),
        gate = held()
      f.storage.gate = gate
      let settled = false
      const pending = f.request('/api/fusions', undefined, 'GET').then((response) => {
        settled = true
        return response
      })
      try {
        await Promise.race([
          gate.entered.promise,
          pending.then(() => {
            throw new Error('Fusion returned before selected configuration ACK')
          }),
        ])
        expect(settled).toBe(false)
        expect(f.drives).toEqual([])
        gate.release.resolve()
        const response = await pending
        expect(response.status, await response.clone().text()).toBe(200)
        expect(await response.json()).toEqual([])
        expect(f.storage.receivers).toHaveLength(3)
        expect(f.storage.receivers.every((receiver) => receiver === f.storage)).toBe(true)
        expect(readFileSync(f.file, 'utf8')).toBe(f.fileBefore)
        f.storage.gate = undefined
        f.storage.current = { ...f.storage.current, defaultRuntime: 'opencode' }
        expect((await f.request('/api/fusions', undefined, 'GET')).status).toBe(200)
        expect(f.storage.receivers).toHaveLength(6)
        expect(f.drives).toEqual([])
        expect(readFileSync(f.file, 'utf8')).toBe(f.fileBefore)
      } finally {
        gate.release.resolve()
        await pending
      }
    }, 30_000)

    test('scheduled run-now reaches the same selected config and driver after ACK', async () => {
      const f = await setup()
      const created = await f.request('/api/scheduled-tasks', {
        name: 'live scheduled',
        launchKind: 'workflow',
        launchPayload: {
          workflowId: f.workflowId,
          name: 'live scheduled task',
          scratch: true,
        },
        scheduleSpec: { kind: 'daily', at: '09:00', timezone: 'UTC' },
        enabled: false,
      })
      expect(created.status, await created.clone().text()).toBe(201)
      const schedule = (await created.json()) as { id: string },
        gate = held()
      f.storage.gate = gate
      let settled = false
      const pending = f.request(`/api/scheduled-tasks/${schedule.id}/run-now`).then((response) => {
        settled = true
        return response
      })
      try {
        await gate.entered.promise
        expect(settled).toBe(false)
        expect(f.drives).toEqual([])
        gate.release.resolve()
        const response = await pending
        expect(response.status, await response.clone().text()).toBe(201)
        const fired = (await response.json()) as { taskId: string }
        await f.waitTask(fired.taskId, 'done')
        f.expectSelectedDrive(0, 'claude-code')
      } finally {
        gate.release.resolve()
        await pending
      }
    }, 30_000)

    test('Fusion create reaches the real engine launch with selected settings and the next launch sees the hot update', async () => {
      const f = await setup()
      const created = await f.request('/api/skills', {
        name: `live-fusion-${ulid().toLowerCase()}`,
        description: 'Task configuration handoff',
        bodyMd: 'Original skill body',
      })
      expect(created.status, await created.clone().text()).toBe(201)
      const skill = (await created.json()) as { id: string },
        memoryId = ulid()
      await scope.harness.db.insert(memories).values({
        id: memoryId,
        scopeType: 'global',
        scopeId: null,
        title: 'Selected Fusion task settings',
        bodyMd: 'Preserve the original skill body.',
        tags: '[]',
        status: 'approved',
        sourceKind: 'manual',
        createdAt: Date.now(),
        version: 1,
      })
      const gate = held()
      f.storage.gate = gate
      let settled = false
      const payload = { skillId: skill.id, memoryIds: [memoryId], intent: 'Check the handoff' }
      const pending = f.request('/api/fusions', payload).then((response) => {
        settled = true
        return response
      })
      try {
        await Promise.race([
          gate.entered.promise,
          pending.then(async (response) => {
            throw new Error(
              `Fusion missed selected ACK: ${response.status} ${await response.clone().text()}`,
            )
          }),
        ])
        expect(settled).toBe(false)
        expect(f.drives).toEqual([])
        expect(await scope.harness.db.select().from(tasks)).toEqual([])
        expect(await scope.harness.db.select().from(fusions)).toEqual([])
        gate.release.resolve()
        const response = await pending
        expect(response.status, await response.clone().text()).toBe(201)
        const first = (await response.json()) as { currentTaskId: string | null }
        expect(first.currentTaskId).not.toBeNull()
        if (first.currentTaskId === null) throw new Error('Fusion did not hand off its Task')
        // The complete selected family deliberately rejects agent effects. This
        // oracle covers the actual route/workspace/engine configuration handoff.
        await f.waitTask(first.currentTaskId, 'failed')
        f.expectSelectedDrive(0, 'claude-code')
        f.storage.gate = undefined
        f.storage.current = { ...f.storage.current, defaultRuntime: 'opencode' }
        const next = await f.request('/api/fusions', payload)
        expect(next.status, await next.clone().text()).toBe(201)
        const second = (await next.json()) as { currentTaskId: string | null }
        expect(second.currentTaskId).not.toBeNull()
        if (second.currentTaskId === null)
          throw new Error('Second Fusion did not hand off its Task')
        await f.waitTask(second.currentTaskId, 'failed')
        f.expectSelectedDrive(1, 'opencode')
        expect(f.drives).toHaveLength(2)
      } finally {
        gate.release.resolve()
        await pending
      }
    }, 30_000)

    test('resume awaits the root runtime object before child lifecycle and uses current settings', async () => {
      const f = await setup()
      const response = await f.request('/api/tasks', {
        workflowId: f.workflowId,
        name: 'resume live',
        scratch: true,
      })
      expect(response.status, await response.clone().text()).toBe(201)
      const task = (await response.json()) as { id: string }
      await f.waitTask(task.id, 'done')
      // A persisted interrupted fixture keeps the real workspace, owner and lineage.
      await scope.harness.db
        .update(tasks)
        .set({ status: 'interrupted' })
        .where(eq(tasks.id, task.id))
      f.storage.current = { ...f.storage.current, defaultRuntime: 'opencode' }
      const gate = held()
      f.storage.gate = gate
      let settled = false
      const pending = f.request(`/api/tasks/${task.id}/resume`).then((value) => {
        settled = true
        return value
      })
      try {
        await gate.entered.promise
        expect(settled).toBe(false)
        expect(f.drives).toHaveLength(1)
        gate.release.resolve()
        const resumed = await pending
        expect(resumed.status, await resumed.clone().text()).toBe(200)
        await f.waitTask(task.id, 'done')
        f.expectSelectedDrive(1, 'opencode')
      } finally {
        gate.release.resolve()
        await pending
      }
    }, 30_000)

    test('deferred preparation and its retry use the selected zero baseline window instead of the file sixty seconds', async () => {
      const f = await setup()
      const response = await f.request('/api/tasks', {
        workflowId: f.workflowId,
        name: 'live preparation',
        repoUrl: 'http://127.0.0.1:1/configuration-closure.git',
      })
      expect(response.status, await response.clone().text()).toBe(201)
      const task = (await response.json()) as { id: string }
      const failed = await f.waitTask(task.id, 'failed')
      expect(failed.errorMessage).not.toBeNull()
      const prep = (
        await scope.harness.db
          .select()
          .from(nodeRuns)
          .where(and(eq(nodeRuns.taskId, task.id), eq(nodeRuns.nodeId, REPO_PREP_NODE_ID)))
      )[0]
      expect(prep?.status).toBe('failed')
      expect(f.storage.receivers.length).toBeGreaterThanOrEqual(6)
      expect(readFileSync(f.file, 'utf8')).toBe(f.fileBefore)
      // SQLite acknowledges background preparation; the original PostgreSQL retry
      // records the failed attempt before returning its synchronous clone failure.
      const retry = await f.request(`/api/tasks/${task.id}/nodes/${prep?.id}/retry`)
      expect(retry.status, await retry.clone().text()).toBe(
        f.opened.taskExecution.provider === 'postgresql' ? 400 : 200,
      )
      if (f.opened.taskExecution.provider === 'postgresql') {
        expect(await retry.json()).toMatchObject({
          ok: false,
          code: 'repo-clone-failed',
          details: { url: 'http://127.0.0.1:1/configuration-closure.git' },
        })
      }
      await f.waitTask(task.id, 'failed')
      const attempts = await scope.harness.db
        .select()
        .from(nodeRuns)
        .where(and(eq(nodeRuns.taskId, task.id), eq(nodeRuns.nodeId, REPO_PREP_NODE_ID)))
      expect(attempts.length).toBeGreaterThanOrEqual(2)
      expect(readFileSync(f.file, 'utf8')).toBe(f.fileBefore)
    }, 30_000)
  },
)
