import { describe, expect, test } from 'bun:test'

import { buildActor, type Actor } from '@/auth/actor'
import type { ProtectedMrLaunchGuard } from '@/modules/integration/public/mrTerminalControl'
import {
  createPostgresqlWebhookExecutionRuntime,
  createPostgresqlWebhookOrchestrationRuntime,
} from '@/modules/integration/infrastructure/postgresqlWebhookDispatchRuntime'
import { createSqliteWebhookExecutionRuntime } from '@/modules/integration/infrastructure/sqliteWebhookDispatchRuntime'
import type { WebhookExecutionRuntimeDependencies } from '@/modules/integration/infrastructure/webhookExecutionRuntime'

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
    for (const compose of [
      createSqliteWebhookExecutionRuntime,
      createPostgresqlWebhookExecutionRuntime,
    ]) {
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

  test('Digital Employee work stays outside TaskExecution and keeps Event Center idempotency', async () => {
    const events: string[] = []
    const runtime = createPostgresqlWebhookExecutionRuntime({
      taskExecutions: taskExecutions(events),
      digitalEmployeeWorkStart: {
        async launch(input) {
          events.push(`employee:${input.intake.idempotencyKey}`)
          return { caseId: 'case-1' }
        },
      },
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
            body: 'repair the pipeline',
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
    ).resolves.toEqual({ kind: 'digital-employee', caseId: 'case-1' })
    expect(events).toEqual(['employee:event-delivery:delivery-1'])
  })

  test('orchestration-only PostgreSQL runtime fails closed for Digital Employee targets', async () => {
    const runtime = createPostgresqlWebhookOrchestrationRuntime({
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
