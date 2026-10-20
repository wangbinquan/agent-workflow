// RFC-382: HTTP and the real MCP launch tool must consume the injected session graph and coordinator.
import { expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { composeSqliteApplicationDeps, createComposedApp } from '@/server'
import { createSecretBoxFromKey } from '@/auth/secretBox'
import { actorOfDirectAuthority } from '@/auth/session'
import { composeDaemonTaskExecutionModules } from '@/cli/daemonModules/taskExecution'
import { composeDaemonProviderCore } from '@/cli/daemonModules/providerCore'
import {
  DAEMON_PROVIDER_CORE_ADAPTERS,
  DAEMON_TASK_EXECUTION_ADAPTERS,
} from '@/cli/daemonModules/adapters'
import { ALL_TOOLS } from '@/mcp/tools'
import { createBoundOperationInvoker } from '@/platform/operations/boundOperationInvoker'
import { describeEachProvider } from './helpers/eachProvider'
import { taskBundleInput, seedBundleTask } from './helpers/daemonTaskExecutionBundle'
import { admitTestDirectAuthority } from './helpers/identityAccessAuthority'
import { operationHandlesForInvoker } from './helpers/mcpOperationRecording'
import { composeUnstartedApplication } from './helpers/providerHttpApplication'

describeEachProvider(
  'RFC-382 SQLite task bundle injection',
  (harness) => {
    test('V preserves member identity; HTTP and MCP launches submit to that exact coordinator', async () => {
      const binding = harness.applicationBinding
      if (binding.provider !== 'sqlite') throw new Error('SQLite injection boundary required')
      const home = mkdtempSync(join(tmpdir(), 'rfc382-http-')),
        token = 'rfc382-daemon-token'
      writeFileSync(join(home, 'config.json'), '{}')
      const fixture = taskBundleInput(harness, home)
      const secretBox = createSecretBoxFromKey(Buffer.alloc(32, 38))
      const core = composeDaemonProviderCore({
        db: binding.db,
        appHome: home,
        secretBox,
        daemonToken: token,
        adapters: DAEMON_PROVIDER_CORE_ADAPTERS.sqlite({
          db: binding.db,
          appHome: home,
          secretBox,
        }),
        realtimePolicy: {
          resourceVisibility: { canViewResource: async () => false },
          memoryVisibility: { canViewMemory: async () => false },
          repoImportOwnerUserId: () => null,
          redactTaskEventPayload: (payload) => payload,
        },
        onCredentialRevoked() {},
        identityEvents: { authorityRevisionChanged() {} },
        presenceProjection: { publish() {} },
      })
      const bundle = composeDaemonTaskExecutionModules({
        ...fixture.input,
        core,
        adapters: DAEMON_TASK_EXECUTION_ADAPTERS.sqlite({ db: binding.db }),
      })
      const submit = spyOn(bundle.coordinator, 'submit')
      const opened = await composeUnstartedApplication((scope) => {
        const composed = composeSqliteApplicationDeps(
          {
            db: binding.db,
            appHome: home,
            configPath: join(home, 'config.json'),
            token,
            dbVersion: 0,
            opencodeVersion: null,
            secretBox,
            providerCore: core,
            taskExecutionModules: bundle,
            resourceCatalogModules: fixture.resourceCatalog,
          },
          scope,
        )
        return { composed, app: createComposedApp(composed) }
      })
      try {
        expect(opened.composed.taskExecutionModules).toBe(bundle)
        expect(opened.composed.taskExecutionModules.routes.tasks).toBe(bundle.routes.tasks)
        expect(opened.composed.taskExecutionModules.launches).toBe(bundle.launches)
        expect(opened.composed.taskExecutionModules.coordinator).toBe(bundle.coordinator)
        expect(opened.composed.taskExecutionReadModels).toBe(bundle.persistence.reads)
        expect(opened.composed.collaborationContext).toBe(bundle.collaboration)
        const seeded = await seedBundleTask(harness, home, 'running', false)
        const response = await opened.app.request('/api/tasks', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            workflowId: seeded.workflowId,
            name: 'http',
            scratch: true,
            inputs: {},
          }),
        })
        expect(response.status, await response.clone().text()).toBe(201)
        const first = (await response.json()) as { id: string }
        await fixture.waitForDrive(1)
        await bundle.executionModule.runtimeRegistry.awaitReleasedSettled(first.id)
        const identity = await admitTestDirectAuthority(core.identityAccess.directAuthority, {
          source: 'daemon',
        })
        if (identity === null) throw new Error('missing daemon identity')
        const actor = actorOfDirectAuthority(identity)
        const tool = ALL_TOOLS.find((tool) => tool.name === 'launch_task')!
        const second = (await tool.handler(
          { workflowId: seeded.workflowId, name: 'mcp', scratch: true, inputs: {} },
          {
            actor,
            operations: operationHandlesForInvoker(
              'launch_task',
              createBoundOperationInvoker(opened.app, actor),
            ),
            progress: async () => {},
            signal: new AbortController().signal,
          },
        )) as { id: string }
        await fixture.waitForDrive(2)
        await bundle.executionModule.runtimeRegistry.awaitReleasedSettled(second.id)
        expect(submit).toHaveBeenCalledTimes(2)
        expect(submit.mock.calls.map(([request]) => request.taskId)).toEqual([first.id, second.id])
        expect(fixture.driven.map((request) => request.taskId)).toEqual([first.id, second.id])
      } finally {
        submit.mockRestore()
        await opened.dispose()
        fixture.identityAccess.shutdown()
        core.identityAccess.shutdown()
        rmSync(home, { recursive: true, force: true })
      }
    })
  },
  { providers: ['sqlite'] },
)
