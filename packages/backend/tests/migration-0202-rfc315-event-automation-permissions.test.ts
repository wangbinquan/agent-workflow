// RFC-315 migration 0202 — permission ids are a persisted wire contract.
// This locks the account-grant provenance, role-baseline cleanup, PAT scope
// rewrite (including inactive tokens), malformed-data fail-closed behavior,
// append-only audit preservation, and migration idempotence.

import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SQL = readFileSync(
  resolve(
    import.meta.dir,
    '..',
    'db',
    'migrations',
    '0202_rfc315_event_automation_permissions.sql',
  ),
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
      role text NOT NULL
    );
    CREATE TABLE user_permission_grants (
      user_id text NOT NULL,
      permission text NOT NULL,
      granted_by_user_id text,
      granted_at integer NOT NULL,
      PRIMARY KEY (user_id, permission)
    );
    CREATE TABLE user_pats (
      id text PRIMARY KEY NOT NULL,
      scopes_json text NOT NULL,
      expires_at integer,
      revoked_at integer
    );
    CREATE TABLE user_access_audit (
      id text PRIMARY KEY NOT NULL,
      added_permissions_json text NOT NULL,
      removed_permissions_json text NOT NULL
    );

    INSERT INTO users (id, role) VALUES
      ('admin', 'admin'),
      ('manager', 'manager'),
      ('user', 'user'),
      ('guest', 'guest');

    INSERT INTO user_permission_grants VALUES
      ('user', 'webhook-triggers:create', 'admin', 11),
      ('manager', 'webhook-triggers:update', 'admin', 12),
      ('guest', 'webhook-triggers:delete', 'admin', 13),
      ('admin', 'webhook-triggers:override-owner', 'admin', 14),
      ('user', 'webhook-triggers:delete', 'old-admin', 15),
      ('user', 'event-automation-rules:delete', 'new-admin', 16),
      ('user', 'event-sources:update', 'admin', 17);

    INSERT INTO user_pats VALUES
      ('active', '["webhook-triggers:read","webhook-triggers:create","event-automation-rules:create","event-sources:update"]', NULL, NULL),
      ('revoked', '["webhook-triggers:update"]', NULL, 20),
      ('expired', '["webhook-triggers:delete"]', 10, NULL),
      ('invalid-json', '{broken', NULL, NULL),
      ('mixed-array', '[1,"webhook-triggers:read"]', NULL, NULL),
      ('unrelated', '[ "event-sources:read" ]', NULL, NULL);

    INSERT INTO user_access_audit VALUES
      ('audit', '["webhook-triggers:create"]', '["webhook-triggers:delete"]');
  `)
  return db
}

function grantRows(db: Database): Array<Record<string, string | number | null>> {
  return db
    .query(
      `SELECT user_id, permission, granted_by_user_id, granted_at
       FROM user_permission_grants ORDER BY user_id, permission`,
    )
    .all() as Array<Record<string, string | number | null>>
}

describe('migration 0202 · RFC-315 event automation permissions', () => {
  test('renames explicit grants, keeps target provenance on conflict, and removes preset redundancy', () => {
    const db = fixture()
    db.exec(SQL)

    expect(grantRows(db)).toEqual([
      {
        user_id: 'guest',
        permission: 'event-automation-rules:delete',
        granted_by_user_id: 'admin',
        granted_at: 13,
      },
      {
        user_id: 'user',
        permission: 'event-automation-rules:create',
        granted_by_user_id: 'admin',
        granted_at: 11,
      },
      {
        user_id: 'user',
        permission: 'event-automation-rules:delete',
        granted_by_user_id: 'new-admin',
        granted_at: 16,
      },
      {
        user_id: 'user',
        permission: 'event-sources:update',
        granted_by_user_id: 'admin',
        granted_at: 17,
      },
    ])
  })

  test('renames and deduplicates all valid string-array PAT rows without changing token state', () => {
    const db = fixture()
    db.exec(SQL)

    expect(
      db.query('SELECT id, scopes_json, expires_at, revoked_at FROM user_pats ORDER BY id').all(),
    ).toEqual([
      {
        id: 'active',
        scopes_json:
          '["event-automation-rules:read","event-automation-rules:create","event-sources:update"]',
        expires_at: null,
        revoked_at: null,
      },
      {
        id: 'expired',
        scopes_json: '["event-automation-rules:delete"]',
        expires_at: 10,
        revoked_at: null,
      },
      { id: 'invalid-json', scopes_json: '{broken', expires_at: null, revoked_at: null },
      {
        id: 'mixed-array',
        scopes_json: '[1,"webhook-triggers:read"]',
        expires_at: null,
        revoked_at: null,
      },
      {
        id: 'revoked',
        scopes_json: '["event-automation-rules:update"]',
        expires_at: null,
        revoked_at: 20,
      },
      {
        id: 'unrelated',
        scopes_json: '[ "event-sources:read" ]',
        expires_at: null,
        revoked_at: null,
      },
    ])
  })

  test('does not rewrite append-only access history and is idempotent', () => {
    const db = fixture()
    db.exec(SQL)
    const once = {
      grants: grantRows(db),
      pats: db.query('SELECT id, scopes_json FROM user_pats ORDER BY id').all(),
      audit: db.query('SELECT * FROM user_access_audit').all(),
    }

    db.exec(SQL)
    expect({
      grants: grantRows(db),
      pats: db.query('SELECT id, scopes_json FROM user_pats ORDER BY id').all(),
      audit: db.query('SELECT * FROM user_access_audit').all(),
    }).toEqual(once)
    expect(once.audit).toEqual([
      {
        id: 'audit',
        added_permissions_json: '["webhook-triggers:create"]',
        removed_permissions_json: '["webhook-triggers:delete"]',
      },
    ])
  })
})
