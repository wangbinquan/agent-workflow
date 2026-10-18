// RFC-370 hosted acceptance (2026-10-18) — AW parents are created for
// archive-and-delete and ended by finalization.
//
// WHY THIS FILE EXISTS (regression intent): AW created every CrewStation
// parent with the `legacy` completion policy. Closing a legacy parent keeps its
// persistent volume, so each deleted task left a PVC behind; at the project's
// volume quota (20) new tasks failed with `pod-missing` ("容器不存在"). A parent
// is now created `archive-and-delete` and ended through
// `POST /v3/business-tasks/:id/finalize` (CS RFC-035), which deletes the volume.
import { expect, test } from 'bun:test'
import { createCrewStationBusinessExecution } from '@/platform/crewstation/businessExecution'

test('a parent is created archive-and-delete on a persistent volume and finalized by its own call', async () => {
  const calls: Array<{ path: string; body: unknown }> = []
  const api = createCrewStationBusinessExecution({
    get: async () => {
      throw new Error('unexpected GET')
    },
    async post<T>(path: string, body: unknown): Promise<T> {
      calls.push({ path, body })
      return { id: 'parent', state: 'creating', generation: 1 } as T
    },
    stream: () => {
      throw new Error('unexpected stream')
    },
  })
  const fence = { epoch: 3, leaseId: 'lease', instanceId: 'instance' }
  await api.createTask({
    requestKey: 'aw-task:x',
    fence,
    taskContractVersion: 'aw-task-v1',
    labels: { 'aw-task-id': 'task' },
  })
  await api.finalizeTask('parent', {
    requestKey: 'aw-task:x:finalize:2',
    fence,
    expectedGeneration: 2,
    outcome: 'succeeded',
    archive: { noArtifactsReason: 'no artifacts' },
  })
  expect(calls).toEqual([
    {
      path: '/v3/business-tasks',
      body: {
        requestKey: 'aw-task:x',
        fence,
        taskContractVersion: 'aw-task-v1',
        volumeMode: 'persistent',
        completionPolicy: 'archive-and-delete',
        labels: { 'aw-task-id': 'task' },
      },
    },
    {
      path: '/v3/business-tasks/parent/finalize',
      body: {
        requestKey: 'aw-task:x:finalize:2',
        fence,
        expectedGeneration: 2,
        outcome: 'succeeded',
        archive: { noArtifactsReason: 'no artifacts' },
      },
    },
  ])
})
