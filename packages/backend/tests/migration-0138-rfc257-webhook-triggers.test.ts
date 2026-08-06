// RFC-257 T2 — 迁移 0138 行为锁。重点不是「表建出来了」，而是三条承重语义：
// ①去重部分唯一索引排除 rejected/failed（multica 教训：secret 配错的一次失败
//   不得永久占位，修正后同 UUID 重投必须能落地；received/processing 在途态
//   占位挡重复分发——设计门 F-4）；②event_uuid NULL 不参与去重（F-18 降级
//   模式：重放行与无 UUID 投递逐条处理）；③fires/streams 对 trigger 的
//   ON DELETE CASCADE（运行时 foreign_keys=ON，db/client.ts:121）。
import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { removeTempDirSync } from './fixtures/tempDir'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const tempDirs: string[] = []

afterEach(() => {
  // RFC-254: dirs hold file-backed sqlite whose handle Windows frees on GC, not
  // close() — removeTempDirSync GCs first so the rm doesn't EBUSY.
  for (const dir of tempDirs.splice(0)) removeTempDirSync(dir)
})

function freshDb(): Database {
  const dir = mkdtempSync(join(tmpdir(), 'rfc257-0138-'))
  tempDirs.push(dir)
  const raw = new Database(join(dir, 'db.sqlite'))
  migrate(drizzle(raw), { migrationsFolder: MIGRATIONS })
  raw.exec('PRAGMA foreign_keys = ON;')
  return raw
}

function seedEndpointAndTrigger(raw: Database): void {
  raw.exec(`
    INSERT INTO webhook_endpoints (id, name, provider, url_token, secret_enc)
    VALUES ('ep-1', '内网 GitLab', 'gitlab', 'aw_whk_tok1', 'sealed');
    INSERT INTO webhook_triggers (
      id, name, endpoint_id, owner_user_id, repo_scope, event_types,
      launch_kind, launch_ref_id, launch_payload
    ) VALUES (
      'tr-1', '修到绿', 'ep-1', 'user-a', '{"kind":"all"}', '["pipeline_failed"]',
      'workflow', 'wf-1', '{"inputs":{}}'
    );
  `)
}

function insertDelivery(raw: Database, id: string, uuid: string | null, status: string): void {
  raw
    .query(
      `INSERT INTO webhook_deliveries (id, endpoint_id, event_uuid, status)
       VALUES (?1, 'ep-1', ?2, ?3)`,
    )
    .run(id, uuid, status)
}

describe('RFC-257 T2 · 迁移 0138', () => {
  test('全量迁移在全新库上跑通，五表 + tasks 两列存在', () => {
    const raw = freshDb()
    const tables = raw
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'webhook_%' ORDER BY name`,
      )
      .all()
      .map((r) => r.name)
    expect(tables).toEqual([
      'webhook_deliveries',
      'webhook_endpoints',
      'webhook_trigger_fires',
      'webhook_trigger_streams',
      'webhook_triggers',
    ])
    const cols = raw
      .query<{ name: string }, []>(`SELECT name FROM pragma_table_info('tasks')`)
      .all()
      .map((r) => r.name)
    expect(cols).toContain('webhook_trigger_id')
    expect(cols).toContain('webhook_fire_id')
  })

  test('去重索引：在途/终态占位，rejected/failed 不占位（同 UUID 重投可落地）', () => {
    const raw = freshDb()
    seedEndpointAndTrigger(raw)
    // received 占位 → 同 UUID 第二行冲突
    insertDelivery(raw, 'd-1', 'uuid-A', 'received')
    expect(() => insertDelivery(raw, 'd-2', 'uuid-A', 'received')).toThrow()
    // matched / ignored 同样占位
    raw.query(`UPDATE webhook_deliveries SET status='matched' WHERE id='d-1'`).run()
    expect(() => insertDelivery(raw, 'd-3', 'uuid-A', 'received')).toThrow()
    // rejected 不占位：secret 配错被拒后，修正 secret 的同 UUID 重投能成功
    insertDelivery(raw, 'd-4', 'uuid-B', 'rejected')
    expect(() => insertDelivery(raw, 'd-5', 'uuid-B', 'received')).not.toThrow()
    // failed 不占位：内部错误后的 Resend 能成功
    insertDelivery(raw, 'd-6', 'uuid-C', 'failed')
    expect(() => insertDelivery(raw, 'd-7', 'uuid-C', 'processing')).not.toThrow()
  })

  test('event_uuid NULL 不参与去重：多行共存（降级模式 + 重放行）', () => {
    const raw = freshDb()
    seedEndpointAndTrigger(raw)
    insertDelivery(raw, 'd-n1', null, 'received')
    expect(() => insertDelivery(raw, 'd-n2', null, 'received')).not.toThrow()
    expect(() => insertDelivery(raw, 'd-n3', null, 'matched')).not.toThrow()
  })

  test('fires/streams 对 trigger 级联删除；endpoint 有 trigger 引用时 FK 拒删', () => {
    const raw = freshDb()
    seedEndpointAndTrigger(raw)
    insertDelivery(raw, 'd-1', 'uuid-A', 'matched')
    raw.exec(`
      INSERT INTO webhook_trigger_fires (id, delivery_id, trigger_id, stream_key, outcome)
      VALUES ('f-1', 'd-1', 'tr-1', 'platform/backend/api|mr:7', 'launched');
      INSERT INTO webhook_trigger_streams (trigger_id, stream_key, consecutive_fires)
      VALUES ('tr-1', 'platform/backend/api|mr:7', 2);
    `)
    // endpoint 删除被 FK 挡住（服务层 restrict 的兜底）
    expect(() => raw.query(`DELETE FROM webhook_endpoints WHERE id='ep-1'`).run()).toThrow()
    // trigger 删除级联 fires/streams
    raw.query(`DELETE FROM webhook_triggers WHERE id='tr-1'`).run()
    expect(
      raw.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM webhook_trigger_fires`).get()?.n,
    ).toBe(0)
    expect(
      raw.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM webhook_trigger_streams`).get()?.n,
    ).toBe(0)
    // deliveries 保留（端点级审计，soft link）
    expect(
      raw.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM webhook_deliveries`).get()?.n,
    ).toBe(1)
  })

  test('streams 复合主键：(trigger, stream) 唯一', () => {
    const raw = freshDb()
    seedEndpointAndTrigger(raw)
    raw
      .query(
        `INSERT INTO webhook_trigger_streams (trigger_id, stream_key, consecutive_fires) VALUES ('tr-1', 's1', 1)`,
      )
      .run()
    expect(() =>
      raw
        .query(
          `INSERT INTO webhook_trigger_streams (trigger_id, stream_key, consecutive_fires) VALUES ('tr-1', 's1', 2)`,
        )
        .run(),
    ).toThrow()
  })
})
