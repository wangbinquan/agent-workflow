import { describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'

import { createInMemoryDb } from '@/db/client'
import { MIGRATIONS } from './migration-freeze'

function seedTasks(db: ReturnType<typeof createInMemoryDb>): void {
  for (const taskId of ['task-a', 'task-b', 'task-c', 'task-d']) {
    db.run(sql`
      INSERT INTO tasks (
        id, name, workflow_id, workflow_snapshot, repo_path, worktree_path,
        base_branch, branch, status, inputs, started_at
      ) VALUES (
        ${taskId}, ${taskId}, 'workflow-333', '{"$schema_version":2,"inputs":[],"nodes":[],"edges":[]}',
        '/tmp/rfc333', '/tmp/rfc333', 'main', ${`agent-workflow/${taskId}`},
        'running', '{}', 1
      )
    `)
  }
}

function thrownCauseMessage(run: () => unknown): string {
  try {
    run()
    throw new Error('expected operation to throw')
  } catch (error) {
    return String((error as { cause?: { message?: string } }).cause?.message ?? error)
  }
}

function insertOperation(
  db: ReturnType<typeof createInMemoryDb>,
  input: {
    id: string
    taskId: string
    gateRef: string
    key: string
    state?: 'preparing' | 'completed'
    expectedGateRevision?: number
    resultGateRevision?: number | null
    receiptJson?: string | null
  },
): void {
  const state = input.state ?? 'preparing'
  const expectedGateRevision = input.expectedGateRevision ?? 0
  const resultGateRevision = input.resultGateRevision ?? null
  const receiptJson = input.receiptJson ?? null
  const committedAt = state === 'completed' ? 10 : null
  const completedAt = state === 'completed' ? 11 : null
  db.run(sql`
    INSERT INTO collaboration_gate_operations (
      id, task_id, gate_kind, operation_kind, gate_ref,
      idempotency_key, request_hash, actor_user_id,
      expected_task_revision, expected_gate_revision, result_gate_revision,
      state, claim_epoch, schema_version, manifest_json, receipt_json,
      created_at, updated_at, committed_at, completed_at
    ) VALUES (
      ${input.id}, ${input.taskId}, 'review', 'open', ${input.gateRef},
      ${input.key}, ${`hash:${input.id}`}, NULL,
      0, ${expectedGateRevision}, ${resultGateRevision},
      ${state}, 1, 1, '{"schemaVersion":1,"kind":"review-open"}', ${receiptJson},
      1, 1, ${committedAt}, ${completedAt}
    )
  `)
}

describe('RFC-333 migrations 0212/0213 — human-gate transaction and handoff storage', () => {
  test('adds the operation journal and splits active intent uniqueness for one exact successor', () => {
    const db = createInMemoryDb(MIGRATIONS)
    const tables = db.all<{ name: string }>(
      sql`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
    )
    expect(tables.map((row) => row.name)).toEqual(
      expect.arrayContaining(['collaboration_gate_operations', 'collaboration_gate_artifacts']),
    )
    const operationIndexes = db.all<{ name: string; unique: number }>(
      sql`SELECT name, "unique" FROM pragma_index_list('collaboration_gate_operations')`,
    )
    expect(operationIndexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'idx_collaboration_gate_operations_idempotency',
          unique: 1,
        }),
        expect.objectContaining({
          name: 'idx_collaboration_gate_operations_revision',
          unique: 1,
        }),
        expect.objectContaining({
          name: 'idx_collaboration_gate_operations_one_active',
          unique: 1,
        }),
        expect.objectContaining({
          name: 'idx_collaboration_gate_operations_recovery',
          unique: 0,
        }),
      ]),
    )
    const intentIndexes = db.all<{ name: string; unique: number }>(
      sql`SELECT name, "unique" FROM pragma_index_list('task_execution_intents')`,
    )
    expect(intentIndexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'idx_task_execution_intents_pending_task', unique: 1 }),
        expect.objectContaining({ name: 'idx_task_execution_intents_claimed_task', unique: 1 }),
      ]),
    )
    expect(intentIndexes.map((row) => row.name)).not.toContain(
      'idx_task_execution_intents_active_task',
    )
    expect(db.all(sql`PRAGMA foreign_key_check`)).toEqual([])
  })

  test('enforces JSON/revision shapes and immutable committed receipts', () => {
    const db = createInMemoryDb(MIGRATIONS)
    seedTasks(db)
    expect(() =>
      db.run(sql`
        INSERT INTO collaboration_gate_operations (
          id, task_id, gate_kind, operation_kind, gate_ref,
          idempotency_key, request_hash, expected_task_revision,
          expected_gate_revision, state, manifest_json, created_at, updated_at
        ) VALUES (
          'bad-json', 'task-a', 'review', 'open', 'bad-json',
          'bad-json', 'hash', 0, 0, 'preparing', '{', 1, 1
        )
      `),
    ).toThrow()
    expect(() =>
      db.run(sql`
        INSERT INTO collaboration_gate_operations (
          id, task_id, gate_kind, operation_kind, gate_ref,
          idempotency_key, request_hash, expected_task_revision,
          expected_gate_revision, state, manifest_json, created_at, updated_at
        ) VALUES (
          'negative-revision', 'task-a', 'review', 'open', 'negative-revision',
          'negative-revision', 'hash', -1, 0, 'preparing', '{}', 1, 1
        )
      `),
    ).toThrow()
    expect(() =>
      db.run(sql`
        INSERT INTO collaboration_gate_operations (
          id, task_id, gate_kind, operation_kind, gate_ref,
          idempotency_key, request_hash, expected_task_revision,
          expected_gate_revision, result_gate_revision,
          state, manifest_json, receipt_json, committed_at, created_at, updated_at
        ) VALUES (
          'skipped-revision', 'task-a', 'review', 'open', 'skipped-revision',
          'skipped-revision', 'hash', 0, 2, 4,
          'committed', '{}', '{}', 1, 1, 1
        )
      `),
    ).toThrow()
    expect(() =>
      db.run(sql`
        INSERT INTO collaboration_gate_operations (
          id, task_id, gate_kind, operation_kind, gate_ref,
          idempotency_key, request_hash, expected_task_revision,
          expected_gate_revision, result_gate_revision,
          state, manifest_json, committed_at, created_at, updated_at
        ) VALUES (
          'missing-receipt', 'task-a', 'review', 'open', 'missing-receipt',
          'missing-receipt', 'hash', 0, 0, 1,
          'committed', '{}', 1, 1, 1
        )
      `),
    ).toThrow()

    insertOperation(db, {
      id: 'completed',
      taskId: 'task-a',
      gateRef: 'gate-completed',
      key: 'completed',
      state: 'completed',
      resultGateRevision: 1,
      receiptJson: '{"accepted":true}',
    })
    expect(
      thrownCauseMessage(() =>
        db.run(sql`
          UPDATE collaboration_gate_operations
          SET result_gate_revision = 2
          WHERE id = 'completed'
        `),
      ),
    ).toContain('human-gate-committed-receipt-immutable')
  })

  test('fences duplicate keys, active exact-gate operations, and gate revisions', () => {
    const db = createInMemoryDb(MIGRATIONS)
    seedTasks(db)
    insertOperation(db, {
      id: 'active-a',
      taskId: 'task-a',
      gateRef: 'gate-shared',
      key: 'key-a',
    })
    expect(() =>
      insertOperation(db, {
        id: 'duplicate-key',
        taskId: 'task-a',
        gateRef: 'gate-other',
        key: 'key-a',
      }),
    ).toThrow()
    expect(() =>
      insertOperation(db, {
        id: 'duplicate-active',
        taskId: 'task-a',
        gateRef: 'gate-shared',
        key: 'key-b',
      }),
    ).toThrow()

    insertOperation(db, {
      id: 'revision-a',
      taskId: 'task-b',
      gateRef: 'gate-revision',
      key: 'revision-a',
      state: 'completed',
      resultGateRevision: 1,
      receiptJson: '{}',
    })
    expect(() =>
      insertOperation(db, {
        id: 'revision-b',
        taskId: 'task-c',
        gateRef: 'gate-revision',
        key: 'revision-b',
        state: 'completed',
        resultGateRevision: 1,
        receiptJson: '{}',
      }),
    ).toThrow()
  })

  test('owns artifact integrity and cascades operation deletion', () => {
    const db = createInMemoryDb(MIGRATIONS)
    seedTasks(db)
    insertOperation(db, {
      id: 'artifact-operation',
      taskId: 'task-a',
      gateRef: 'gate-artifact',
      key: 'artifact-operation',
    })
    db.run(sql`
      INSERT INTO collaboration_gate_artifacts (
        operation_id, artifact_key, artifact_kind, staged_path, final_path,
        sha256, byte_size, state, updated_at
      ) VALUES (
        'artifact-operation', 'doc:0001', 'review-doc', 'staged/doc-1', 'final/doc-1',
        'digest', 42, 'declared', 1
      )
    `)
    expect(() =>
      db.run(sql`
        INSERT INTO collaboration_gate_artifacts (
          operation_id, artifact_key, artifact_kind, staged_path, final_path,
          sha256, byte_size, state, updated_at
        ) VALUES (
          'artifact-operation', 'doc:0002', 'review-doc', 'staged/doc-2', 'final/doc-1',
          'digest', 42, 'declared', 1
        )
      `),
    ).toThrow()
    expect(() =>
      db.run(sql`
        INSERT INTO collaboration_gate_artifacts (
          operation_id, artifact_key, artifact_kind, staged_path, final_path,
          sha256, byte_size, state, updated_at
        ) VALUES (
          'missing-operation', 'doc:0001', 'review-doc', 'staged/missing', 'final/missing',
          'digest', 1, 'declared', 1
        )
      `),
    ).toThrow()
    db.run(sql`DELETE FROM collaboration_gate_operations WHERE id = 'artifact-operation'`)
    expect(
      db.all<{ count: number }>(sql`
        SELECT count(*) AS count
        FROM collaboration_gate_artifacts
        WHERE operation_id = 'artifact-operation'
      `),
    ).toEqual([{ count: 0 }])
  })
})
