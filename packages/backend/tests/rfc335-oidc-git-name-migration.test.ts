import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const MIGRATION = resolve(
  import.meta.dir,
  '..',
  'db',
  'migrations',
  '0214_rfc335_oidc_git_name.sql',
)

describe('migration 0214 — independent OIDC Git name', () => {
  test('backfills every existing user and adds the provider selector', () => {
    const sqlite = new Database(':memory:')
    sqlite.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY NOT NULL,
        display_name TEXT NOT NULL
      );
      CREATE TABLE oidc_providers (
        id TEXT PRIMARY KEY NOT NULL,
        username_claim TEXT
      );
      INSERT INTO users (id, display_name) VALUES
        ('local', 'Local Display'),
        ('oidc', 'OIDC Display'),
        ('__system__', 'System');
      INSERT INTO oidc_providers (id, username_claim) VALUES ('provider', 'nickname');
    `)

    sqlite.exec(readFileSync(MIGRATION, 'utf8'))

    expect(sqlite.query('SELECT id, display_name, git_name FROM users ORDER BY id').all()).toEqual([
      { id: '__system__', display_name: 'System', git_name: 'System' },
      { id: 'local', display_name: 'Local Display', git_name: 'Local Display' },
      { id: 'oidc', display_name: 'OIDC Display', git_name: 'OIDC Display' },
    ])
    sqlite
      .query("UPDATE users SET display_name = 'Visible', git_name = 'Committer' WHERE id = 'oidc'")
      .run()
    expect(
      sqlite.query("SELECT display_name, git_name FROM users WHERE id = 'oidc'").get(),
    ).toEqual({
      display_name: 'Visible',
      git_name: 'Committer',
    })

    sqlite
      .query("UPDATE oidc_providers SET git_name_claim = 'full_name' WHERE id = 'provider'")
      .run()
    expect(
      sqlite
        .query("SELECT username_claim, git_name_claim FROM oidc_providers WHERE id = 'provider'")
        .get(),
    ).toEqual({ username_claim: 'nickname', git_name_claim: 'full_name' })
    sqlite.close()
  })
})
