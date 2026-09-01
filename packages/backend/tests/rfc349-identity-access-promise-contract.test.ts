// RFC-349 — identity-access commands keep one Promise application surface even
// when SQLite performs the underlying decision in a synchronous transaction.

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

import { createInMemoryDb } from '@/db/client'
import { createIdentityAccessRuntime } from '@/modules/identity-access/composition'
import { admitTestDirectAuthority } from './helpers/identityAccessAuthority'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

describe('RFC-349 identity-access Promise contract', () => {
  test('SQLite public directory matches PostgreSQL filtering and lookup order', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const insert = db.$client.query(
      `INSERT INTO users (
        id, username, display_name, git_name, role, status,
        force_password_change, created_at, updated_at, schema_version, access_revision
      ) VALUES (?, ?, ?, ?, 'user', ?, 0, ?, ?, 1, 0)`,
    )
    insert.run('user-1', 'alice', 'Alice', 'Alice', 'active', 1, 1)
    insert.run('user-2', 'archived', 'Archived', 'Archived', 'disabled', 2, 2)
    const runtime = createIdentityAccessRuntime({ db })

    await expect(
      runtime.userDirectory.search({
        q: 'a',
        limit: 10,
        excludeIds: ['other'],
      }),
    ).resolves.toEqual([
      { id: 'user-1', username: 'alice', displayName: 'Alice', role: 'user', status: 'active' },
    ])
    await expect(runtime.userDirectory.lookup(['user-2', 'missing', 'user-1'])).resolves.toEqual([
      {
        id: 'user-2',
        username: 'archived',
        displayName: 'Archived',
        role: 'user',
        status: 'disabled',
      },
      { id: 'user-1', username: 'alice', displayName: 'Alice', role: 'user', status: 'active' },
    ])
    runtime.shutdown()
  })

  test('SQLite profile mutation returns a Promise and keeps audit atomic', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    db.$client
      .query(
        `INSERT INTO users (
          id, username, email, display_name, git_name, role, status,
          force_password_change, created_at, updated_at, schema_version, access_revision
        ) VALUES (?, ?, ?, ?, ?, 'user', 'active', 0, 1, 1, 1, 0)`,
      )
      .run('user-1', 'user-1', 'old@example.com', 'Old', 'Old Git')
    const runtime = createIdentityAccessRuntime({ db, id: () => 'audit-1' })
    const identity = await admitTestDirectAuthority(runtime.directAuthority, {
      userId: 'user-1',
      source: 'session',
    })
    const context = runtime.contexts.fromAuthority(identity!.authority, 'http', 2)

    const pending = runtime.updateOwnProfile.execute(context, {
      displayName: 'New',
      gitName: 'New Git',
      email: 'new@example.com',
    })

    expect(pending).toBeInstanceOf(Promise)
    await expect(pending).resolves.toEqual({
      displayName: 'New',
      gitName: 'New Git',
      email: 'new@example.com',
      gitCommitIdentity: { name: 'New Git', email: 'new@example.com' },
    })
    expect(
      db.$client
        .query('SELECT display_name, git_name, email FROM users WHERE id = ?')
        .get('user-1'),
    ).toEqual({ display_name: 'New', git_name: 'New Git', email: 'new@example.com' })
    expect(
      db.$client
        .query('SELECT target_user_id, access_revision FROM user_access_audit WHERE id = ?')
        .get('audit-1'),
    ).toEqual({ target_user_id: 'user-1', access_revision: 0 })
    runtime.shutdown()
  })
})
