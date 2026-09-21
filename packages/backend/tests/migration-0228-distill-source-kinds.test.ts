// RFC-366 —— 迁移 0228：`memory_distill_jobs` / `memories` 两张表的 `source_kind`
// 值域扩容（加入 agent-run / task-run）。
//
// SQLite 的 CHECK 写死在表 DDL 文本里，`ALTER TABLE` 没有修改它的语法，所以这是
// 一次**整表重建**。重建最容易悄悄丢掉的三样东西各有一条用例：
//
//   ① 索引（重建后要一条不少地建回来）；
//   ② 入向外键（`memory_distill_events.distill_job_id` 是 ON DELETE CASCADE——
//      指丢了不会报错，只会在某天删 job 时留下孤儿事件）；
//   ③ 存量行（INSERT … SELECT 漏列同样不报错，只是那一列变成 NULL/默认）。
//
// 另外锁住「扩容之后仍然拒绝非法值」：只加值不加把门的话，CHECK 还不如没有。

import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { migrateSqlite } from '@/platform/persistence/sqliteMigrator'

const MIGRATIONS_FOLDER = resolve(import.meta.dir, '..', 'db', 'migrations')
const TAG = '0228_rfc366_distill_source_kinds'

function freshDatabase(): Database {
  const db = new Database(':memory:')
  db.exec('PRAGMA foreign_keys=OFF')
  migrateSqlite(db, { migrationsFolder: MIGRATIONS_FOLDER })
  return db
}

function checkValues(db: Database, table: string): string[] {
  const row = db
    .query<
      { sql: string },
      []
    >(`SELECT sql FROM sqlite_master WHERE type='table' AND name='${table}'`)
    .get()
  expect(row).not.toBeNull()
  const match = /CHECK \(`source_kind` IN \(([^)]*)\)\)/.exec(row!.sql)
  expect(match).not.toBeNull()
  return match![1]!.split(',').map((item) => item.trim().replace(/^'|'$/g, ''))
}

function indexNames(db: Database, table: string): string[] {
  return db
    .query<{ name: string }, []>(
      `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='${table}' AND sql IS NOT NULL ORDER BY name`,
    )
    .all()
    .map((row) => row.name)
}

