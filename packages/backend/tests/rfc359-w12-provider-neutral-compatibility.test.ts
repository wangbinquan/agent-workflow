// RFC-359 W12 — the compatibility inputs retained in production now accept
// either database client. Exercise their real queries and runtime delegation
// through the same harness before retiring their misleading SQLite names.

import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'

import { createAuthRuntimeFor } from '@/auth/composition'
import { compatibleAuthRuntimeOf } from '@/auth/infrastructure/compatibleAuthRuntime'
import { users, workflows } from '@/db/schema'
import { createIdentityAccessRuntime } from '@/modules/identity-access/composition'
import { legacyUserService } from '@/modules/identity-access/composition/legacyUserService'
import type { SearchInput } from '@/modules/identity-access/infrastructure/legacyUserService'
import { ownerScopedNameCondition } from '@/modules/identity-access/infrastructure/ownerScopedName'
import { describeEachProvider } from './helpers/eachProvider'

describeEachProvider('RFC-359 W12 — shared compatibility inputs', (harness) => {
  test('database and bound-runtime inputs resolve the same persisted login policy', async () => {
    const runtime = createAuthRuntimeFor({ db: harness.db })
    const policy = await runtime.getLoginPolicy()

    expect(compatibleAuthRuntimeOf(runtime)).toBe(runtime)
    expect(compatibleAuthRuntimeOf({ auth: runtime })).toBe(runtime)
    await expect(compatibleAuthRuntimeOf(harness.db).getLoginPolicy()).resolves.toEqual(policy)
    await expect(compatibleAuthRuntimeOf({ db: harness.db }).getLoginPolicy()).resolves.toEqual(
      policy,
    )
  })

  test('compatibility user creation and profile updates round-trip through the shared runtime', async () => {
    const baseline = await legacyUserService.countNonSystemUsers(harness.db)
    const created = await legacyUserService.createUser(harness.db, {
      username: 'compat_profile',
      displayName: 'Original Name',
      role: 'user',
      now: 100,
    })
    expect(created).toMatchObject({ username: 'compat_profile', displayName: 'Original Name' })
    const updated = await legacyUserService.patchUser(
      harness.db,
      created.id,
      { displayName: 'Updated Name' },
      200,
    )
    expect(updated.displayName).toBe('Updated Name')
    expect(await legacyUserService.findById(harness.db, created.id)).toEqual(updated)
    expect(await legacyUserService.findByUsername(harness.db, 'compat_profile')).toEqual(updated)
    expect(await legacyUserService.countNonSystemUsers(harness.db)).toBe(baseline + 1)
    expect((await legacyUserService.listAllUsers(harness.db)).map((row) => row.id)).toContain(
      created.id,
    )
  })

  test('directory search and Git identity preserve the same user projection on either client', async () => {
    await harness.db.insert(users).values({
      id: 'compat_search_user',
      username: 'compat_search',
      displayName: 'Mixed Case Display',
      gitName: 'Commit Author',
      email: 'author@example.test',
      status: 'active',
      role: 'user',
      createdAt: 10,
      updatedAt: 10,
    })

    expect(
      await legacyUserService.searchUsersPublic(harness.db, { q: '  MIXED ', limit: 1 }),
    ).toEqual([
      {
        id: 'compat_search_user',
        username: 'compat_search',
        displayName: 'Mixed Case Display',
        status: 'active',
        role: 'user',
      },
    ])
    expect(
      await legacyUserService.lookupUsersPublic(harness.db, [
        'compat_search_user',
        'compat_search_user',
        'missing_user',
      ]),
    ).toHaveLength(1)
    expect(
      await legacyUserService.getUserGitCommitIdentity(harness.db, 'compat_search_user'),
    ).toEqual({ name: 'Commit Author', email: 'author@example.test' })
  })

  test('compatibility searches share the canonical directory ordering before filtering and limiting', async () => {
    await harness.db.insert(users).values([
      { id: 'mixed_z', username: 'MiXeD_z', displayName: 'Late', createdAt: 30, updatedAt: 30 },
      {
        id: 'mixed_b',
        username: 'other_b',
        displayName: 'MIXED B',
        createdAt: 10,
        updatedAt: 10,
      },
      { id: 'mixed_a', username: 'mixed_a', displayName: 'Alpha', createdAt: 10, updatedAt: 10 },
      {
        id: 'mixed_disabled',
        username: 'mixed_disabled',
        displayName: 'Disabled',
        status: 'disabled',
        createdAt: 0,
        updatedAt: 0,
      },
      {
        id: 'mixed_invited',
        username: 'other_invited',
        displayName: 'Mixed Invited',
        status: 'invited',
        createdAt: 20,
        updatedAt: 20,
      },
    ])
    const cases: ReadonlyArray<{ input: SearchInput; ids: readonly string[] }> = [
      {
        input: { q: '  MiXeD ' },
        ids: ['mixed_disabled', 'mixed_a', 'mixed_b', 'mixed_invited', 'mixed_z'],
      },
      { input: { q: 'MIXED', status: 'active', limit: 2 }, ids: ['mixed_a', 'mixed_b'] },
      {
        input: { q: 'mixed', excludeIds: ['mixed_a'], limit: 2 },
        ids: ['mixed_b', 'mixed_invited'],
      },
      {
        input: { q: 'mixed', status: 'disabled', excludeIds: ['mixed_b'], limit: 1 },
        ids: ['mixed_disabled'],
      },
    ]
    const runtime = createIdentityAccessRuntime({ db: harness.db })
    try {
      for (const { input, ids } of cases) {
        const actual = await legacyUserService.searchUsersPublic(harness.db, input)
        const canonical = await runtime.userDirectory.search({
          ...input,
          limit: input.limit ?? 20,
          excludeIds: input.excludeIds ?? [],
        })
        expect(actual).toEqual([...canonical])
        expect(actual.map((row) => row.id)).toEqual([...ids])
      }
    } finally {
      runtime.shutdown()
    }
  })

  test('compatibility searches retain their default and bounded limits', async () => {
    const rows = Array.from({ length: 105 }, (_, index) => ({
      id: `compat_limit_${index.toString().padStart(3, '0')}`,
      username: `compat_limit_${index.toString().padStart(3, '0')}`,
      displayName: `Compatibility ${index}`,
      createdAt: index,
      updatedAt: index,
    }))
    await harness.db.insert(users).values([...rows].reverse())
    const runtime = createIdentityAccessRuntime({ db: harness.db })
    try {
      for (const [requested, expected] of [
        [undefined, 20],
        [0, 1],
        [500, 100],
      ] as const) {
        const actual = await legacyUserService.searchUsersPublic(harness.db, {
          q: 'compat_limit_',
          limit: requested,
        })
        const canonical = await runtime.userDirectory.search({
          q: 'compat_limit_',
          limit: expected,
          excludeIds: [],
        })
        expect(actual).toEqual([...canonical])
        expect(actual.map((row) => row.id)).toEqual(rows.slice(0, expected).map((row) => row.id))
      }
    } finally {
      runtime.shutdown()
    }
  })

  test('owner/name conditions match null and named owners and honor the excluded row', async () => {
    await harness.db.insert(workflows).values([
      { id: 'compat_unowned', name: 'Same name', definition: '{}', ownerUserId: null },
      { id: 'compat_owned', name: 'Same name', definition: '{}', ownerUserId: 'compat_owner' },
    ])
    const ids = async (owner: string | null, excludedId?: string) =>
      (
        await harness.db
          .select({ id: workflows.id })
          .from(workflows)
          .where(
            ownerScopedNameCondition(
              workflows.ownerUserId,
              workflows.name,
              owner,
              'Same name',
              excludedId === undefined ? undefined : { column: workflows.id, id: excludedId },
            ),
          )
      ).map((row) => row.id)

    expect(await ids(null)).toEqual(['compat_unowned'])
    expect(await ids('compat_owner')).toEqual(['compat_owned'])
    expect(await ids('compat_owner', 'compat_owned')).toEqual([])
    await harness.db.delete(workflows).where(eq(workflows.id, 'compat_owned'))
    expect(await ids('compat_owner')).toEqual([])
  })
})
