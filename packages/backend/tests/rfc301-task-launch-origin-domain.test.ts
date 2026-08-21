// RFC-301 — pure launch-origin semantics.
//
// These tests pin the trusted auth projection, business-invoker precedence,
// and the root attribution negative space before any DB/filesystem behavior is
// involved. Mutation check: swapping daemon to manual or relaxing any webhook
// triplet arm must make this file red.

import { describe, expect, test } from 'bun:test'

import { TASK_LAUNCH_ORIGINS } from '@agent-workflow/shared'
import {
  deriveTaskLaunchOrigin,
  taskLaunchAdmissionIssue,
  type TaskLaunchProvenance,
} from '../src/modules/task-execution/domain/taskLaunchOrigin'
import { directTaskInitiatorFromActorSource } from '../src/modules/task-execution/inbound/directTaskInitiator'

describe('RFC-301 trusted direct initiator', () => {
  test('session is manual while PAT and daemon-token are API', () => {
    expect(directTaskInitiatorFromActorSource('session')).toBe('manual')
    expect(directTaskInitiatorFromActorSource('pat')).toBe('api')
    expect(directTaskInitiatorFromActorSource('daemon')).toBe('api')
  })
})

describe('RFC-301 closed provenance derivation', () => {
  test('all root variants reduce to the persisted literals', () => {
    const cases: Array<[TaskLaunchProvenance, (typeof TASK_LAUNCH_ORIGINS)[number]]> = [
      [{ kind: 'direct-json', initiator: 'manual' }, 'manual'],
      [{ kind: 'direct-json', initiator: 'api' }, 'api'],
      [{ kind: 'direct-multipart', initiator: 'manual' }, 'manual'],
      [{ kind: 'direct-multipart', initiator: 'api' }, 'api'],
      [{ kind: 'fusion', initiator: 'manual' }, 'manual'],
      [{ kind: 'fusion', initiator: 'api' }, 'api'],
      [{ kind: 'schedule' }, 'scheduled'],
      [{ kind: 'event' }, 'event'],
      [{ kind: 'webhook' }, 'webhook'],
    ]
    expect(cases.map(([source]) => deriveTaskLaunchOrigin(source))).toEqual(
      cases.map(([, origin]) => origin),
    )
    expect(new Set(cases.map(([, origin]) => origin))).toEqual(new Set(TASK_LAUNCH_ORIGINS))
  })

  test('root metadata is source-shaped and webhook requires the complete triplet', () => {
    const none = { hasTriggerContext: false }
    expect(taskLaunchAdmissionIssue({ kind: 'direct-json', initiator: 'manual' }, none)).toBeNull()
    expect(
      taskLaunchAdmissionIssue(
        { kind: 'direct-json', initiator: 'api' },
        { ...none, scheduledTaskId: 'schedule-1' },
      )?.code,
    ).toBe('task-launch-direct-metadata-invalid')
    expect(
      taskLaunchAdmissionIssue(
        { kind: 'direct-json', initiator: 'manual' },
        { ...none, webhookTriggerId: ' ' },
      )?.code,
    ).toBe('task-launch-direct-metadata-invalid')

    expect(
      taskLaunchAdmissionIssue({ kind: 'schedule' }, { ...none, scheduledTaskId: 'schedule-1' }),
    ).toBeNull()
    expect(taskLaunchAdmissionIssue({ kind: 'schedule' }, none)?.code).toBe(
      'task-launch-schedule-metadata-invalid',
    )
    expect(
      taskLaunchAdmissionIssue(
        { kind: 'schedule' },
        { scheduledTaskId: 'schedule-1', webhookTriggerId: 'trigger-1', hasTriggerContext: false },
      )?.code,
    ).toBe('task-launch-schedule-metadata-invalid')
    expect(
      taskLaunchAdmissionIssue(
        { kind: 'schedule' },
        { scheduledTaskId: 'schedule-1', webhookFireId: ' ', hasTriggerContext: false },
      )?.code,
    ).toBe('task-launch-schedule-metadata-invalid')

    const completeWebhook = {
      webhookTriggerId: 'trigger-1',
      webhookFireId: 'fire-1',
      hasTriggerContext: true,
    }
    expect(taskLaunchAdmissionIssue({ kind: 'webhook' }, completeWebhook)).toBeNull()
    for (const partial of [
      { ...completeWebhook, webhookTriggerId: undefined },
      { ...completeWebhook, webhookFireId: undefined },
      { ...completeWebhook, hasTriggerContext: false },
      { ...completeWebhook, scheduledTaskId: 'schedule-1' },
      { ...completeWebhook, scheduledTaskId: ' ' },
    ]) {
      expect(taskLaunchAdmissionIssue({ kind: 'webhook' }, partial)?.code).toBe(
        'task-launch-webhook-metadata-invalid',
      )
    }
  })
})