describe('RFC-366 migration 0228 — distill source-kind widening', () => {
  test('登记在迁移链尾（journal idx 连号，否则迁移器会静默跳过）', async () => {
    const text = await Bun.file(resolve(MIGRATIONS_FOLDER, 'meta', '_journal.json')).text()
    const parsed = JSON.parse(text) as { entries: Array<{ idx: number; tag: string }> }
    // RFC-365 的 0229 落在链尾之后，这里不再要求本迁移在末尾——只要求它已登记，
    // 且 idx 连号（迁移器按 idx / folderMillis 顺序，不是「最后一个」）。
    expect(
      parsed.entries.some((entry) => entry.tag === TAG),
      `${TAG} 必须登记在 journal 里`,
    ).toBe(true)
    expect(parsed.entries.map((entry) => entry.idx)).toEqual(
      parsed.entries.map((_, index) => index),
    )
    // 迁移器读得到这条文件本身（tag 与文件名必须对得上）。
    expect(readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER })).toHaveLength(
      parsed.entries.length,
    )
  })

  test('两张表的值域各自扩到预期集合', () => {
    const db = freshDatabase()
    expect(checkValues(db, 'memory_distill_jobs')).toEqual([
      'clarify',
      'review',
      'feedback',
      'agent-run',
      'task-run',
    ])
    // `manual` 只存在于 memories——它是手工撰写的记忆行的来源，不是蒸馏触发源。
    expect(checkValues(db, 'memories')).toEqual([
      'clarify',
      'review',
      'feedback',
      'agent-run',
      'task-run',
      'manual',
    ])
    db.close()
  })

  test('新值可插入，非法值仍被拒（把门的还在）', () => {
    const db = freshDatabase()
    const insert = (kind: string) =>
      db.exec(
        `INSERT INTO memory_distill_jobs (id,debounce_key,source_kind,source_event_id,scope_resolved_json,status,next_run_at,created_at)
         VALUES ('${kind}-id','k','${kind}','evt','{}','pending',1,1)`,
      )
    for (const kind of ['clarify', 'review', 'feedback', 'agent-run', 'task-run']) {
      expect(() => insert(kind)).not.toThrow()
    }
    expect(() => insert('bogus')).toThrow()
    // memories 侧同样：manual 可以，蒸馏源以外的自造值不行。
    const insertMemory = (kind: string) =>
      db.exec(
        `INSERT INTO memories (id,scope_type,scope_id,title,body_md,tags,status,source_kind,created_at,version)
         VALUES ('m-${kind}','global',NULL,'t','b','[]','candidate','${kind}',1,1)`,
      )
    expect(() => insertMemory('agent-run')).not.toThrow()
    expect(() => insertMemory('manual')).not.toThrow()
    expect(() => insertMemory('nope')).toThrow()
    db.close()
  })

  test('重建保住了索引', () => {
    const db = freshDatabase()
    expect(indexNames(db, 'memory_distill_jobs')).toEqual([
      'idx_distill_jobs_debounce',
      'idx_distill_jobs_status_next',
      'idx_distill_jobs_task',
    ])
    expect(indexNames(db, 'memories')).toEqual([
      'idx_memories_created',
      'idx_memories_fused_skill_id',
      'idx_memories_scope_status',
      'idx_memories_source',
      'idx_memories_status_created',
      'idx_memories_supersedes',
    ])
    db.close()
  })

  test('重建保住了入向外键与自引用外键', () => {
    const db = freshDatabase()
    const eventsFk = db
      .query<
        { table: string; on_delete: string },
        []
      >(`SELECT "table", "on_delete" FROM pragma_foreign_key_list('memory_distill_events')`)
      .all()
    expect(eventsFk).toEqual([{ table: 'memory_distill_jobs', on_delete: 'CASCADE' }])
    const memoriesFk = db
      .query<
        { table: string; from: string },
        []
      >(`SELECT "table", "from" FROM pragma_foreign_key_list('memories') ORDER BY "from"`)
      .all()
    // 自引用两条：supersedes_id / superseded_by_id。DROP+RENAME 之后它们必须指回
    // 终名 `memories` 而不是临时名。
    expect(memoriesFk).toEqual([
      { table: 'memories', from: 'superseded_by_id' },
      { table: 'memories', from: 'supersedes_id' },
    ])
    db.close()
  })

  test('存量行原样搬运（重放到 0227 写行，再跑完 0228 逐字段比对）', async () => {
    const chain = readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER })
    const db = new Database(':memory:')
    db.exec('PRAGMA foreign_keys=OFF')
    // 手工重放到 0228 之前的那一条为止。
    for (const migration of chain.slice(0, chain.length - 1)) {
      for (const statement of migration.sql) db.exec(statement)
    }
    db.exec(
      `INSERT INTO memory_distill_jobs (id,debounce_key,source_kind,source_event_id,task_id,scope_resolved_json,status,attempts,next_run_at,last_error,created_at,started_at,finished_at,output_lang)
       VALUES ('legacy-job','t:review','review','dv-1','t-1','{"agentIds":[]}','done',2,10,'boom',20,30,40,'zh-CN')`,
    )
    db.exec(
      `INSERT INTO memories (id,scope_type,scope_id,title,body_md,tags,status,source_kind,source_event_id,source_task_id,distill_job_id,created_at,version)
       VALUES ('legacy-mem','repo','r-1','title','body','["x"]','approved','clarify','c-1','t-1','legacy-job',50,3)`,
    )
    db.exec(
      `INSERT INTO memory_distill_events (distill_job_id,attempt_index,session_id,ts,kind,payload)
       VALUES ('legacy-job',0,'s-1',60,'text','{}')`,
    )
    // 再跑最后一条（被测迁移本身）。
    for (const statement of chain[chain.length - 1]!.sql) db.exec(statement)

    expect(
      db.query<Record<string, unknown>, []>(`SELECT * FROM memory_distill_jobs`).all(),
    ).toEqual([
      {
        id: 'legacy-job',
        debounce_key: 't:review',
        source_kind: 'review',
        source_event_id: 'dv-1',
        task_id: 't-1',
        scope_resolved_json: '{"agentIds":[]}',
        status: 'done',
        attempts: 2,
        next_run_at: 10,
        last_error: 'boom',
        created_at: 20,
        started_at: 30,
        finished_at: 40,
        opencode_session_id: null,
        user_prompt_md: null,
        exit_code: null,
        stderr_excerpt: null,
        dedup_snapshot_ids_json: null,
        output_lang: 'zh-CN',
      },
    ])
    const memory = db
      .query<Record<string, unknown>, []>(`SELECT * FROM memories WHERE id='legacy-mem'`)
      .get()
    expect(memory).toMatchObject({
      scope_type: 'repo',
      scope_id: 'r-1',
      title: 'title',
      body_md: 'body',
      tags: '["x"]',
      status: 'approved',
      source_kind: 'clarify',
      source_event_id: 'c-1',
      source_task_id: 't-1',
      distill_job_id: 'legacy-job',
      created_at: 50,
      version: 3,
    })
    // 级联外键仍然指向重建后的表：删 job 必须带走它的事件。
    db.exec('PRAGMA foreign_keys=ON')
    db.exec(`DELETE FROM memory_distill_jobs WHERE id='legacy-job'`)
    expect(
      db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM memory_distill_events`).get(),
    ).toEqual({ n: 0 })
    db.close()
  })
})
