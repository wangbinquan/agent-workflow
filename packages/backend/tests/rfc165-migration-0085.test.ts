// LOCKS: RFC-165 T3 — migration 0085 backfill semantics (design §1, §11.18).
//
//   M1 the SQL literal 'aw-skill-fusion' must stay in lockstep with the
//      authoritative SKILL_FUSION_WORKFLOW_NAME constant (SQL cannot import
//      TS constants — design §15.5), and every statement is separated by
//      `--> statement-breakpoint` (0052/0053 silent-truncation incident).
//   M2 space_kind backfill replayed against seeded rows:
//        * url single-repo        → 'remote' (column default, untouched)
//        * path single-repo       → 'local'  (top-level repo_url IS NULL)
//        * MIXED multi-repo       → 'local'  (any task_repos row with
//          repo_url NULL — F20: the top-level mirror alone would mislabel)
//        * fusion builtin task    → 'internal' (matched by canonical name)
//        * workgroup host task    → stays 'remote' (builtin=1 alone must NOT
//          mark it internal — F4-r3: workgroup_id IS NOT NULL excluded)
// The rolling-upgrade suite (upgrade-rolling.test.ts) separately locks that
// 0085 applies cleanly on top of every frozen journal prefix.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { sql } from 'drizzle-orm'
import { createInMemoryDb } from '../src/db/client'
import { taskRepos, tasks, workflows } from '../src/db/schema'
import { SKILL_FUSION_WORKFLOW_NAME } from '../src/services/systemResources'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const SQL_PATH = resolve(MIGRATIONS, '0085_rfc165_task_space.sql')

describe('RFC-165 T3 — migration 0085', () => {
  test('M1 fusion literal locked to SKILL_FUSION_WORKFLOW_NAME + breakpoints present', () => {
    const src = readFileSync(SQL_PATH, 'utf8')
    expect(SKILL_FUSION_WORKFLOW_NAME).toBe('aw-skill-fusion')
    expect(src.includes(`\`name\` = '${SKILL_FUSION_WORKFLOW_NAME}'`)).toBe(true)
    // 7 statements → 6 breakpoints (hand-written multi-statement migrations
    // silently truncate after the first statement without them).
    const statements = src.split('--> statement-breakpoint')
    expect(statements.length).toBe(7)
  })

  test('M2 space_kind backfill: local / mixed-multi / internal / workgroup-host', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const now = Date.now()
    const mkWf = async (id: string, name: string, builtin: boolean) => {
      await db
        .insert(workflows)
        .values({ id, name, definition: '{}', builtin, createdAt: now, updatedAt: now })
    }
    await mkWf('wf-plain', 'user-wf', false)
    await mkWf('wf-fusion', SKILL_FUSION_WORKFLOW_NAME, true)
    await mkWf('wf-wghost', '__workgroup_host__', true)

    const base = {
      name: 't',
      workflowSnapshot: '{}',
      worktreePath: '/tmp/x',
      baseBranch: 'main',
      branch: 'b',
      status: 'done' as const,
      inputs: '{}',
      startedAt: now,
    }
    await db.insert(tasks).values([
      {
        ...base,
        id: 'T-URL',
        workflowId: 'wf-plain',
        repoPath: '/cache/a',
        repoUrl: 'https://x/a.git',
      },
      { ...base, id: 'T-PATH', workflowId: 'wf-plain', repoPath: '/home/u/repo', repoUrl: null },
      {
        ...base,
        id: 'T-MIXED',
        workflowId: 'wf-plain',
        repoPath: '/cache/a',
        repoUrl: 'https://x/a.git',
        repoCount: 2,
      },
      { ...base, id: 'T-FUSION', workflowId: 'wf-fusion', repoPath: '/tmp/fusion', repoUrl: null },
      {
        ...base,
        id: 'T-WG',
        workflowId: 'wf-wghost',
        repoPath: '/cache/b',
        repoUrl: 'https://x/b.git',
        workgroupId: 'wg1',
      },
    ])
    await db.insert(taskRepos).values([
      {
        taskId: 'T-MIXED',
        repoIndex: 0,
        repoPath: '/cache/a',
        repoUrl: 'https://x/a.git',
        baseBranch: 'main',
        branch: 'b',
        worktreePath: '/tmp/m/a',
        worktreeDirName: 'a',
        schemaVersion: 1,
      },
      {
        taskId: 'T-MIXED',
        repoIndex: 1,
        repoPath: '/home/u/second',
        repoUrl: null,
        baseBranch: 'main',
        branch: 'b',
        worktreePath: '/tmp/m/second',
        worktreeDirName: 'second',
        schemaVersion: 1,
      },
    ])

    // Simulate the pre-backfill state (ALTER's DEFAULT landed 'remote' on all).
    await db.run(sql`UPDATE tasks SET space_kind = 'remote'`)

    // Replay the migration's backfill UPDATEs verbatim from the SQL file —
    // the lock is on the SHIPPED statements, not a re-implementation.
    const statements = readFileSync(SQL_PATH, 'utf8')
      .split('--> statement-breakpoint')
      .map((s) =>
        s
          .split('\n')
          .filter((l) => !l.trim().startsWith('--'))
          .join('\n')
          .trim(),
      )
      .filter((s) => s.toUpperCase().startsWith('UPDATE'))
    expect(statements.length).toBe(2)
    for (const stmt of statements) {
      await db.run(sql.raw(stmt))
    }

    const kind = async (id: string) =>
      (await db.select({ k: tasks.spaceKind }).from(tasks).where(eq(tasks.id, id)))[0]!.k
    expect(await kind('T-URL')).toBe('remote')
    expect(await kind('T-PATH')).toBe('local')
    expect(await kind('T-MIXED')).toBe('local') // F20: secondary path row wins
    expect(await kind('T-FUSION')).toBe('internal')
    expect(await kind('T-WG')).toBe('remote') // F4-r3: workgroup host ≠ internal
  })
})
