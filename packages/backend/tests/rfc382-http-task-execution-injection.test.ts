// RFC-382: HTTP and the real MCP launch tool must consume the injected session graph and coordinator.
import * as collaborationComposition from '@/modules/collaboration/composition/collaborationRouteOperations'
import { createProviderHttpCompositionFixture } from './helpers/providerHttpComposition'

import { expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSecretBoxFromKey } from '@/auth/secretBox'
import { actorOfDirectAuthority } from '@/auth/session'
import { composeDaemonTaskExecutionModules } from '@/cli/daemonModules/taskExecution'
import { ALL_TOOLS } from '@/mcp/tools'
import { createBoundOperationInvoker } from '@/platform/operations/boundOperationInvoker'
import { describeEachProvider } from './helpers/eachProvider'
import { taskBundleInput, seedBundleTask } from './helpers/daemonTaskExecutionBundle'
import { admitTestDirectAuthority } from './helpers/identityAccessAuthority'
import { operationHandlesForInvoker } from './helpers/mcpOperationRecording'

describeEachProvider('RFC-382 task bundle HTTP injection', (harness) => {
  test('HTTP composition preserves member identity; HTTP and MCP launches submit to that exact coordinator', async () => {
    const home = mkdtempSync(join(tmpdir(), 'rfc382-http-')),
      token = 'rfc382-daemon-token'
    writeFileSync(join(home, 'config.json'), '{}')
    const fixture = taskBundleInput(harness, home)
    const secretBox = createSecretBoxFromKey(Buffer.alloc(32, 38))
    const opened = await createProviderHttpCompositionFixture(harness, {
      appHome: home,
      token,
      dbVersion: 0,
      secretBox,
    })
    const core = opened.core
    const bundle = composeDaemonTaskExecutionModules({ ...fixture.input, core })
    const submit = spyOn(bundle.coordinator, 'submit')
    const collaboration = spyOn(collaborationComposition, 'composeCollaborationRouteOperations')
    const http = opened.compose({ taskExecution: bundle, resourceCatalog: fixture.resourceCatalog })
    try {
      expect(http.composition.taskExecution.tasks.operations).toBe(bundle.routes.tasks)
      expect(http.composition.resourceCatalog.agents.taskLaunch).toBe(bundle.routeLaunch.agent)
      expect(http.composition.resourceCatalog.workgroups.taskLaunch).toBe(
        bundle.routeLaunch.workgroup,
      )
      expect(bundle.readModels).toBe(bundle.persistence.reads)
      expect(http.composition.taskExecution.tasks.taskExecutionReadModels).toBe(bundle.readModels)
      expect(collaboration.mock.calls[0]?.[0].context).toBe(bundle.collaboration)
      const seeded = await seedBundleTask(harness, home, 'running', false)
      const response = await http.app.request('/api/tasks', {
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
            createBoundOperationInvoker(http.app, actor),
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
      collaboration.mockRestore()
      submit.mockRestore()
      await opened.dispose()
      fixture.identityAccess.shutdown()
      core.identityAccess.shutdown()
      rmSync(home, { recursive: true, force: true })
    }
  })
})
