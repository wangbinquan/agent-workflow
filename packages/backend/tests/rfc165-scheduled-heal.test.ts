// LOCKS: RFC-165 T4 — scheduled launchPayload boot healer + tolerant repair
// (design §9, §11.14/.15).
//
//   H1 path row (real local git repo) → rewritten to a FAITHFUL file:// URL
//      (pathToFileURL(realpath), baseBranch → ref, retired keys dropped);
//      enabled untouched; second run is a no-op (idempotent).
//   H2 fetchBeforeLaunch:true → DISABLED + 'rfc165-fetch-semantic-review'
//      (the old semantics have no file:// equivalent — never silently
//      converted); payload left as-is; re-run skips the row.
//   H3 missing dir → DISABLED + 'rfc165-local-path-retired'.
//   H4 multi-repo with ONE missing path → whole row disabled, payload NOT
//      half-rewritten.
//   H5 v2-clean rows untouched.
//   H6 a healed payload passes StartTaskSchema strictly (fire-ready).
//   H7 degraded row repair: partial PUT keeping the broken field → 422
//      'scheduled-task-needs-repair'; full-field PUT repairs and clears the
//      rfc165 lastError breadcrumb.
import { beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { StartTaskSchema } from '@agent-workflow/shared'
import { buildActor } from '../src/auth/actor'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { scheduledTasks, users, workflows } from '../src/db/schema'
import {
  getScheduledTask,
  healScheduledLaunchPayloads,
  updateScheduledTask,
} from '../src/services/scheduledTasks'
import { runGit } from '../src/util/git'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

let db: DbClient
let tmp: string

async function seedRepo(name: string): Promise<string> {
  const repo = join(tmp, name)
  await runGit(tmp, ['init', '-q', '-b', 'main', name])
  await runGit(repo, [
    '-c',
    'user.name=T',
    '-c',
    'user.email=t@t',
    'commit',
    '--allow-empty',
    '-q',
    '-m',
    'init',
  ])
  return repo
}

async function seedRow(
  payload: unknown,
  overrides: Partial<typeof scheduledTasks.$inferInsert> = {},
): Promise<string> {
  const id = ulid()
  await db.insert(scheduledTasks).values({
    id,
    name: 'sched',
    ownerUserId: 'alice',
    launchPayload: JSON.stringify(payload),
    scheduleSpec: JSON.stringify({ kind: 'interval', every: 1, unit: 'hours' }),
    enabled: true,
    nextRunAt: Date.now() + 60_000,
    consecutiveFailures: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  })
  return id
}

async function rawPayload(id: string): Promise<Record<string, unknown>> {
  const row = (await db.select().from(scheduledTasks).where(eq(scheduledTasks.id, id)))[0]!
  return JSON.parse(row.launchPayload) as Record<string, unknown>
}

async function rawRow(id: string) {
  return (await db.select().from(scheduledTasks).where(eq(scheduledTasks.id, id)))[0]!
}

describe('RFC-165 T4 — scheduled payload heal + tolerant repair', () => {
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
    tmp = mkdtempSync(join(tmpdir(), 'aw-rfc165-heal-'))
  })

  test('H1 path row → faithful file:// rewrite; idempotent', async () => {
    const repo = await seedRepo('r1')
    const id = await seedRow({
      workflowId: 'wf1',
      name: 't',
      inputs: {},
      repoPath: repo,
      baseBranch: 'main',
    })

    const r1 = await healScheduledLaunchPayloads(db)
    expect(r1.converted).toBe(1)
    expect(r1.disabled).toBe(0)

    const p = await rawPayload(id)
    expect(p['repoUrl']).toBe(pathToFileURL(realpathSync(repo)).href)
    expect(p['ref']).toBe('main')
    expect('repoPath' in p).toBe(false)
    expect('baseBranch' in p).toBe(false)
    expect('fetchBeforeLaunch' in p).toBe(false)
    expect((await rawRow(id)).enabled).toBe(true)

    const r2 = await healScheduledLaunchPayloads(db)
    expect(r2.converted).toBe(0)
    expect(r2.disabled).toBe(0)
    rmSync(tmp, { recursive: true, force: true })
  })

  test('H2 fetchBeforeLaunch:true → disabled with semantic-review breadcrumb', async () => {
    const repo = await seedRepo('r2')
    const id = await seedRow({
      workflowId: 'wf1',
      name: 't',
      inputs: {},
      repoPath: repo,
      baseBranch: 'main',
      fetchBeforeLaunch: true,
    })

    const r = await healScheduledLaunchPayloads(db)
    expect(r.disabled).toBe(1)
    const row = await rawRow(id)
    expect(row.enabled).toBe(false)
    expect(row.nextRunAt).toBe(null)
    expect(row.lastError ?? '').toContain('rfc165-fetch-semantic-review')
    // Payload untouched — the user repairs by re-picking a source.
    expect((await rawPayload(id))['repoPath']).toBe(repo)

    // Re-run skips the already-disabled rfc165 row.
    const r2 = await healScheduledLaunchPayloads(db)
    expect(r2.disabled).toBe(0)
    rmSync(tmp, { recursive: true, force: true })
  })

  test('H3 missing dir → disabled with local-path-retired breadcrumb', async () => {
    const id = await seedRow({
      workflowId: 'wf1',
      name: 't',
      inputs: {},
      repoPath: join(tmp, 'gone'),
      baseBranch: 'main',
    })
    const r = await healScheduledLaunchPayloads(db)
    expect(r.disabled).toBe(1)
    expect((await rawRow(id)).lastError ?? '').toContain('rfc165-local-path-retired')
  })

  test('H4 multi-repo partial failure → whole row disabled, payload not half-rewritten', async () => {
    const repo = await seedRepo('r4')
    const id = await seedRow({
      workflowId: 'wf1',
      name: 't',
      inputs: {},
      repos: [
        { repoPath: repo, baseBranch: 'main' },
        { repoPath: join(tmp, 'missing'), baseBranch: 'main' },
      ],
    })
    const r = await healScheduledLaunchPayloads(db)
    expect(r.disabled).toBe(1)
    const p = await rawPayload(id)
    const rows = p['repos'] as Array<Record<string, unknown>>
    expect(typeof rows[0]!['repoPath']).toBe('string') // NOT half-rewritten
    expect(typeof rows[1]!['repoPath']).toBe('string')
    rmSync(tmp, { recursive: true, force: true })
  })

  test('H5 v2-clean rows untouched; H6 healed payload is fire-ready', async () => {
    const cleanId = await seedRow({
      workflowId: 'wf1',
      name: 't',
      inputs: {},
      repoUrl: 'https://example.com/a.git',
    })
    const repo = await seedRepo('r5')
    const pathId = await seedRow({
      workflowId: 'wf1',
      name: 't',
      inputs: {},
      repoPath: repo,
      baseBranch: 'main',
    })
    const before = (await rawRow(cleanId)).updatedAt
    await healScheduledLaunchPayloads(db)
    expect((await rawRow(cleanId)).updatedAt).toBe(before)

    const healed = await rawPayload(pathId)
    const parsed = StartTaskSchema.safeParse(healed)
    expect(parsed.success).toBe(true)
    rmSync(tmp, { recursive: true, force: true })
  })

  test('H7 degraded row: partial PUT 422, full-field PUT repairs + clears breadcrumb', async () => {
    await db.insert(users).values({
      id: 'alice',
      username: 'alice',
      displayName: 'Alice',
      role: 'admin',
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    await db.insert(workflows).values({
      id: 'wf1',
      name: 'wf',
      definition: JSON.stringify({ $schema_version: 1, inputs: [], nodes: [], edges: [] }),
      visibility: 'public',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    const id = await seedRow(
      { totally: 'not-a-start-task' },
      { lastError: 'rfc165-local-path-retired: /x', enabled: false, nextRunAt: null },
    )
    const dto = await getScheduledTask(db, id)
    expect(dto!.launchPayload).toBe(null)
    expect(dto!.migrationError?.launchPayload ?? '').toContain('invalid-shape')

    const owner = (await db.select().from(users).where(eq(users.id, 'alice')))[0]!
    const actor = buildActor({
      user: {
        id: owner.id,
        username: owner.username,
        displayName: owner.displayName,
        role: owner.role,
        status: owner.status,
      },
      source: 'daemon',
    })
    // Partial PUT that does NOT supply the broken field → explicit repair 422.
    await expect(
      updateScheduledTask(
        db,
        id,
        { name: 'renamed-only-is-fine-but-enable-needs-payload', enabled: true },
        { actor },
      ),
    ).rejects.toThrow(/unreadable launchPayload/)

    // Full-field PUT repairs the row and clears the rfc165 breadcrumb.
    const repaired = await updateScheduledTask(
      db,
      id,
      {
        launchPayload: {
          workflowId: 'wf1',
          name: 't',
          inputs: {},
          repoUrl: 'https://example.com/a.git',
        },
      },
      { actor },
    )
    expect(repaired.launchPayload).not.toBe(null)
    expect(repaired.migrationError).toBe(null)
    expect(repaired.lastError).toBe(null)
  })
})
