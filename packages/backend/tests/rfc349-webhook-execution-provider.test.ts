import { describe, expect, test } from 'bun:test'

import { buildActor, type Actor } from '@/auth/actor'
import type { ProtectedMrLaunchGuard } from '@/modules/integration/public/mrTerminalControl'
import {
  createWebhookDispatchExecutionRuntime,
  createWebhookDispatchOrchestrationRuntime,
} from '@/modules/integration/infrastructure/webhookDispatchRuntime'
import type { WebhookExecutionRuntimeDependencies } from '@/modules/integration/infrastructure/webhookExecutionRuntime'
import type { DigitalEmployeeWorkStartPort } from '@/modules/integration/public/participants'

const actor: Actor = buildActor({
  user: {
    id: 'user-1',
    username: 'owner',
    displayName: 'Owner',
    role: 'user',
    status: 'active',
  },
  source: 'session',
})

const triggerContext = Object.freeze({
  trigger: Object.freeze({
    webhook: Object.freeze({ event_type: 'push', repo_path: 'group/repo' }),
  }),
})

const employeeTarget = {
  kind: 'digital-employee',
  refId: 'employee-1',
  intake: {
    kind: 'body',
    target: { repositoryId: 'repository-1' },
    body: 'repair the pipeline',
    externalId: null,
    uploads: [],
  },
} as const
const eventInvoker = {
  type: 'event',
  eventSubscriptionId: 'subscription-1',
  eventDeliveryId: 'delivery-1',
  triggerContext,
} as const

function guard(events: string[]): ProtectedMrLaunchGuard {
  return {
    id: 'guard-1',
    signal: new AbortController().signal,
    snapshot: Object.freeze({
      binding: 'endpoint-1:repo!1',
      launchRevision: 2,
      fence: null,
      effectRevision: null,
    }),
    assertCanCommit() {},
    async verifyCanCommit() {
      events.push('verify')
    },
    async taskCommitted() {},
    async launchSettled() {},
    async failed() {},
    release() {},
  }
}

function taskExecutions(events: string[]): WebhookExecutionRuntimeDependencies['taskExecutions'] {
  return {
    async launch(input) {
      events.push(`launch:${input.target.kind}`)
      expect(input.actor).toBe(actor)
      expect(input.invoker.type).toBe('webhook')
      expect(input.guard?.id).toBe('guard-1')
      return { taskId: 'task-1' }
    },
    async cancel(taskId) {
      events.push(`cancel:${taskId}`)
    },
  }
}

describe('RFC-349 Webhook execution provider composition', () => {
  test('SQLite and PostgreSQL runtimes delegate orchestration to the selected participant', async () => {
    // RFC-359 W4-B4：执行运行时只剩一份实现，这里只需跑一次。
    for (const compose of [createWebhookDispatchExecutionRuntime]) {
      const events: string[] = []
      const runtime = compose({
        taskExecutions: taskExecutions(events),
        digitalEmployeeWorkStart: {
          async launch() {
            throw new Error('unexpected Digital Employee launch')
          },
        },
      })
      await expect(
        runtime.launch(
          actor,
          {
            kind: 'workflow',
            refId: 'workflow-1',
            payload: { workflowId: 'workflow-1', name: 'Webhook task', inputs: {} },
          },
          {
            type: 'webhook',
            webhookTriggerId: 'trigger-1',
            webhookFireId: 'fire-1',
            triggerContext,
          },
          Object.freeze({}) as never,
          guard(events),
        ),
      ).resolves.toEqual({ kind: 'orchestration', taskId: 'task-1' })
      await runtime.cancel('task-1')
      expect(events).toEqual(['verify', 'launch:workflow', 'cancel:task-1'])
    }
  })

  test('construction keeps the later WorkStart owner lazy and launch retains its receiver and event input', async () => {
    const events: string[] = []
    // Bootstrap creates this full port before its owner. Constructor-time launch
    // would throw a TDZ error; retaining the owner call also preserves `this`.
    const digitalEmployeeWorkStart = Object.freeze<DigitalEmployeeWorkStartPort>({
      launch: (input) => httpEmployee.launch(input),
    })
    const runtime = createWebhookDispatchExecutionRuntime({
      taskExecutions: taskExecutions(events),
      digitalEmployeeWorkStart,
    })
    const httpEmployee: DigitalEmployeeWorkStartPort = {
      async launch(input) {
        expect(this).toBe(httpEmployee)
        expect(input).toEqual({
          employeeId: employeeTarget.refId,
          actorUserId: actor.user.id,
          intake: { ...employeeTarget.intake, idempotencyKey: 'event-delivery:delivery-1' },
          origin: { eventSubscriptionId: 'subscription-1', eventDeliveryId: 'delivery-1' },
        })
        events.push(`employee:${input.intake.idempotencyKey}`)
        return { caseId: 'case-1' }
      },
    }
    expect(events).toEqual([])

    await expect(
      runtime.launch(actor, employeeTarget, eventInvoker, Object.freeze({}) as never),
    ).resolves.toEqual({ kind: 'digital-employee', caseId: 'case-1' })
    expect(events).toEqual(['employee:event-delivery:delivery-1'])
  })

  test('a completed WorkStart failure propagates without an orchestration fallback or receipt', async () => {
    const events: string[] = []
    const failure = new Error('employee-definition-not-found')
    const runtime = createWebhookDispatchExecutionRuntime({
      taskExecutions: taskExecutions(events),
      digitalEmployeeWorkStart: Object.freeze({
        async launch() {
          throw failure
        },
      }),
    })
    await expect(
      runtime.launch(actor, employeeTarget, eventInvoker, Object.freeze({}) as never),
    ).rejects.toBe(failure)
    expect(events).toEqual([])
  })

  test('orchestration-only PostgreSQL runtime fails closed for Digital Employee targets', async () => {
    const runtime = createWebhookDispatchOrchestrationRuntime({
      taskExecutions: taskExecutions([]),
    })
    await expect(
      runtime.launch(
        actor,
        {
          kind: 'digital-employee',
          refId: 'employee-1',
          intake: {
            kind: 'body',
            target: {},
            body: null,
            externalId: null,
            uploads: [],
          },
        },
        {
          type: 'event',
          eventSubscriptionId: 'subscription-1',
          eventDeliveryId: 'delivery-1',
          triggerContext,
        },
        Object.freeze({}) as never,
      ),
    ).rejects.toThrow('digital employee webhook work-start requires Event Center delivery')
  })
})
