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
import { beforeEach, describe, expect, test, beforeAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { StartTaskSchema } from '@agent-workflow/shared'
import { buildActor } from '../src/auth/actor'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { scheduledTasks, users, workflows } from '../src/db/schema'
import {
  getScheduledTask,
  healScheduledLaunchPayloads,
} from './helpers/integrationTriggerResourceBinding'
import { updateScheduledTaskWithIntegrationTriggerResources as updateScheduledTask } from './helpers/integrationTriggerResourceBinding'
import { runGit } from '../src/util/git'
import { pathToFileURL } from 'node:url'
import { startGitHttpRemote } from './helpers/gitHttpRemote'

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

// RFC-287 T11：夹具仓经真实 git smart-HTTP 远端（file:// 已是非法参数）。
beforeAll(async () => {
  await startGitHttpRemote()
})

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

  test('RFC-320 identity-only legacy row drops the retired pair and stays enabled', async () => {
    const id = await seedRow({
      workflowId: 'wf1',
      name: 't',
      inputs: { topic: 'preserve' },
      repoUrl: 'https://example.com/a.git',
      gitUserName: 'Legacy Author',
      gitUserEmail: 'legacy@example.test',
    })

    const first = await healScheduledLaunchPayloads(db)
    expect(first).toEqual({ scanned: 1, converted: 1, disabled: 0 })
    expect(await rawPayload(id)).toEqual({
      workflowId: 'wf1',
      name: 't',
      inputs: { topic: 'preserve' },
      repoUrl: 'https://example.com/a.git',
    })
    const row = await rawRow(id)
    expect(row.enabled).toBe(true)

    expect(await healScheduledLaunchPayloads(db)).toEqual({ scanned: 1, converted: 0, disabled: 0 })
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

  test('H5 v2-clean rows untouched; H6 本机路径自愈后**不再可开火**（RFC-287 G5）', async () => {
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

    // RFC-287 G5：自愈把 legacy 的本地 `repoPath` 转成 `file://` URL——本地路径
    // 除了 file:// 无从表达，所以自愈**照旧产出**；但 file:// 自此是非法来源，
    // 于是这类老记录自愈后**不再可开火**，到点开火时被启动校验拒掉。
    //
    // 刻意不为它造「自愈时拒绝 / 自动停用 / 标记需修复」的机制：用户明确确认过
    // 这类存量记录数量为零，为零人群造状态机是纯负债。行为如实锁在这里，将来
    // 真出现了也一眼看得到发生了什么。
    const healed = await rawPayload(pathId)
    const parsed = StartTaskSchema.safeParse(healed)
    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      expect(parsed.error.issues.map((i) => i.message)).toContain(
        'repo-url-file-scheme-unsupported',
      )
    }
    // 反向：非本机来源的老记录自愈后照常可开火（别把整条自愈路径判死）。
    const cleanParsed = StartTaskSchema.safeParse(await rawPayload(cleanId))
    expect(cleanParsed.success).toBe(true)
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

  test('H8 remote-tracking baseBranch → disabled (never silently re-pointed)', async () => {
    // Implementation-gate P1: in the file clone, 'origin/main' resolves against
    // the CLONE's origin (= the source's local main) — not the source's own
    // refs/remotes/origin/main. Faithful conversion is impossible → disable.
    const repo = await seedRepo('r8')
    const id = await seedRow({
      workflowId: 'wf1',
      name: 't',
      inputs: {},
      repoPath: repo,
      baseBranch: 'origin/main',
    })
    const r = await healScheduledLaunchPayloads(db)
    expect(r.disabled).toBe(1)
    expect(r.converted).toBe(0)
    const row = await rawRow(id)
    expect(row.enabled).toBe(false)
    expect(row.lastError ?? '').toContain('rfc165-remote-tracking-ref')
    // Payload untouched — the user repairs by re-picking a source.
    expect((await rawPayload(id))['repoPath']).toBe(repo)
    rmSync(tmp, { recursive: true, force: true })
  })

  test('H9 bare repo path heals (git probe, not a `.git` child check)', async () => {
    // Implementation-gate P2: a bare repo has no `.git` subdir but was a
    // perfectly launchable path-mode source.
    const bare = join(tmp, 'bare.git')
    await runGit(tmp, ['init', '-q', '--bare', '-b', 'main', 'bare.git'])
    const id = await seedRow({
      workflowId: 'wf1',
      name: 't',
      inputs: {},
      repoPath: bare,
      baseBranch: 'main',
    })
    const r = await healScheduledLaunchPayloads(db)
    expect(r.converted).toBe(1)
    expect(r.disabled).toBe(0)
    const p = await rawPayload(id)
    expect(p['repoUrl']).toBe(pathToFileURL(realpathSync(bare)).href)
    expect('repoPath' in p).toBe(false)
    rmSync(tmp, { recursive: true, force: true })
  })

  test('H11 repoPath inside a worktree subdir → healed URL points at the repo ROOT', async () => {
    // Codex P2: `rev-parse` succeeds in a subdir, but `git clone
    // file:///repo/subdir` fails (not a repo root) — the healed row would sit
    // enabled yet unable to fire.
    const repo = await seedRepo('r11')
    const sub = join(repo, 'packages', 'web')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(sub, { recursive: true })
    const id = await seedRow({
      workflowId: 'wf1',
      name: 't',
      inputs: {},
      repoPath: sub,
      baseBranch: 'main',
    })
    const r = await healScheduledLaunchPayloads(db)
    expect(r.converted).toBe(1)
    const p = await rawPayload(id)
    expect(p['repoUrl']).toBe(pathToFileURL(realpathSync(repo)).href)
    rmSync(tmp, { recursive: true, force: true })
  })

  test('H12 a LOCAL branch literally named origin/topic is NOT disabled (ref verified per repo)', async () => {
    // Codex P2: spelling alone misclassified refs/heads/origin/topic as
    // remote-tracking and disabled a runnable schedule at boot.
    const repo = await seedRepo('r12')
    await runGit(repo, ['branch', 'origin/topic'])
    const id = await seedRow({
      workflowId: 'wf1',
      name: 't',
      inputs: {},
      repoPath: repo,
      baseBranch: 'origin/topic',
    })
    const r = await healScheduledLaunchPayloads(db)
    expect(r.disabled).toBe(0)
    expect(r.converted).toBe(1)
    const p = await rawPayload(id)
    expect(p['ref']).toBe('origin/topic')
    expect((await rawRow(id)).enabled).toBe(true)
    rmSync(tmp, { recursive: true, force: true })
  })

  test('H10 degraded row: rename + disable pass WITHOUT repair (guard narrowed)', async () => {
    // Implementation-gate P2: only operations that CONSUME the degraded field
    // (the result being enabled) force a full repair — a corrupt schedule must
    // stay stoppable/renamable.
    await db.insert(users).values({
      id: 'alice',
      username: 'alice',
      displayName: 'Alice',
      role: 'admin',
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    const id = await seedRow({ totally: 'not-a-start-task' })
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
    const renamed = await updateScheduledTask(
      db,
      id,
      { name: 'renamed', enabled: false },
      { actor },
    )
    expect(renamed.name).toBe('renamed')
    expect(renamed.enabled).toBe(false)
    expect(renamed.launchPayload).toBe(null) // still degraded — repair not forced

    // Re-enabling WITHOUT repairing still 422s (the fire path needs a payload).
    await expect(updateScheduledTask(db, id, { enabled: true }, { actor })).rejects.toThrow(
      /unreadable launchPayload/,
    )
  })
})
