// RFC-159 T1 — ScheduleSpec 判别联合 + Create/Update schema 校验。
import { describe, expect, test } from 'bun:test'

import {
  CreateScheduledTaskSchema,
  ScheduleSpecSchema,
  ScheduledAgentPayloadSchema,
  ScheduledTaskNameSchema,
  ScheduledWorkflowPayloadSchema,
  ScheduledWorkgroupPayloadSchema,
  UpdateScheduledTaskSchema,
} from '../src/index'

const VALID_LAUNCH = {
  workflowId: 'wf1',
  name: 'nightly audit',
  repoUrl: 'file:///repo',
  ref: 'main',
}

describe('ScheduleSpecSchema — four kinds', () => {
  test('accepts each kind', () => {
    expect(
      ScheduleSpecSchema.safeParse({ kind: 'interval', every: 6, unit: 'hours' }).success,
    ).toBe(true)
    expect(
      ScheduleSpecSchema.safeParse({ kind: 'daily', at: '09:00', timezone: 'America/New_York' })
        .success,
    ).toBe(true)
    expect(
      ScheduleSpecSchema.safeParse({
        kind: 'weekly',
        daysOfWeek: [1, 4],
        at: '08:30',
        timezone: 'Asia/Shanghai',
      }).success,
    ).toBe(true)
    expect(
      ScheduleSpecSchema.safeParse({
        kind: 'monthly',
        dayOfMonth: 15,
        at: '23:59',
        timezone: 'UTC',
      }).success,
    ).toBe(true)
  })

  test('rejects malformed HH:MM', () => {
    for (const at of ['9:00', '24:00', '12:60', '09-00', '0900', '', '9:5'])
      expect(ScheduleSpecSchema.safeParse({ kind: 'daily', at, timezone: 'UTC' }).success).toBe(
        false,
      )
  })

  test('rejects invalid IANA timezone', () => {
    expect(
      ScheduleSpecSchema.safeParse({ kind: 'daily', at: '09:00', timezone: 'Mars/Phobos' }).success,
    ).toBe(false)
  })

  test('weekly: rejects dayOfWeek out of 0..6; dedups + sorts', () => {
    expect(
      ScheduleSpecSchema.safeParse({
        kind: 'weekly',
        daysOfWeek: [7],
        at: '09:00',
        timezone: 'UTC',
      }).success,
    ).toBe(false)
    expect(
      ScheduleSpecSchema.safeParse({ kind: 'weekly', daysOfWeek: [], at: '09:00', timezone: 'UTC' })
        .success,
    ).toBe(false)
    const parsed = ScheduleSpecSchema.parse({
      kind: 'weekly',
      daysOfWeek: [3, 1, 1, 6],
      at: '09:00',
      timezone: 'UTC',
    })
    expect(parsed.kind === 'weekly' && parsed.daysOfWeek).toEqual([1, 3, 6])
  })

  test('monthly: rejects dayOfMonth outside 1..31', () => {
    for (const dayOfMonth of [0, 32, -1])
      expect(
        ScheduleSpecSchema.safeParse({ kind: 'monthly', dayOfMonth, at: '09:00', timezone: 'UTC' })
          .success,
      ).toBe(false)
  })

  test('interval: every ∈ [1,1000], unit enum', () => {
    expect(
      ScheduleSpecSchema.safeParse({ kind: 'interval', every: 0, unit: 'hours' }).success,
    ).toBe(false)
    expect(
      ScheduleSpecSchema.safeParse({ kind: 'interval', every: 1001, unit: 'hours' }).success,
    ).toBe(false)
    expect(
      ScheduleSpecSchema.safeParse({ kind: 'interval', every: 5, unit: 'weeks' }).success,
    ).toBe(false)
  })

  test('rejects unknown / missing discriminator', () => {
    expect(ScheduleSpecSchema.safeParse({ kind: 'cron', expr: '0 9 * * *' }).success).toBe(false)
    expect(ScheduleSpecSchema.safeParse({ every: 6, unit: 'hours' }).success).toBe(false)
  })
})

describe('ScheduledTaskNameSchema', () => {
  test('trims; rejects empty / whitespace-only; caps 255', () => {
    expect(ScheduledTaskNameSchema.parse('  nightly  ')).toBe('nightly')
    expect(ScheduledTaskNameSchema.safeParse('   ').success).toBe(false)
    expect(ScheduledTaskNameSchema.safeParse('').success).toBe(false)
    expect(ScheduledTaskNameSchema.safeParse('x'.repeat(256)).success).toBe(false)
  })
})

