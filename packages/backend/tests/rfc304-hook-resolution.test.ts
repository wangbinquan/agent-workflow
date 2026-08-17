// RFC-304 T7 — where a repository's hooks come from.
//
// The lookup is repo cell → binding → framework, and each hop is a place a
// wrong join silently changes whose scripts run as the daemon. One such bug was
// in the first draft of this module: `.where(eq(repoId) && eq(capability))`,
// with a JavaScript `&&` instead of drizzle's `and()`. A `&&` between two
// condition objects evaluates to the SECOND one, so the repository filter
// vanished and every repository would have inherited whichever cell matched the
// capability first — running another team's daemon-privileged scripts. It
// type-checks, and it passes any test that only ever seeds one repository.
//
// Hence the cross-repository and cross-capability cases below: they are the
// only ones that can see that class of mistake.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { capabilityTemplates, repoCapabilityConfig } from '../src/db/schema'
import { hooksFor, resolveCapabilityHooks } from '../src/services/codeCapabilityHooks'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const NOW = 1_700_000_000_000

const HOOK = {
  stage: 'publish',
  phase: 'pre',
  language: 'bash',
  script: 'exit 0',
  blocking: true,
}

async function seed(
  db: DbClient,
  over: {
    repoId?: string
    capability?: string
    hooksJson?: string
    frameworkVer?: number
    frameworkId?: string
    templateId?: string
  } = {},
) {
  // RFC-309 — hooks live on the template the cell points at. This used to be a
  // framework row plus a binding row pointing at it, and the resolution had to
  // hop through the middle; the merge removed the hop and the class of failure
  // where the middle row went missing on its own.
  const templateId = over.templateId ?? 'bd-1'
  await db
    .insert(capabilityTemplates)
    .values({
      id: templateId,
      name: `template-${templateId}`,
      capability: over.capability ?? 'mr-review',
      hooksJson: over.hooksJson ?? JSON.stringify([HOOK]),
      stageContractVer: over.frameworkVer ?? 4,
      createdAt: NOW,
      updatedAt: NOW,
    })
    .onConflictDoNothing()
  await db.insert(repoCapabilityConfig).values({
    id: `cell-${over.repoId ?? 'repo-a'}-${over.capability ?? 'mr-review'}`,
    repoId: over.repoId ?? 'repo-a',
    capability: over.capability ?? 'mr-review',
    templateId,
    enabled: true,
    createdAt: NOW,
    updatedAt: NOW,
  })
}

describe('RFC-304 — resolving a repository’s hooks', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })
  afterEach(() => db.$client.close())

  test('finds the framework’s hooks through the binding', async () => {
    await seed(db)
    const resolved = await resolveCapabilityHooks(db, {
      repoId: 'repo-a',
      capability: 'mr-review',
    })
    expect(resolved.hooks).toHaveLength(1)
    expect(resolved.hooks[0]?.stage).toBe('publish')
    expect(resolved.hooks[0]?.blocking).toBe(true)
  })

  test('carries the framework’s contract version, for the migration check', async () => {
    await seed(db, { frameworkVer: 2 })
    const resolved = await resolveCapabilityHooks(db, {
      repoId: 'repo-a',
      capability: 'mr-review',
    })
    expect(resolved.stageContractVer).toBe(2)
    expect(resolved.hooks[0]?.stageContractVer).toBe(2)
  })

  test('ANOTHER repository does not inherit these hooks', async () => {
    // The `&&`-instead-of-`and()` bug. With it, this returns repo-a's hooks —
    // one team's daemon-privileged scripts running on another team's MRs.
    await seed(db, { repoId: 'repo-a' })
    const resolved = await resolveCapabilityHooks(db, {
      repoId: 'repo-b',
      capability: 'mr-review',
    })
    expect(resolved.hooks).toEqual([])
  })

  test('another CAPABILITY on the same repository does not inherit them', async () => {
    await seed(db, { repoId: 'repo-a', capability: 'mr-review' })
    const resolved = await resolveCapabilityHooks(db, {
      repoId: 'repo-a',
      capability: 'mr-monitor',
    })
    expect(resolved.hooks).toEqual([])
  })

  test('two repositories keep their own hooks', async () => {
    await seed(db, { repoId: 'repo-a', frameworkId: 'fw-a', templateId: 'bd-a' })
    await seed(db, {
      repoId: 'repo-b',
      templateId: 'bd-b',
      hooksJson: JSON.stringify([{ ...HOOK, stage: 'gate' }]),
    })
    const a = await resolveCapabilityHooks(db, { repoId: 'repo-a', capability: 'mr-review' })
    const b = await resolveCapabilityHooks(db, { repoId: 'repo-b', capability: 'mr-review' })
    expect(a.hooks[0]?.stage).toBe('publish')
    expect(b.hooks[0]?.stage).toBe('gate')
  })

  test('a repository with no cell has no hooks, and that is not a problem', async () => {
    // Most repositories never write one; reporting it would make the ordinary
    // case look like a fault.
    const resolved = await resolveCapabilityHooks(db, {
      repoId: 'never-configured',
      capability: 'mr-review',
    })
    expect(resolved.hooks).toEqual([])
    expect(resolved.problem).toBeNull()
  })
})

