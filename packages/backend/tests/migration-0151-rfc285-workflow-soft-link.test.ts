// RFC-285 T5（B2/E2）—— migration 0151：tasks.workflow_id 硬 FK → durable soft
// link 的 12-step rebuild。
//
// 锁四件事：①重建后表定义无表级 FOREIGN KEY、owner/parent 两条**内联** REFERENCES
// 保留；②全行全列数据原样搬运；③入向 FK（node_runs 等 14 表的代表）**不被
// 改写**——实现门 P1-1 定稿的双保险：官方 12-step 反序（唯一 RENAME 只作用于
// 零入向引用的临时名 `__new_tasks`，平台无关）+ 迁移期临时 legacy_alter_table=ON
// （防语序回退，事务内可生效），且 legacy 开关执行后不泄漏（恢复 0）；
// ④软链生效：删除仍被任务引用的 workflow 行不再撞 SQLITE_CONSTRAINT（应用层
// 非终态门在 rfc285-b2-delete-tier / rfc199 套件，此处只证 SQL 层）。

import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { removeTempDirSync } from './fixtures/tempDir'

const tempDirs: string[] = []
const migrationSql = readFileSync(
  resolve(import.meta.dir, '..', 'db', 'migrations', '0151_rfc285_workflow_soft_link.sql'),
  'utf8',
)

afterEach(() => {
  for (const dir of tempDirs.splice(0)) removeTempDirSync(dir)
})

/** 迁移文件里的新表 DDL（`__new_tasks`）+ 终名 + 尾部补回旧 FK = 精确的
 *  pre-0151 形（防夹具与真表漂移）。 */
function preMigrationTasksDdl(): string {
  const m = migrationSql.match(/CREATE TABLE `__new_tasks` \(([\s\S]*?)\);--> statement-breakpoint/)
  if (m === null) throw new Error('cannot extract new-tasks DDL from migration file')
  return (
    'CREATE TABLE `tasks` (' +
    m[1] +
    ',\n\tFOREIGN KEY (`workflow_id`) REFERENCES `workflows`(`id`) ON UPDATE no action ON DELETE no action\n)'
  )
}

function fixtureDb(): Database {
  const dir = mkdtempSync(join(tmpdir(), 'rfc285-0151-'))
  tempDirs.push(dir)
  const raw = new Database(join(dir, 'db.sqlite'))
  // 模拟现代 SQLite 默认：仅 foreign_keys=OFF 仍会在 rename 时改写入向引用；
  // migration 必须自行临时启用 legacy_alter_table，且执行后恢复 OFF。
  raw.exec('PRAGMA foreign_keys = OFF;')
  raw.exec('PRAGMA legacy_alter_table = OFF;')
  raw.exec('CREATE TABLE `users` (`id` text PRIMARY KEY NOT NULL);')
  raw.exec('CREATE TABLE `workflows` (`id` text PRIMARY KEY NOT NULL);')
  raw.exec(preMigrationTasksDdl() + ';')
  raw.exec(
    'CREATE TABLE `node_runs` (`id` text PRIMARY KEY NOT NULL, `task_id` text NOT NULL REFERENCES `tasks`(`id`) ON DELETE CASCADE);',
  )
  raw.exec(`
    INSERT INTO workflows (id) VALUES ('wf1');
    INSERT INTO users (id) VALUES ('u1');
    INSERT INTO tasks (
      id, workflow_id, workflow_snapshot, repo_path, worktree_path, base_branch,
      branch, status, inputs, started_at, owner_user_id, name, trigger_context_json
    ) VALUES
      ('t1', 'wf1', '{"v":1}', '/r', '/w', 'main', 'b1', 'done', '{}', 111, 'u1', 'task-one', '{"k":"v"}'),
      ('t2', 'wf1', '{"v":2}', '/r', '/w', 'main', 'b2', 'running', '{}', 222, NULL, NULL, NULL);
    INSERT INTO node_runs (id, task_id) VALUES ('n1', 't1');
  `)
  raw.exec(migrationSql)
  return raw
}

describe('migration 0151 · RFC-285 workflow_id soft link', () => {
  test('表级 FK 摘除、内联 owner/parent REFERENCES 保留、8 索引重建', () => {
    const raw = fixtureDb()
    const sql = raw
      .query<
        { sql: string },
        []
      >("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'")
      .get()!.sql
    expect(sql.includes('FOREIGN KEY')).toBe(false)
    expect(sql).toContain('REFERENCES `users`')
    expect(sql).toContain('REFERENCES `tasks`')
    const idx = raw
      .query<
        { c: number },
        []
      >("SELECT COUNT(*) c FROM sqlite_master WHERE type='index' AND tbl_name='tasks' AND sql IS NOT NULL")
      .get()!
    expect(idx.c).toBe(8)
  })

  test('全行全列原样搬运（含 NULL 与 JSON 列）', () => {
    const raw = fixtureDb()
    const t1 = raw.query<Record<string, unknown>, []>("SELECT * FROM tasks WHERE id='t1'").get()!
    expect(t1.workflow_id).toBe('wf1')
    expect(t1.workflow_snapshot).toBe('{"v":1}')
    expect(t1.owner_user_id).toBe('u1')
    expect(t1.name).toBe('task-one')
    expect(t1.trigger_context_json).toBe('{"k":"v"}')
    expect(t1.status).toBe('done')
    expect(t1.started_at).toBe(111)
    const t2 = raw.query<Record<string, unknown>, []>("SELECT * FROM tasks WHERE id='t2'").get()!
    expect(t2.owner_user_id).toBeNull()
    expect(raw.query<{ c: number }, []>('SELECT COUNT(*) c FROM tasks').get()!.c).toBe(2)
  })

  test('入向 FK 未被 rename 改写：node_runs 仍指向 tasks 且完整性干净', () => {
    const raw = fixtureDb()
    const nrSql = raw
      .query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE name='node_runs'")
      .get()!.sql
    expect(nrSql).toContain('REFERENCES `tasks`')
    expect(nrSql.includes('__old_tasks')).toBe(false)
    expect(nrSql.includes('__new_tasks')).toBe(false)
    // 结构锁（P1-1 平台无关性的根据）：整份迁移**唯一**的 RENAME 只作用于
    // 零入向引用的临时名——改回 rename-first（rename `tasks`）立刻红。
    expect(migrationSql.match(/ALTER TABLE `[^`]+` RENAME TO/g)).toEqual([
      'ALTER TABLE `__new_tasks` RENAME TO',
    ])
    expect(
      raw.query<{ legacy_alter_table: number }, []>('PRAGMA legacy_alter_table').get()!
        .legacy_alter_table,
    ).toBe(0)
    raw.exec('PRAGMA foreign_keys = ON;')
    expect(raw.query('PRAGMA foreign_key_check').all().length).toBe(0)
    expect(raw.query<{ quick_check: string }, []>('PRAGMA quick_check').get()!.quick_check).toBe(
      'ok',
    )
  })

  test('软链生效：删被引用的 workflow 不再撞 FK（悬空引用保留）', () => {
    const raw = fixtureDb()
    raw.exec('PRAGMA foreign_keys = ON;')
    raw.exec("DELETE FROM workflows WHERE id='wf1'") // pre-0151 这里 SQLITE_CONSTRAINT
    const t1 = raw
      .query<{ workflow_id: string }, []>("SELECT workflow_id FROM tasks WHERE id='t1'")
      .get()!
    expect(t1.workflow_id).toBe('wf1')
  })
})