describe('CreateScheduledTaskSchema', () => {
  test('accepts a valid launch body + spec; enabled defaults true', () => {
    const parsed = CreateScheduledTaskSchema.parse({
      name: 'daily audit',
      launchPayload: VALID_LAUNCH,
      scheduleSpec: { kind: 'daily', at: '09:00', timezone: 'America/New_York' },
    })
    expect(parsed.enabled).toBe(true)
    expect(parsed.launchPayload.workflowId).toBe('wf1')
  })

  test('rejects an invalid launch body (StartTaskSchema still enforced as a sub-field)', () => {
    const res = CreateScheduledTaskSchema.safeParse({
      name: 'x',
      launchPayload: { workflowId: 'wf1', name: 'x' }, // no repo source → StartTaskSchema superRefine fails
      scheduleSpec: { kind: 'interval', every: 6, unit: 'hours' },
    })
    expect(res.success).toBe(false)
  })
})

describe('RFC-223 PR-7 scheduled target identity', () => {
  const scheduleSpec = { kind: 'interval' as const, every: 6, unit: 'hours' as const }

  test('agent schedules require agentId; agentName is display-only', () => {
    const launch = { name: 'nightly', description: 'audit', scratch: true }
    expect(ScheduledAgentPayloadSchema.safeParse({ ...launch, agentName: 'auditor' }).success).toBe(
      false,
    )
    expect(
      ScheduledAgentPayloadSchema.safeParse({
        ...launch,
        agentId: 'agent-01',
        agentName: 'stale-display-only',
      }).success,
    ).toBe(true)
    expect(
      CreateScheduledTaskSchema.safeParse({
        name: 'agent schedule',
        launchKind: 'agent',
        launchPayload: { ...launch, agentName: 'auditor' },
        scheduleSpec,
      }).success,
    ).toBe(false)
  })

  test('workgroup schedules require workgroupId; workgroupName is display-only', () => {
    const launch = { name: 'nightly', goal: 'audit', scratch: true }
    expect(
      ScheduledWorkgroupPayloadSchema.safeParse({ ...launch, workgroupName: 'reviewers' }).success,
    ).toBe(false)
    expect(
      ScheduledWorkgroupPayloadSchema.safeParse({
        ...launch,
        workgroupId: 'workgroup-01',
        workgroupName: 'stale-display-only',
      }).success,
    ).toBe(true)
    expect(
      CreateScheduledTaskSchema.safeParse({
        name: 'workgroup schedule',
        launchKind: 'workgroup',
        launchPayload: { ...launch, workgroupName: 'reviewers' },
        scheduleSpec,
      }).success,
    ).toBe(false)
  })

  test('scheduled payloads reject every immediate-submit OCC field', () => {
    expect(
      ScheduledWorkflowPayloadSchema.safeParse({
        ...VALID_LAUNCH,
        expectedWorkflowVersion: 3,
      }).success,
    ).toBe(false)
    expect(
      ScheduledAgentPayloadSchema.safeParse({
        name: 'nightly',
        description: 'audit',
        scratch: true,
        agentId: 'agent-01',
        expectedAgentId: 'agent-01',
      }).success,
    ).toBe(false)
    expect(
      ScheduledWorkgroupPayloadSchema.safeParse({
        name: 'nightly',
        goal: 'audit',
        scratch: true,
        workgroupId: 'workgroup-01',
        expectedWorkgroupId: 'workgroup-01',
        expectedWorkgroupVersion: 2,
      }).success,
    ).toBe(false)

    for (const [launchKind, launchPayload] of [
      ['workflow', { ...VALID_LAUNCH, expectedWorkflowVersion: 3 }],
      [
        'agent',
        {
          name: 'nightly',
          description: 'audit',
          scratch: true,
          agentId: 'agent-01',
          expectedAgentId: 'agent-01',
        },
      ],
      [
        'workgroup',
        {
          name: 'nightly',
          goal: 'audit',
          scratch: true,
          workgroupId: 'workgroup-01',
          expectedWorkgroupId: 'workgroup-01',
          expectedWorkgroupVersion: 2,
        },
      ],
    ] as const) {
      expect(
        CreateScheduledTaskSchema.safeParse({
          name: `${launchKind} schedule`,
          launchKind,
          launchPayload,
          scheduleSpec,
        }).success,
      ).toBe(false)
    }
  })
})

describe('UpdateScheduledTaskSchema — strict partial', () => {
  test('accepts partial fields', () => {
    expect(UpdateScheduledTaskSchema.safeParse({ enabled: false }).success).toBe(true)
    expect(
      UpdateScheduledTaskSchema.safeParse({
        scheduleSpec: { kind: 'interval', every: 12, unit: 'hours' },
      }).success,
    ).toBe(true)
  })
  test('rejects unknown keys (strict)', () => {
    expect(UpdateScheduledTaskSchema.safeParse({ ownerUserId: 'u2' }).success).toBe(false)
    expect(UpdateScheduledTaskSchema.safeParse({ nextRunAt: 123 }).success).toBe(false)
  })
})
