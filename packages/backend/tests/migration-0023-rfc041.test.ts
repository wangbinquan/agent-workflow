// RFC-041 — locks migration 0023: three new tables (memories /
// memory_distill_jobs / task_feedback), their CHECK constraints, and the key
// indices the read path depends on (idx_memories_scope_status hot path for
// runner inject; idx_distill_jobs_status_next hot path for daemon worker).
//
// If this test fails, PR1 is broken (or someone re-numbered migrations).

import { createFrozenEpoch1Db, type FrozenDbClient, FROZEN_MIGRATIONS } from './migration-freeze'
import { describe, expect, test, beforeEach } from 'bun:test'
import { resolve } from 'node:path'
import { ulid } from 'ulid'

const MIGRATIONS = resolve(FROZEN_MIGRATIONS)

describe('migration 0023 (RFC-041 memories / memory_distill_jobs / task_feedback)', () => {
  let db: FrozenDbClient
  beforeEach(() => {
    db = createFrozenEpoch1Db(MIGRATIONS)
  })

  test('three tables exist via PRAGMA table_list', () => {
    const tables = db.$client
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN (?, ?, ?)`)
      .all('memories', 'memory_distill_jobs', 'task_feedback') as Array<{ name: string }>
    expect(new Set(tables.map((t) => t.name))).toEqual(
      new Set(['memories', 'memory_distill_jobs', 'task_feedback']),
    )
  })

  test('key indices exist', () => {
    const indices = db.$client
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' AND tbl_name IN (?, ?, ?)`,
      )
      .all('memories', 'memory_distill_jobs', 'task_feedback') as Array<{ name: string }>
    const names = new Set(indices.map((i) => i.name))
    for (const want of [
      'idx_memories_scope_status',
      'idx_memories_status_created',
      'idx_memories_supersedes',
      'idx_memories_source',
      'idx_distill_jobs_status_next',
      'idx_distill_jobs_debounce',
      'idx_distill_jobs_task',
      'idx_task_feedback_task',
    ]) {
      expect(names.has(want)).toBe(true)
    }
  })

  test('CHECK: global scope requires NULL scope_id', () => {
    const insert = (scopeType: string, scopeId: string | null) =>
      db.$client
        .prepare(
          `INSERT INTO memories (id, scope_type, scope_id, title, body_md, status, source_kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(ulid(), scopeType, scopeId, 't', 'b', 'approved', 'manual', Date.now())
    // OK: global + null
    expect(() => insert('global', null)).not.toThrow()
    // Reject: global + non-null
    expect(() => insert('global', 'something')).toThrow()
  })

  test('CHECK: non-global scope requires NOT NULL scope_id', () => {
    const insert = (scopeType: string, scopeId: string | null) =>
      db.$client
        .prepare(
          `INSERT INTO memories (id, scope_type, scope_id, title, body_md, status, source_kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(ulid(), scopeType, scopeId, 't', 'b', 'candidate', 'manual', Date.now())
    expect(() => insert('agent', null)).toThrow()
    expect(() => insert('agent', 'agent_1')).not.toThrow()
    expect(() => insert('workflow', 'wf_1')).not.toThrow()
    expect(() => insert('repo', 'r_1')).not.toThrow()
  })

  test('CHECK: status enum rejects garbage', () => {
    expect(() =>
      db.$client
        .prepare(
          `INSERT INTO memories (id, scope_type, scope_id, title, body_md, status, source_kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(ulid(), 'global', null, 't', 'b', 'maybe-later', 'manual', Date.now()),
    ).toThrow()
  })

  test('CHECK: scope_type enum rejects user (per design — only 4 scopes)', () => {
    expect(() =>
      db.$client
        .prepare(
          `INSERT INTO memories (id, scope_type, scope_id, title, body_md, status, source_kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(ulid(), 'user', 'u_1', 't', 'b', 'candidate', 'manual', Date.now()),
    ).toThrow()
  })

  test('memory_distill_jobs status / source_kind enums enforced', () => {
    const ok = () =>
      db.$client
        .prepare(
          `INSERT INTO memory_distill_jobs (id, debounce_key, source_kind, source_event_id, scope_resolved_json, status, next_run_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(ulid(), 't:clarify', 'clarify', 'e', '{}', 'pending', Date.now(), Date.now())
    expect(() => ok()).not.toThrow()
    expect(() =>
      db.$client
        .prepare(
          `INSERT INTO memory_distill_jobs (id, debounce_key, source_kind, source_event_id, scope_resolved_json, status, next_run_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(ulid(), 't:bad', 'bogus', 'e', '{}', 'pending', Date.now(), Date.now()),
    ).toThrow()
    expect(() =>
      db.$client
        .prepare(
          `INSERT INTO memory_distill_jobs (id, debounce_key, source_kind, source_event_id, scope_resolved_json, status, next_run_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(ulid(), 't:clarify', 'clarify', 'e', '{}', 'maybe', Date.now(), Date.now()),
    ).toThrow()
  })

  test('task_feedback accepts NULL author_user_id (legacy "local" actor)', () => {
    expect(() =>
      db.$client
        .prepare(
          `INSERT INTO task_feedback (id, task_id, author_user_id, body_md, created_at, distilled) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(ulid(), 't_1', null, 'note', Date.now(), 0),
    ).not.toThrow()
  })
})
