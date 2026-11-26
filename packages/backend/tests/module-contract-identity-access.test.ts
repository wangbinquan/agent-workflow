// Module contract audit: exercise the composed public profile/directory surface on both providers.
// Existing auth-routes and users-service cases cover the ordinary UI flows; these cases lock
// no-op writes, cross-view coherence, and bounded batch lookup without testing access policy.
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { createIdentityAccessRuntime } from '@/modules/identity-access/composition'
import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { describeEachProvider } from './helpers/eachProvider'
import { admitTestDirectAuthority } from './helpers/identityAccessAuthority'

async function seedUser(db: PersistenceDb, id: string, email: string | null = null) {
  const { users } = tablesOf(db)
  await insertOne(db, users, {
    id,
    username: id,
    displayName: `Display ${id}`,
    gitName: `Git ${id}`,
    email,
    role: 'user',
    status: 'active',
    createdAt: 10,
    updatedAt: 20,
  })
}

describeEachProvider('module contract — identity-access profile and directory', (harness) => {
  test('profile edits are immediately reflected in profile, commit identity and public display name', async () => {
    await seedUser(harness.db, 'contract-profile')
    const runtime = createIdentityAccessRuntime({ db: harness.db })
    try {
      expect(await runtime.getUserProfile.execute('contract-profile')).toMatchObject({
        email: null,
        gitCommitIdentity: null,
      })
      expect(await runtime.getUserProfile.execute('missing-profile')).toBeNull()
      const identity = await admitTestDirectAuthority(runtime.directAuthority, {
        userId: 'contract-profile',
        source: 'session',
      })
      if (identity === null) throw new Error('fixture identity missing')
      const receipt = await runtime.updateOwnProfile.execute(
        runtime.contexts.fromAuthority(identity.authority, 'http', 500),
        { displayName: '陈 · Alice', gitName: 'Alice Chen', email: 'alice@example.test' },
      )
      expect(await runtime.getUserProfile.execute('contract-profile')).toEqual(receipt)
      expect(await runtime.getUserGitCommitIdentity.execute('contract-profile')).toEqual({
        name: 'Alice Chen',
        email: 'alice@example.test',
      })
      expect(await runtime.userDirectory.lookup(['contract-profile'])).toEqual([
        {
          id: 'contract-profile',
          username: 'contract-profile',
          displayName: '陈 · Alice',
          role: 'user',
          status: 'active',
        },
      ])
    } finally {
      runtime.shutdown()
    }
  })

  test('saving an unchanged profile does not rewrite the user or append another audit row', async () => {
    await seedUser(harness.db, 'contract-noop', 'noop@example.test')
    const runtime = createIdentityAccessRuntime({ db: harness.db })
    try {
      const identity = await admitTestDirectAuthority(runtime.directAuthority, {
        userId: 'contract-noop',
        source: 'session',
      })
      if (identity === null) throw new Error('fixture identity missing')
      const recording = harness.recordStatements()
      try {
        await runtime.updateOwnProfile.execute(
          runtime.contexts.fromAuthority(identity.authority, 'http', 500),
          {
            displayName: 'Display contract-noop',
            gitName: 'Git contract-noop',
            email: 'noop@example.test',
          },
        )
      } finally {
        recording.stop()
      }
      const profileWrites = recording.statements.filter(
        ({ sql }) =>
          /^\s*(?:insert|update)\b/i.test(sql) && /"(?:users|user_access_audit)"/.test(sql),
      )
      expect(profileWrites).toEqual([])
      const { users, userAccessAudit } = tablesOf(harness.db)
      expect(
        await harness.db
          .select({ updatedAt: users.updatedAt })
          .from(users)
          .where(eq(users.id, 'contract-noop')),
      ).toEqual([{ updatedAt: 20 }])
      expect(
        await harness.db
          .select()
          .from(userAccessAudit)
          .where(eq(userAccessAudit.targetUserId, 'contract-noop')),
      ).toEqual([])
    } finally {
      runtime.shutdown()
    }
  })

  test('lookup preserves first-request order, deduplicates ids and uses one bounded batch read', async () => {
    const ids = Array.from(
      { length: 40 },
      (_, index) => `contract-user-${String(index).padStart(2, '0')}`,
    )
    for (const id of ids) await seedUser(harness.db, id)
    const runtime = createIdentityAccessRuntime({ db: harness.db })
    try {
      const wanted = [...ids].reverse()
      const recording = harness.recordStatements()
      let rows: Awaited<ReturnType<typeof runtime.userDirectory.lookup>>
      try {
        rows = await runtime.userDirectory.lookup([
          wanted[0]!,
          'missing-user',
          ...wanted,
          wanted[0]!,
        ])
      } finally {
        recording.stop()
      }
      expect(rows.map((row) => row.id)).toEqual(wanted)
      const reads = recording.selects().filter(({ sql }) => /"users"/.test(sql))
      expect(reads).toHaveLength(1)
      expect(reads[0]!.rows).toBe(40)
      expect(reads[0]!.params).toBeLessThanOrEqual(41)

      const emptyRecording = harness.recordStatements()
      try {
        expect(await runtime.userDirectory.lookup([])).toEqual([])
      } finally {
        emptyRecording.stop()
      }
      expect(emptyRecording.selects().filter(({ sql }) => /"users"/.test(sql))).toEqual([])
    } finally {
      runtime.shutdown()
    }
  })

  test('an email already used by another profile leaves all current profile fields intact', async () => {
    await seedUser(harness.db, 'contract-editor', 'editor@example.test')
    await seedUser(harness.db, 'contract-existing', 'existing@example.test')
    const runtime = createIdentityAccessRuntime({ db: harness.db })
    try {
      const before = await runtime.getUserProfile.execute('contract-editor')
      const identity = await admitTestDirectAuthority(runtime.directAuthority, {
        userId: 'contract-editor',
        source: 'session',
      })
      if (identity === null) throw new Error('fixture identity missing')
      await expect(
        runtime.updateOwnProfile.execute(
          runtime.contexts.fromAuthority(identity.authority, 'http', 500),
          {
            displayName: 'Must not persist',
            gitName: 'Must not persist',
            email: 'existing@example.test',
          },
        ),
      ).rejects.toMatchObject({ code: 'profile-email-conflict' })
      expect(await runtime.getUserProfile.execute('contract-editor')).toEqual(before)
    } finally {
      runtime.shutdown()
    }
  })
})
