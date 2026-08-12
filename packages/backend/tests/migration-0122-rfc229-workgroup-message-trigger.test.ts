// RFC-229 — rolling upgrade and self-FK semantics for message reply provenance.

import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const tempDirs: string[] = []

function freezeThrough(maxIdx: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'rfc229-0122-'))
  tempDirs.push(dir)
  cpSync(MIGRATIONS, dir, { recursive: true })
  const journalPath = join(dir, 'meta', '_journal.json')
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
    entries: Array<{ idx: number }>
  }
  journal.entries = journal.entries.filter((entry) => entry.idx <= maxIdx)
  writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`)
  return dir
}

const freezeThrough0121 = (): string => freezeThrough(120)

function seedTaskAndLegacyMessage(raw: Database): void {
  raw.exec(`
    INSERT INTO workflows (id, name, definition)
    VALUES ('workflow-rfc229', 'workflow-rfc229', '{}');
    INSERT INTO tasks (
      id, name, workflow_id, workflow_snapshot, repo_path, worktree_path,
      base_branch, branch, status, inputs, started_at
    ) VALUES (
      'task-rfc229', 'task-rfc229', 'workflow-rfc229', '{}',
      '/tmp/repo', '/tmp/worktree', 'main', 'aw/rfc229', 'running', '{}', 1
    );
    INSERT INTO workgroup_messages (
      id, task_id, round, author_kind, kind, body_md, mentions_json, created_at
    ) VALUES (
      'message-parent', 'task-rfc229', 1, 'human', 'chat',
      '@B please review', '["member-b"]', 1
    );
  `)
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('migration 0122 RFC-229 workgroup message trigger', () => {
  test('upgrades legacy rows and enforces SET NULL plus task cascade', () => {
    const raw = new Database(':memory:')
    raw.exec('PRAGMA foreign_keys = ON')
    migrate(drizzle(raw), { migrationsFolder: freezeThrough0121() })
    seedTaskAndLegacyMessage(raw)

    // RFC-285 T5 改锚：第二段重放封顶在 0122 自己（idx 121），不再 replay 到
    // HEAD——0151 是链上首个「父表重建」（tasks 12-step），按 RFC-115 F1 契约
    // 只支持 FK-OFF 重放（drizzle 单事务内 pragma 无效），本测试 FK-ON 连接
    // 继续全链会让 seeded tasks 的 DROP 级联清掉子表行。意图（0122 自身升级
    // 语义 + SET NULL/cascade 行为）不受封顶影响。
    migrate(drizzle(raw), { migrationsFolder: freezeThrough(121) })

    const columns = raw.query("PRAGMA table_info('workgroup_messages')").all() as Array<{
      name: string
      notnull: number
    }>
    expect(columns.find((column) => column.name === 'trigger_message_id')).toEqual(
      expect.objectContaining({ name: 'trigger_message_id', notnull: 0 }),
    )
    expect(
      raw
        .query(
          "SELECT trigger_message_id AS triggerMessageId FROM workgroup_messages WHERE id = 'message-parent'",
        )
        .get(),
    ).toEqual({ triggerMessageId: null })

    raw.exec(`
      INSERT INTO workgroup_messages (
        id, task_id, round, author_kind, author_member_id, kind, body_md,
        mentions_json, trigger_message_id, created_at
      ) VALUES (
        'message-child', 'task-rfc229', 1, 'member', 'member-b', 'chat',
        'reviewed', '[]', 'message-parent', 2
      );
      INSERT INTO workgroup_messages (
        id, task_id, round, author_kind, author_member_id, kind, body_md,
        mentions_json, trigger_message_id, created_at
      ) VALUES (
        'message-grandchild', 'task-rfc229', 1, 'member', 'member-c', 'chat',
        'follow-up', '[]', 'message-child', 3
      );
      DELETE FROM workgroup_messages WHERE id = 'message-parent';
    `)
    expect(
      raw
        .query(
          "SELECT trigger_message_id AS triggerMessageId FROM workgroup_messages WHERE id = 'message-child'",
        )
        .get(),
    ).toEqual({ triggerMessageId: null })
    expect(
      raw
        .query(
          "SELECT trigger_message_id AS triggerMessageId FROM workgroup_messages WHERE id = 'message-grandchild'",
        )
        .get(),
    ).toEqual({ triggerMessageId: 'message-child' })

    raw.exec("DELETE FROM tasks WHERE id = 'task-rfc229'")
    expect(raw.query('SELECT count(*) AS count FROM workgroup_messages').get()).toEqual({
      count: 0,
    })
    expect(raw.query('PRAGMA foreign_key_check').all()).toEqual([])
    raw.close()
  })
})
