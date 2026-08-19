// RFC-312 migration 0188 —— 存量用户的 `users:presence` backfill。
//
// 这条迁移的每一个 WHERE 条件都对应一条产品判断，逐条锁死：
//   · user / manager 补 —— 否则升级后老用户看不到在线点，而新建用户能看到，行为分叉；
//   · admin 跳过 —— 它由动态全量 baseline（admin = [...PERMISSIONS]）天然持有，
//     插进去只会被读路径判冗余丢弃，徒留噪声行；
//   · guest 跳过 —— public-read-only 预设不含"谁在线"；
//   · __system__ 跳过 —— 它是 daemon-token 的记账主体，不是人；
//   · granted_by_user_id = NULL —— 表示**系统默认授予**，与"某管理员点的"在审计上可区分；
//   · INSERT OR IGNORE —— 迁移必须可重复应用而不产生第二行。

import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SQL = readFileSync(
  resolve(import.meta.dir, '..', 'db', 'migrations', '0188_rfc312_users_presence_grant.sql'),
  'utf8',
)

const opened: Database[] = []
afterEach(() => {
  for (const db of opened.splice(0)) db.close()
})

function fixture(): Database {
  const db = new Database(':memory:')
  opened.push(db)
  db.exec(`
    CREATE TABLE users (
      id text PRIMARY KEY NOT NULL,
      username text NOT NULL UNIQUE,
      role text NOT NULL
    );
    CREATE TABLE user_permission_grants (
      user_id text NOT NULL,
      permission text NOT NULL,
      granted_by_user_id text,
      granted_at integer NOT NULL,
      PRIMARY KEY (user_id, permission)
    );
    INSERT INTO users (id, username, role) VALUES
      ('u-user', 'alice', 'user'),
      ('u-manager', 'mgr', 'manager'),
      ('u-admin', 'root', 'admin'),
      ('u-guest', 'guest', 'guest'),
      ('__system__', 'system', 'admin');
  `)
  return db
}

function grantedUsers(db: Database): string[] {
  return (
    db
      .query(
        "SELECT user_id FROM user_permission_grants WHERE permission = 'users:presence' ORDER BY user_id",
      )
      .all() as Array<{ user_id: string }>
  ).map((r) => r.user_id)
}

describe('migration 0188 · RFC-312 presence backfill', () => {
  test('只补 user 与 manager；admin / guest / __system__ 都跳过', () => {
    const db = fixture()
    db.exec(SQL)
    expect(grantedUsers(db)).toEqual(['u-manager', 'u-user'])
  })

  test('归属为系统默认授予（granted_by_user_id 为 NULL）', () => {
    const db = fixture()
    db.exec(SQL)
    const row = db
      .query(
        "SELECT granted_by_user_id AS g, granted_at AS t FROM user_permission_grants WHERE user_id = 'u-user'",
      )
      .get() as { g: string | null; t: number }
    expect(row.g).toBeNull()
    expect(row.t).toBeGreaterThan(0)
  })

  test('可重复应用：第二次不产生第二行，也不覆盖已有归属', () => {
    const db = fixture()
    db.exec(SQL)
    // 模拟"管理员事后显式授予过"——重跑迁移不得把归属抹成 NULL
    db.exec(
      "UPDATE user_permission_grants SET granted_by_user_id = 'u-admin' WHERE user_id = 'u-manager'",
    )
    db.exec(SQL)
    expect(grantedUsers(db)).toEqual(['u-manager', 'u-user'])
    expect(
      (
        db
          .query(
            "SELECT granted_by_user_id AS g FROM user_permission_grants WHERE user_id = 'u-manager'",
          )
          .get() as { g: string | null }
      ).g,
    ).toBe('u-admin')
  })

  test('不碰其它权限点的既有 grant', () => {
    const db = fixture()
    db.exec("INSERT INTO user_permission_grants VALUES ('u-user', 'scripts:author', 'u-admin', 1)")
    db.exec(SQL)
    expect(
      db.query('SELECT COUNT(*) AS n FROM user_permission_grants').get() as { n: number },
    ).toEqual({ n: 3 })
  })
})
