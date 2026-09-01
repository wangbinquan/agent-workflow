import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { sql } from 'drizzle-orm'
import {
  WORKGROUP_SYSTEM_TEMPLATE_KEYS,
  WorkgroupMessageSchema,
  resolveWorkgroupOutputContract,
  type WorkgroupSystemTemplate,
} from '@agent-workflow/shared'
import { createInMemoryDb } from '../src/db/client'
import { buildRoomMessageRow } from '../src/modules/resource-catalog/infrastructure/legacy/workgroup/messages'
import {
  buildSystemMessage,
  parseStoredSystemTemplate,
} from '../src/modules/resource-catalog/infrastructure/legacy/workgroup/systemMessages'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const EXAMPLES: WorkgroupSystemTemplate[] = [
  { key: 'assignmentAgentUnresolvable', params: { title: 't', member: 'm' } },
  { key: 'assignmentFailed', params: { title: 't', detail: 'd' } },
  { key: 'assignmentProtocolViolation', params: { title: 't', detail: 'd' } },
  { key: 'assignmentReportedFailed', params: { title: 't', member: 'm', detail: 'd' } },
  { key: 'assignmentCanceledByMember', params: { title: 't' } },
  { key: 'messageTurnFailed', params: { member: 'm', detail: 'd' } },
  { key: 'freeCollabConverged', params: { count: 2, details: 'd' } },
  { key: 'freeCollabConvergedEmpty', params: {} },
  { key: 'leaderNudge', params: {} },
  { key: 'maxRoundsFailed', params: { maxRounds: 5 } },
  { key: 'freeCollabDeadlock', params: {} },
  { key: 'internalDriveError', params: { item: 'i', detail: 'd' } },
  { key: 'completionGateWaiting', params: { summary: 's' } },
  { key: 'zeroDeltaDone', params: { count: 1 } },
  { key: 'leaderAgentUnresolvable', params: { member: 'm' } },
  { key: 'roundCapDispatchIgnored', params: {} },
  { key: 'tasksAddRejected', params: { member: 'm', detail: 'd' } },
  { key: 'duplicateTasksDropped', params: { count: 1, member: 'm' } },
  { key: 'visibilityMessagesDropped', params: { count: 1, member: 'm' } },
  { key: 'batchAgentUnresolvable', params: { member: 'm' } },
  { key: 'batchFailed', params: { count: 1, member: 'm', detail: 'd' } },
  { key: 'batchProtocolViolation', params: { member: 'm', detail: 'd' } },
]

describe('RFC-274 workgroup output contract', () => {
  test('one resolver keeps legacy values file-oriented', () => {
    expect(resolveWorkgroupOutputContract(undefined)).toBe('files')
    expect(resolveWorkgroupOutputContract('files')).toBe('files')
    expect(resolveWorkgroupOutputContract('discussion')).toBe('discussion')
    expect(resolveWorkgroupOutputContract('invented')).toBe('files')
  })

  test('migration adds the resource contract and nullable message metadata', () => {
    const db = createInMemoryDb(MIGRATIONS)
    const workgroupColumns = db.all<{ name: string; dflt_value: string | null; notnull: number }>(
      sql`SELECT name, dflt_value, "notnull" FROM pragma_table_info('workgroups')`,
    )
    const output = workgroupColumns.find((column) => column.name === 'output_contract')
    expect(output).toMatchObject({ dflt_value: "'files'", notnull: 1 })

    const messageColumns = db.all<{ name: string; notnull: number }>(
      sql`SELECT name, "notnull" FROM pragma_table_info('workgroup_messages')`,
    )
    expect(messageColumns.find((column) => column.name === 'template_key')?.notnull).toBe(0)
    expect(messageColumns.find((column) => column.name === 'template_params_json')?.notnull).toBe(0)
  })
})

describe('RFC-274 typed room-system-message registry', () => {
  test('every closed key has valid params, a durable fallback and a round-trip decoder', () => {
    expect(EXAMPLES.map((example) => example.key)).toEqual([...WORKGROUP_SYSTEM_TEMPLATE_KEYS])
    for (const example of EXAMPLES) {
      const built = buildSystemMessage(example)
      expect(built.templateKey).toBe(example.key)
      expect(built.bodyMd.length).toBeGreaterThan(0)
      expect(parseStoredSystemTemplate(built.templateKey, built.templateParamsJson)).toEqual(
        example,
      )
    }
    expect(parseStoredSystemTemplate('futureKey', '{}')).toBeNull()
    expect(parseStoredSystemTemplate('leaderNudge', '{')).toBeNull()
  })

  test('the unique row constructor writes key+params+fallback atomically', () => {
    const row = buildRoomMessageRow({
      id: 'm1',
      taskId: 't1',
      round: 0,
      authorKind: 'system',
      kind: 'system',
      systemTemplate: { key: 'maxRoundsFailed', params: { maxRounds: 5 } },
      triggerMessageId: null,
      createdAt: 1,
    })
    expect(row.templateKey).toBe('maxRoundsFailed')
    expect(row.templateParamsJson).toBe('{"maxRounds":5}')
    expect(row.bodyMd).toContain('5')

    expect(() =>
      buildRoomMessageRow({
        id: 'm2',
        taskId: 't1',
        round: 0,
        authorKind: 'system',
        kind: 'system',
        bodyMd: 'unclassified platform copy',
        triggerMessageId: null,
        createdAt: 1,
      }),
    ).toThrow('workgroup-system-message-localization-unclassified')
  })

  test('wire pairing is enforced while future bounded keys remain bodyMd-compatible', () => {
    const base = {
      id: 'm1',
      taskId: 't1',
      round: 0,
      authorKind: 'system' as const,
      authorMemberId: null,
      authorUserId: null,
      kind: 'system' as const,
      bodyMd: 'fallback',
      mentionMemberIds: [],
      assignmentId: null,
      triggerMessageId: null,
      createdAt: 1,
    }
    expect(
      WorkgroupMessageSchema.safeParse({
        ...base,
        templateKey: 'futureKey',
        templateParams: { value: 1 },
      }).success,
    ).toBe(true)
    expect(WorkgroupMessageSchema.safeParse({ ...base, templateKey: 'leaderNudge' }).success).toBe(
      false,
    )
    expect(
      WorkgroupMessageSchema.safeParse({
        ...base,
        authorKind: 'member',
        templateKey: 'leaderNudge',
        templateParams: {},
      }).success,
    ).toBe(false)
  })
})
