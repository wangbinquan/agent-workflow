// RFC-370 hosted acceptance (2026-10-17) — a full concurrent task quota is a
// wait, not a failure.
//
// WHY THIS FILE EXISTS (regression intent): a task launched right after another
// one failed its repository preparation within seconds with CrewStation's
// `429 quota_exceeded` ("并发任务额度不足，请使用同一 requestKey 重试"): the
// previous task's container was still in its pause grace and a system scratch
// parent held the other slot. The platform admits the same request key as soon
// as a slot frees, but the parent creation gave up after the transport's few
// quick retries. It now waits within the provisioning budget, resubmitting the
// same key; a quota that stays full ends in an explicit, resumable error.
//
// 2026-10-18: a CrewStation upgrade that changed the task runner base
// invalidated the task image's validation; every launch then failed with the
// raw `412 image_usage_unvalidated` refusal, shown as an unexplained HTTP 500.
// That refusal now fails at once with an explicit operator action.
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { hostedTaskWorkspaces } from '@/db/schema'
import {
  createHostedTaskWorkspaces,
  HostedTaskImageUnvalidatedError,
  HostedWorkspaceQuotaExhaustedError,
} from '@/modules/source-control/infrastructure/crewstation/taskWorkspace'
import { createDatabaseHostedExecutionControl } from '@/modules/system-operations/infrastructure/hostedExecutionControl'
import type {
  BusinessTask,
  CrewStationBusinessExecution,
} from '@/platform/crewstation/businessExecution'
import { CrewStationApiError } from '@/platform/crewstation/platformApi'
import { describeEachProvider } from './helpers/eachProvider'

const unused = async (): Promise<never> => {
  throw new Error('unexpected platform operation')
}
const quotaFull = () =>
  new CrewStationApiError(429, 'quota_exceeded', '并发任务额度不足，请使用同一 requestKey 重试', {
    code: 'quota_exceeded',
    retryAfterSeconds: 1,
  })

describeEachProvider('RFC-370 a full task quota is waited out', (harness) => {
  const lease = { epoch: 1, leaseId: 'lease', instanceId: 'instance' }
  const setup = async (refusals: () => Error | null) => {
    const control = createDatabaseHostedExecutionControl({ db: harness.db })
    for (const phase of ['preparing', 'active'] as const)
      await control.write({
        ...lease,
        owner: lease.instanceId,
        phase,
        expiresAt: Date.now() + 60_000,
      })
    const keys: string[] = []
    const parents = new Map<string, BusinessTask>()
    const api: CrewStationBusinessExecution = {
      createTask: async (request) => {
        keys.push(request.requestKey)
        const refusal = refusals()
        if (refusal !== null) throw refusal
        const parent = { id: 'parent-1', state: 'running', resourceState: 'ready', generation: 1 }
        parents.set(parent.id, parent)
        return parent
      },
      getTask: async (id) => parents.get(id)!,
      closeTask: unused,
      finalizeTask: unused,
      resumeTask: unused,
      pauseTask: unused,
      listSubtasks: unused,
      createMaterial: unused,
      submitSubtask: unused,
      getSubtask: unused,
      cancelSubtask: unused,
      events: unused,
      streamEvents: () => {
        throw new Error('unexpected event stream')
      },
      readFile: unused,
      listFiles: unused,
    }
    let clock = 1_000_000
    const workspaces = createHostedTaskWorkspaces({
      db: harness.db,
      api,
      installation: 'project/service',
      taskContractVersion: 'aw-task-v1',
      fence: { current: () => lease, assertHeld: (tx, value) => control.assertHeld(tx, value) },
      now: () => clock,
      sleep: async (ms) => {
        clock += ms
      },
      readyTimeoutMs: 300_000,
    })
    const row = async (owner: string) =>
      (
        await harness.db
          .select()
          .from(hostedTaskWorkspaces)
          .where(eq(hostedTaskWorkspaces.taskId, owner))
      )[0]
    return { workspaces, keys, row, elapsed: () => clock - 1_000_000 }
  }

  test('the same request key is resubmitted until a slot frees', async () => {
    let refused = 0
    const f = await setup(() => (refused++ < 3 ? quotaFull() : null))
    await expect(f.workspaces.ensure('01M56TASK')).resolves.toEqual({
      taskId: '01M56TASK',
      businessTaskId: 'parent-1',
    })
    expect(f.keys).toHaveLength(4)
    expect(new Set(f.keys).size).toBe(1)
    expect(f.elapsed()).toBeGreaterThan(0)
    expect((await f.row('01M56TASK'))?.businessTaskId).toBe('parent-1')
  })

  test('a quota that stays full ends in an explicit error and keeps the parent request', async () => {
    const f = await setup(() => quotaFull())
    const error = await f.workspaces.ensure('01M56TASK').then(
      () => null,
      (failure: unknown) => failure,
    )
    expect(error).toBeInstanceOf(HostedWorkspaceQuotaExhaustedError)
    expect(error).toMatchObject({ code: 'hosted-task-quota-exhausted', status: 429 })
    expect(f.elapsed()).toBeGreaterThanOrEqual(300_000)
    expect(new Set(f.keys).size).toBe(1)
    // Resuming the task resubmits this same key once a slot is free.
    expect(await f.row('01M56TASK')).toMatchObject({ state: 'creating', businessTaskId: null })
  })

  test('an unvalidated task image fails at once with the operator action', async () => {
    const f = await setup(
      () =>
        new CrewStationApiError(412, 'precondition', '该镜像尚未通过所选用途与档位的验证', {
          code: 'image_usage_unvalidated',
          imageVersionId: 'version-1',
          usage: 'task',
        }),
    )
    const error = await f.workspaces.ensure('01M56TASK').then(
      () => null,
      (failure: unknown) => failure,
    )
    expect(error).toBeInstanceOf(HostedTaskImageUnvalidatedError)
    expect(error).toMatchObject({
      code: 'hosted-task-image-unvalidated',
      status: 503,
      details: {
        imageVersionId: 'version-1',
        platformMessage: '该镜像尚未通过所选用途与档位的验证',
      },
    })
    expect((error as Error).message).toContain('re-validate the task image')
    expect(f.keys).toHaveLength(1)
    expect(f.elapsed()).toBe(0)
    // No parent exists, so retrying after the re-validation resubmits this key.
    expect(await f.row('01M56TASK')).toMatchObject({ state: 'creating', businessTaskId: null })
  })

  test('any other refusal still fails at once', async () => {
    const f = await setup(
      () => new CrewStationApiError(403, 'forbidden', '此发布不拥有执行权', { code: 'not_active' }),
    )
    await expect(f.workspaces.ensure('01M56TASK')).rejects.toMatchObject({ status: 403 })
    expect(f.keys).toHaveLength(1)
    expect(f.elapsed()).toBe(0)
  })
})