describe('RFC-304 — a framework whose hooks are malformed', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })
  afterEach(() => db.$client.close())

  test('unparsable JSON disables the hooks and says so', async () => {
    // Not a round failure: refusing to review anything until somebody fixes a
    // JSON column takes the platform down for every MR in the repository.
    await seed(db, { hooksJson: '{not json' })
    const resolved = await resolveCapabilityHooks(db, {
      repoId: 'repo-a',
      capability: 'mr-review',
    })
    expect(resolved.hooks).toEqual([])
    expect(String(resolved.problem)).toContain('not valid JSON')
  })

  test('a non-list is refused by name', async () => {
    await seed(db, { hooksJson: '{"stage":"publish"}' })
    const resolved = await resolveCapabilityHooks(db, {
      repoId: 'repo-a',
      capability: 'mr-review',
    })
    expect(String(resolved.problem)).toContain('not a list')
  })

  test('one bad hook does not disarm the good ones', async () => {
    // All-or-nothing would let a typo in an optional hook silently switch off a
    // team's mandatory gate.
    await seed(db, {
      hooksJson: JSON.stringify([HOOK, { stage: 'gate' }]),
    })
    const resolved = await resolveCapabilityHooks(db, {
      repoId: 'repo-a',
      capability: 'mr-review',
    })
    expect(resolved.hooks).toHaveLength(1)
    expect(resolved.hooks[0]?.stage).toBe('publish')
  })

  test('the rejected hook is named, so it can be fixed', async () => {
    await seed(db, { hooksJson: JSON.stringify([{ stage: 'gate', phase: 'pre' }]) })
    const resolved = await resolveCapabilityHooks(db, {
      repoId: 'repo-a',
      capability: 'mr-review',
    })
    expect(String(resolved.problem)).toContain('gate')
    expect(String(resolved.problem)).toContain('script')
  })

  test('a hook with an unknown phase is refused rather than defaulted', async () => {
    // Defaulting to `pre` would run a hook the author meant to run AFTER the
    // stage — before it, against different state.
    await seed(db, {
      hooksJson: JSON.stringify([{ ...HOOK, phase: 'during' }]),
    })
    const resolved = await resolveCapabilityHooks(db, {
      repoId: 'repo-a',
      capability: 'mr-review',
    })
    expect(resolved.hooks).toEqual([])
    expect(String(resolved.problem)).toContain('pre/post')
  })

  test('a hook is not blocking unless it says so', async () => {
    // The power to stop the line is not something a hook acquires by accident.
    await seed(db, {
      hooksJson: JSON.stringify([{ stage: 'gate', phase: 'pre', language: 'bash', script: 'x' }]),
    })
    const resolved = await resolveCapabilityHooks(db, {
      repoId: 'repo-a',
      capability: 'mr-review',
    })
    expect(resolved.hooks[0]?.blocking).toBeUndefined()
  })
})

describe('RFC-304 — hooksFor', () => {
  test('selects by stage AND phase', async () => {
    const hooks = [
      {
        ...HOOK,
        stage: 'gate',
        phase: 'pre' as const,
        stageContractVer: 4,
        language: 'bash' as const,
      },
      {
        ...HOOK,
        stage: 'gate',
        phase: 'post' as const,
        stageContractVer: 4,
        language: 'bash' as const,
      },
      {
        ...HOOK,
        stage: 'publish',
        phase: 'pre' as const,
        stageContractVer: 4,
        language: 'bash' as const,
      },
    ]
    expect(hooksFor(hooks, 'gate', 'pre')).toHaveLength(1)
    expect(hooksFor(hooks, 'gate', 'post')).toHaveLength(1)
    expect(hooksFor(hooks, 'nothing', 'pre')).toHaveLength(0)
  })
})
