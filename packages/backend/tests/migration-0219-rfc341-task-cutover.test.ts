import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'

import { decodeTaskLifecycleCommittedEvent } from '@/modules/task-execution/domain/taskLifecycleCommittedEvent'
import { freezeAt } from './migration-freeze'

describe('migration 0219 — RFC-341 task lifecycle cutover', () => {
  test('moves unresolved legacy publication into a canonical event and preserves retry state', () => {
    const raw = new Database(':memory:')
    raw.exec('PRAGMA foreign_keys = ON')
    migrate(drizzle(raw), { migrationsFolder: freezeAt(217) })

    raw.exec(`
      INSERT INTO workflows (id, name, definition)
      VALUES ('workflow-341', 'workflow-341', '{}');
      INSERT INTO tasks (
        id, name, workflow_id, workflow_snapshot, repo_path, worktree_path,
        base_branch, branch, status, inputs, started_at, lifecycle_event_revision
      ) VALUES (
        'task-341', 'task-341', 'workflow-341', '{}', '/tmp/repo', '/tmp/worktree',
        'main', 'aw/task-341', 'running', '{}', 1, 2
      );
    `)
    const observationJson = JSON.stringify({
      sourceRef: { id: 'platform.task-lifecycle', revision: 1 },
      eventTypeRef: { id: 'platform.task.status-changed', revision: 1 },
      subject: { typeId: 'task', subjectRef: 'task-341' },
      occurredAt: 1_789_574_400_123,
      dedupeKey: 'task:task-341:lifecycle:2',
      summary: "Task task-341 changed from 'pending' to 'running'",
      payloadArtifactRef: null,
      routingFactsJson: JSON.stringify({
        taskId: 'task-341',
        lifecycleRevision: 2,
        previousStatus: 'pending',
        status: 'running',
      }),
      triggerParameters: null,
    })
    raw
      .query(
        `INSERT INTO task_lifecycle_event_outbox (
          id, task_id, task_revision, observation_json, state, attempt_count,
          next_attempt_at, last_error, created_at, dead_letter_at
        ) VALUES (?, 'task-341', 2, ?, 'dead-letter', 3, 1789574400123,
                  'legacy publication failed', 1789574400123, 1789574400456)`,
      )
      .run('task-lifecycle:task-341:2', observationJson)

    migrate(drizzle(raw), { migrationsFolder: freezeAt(218) })

    expect(raw.query('PRAGMA foreign_key_check').all()).toEqual([])
    expect(
      raw
        .query(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'task_lifecycle_event_outbox'",
        )
        .get(),
    ).toBeNull()
    const event = raw
      .query(
        `SELECT payload_json AS payloadJson, payload_digest AS payloadDigest,
                delivery_mode AS deliveryMode, producer_epoch AS producerEpoch
         FROM committed_events WHERE id = 'task-lifecycle:task-341:2'`,
      )
      .get() as {
      payloadJson: string
      payloadDigest: string
      deliveryMode: string
      producerEpoch: number
    }
    expect(event.payloadDigest).toBe(
      `canonical-hex-v1:${Buffer.from(event.payloadJson, 'utf8').toString('hex')}`,
    )
    expect(decodeTaskLifecycleCommittedEvent(JSON.parse(event.payloadJson))).toMatchObject({
      type: 'task.lifecycle-transitioned.v1',
      aggregate: { id: 'task-341', seq: 2 },
      payload: {
        taskId: 'task-341',
        lifecycleRevision: 2,
        previousStatus: 'pending',
        status: 'running',
      },
    })
    expect(event).toMatchObject({ deliveryMode: 'dispatchable', producerEpoch: 2 })
    expect(
      raw
        .query(
          `SELECT state, attempt_count AS attemptCount, last_error_summary AS lastErrorSummary,
                  dead_letter_at AS deadLetterAt
           FROM committed_event_deliveries
           WHERE event_id = 'task-lifecycle:task-341:2'
             AND consumer_id = 'event-center.task-lifecycle'`,
        )
        .get(),
    ).toEqual({
      state: 'dead-letter',
      attemptCount: 3,
      lastErrorSummary: 'legacy publication failed',
      deadLetterAt: 1_789_574_400_456,
    })
    expect(
      raw
        .query(
          `SELECT mode, epoch FROM committed_event_family_cutovers
           WHERE producer = 'task-execution' AND family = 'task-lifecycle'`,
        )
        .get(),
    ).toEqual({ mode: 'dispatchable', epoch: 2 })
    raw.close()
  })
})
