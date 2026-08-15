// RFC-305 migration 0162 — additive account permissions must upgrade existing
// users at revision zero, enforce one grant row per permission, cascade only
// live grants, and retain append-only audit evidence after account deletion.

import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SQL = readFileSync(
  resolve(import.meta.dir, '..', 'db', 'migrations', '0162_rfc305_user_permission_grants.sql'),
  'utf8',
)

const opened: Database[] = []

afterEach(() => {
  for (const db of opened.splice(0)) db.close()
})

function fixture(): Database {
  const db = new Database(':memory:')
  opened.push(db)
  db.exec('PRAGMA foreign_keys = ON;')
  db.exec(`
    CREATE TABLE users (
      id text PRIMARY KEY NOT NULL,
      username text NOT NULL UNIQUE
    );
    INSERT INTO users (id, username) VALUES ('existing', 'existing');
  `)
  db.exec(SQL)
  return db
}

describe('migration 0162 · RFC-305 user permission grants', () => {
  test('backfills existing users and defaults future users to revision zero', () => {
    const db = fixture()
    expect(
      db
        .query<
          { access_revision: number },
          []
        >("SELECT access_revision FROM users WHERE id = 'existing'")
        .get(),
    ).toEqual({ access_revision: 0 })

    db.query("INSERT INTO users (id, username) VALUES ('future', 'future')").run()
    expect(
      db
        .query<
          { access_revision: number },
          []
        >("SELECT access_revision FROM users WHERE id = 'future'")
        .get(),
    ).toEqual({ access_revision: 0 })
  })

  test('enforces grant identity and owner FK while allowing future catalog ids', () => {
    const db = fixture()
    const insert = db.query(
      'INSERT INTO user_permission_grants ' +
        '(user_id, permission, granted_by_user_id, granted_at) VALUES (?, ?, ?, ?)',
    )
    insert.run('existing', 'scripts:author', 'admin', 1)
    expect(() => insert.run('existing', 'scripts:author', 'admin', 2)).toThrow()
    expect(() => insert.run('missing', 'scripts:author', 'admin', 3)).toThrow()

    insert.run('existing', 'future:catalog-point', 'admin', 4)
    expect(
      db
        .query<
          { permission: string },
          []
        >('SELECT permission FROM user_permission_grants ORDER BY permission')
        .all(),
    ).toEqual([{ permission: 'future:catalog-point' }, { permission: 'scripts:author' }])
  })

  test('cascades live grants but preserves access audit history', () => {
    const db = fixture()
    db.exec(`
      INSERT INTO user_permission_grants
        (user_id, permission, granted_by_user_id, granted_at)
      VALUES ('existing', 'scripts:author', 'admin', 1);
      INSERT INTO user_access_audit (
        id, target_user_id, actor_user_id, actor_kind, operation_id,
        correlation_id, before_role, after_role, added_permissions_json,
        removed_permissions_json, access_revision, created_at
      ) VALUES (
        'audit-1', 'existing', 'admin', 'session', 'operation-1', NULL,
        'user', 'user', '["scripts:author"]', '[]', 1, 2
      );
      DELETE FROM users WHERE id = 'existing';
    `)

    expect(
      db.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM user_permission_grants').get(),
    ).toEqual({ count: 0 })
    expect(
      db
        .query<
          { target_user_id: string },
          []
        >("SELECT target_user_id FROM user_access_audit WHERE id = 'audit-1'")
        .get(),
    ).toEqual({ target_user_id: 'existing' })
  })

  test('enforces access audit append-only history in SQLite', () => {
    const db = fixture()
    db.exec(`
      INSERT INTO user_access_audit (
        id, target_user_id, actor_user_id, actor_kind, operation_id,
        correlation_id, before_role, after_role, added_permissions_json,
        removed_permissions_json, access_revision, created_at
      ) VALUES (
        'audit-immutable', 'existing', 'admin', 'session', 'operation-1', NULL,
        'user', 'user', '["scripts:author"]', '[]', 1, 2
      );
    `)

    expect(() =>
      db.exec("UPDATE user_access_audit SET after_role = 'admin' WHERE id = 'audit-immutable'"),
    ).toThrow('user_access_audit_append_only')
    expect(() => db.exec("DELETE FROM user_access_audit WHERE id = 'audit-immutable'")).toThrow(
      'user_access_audit_append_only',
    )
    expect(
      db
        .query<
          { after_role: string },
          []
        >("SELECT after_role FROM user_access_audit WHERE id = 'audit-immutable'")
        .get(),
    ).toEqual({ after_role: 'user' })
  })
})
