// RFC-330 T1 —— 迁移 0211：工具 / 岗位模版接进 ACL kernel 的存量回填与模版分区索引。
//
// 锁 proposal AC-1 / AC-5 的迁移半边：
//   ① 工具 `name` 从 `draft_json.content.displayName` 回填；**畸形 JSON / 缺字段**的
//      行落 `''` 且迁移不中断（json_extract 对非法 JSON 直接抛，json_valid 分支是
//      唯一挡住它的东西）；
//   ② 存量行 visibility 回填 public、acl_revision 0（读面零变化，D12）；
//   ③ D17'：模版名字唯一域从 (type, revision, name) 放宽到 (owner, type, revision,
//      name)——异 owner 同名可插，同 owner 同分区同名仍撞 UNIQUE；跨分区同名照旧允许；
//   ④ 新表 employee_case_members 的角色 CHECK 与主键。
//
// 与 migration-0206 同口径：bun:sqlite 直接建最小表、跑迁移文件，不经 drizzle。

import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const MIGRATION = resolve(
  import.meta.dir,
  '..',
  'db',
  'migrations',
  '0211_rfc330_employee_authoring_acl.sql',
)

function freshDb(): Database {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY NOT NULL);
    CREATE TABLE employee_tool_registrations (
      id TEXT PRIMARY KEY NOT NULL,
      type_id TEXT NOT NULL,
      type_revision INTEGER NOT NULL,
      work_item_ref TEXT NOT NULL,
      draft_json TEXT NOT NULL,
      owner_user_id TEXT
    );
    CREATE TABLE employee_job_templates (
      id TEXT PRIMARY KEY NOT NULL,
      type_id TEXT NOT NULL,
      type_revision INTEGER NOT NULL,
      name TEXT NOT NULL,
      draft_json TEXT NOT NULL,
      owner_user_id TEXT
    );
    CREATE UNIQUE INDEX employee_job_templates_type_name_unique
      ON employee_job_templates (type_id, type_revision, name);
    CREATE TABLE employee_cases (id TEXT PRIMARY KEY NOT NULL);
    INSERT INTO users (id) VALUES ('alice'), ('bob');
    INSERT INTO employee_tool_registrations VALUES
      ('tool-valid', 'development', 10, 'analyze', '{"content":{"displayName":"Analyzer"},"validationReceipt":{}}', 'alice'),
      ('tool-no-name', 'development', 10, 'analyze', '{"content":{},"validationReceipt":{}}', 'alice'),
      ('tool-dirty', 'development', 10, 'analyze', 'not-json', NULL);
    INSERT INTO employee_job_templates VALUES
      ('job-a-10', 'development', 10, 'Reviewer', '{}', 'alice'),
      ('job-a-11', 'development', 11, 'Reviewer', '{}', 'alice');
  `)
  return sqlite
}

function runMigration(sqlite: Database): void {
  for (const statement of readFileSync(MIGRATION, 'utf8').split('--> statement-breakpoint')) {
    if (statement.trim().length > 0) sqlite.exec(statement)
  }
}

describe('migration 0211 — RFC-330 employee authoring ACL', () => {
  test('工具 name 回填：合法行取 displayName，缺字段与畸形 JSON 落空串且迁移不中断', () => {
    const sqlite = freshDb()
    expect(() => runMigration(sqlite)).not.toThrow()
    expect(
      sqlite
        .query(
          'SELECT id, name, visibility, acl_revision FROM employee_tool_registrations ORDER BY id',
        )
        .all(),
    ).toEqual([
      { id: 'tool-dirty', name: '', visibility: 'public', acl_revision: 0 },
      { id: 'tool-no-name', name: '', visibility: 'public', acl_revision: 0 },
      { id: 'tool-valid', name: 'Analyzer', visibility: 'public', acl_revision: 0 },
    ])
    sqlite.close()
  })

  test('存量模版回填 public / 0，名字逐行不变', () => {
    const sqlite = freshDb()
    runMigration(sqlite)
    expect(
      sqlite
        .query('SELECT id, name, visibility, acl_revision FROM employee_job_templates ORDER BY id')
        .all(),
    ).toEqual([
      { id: 'job-a-10', name: 'Reviewer', visibility: 'public', acl_revision: 0 },
      { id: 'job-a-11', name: 'Reviewer', visibility: 'public', acl_revision: 0 },
    ])
    sqlite.close()
  })

  test("D17'：异 owner 同分区同名可插；同 owner 同分区同名仍撞 UNIQUE；旧索引已删", () => {
    const sqlite = freshDb()
    runMigration(sqlite)
    const insert = (id: string, owner: string | null, revision: number, name: string) =>
      sqlite
        .query(
          'INSERT INTO employee_job_templates (id, type_id, type_revision, name, draft_json, owner_user_id) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(id, 'development', revision, name, '{}', owner)
    // 迁移前（旧索引）这一条会 409：同类型版本下全局唯一。
    expect(() => insert('job-b-10', 'bob', 10, 'Reviewer')).not.toThrow()
    // 同 owner 同分区同名：仍然唯一。
    expect(() => insert('job-a-10-dup', 'alice', 10, 'Reviewer')).toThrow(/UNIQUE/)
    // null owner 归入 '' 分区，两条 null-owner 同名也撞。
    expect(() => insert('job-null-1', null, 10, 'Reviewer')).not.toThrow()
    expect(() => insert('job-null-2', null, 10, 'Reviewer')).toThrow(/UNIQUE/)
    const indexes = sqlite
      .query(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'employee_job_templates'",
      )
      .all() as { name: string }[]
    expect(indexes.map((row) => row.name)).toContain(
      'employee_job_templates_owner_type_name_unique',
    )
    expect(indexes.map((row) => row.name)).not.toContain('employee_job_templates_type_name_unique')
    sqlite.close()
  })

  test('employee_case_members：角色 CHECK、(case, user) 主键、用户 RESTRICT', () => {
    const sqlite = freshDb()
    runMigration(sqlite)
    sqlite.exec('PRAGMA foreign_keys = ON')
    sqlite.query("INSERT INTO employee_cases (id) VALUES ('case-1')").run()
    const insert = (user: string, role: string) =>
      sqlite
        .query(
          'INSERT INTO employee_case_members (case_id, user_id, role, added_by, added_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run('case-1', user, role, 'alice', 1)
    expect(() => insert('bob', 'collaborator')).not.toThrow()
    expect(() => insert('bob', 'observer')).toThrow(/UNIQUE|PRIMARY KEY/)
    expect(() => insert('alice', 'owner')).toThrow(/CHECK/)
    expect(() => sqlite.query("DELETE FROM users WHERE id = 'bob'").run()).toThrow(/FOREIGN KEY/)
    sqlite.query("DELETE FROM employee_cases WHERE id = 'case-1'").run()
    expect(sqlite.query('SELECT COUNT(*) AS n FROM employee_case_members').get()).toEqual({ n: 0 })
    sqlite.close()
  })
})
