// RFC-321 — old global code-host ciphertext must be projected byte-for-byte,
// while personal publication credentials start empty and remain bound to the
// exact user + provider + logical connection generation.

import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const MIGRATION = resolve(
  import.meta.dir,
  '..',
  'db',
  'migrations',
  '0208_rfc321_repository_transport_credentials.sql',
)

function legacyDatabase(): Database {
  const sqlite = new Database(':memory:')
  sqlite.exec('PRAGMA foreign_keys = ON;')
  sqlite.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY NOT NULL
    );
    CREATE TABLE code_host_connections (
      provider text PRIMARY KEY NOT NULL,
      base_url text NOT NULL,
      repository_url_prefixes_json text DEFAULT '[]' NOT NULL,
      reject_unauthorized integer DEFAULT 1 NOT NULL,
      token_enc text NOT NULL,
      token_hint text NOT NULL,
      last_test_json text,
      updated_at integer DEFAULT (unixepoch() * 1000) NOT NULL,
      updated_by text
    );
    INSERT INTO users (id) VALUES ('alice'), ('bob');
    INSERT INTO code_host_connections (
      provider, base_url, repository_url_prefixes_json, reject_unauthorized,
      token_enc, token_hint, last_test_json, updated_at, updated_by
    ) VALUES (
      'gitlab', 'https://gitlab.example/api/v4',
      '["https://code.example/team"]', 0,
      'sealed-global-ciphertext', '1234', '{"ok":true}', 321, 'alice'
    );
  `)
  return sqlite
}

describe('migration 0208 — repository transport credentials', () => {
  test('copies the global sealed projection without exposing or rewriting the ciphertext', () => {
    const sqlite = legacyDatabase()
    sqlite.exec(readFileSync(MIGRATION, 'utf8'))

    const connection = sqlite
      .query(
        `SELECT provider, base_url AS baseUrl,
                connection_generation AS generation,
                transport_mappings_json AS mappings,
                token_enc AS tokenEnc, token_hint AS tokenHint,
                reject_unauthorized AS rejectUnauthorized,
                last_test_json AS lastTest, updated_at AS updatedAt, updated_by AS updatedBy
         FROM code_host_connections`,
      )
      .get() as Record<string, unknown>
    expect(connection).toMatchObject({
      provider: 'gitlab',
      baseUrl: 'https://gitlab.example/api/v4',
      mappings: '[]',
      tokenEnc: 'sealed-global-ciphertext',
      tokenHint: '1234',
      rejectUnauthorized: 0,
      lastTest: '{"ok":true}',
      updatedAt: 321,
      updatedBy: 'alice',
    })
    expect(connection.generation).toMatch(/^[a-f0-9]{32}$/)

    const projection = sqlite
      .query(
        `SELECT provider, connection_generation AS generation,
                endpoint_binding_digest AS digest,
                transport_mappings_json AS mappings,
                allowed_http_base_urls_json AS allowedBases,
                global_token_enc AS tokenEnc, global_token_hint AS tokenHint,
                credential_revision AS revision
         FROM repository_transport_connections`,
      )
      .get() as Record<string, unknown>
    expect(projection).toMatchObject({
      provider: 'gitlab',
      generation: connection.generation,
      mappings: '[]',
      allowedBases: '["https://code.example/team"]',
      tokenEnc: 'sealed-global-ciphertext',
      tokenHint: '1234',
      revision: 1,
    })
    expect(projection.digest).toMatch(/^[a-f0-9]{64}$/)
    expect(
      sqlite.query('SELECT count(*) AS count FROM user_repository_transport_credentials').get(),
    ).toEqual({ count: 0 })
    sqlite.close()
  })

  test('enforces user/provider uniqueness and the current connection generation', () => {
    const sqlite = legacyDatabase()
    sqlite.exec(readFileSync(MIGRATION, 'utf8'))
    const binding = sqlite
      .query(
        `SELECT connection_generation AS generation, endpoint_binding_digest AS digest
         FROM repository_transport_connections WHERE provider = 'gitlab'`,
      )
      .get() as { generation: string; digest: string }
    const insert = sqlite.query(`
      INSERT INTO user_repository_transport_credentials (
        user_id, provider, connection_generation, endpoint_binding_digest,
        token_enc, token_hint, credential_revision, created_at, updated_at
      ) VALUES (?, 'gitlab', ?, ?, ?, ?, 1, 1, 1)
    `)
    insert.run('alice', binding.generation, binding.digest, 'sealed-personal', '9999')
    expect(() =>
      insert.run('alice', binding.generation, binding.digest, 'replacement', '8888'),
    ).toThrow()
    expect(() => insert.run('bob', 'stale-generation', binding.digest, 'sealed', '7777')).toThrow()
    expect(() =>
      insert.run('missing-user', binding.generation, binding.digest, 'sealed', '6666'),
    ).toThrow()

    sqlite.query("DELETE FROM repository_transport_connections WHERE provider = 'gitlab'").run()
    expect(
      sqlite.query('SELECT count(*) AS count FROM user_repository_transport_credentials').get(),
    ).toEqual({ count: 0 })
    sqlite.close()
  })

  test('new integration rows mint a non-empty generation even for an older writer', () => {
    const sqlite = legacyDatabase()
    sqlite.exec(readFileSync(MIGRATION, 'utf8'))
    sqlite
      .query(
        `INSERT INTO code_host_connections (
          provider, base_url, token_enc, token_hint, updated_at
        ) VALUES ('github', 'https://api.github.com', 'sealed', 'abcd', 1)`,
      )
      .run()
    expect(
      sqlite
        .query(
          `SELECT length(connection_generation) AS generationLength,
                  transport_mappings_json AS mappings
           FROM code_host_connections WHERE provider = 'github'`,
        )
        .get(),
    ).toEqual({ generationLength: 32, mappings: '[]' })
    sqlite.close()
  })
})
