// RFC-053 PR-A T1e — resumeTask behavior + idempotency + race.
//
// Locks the current contract:
//   - failed / interrupted / awaiting_review / awaiting_human → flip task to
//     pending, fire-and-forget runTask
//   - any other task status (pending / running / done / canceled) → 409
//   - non-existent task → 404
//   - done node_runs left untouched on resume (only failed/interrupted are
//     rolled back to preSnapshot — and even then only on the latest row per
//     nodeId)
//
// Calling resumeTask twice in fast succession will see task=pending on the
// second call and throw 409 — this is the idempotency story we have today
// (PR-D / PR-E may add outbox semantics later).

import { legacyStashSnapshotFixture } from './helpers/legacyStashSnapshot'
import {
  nodeRunFixture,
  patchNodeRunFixture,
  patchTaskFixture,
  readTaskFixtures,
  taskFixture,
  workflowFixture,
} from './helpers/model'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { first } from '@/platform/persistence/queryHelpers'
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { DbClient } from '../src/db/client'
import { createInMemoryDb } from '../src/db/client'
import { claimNewRuntimeSession } from '../src/services/runtimeSessionLease'
import { runGit } from '../src/util/git'
import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import { createTaskExecutionTestTopology } from './helpers/taskExecutionTestTopology'
import { createResumeEngine } from './helpers/resumeEngine'
import { createRuntimeSessionLeaseOperations } from '../src/modules/task-execution/infrastructure/runtimeSessionLeaseOperations'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface Harness {
  db: DbClient
  appHome: string
  repoPath: string
  taskId: string
  cleanup: () => void
}

async function buildHarness(
  taskStatus:
    | 'pending'
    | 'running'
    | 'awaiting_review'
    | 'awaiting_human'
    | 'done'
    | 'failed'
    | 'canceled'
    | 'interrupted',
): Promise<Harness> {
  const tmp = mkdtempSync(join(tmpdir(), 'aw-rfc053-t1e-'))
  const appHome = join(tmp, 'appHome')
  const repoPath = join(tmp, 'repo')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(appHome, { recursive: true })
  mkdirSync(repoPath, { recursive: true })
  await runGit(repoPath, ['init', '-q', '-b', 'main'])
  await runGit(repoPath, ['config', 'user.email', 't@t.test'])
  await runGit(repoPath, ['config', 'user.name', 't'])
  writeFileSync(join(repoPath, 'README.md'), '# r\n')
  await runGit(repoPath, ['add', '.'])
  await runGit(repoPath, ['commit', '-q', '-m', 'i'])

  const db = createInMemoryDb(MIGRATIONS)
  const definition: WorkflowDefinition = {
    $schema_version: 2,
    inputs: [],
    nodes: [
      { id: 'doc', kind: 'agent-single', agentName: 'doc', promptTemplate: '' } as WorkflowNode,
    ],
    edges: [],
  }
  const workflowId = ulid()
  await workflowFixture(db, {
    id: workflowId,
    name: 'w',
    definition: JSON.stringify(definition),
  })
  const taskId = ulid()
  await taskFixture(db, {
    name: 't',
    id: taskId,
    workflowId,
    workflowSnapshot: JSON.stringify(definition),
    repoPath,
    worktreePath: repoPath,
    baseBranch: 'main',
    branch: 'agent-workflow/' + taskId,
    status: taskStatus,
    inputs: '{}',
    startedAt: Date.now(),
    finishedAt: taskStatus === 'done' || taskStatus === 'failed' ? Date.now() : null,
    errorSummary: taskStatus === 'failed' ? 'boom' : null,
  })
  return {
    db,
    appHome,
    repoPath,
    taskId,
    cleanup: () => rmSync(tmp, { recursive: true, force: true }),
  }
}

describe('RFC-053 PR-A T1e — resumeTask idempotency + race', () => {
  let h: Harness
  afterEach(() => h?.cleanup())

  test('R1 resume from failed flips task→pending and clears error fields', async () => {
    h = await buildHarness('failed')
    await patchTaskFixture(
      h.db,
      { id: h.taskId },
      { errorSummary: 'boom', errorMessage: 'detail', failedNodeId: 'doc' },
    )

    const after = await createResumeEngine(h.db, {
      appHome: h.appHome,
      schedulerDriver: createTaskExecutionTestTopology({ db: h.db, driver: 'real' })
        .schedulerDriver,
      runConfig: {
        binaryOverride: ['/usr/bin/env', 'true'],
      },
    }).resume(h.taskId)
    expect(after.status).toBe('pending')
    expect(after.errorSummary).toBeNull()
    expect(after.errorMessage).toBeNull()
    expect(after.failedNodeId).toBeNull()
    expect(after.finishedAt).toBeNull()
  })

  test('R2 resume from interrupted: same path', async () => {
    h = await buildHarness('interrupted')
    const after = await createResumeEngine(h.db, {
      appHome: h.appHome,
      schedulerDriver: createTaskExecutionTestTopology({ db: h.db, driver: 'real' })
        .schedulerDriver,
      runConfig: {
        binaryOverride: ['/usr/bin/env', 'true'],
      },
    }).resume(h.taskId)
    expect(after.status).toBe('pending')
  })

  test('R3 resume from awaiting_review: same path (post-approve / fix-up)', async () => {
    h = await buildHarness('awaiting_review')
    const after = await createResumeEngine(h.db, {
      appHome: h.appHome,
      schedulerDriver: createTaskExecutionTestTopology({ db: h.db, driver: 'real' })
        .schedulerDriver,
      runConfig: {
        binaryOverride: ['/usr/bin/env', 'true'],
      },
    }).resume(h.taskId)
    expect(after.status).toBe('pending')
  })

  test('R4 resume from awaiting_human: same path (post-clarify-answer)', async () => {
    h = await buildHarness('awaiting_human')
    const after = await createResumeEngine(h.db, {
      appHome: h.appHome,
      schedulerDriver: createTaskExecutionTestTopology({ db: h.db, driver: 'real' })
        .schedulerDriver,
      runConfig: {
        binaryOverride: ['/usr/bin/env', 'true'],
      },
    }).resume(h.taskId)
    expect(after.status).toBe('pending')
  })

  test('R5 resume twice rapidly: second call throws 409 (task-not-resumable)', async () => {
    h = await buildHarness('failed')
    await createResumeEngine(h.db, {
      appHome: h.appHome,
      schedulerDriver: createTaskExecutionTestTopology({ db: h.db, driver: 'real' })
        .schedulerDriver,
      runConfig: {
        binaryOverride: ['/usr/bin/env', 'true'],
      },
    }).resume(h.taskId)
    let code: string | undefined
    try {
      await createResumeEngine(h.db, {
        appHome: h.appHome,
        schedulerDriver: createTaskExecutionTestTopology({ db: h.db, driver: 'real' })
          .schedulerDriver,
        runConfig: {
          binaryOverride: ['/usr/bin/env', 'true'],
        },
      }).resume(h.taskId)
    } catch (err) {
      code = (err as { code?: string }).code
    }
    expect(code).toBe('task-not-resumable')
  })

  test('R6 resume from done throws 409', async () => {
    h = await buildHarness('done')
    let code: string | undefined
    try {
      await createResumeEngine(h.db, {
        appHome: h.appHome,
        schedulerDriver: createTaskExecutionTestTopology({ db: h.db, driver: 'real' })
          .schedulerDriver,
        runConfig: {
          binaryOverride: ['/usr/bin/env', 'true'],
        },
      }).resume(h.taskId)
    } catch (err) {
      code = (err as { code?: string }).code
    }
    expect(code).toBe('task-not-resumable')
  })

  test('R7 resume on non-existent task throws 404', async () => {
    h = await buildHarness('failed')
    let code: string | undefined
    try {
      await createResumeEngine(h.db, {
        appHome: h.appHome,
        schedulerDriver: createTaskExecutionTestTopology({ db: h.db, driver: 'real' })
          .schedulerDriver,
        runConfig: {
          binaryOverride: ['/usr/bin/env', 'true'],
        },
      }).resume('no-such-task')
    } catch (err) {
      code = (err as { code?: string }).code
    }
    expect(code).toBe('task-not-found')
  })

  test('RFC-292: missing frozen webhook context rejects resume before CAS and metadata clearing', async () => {
    h = await buildHarness('failed')
    const triggerDefinition: WorkflowDefinition = {
      $schema_version: 5,
      inputs: [],
      nodes: [
        {
          id: 'doc',
          kind: 'agent-single',
          agentName: 'doc',
          promptTemplate: 'Handle {{trigger.webhook.comment_text}}',
        } as WorkflowNode,
      ],
      edges: [],
    }
    const finishedAt = Date.now() - 10
    await patchTaskFixture(
      h.db,
      { id: h.taskId },
      {
        workflowSnapshot: JSON.stringify(triggerDefinition),
        finishedAt,
        errorSummary: 'original-summary',
        errorMessage: 'original-detail',
        failedNodeId: 'doc',
      },
    )

    await expect(
      createResumeEngine(h.db, {
        appHome: h.appHome,
        schedulerDriver: createTaskExecutionTestTopology({ db: h.db, driver: 'real' })
          .schedulerDriver,
        runConfig: {
          binaryOverride: ['/usr/bin/env', 'true'],
        },
      }).resume(h.taskId),
    ).rejects.toMatchObject({ code: 'trigger-context-missing' })

    const row = (await readTaskFixtures(h.db, { id: h.taskId }))[0]!
    expect(row).toMatchObject({
      status: 'failed',
      finishedAt,
      errorSummary: 'original-summary',
      errorMessage: 'original-detail',
      failedNodeId: 'doc',
    })
  })

  // RFC-098 B2 (design 修订#5): the old R8 used a FAKE sha ('sha-fake-failed')
  // on the failed row, which only stayed green because the pre-fix rollback was
  // warn-and-continue even when `git stash apply` blew up. The WP-9 fail-closed
  // rollback turns a missing snapshot into a task-level 'snapshot-lost'
  // escalation, so the case is split:
  //   R8a — the happy half with a REAL stash sha (done rows untouched, failed
  //         row stays historical, resume proceeds);
  //   R8b — the snapshot-lost half (resumeTask throws 409 'snapshot-lost',
  //         task flips failed with errorSummary='snapshot-lost', and the
  //         worktree is byte-for-byte untouched — fail-closed means the
  //         destructive reset/clean never ran).
  test('R8a resume with a REAL stash sha: done node_runs untouched, failed row stays historical, resume proceeds', async () => {
    h = await buildHarness('failed')
    const doneId = ulid()
    const finishedAt = Date.now() - 500
    const { nodeRuns } = tablesOf(h.db)
    await nodeRunFixture(h.db, {
      id: doneId,
      taskId: h.taskId,
      nodeId: 'doc',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      startedAt: Date.now() - 1000,
      finishedAt,
      // Done rows are never rolled back — a fake sha here proves it: were the
      // rollback to touch this row, fail-closed would 409 the whole resume.
      checkpoints: [{ mountPath: '', preSnapshot: 'sha-fake-done' }],
    })
    // A subsequent failed retry attempt with a REAL stash snapshot.
    writeFileSync(join(h.repoPath, 'README.md'), '# snapshot-time\n')
    const realSha = await legacyStashSnapshotFixture(h.repoPath)
    expect(realSha).not.toBe('')
    const failedId = ulid()
    await nodeRunFixture(h.db, {
      id: failedId,
      taskId: h.taskId,
      nodeId: 'doc',
      status: 'failed',
      retryIndex: 1,
      iteration: 0,
      startedAt: Date.now() - 200,
      finishedAt: Date.now() - 100,
      errorMessage: 'boom',
      checkpoints: [{ mountPath: '', preSnapshot: realSha }],
    })

    const after = await createResumeEngine(h.db, {
      appHome: h.appHome,
      schedulerDriver: createTaskExecutionTestTopology({ db: h.db, driver: 'real' })
        .schedulerDriver,
      runConfig: {
        binaryOverride: ['/usr/bin/env', 'true'],
      },
    }).resume(h.taskId)
    expect(after.status).toBe('pending')

    // Done row preserved (status + finishedAt unchanged).
    const doneAfter = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, doneId)))[0]!
    expect(doneAfter.status).toBe('done')
    expect(doneAfter.finishedAt).toBe(finishedAt)
    // Failed row stays as historical (resumeTask doesn't change its status
    // — the scheduler will mint a fresh retry on dispatch).
    const failedAfter = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, failedId)))[0]!
    expect(failedAfter.status).toBe('failed')
    // The rollback actually restored the snapshot-time worktree state.
    expect(readFileSync(join(h.repoPath, 'README.md'), 'utf-8')).toBe('# snapshot-time\n')
  })

  test("R8b snapshot lost: resumeTask throws 409 'snapshot-lost', task flips failed (errorSummary='snapshot-lost'), worktree untouched", async () => {
    h = await buildHarness('failed')
    const failedId = ulid()
    await nodeRunFixture(h.db, {
      id: failedId,
      taskId: h.taskId,
      nodeId: 'doc',
      status: 'failed',
      retryIndex: 0,
      iteration: 0,
      startedAt: Date.now() - 200,
      finishedAt: Date.now() - 100,
      errorMessage: 'boom',
      // Well-formed sha that exists in NO odb — deterministic stand-in for a
      // gc-pruned snapshot (same shape git-snapshot.test.ts uses).
      checkpoints: [{ mountPath: '', preSnapshot: 'deadbeef'.repeat(5) }],
    })
    // Dirty worktree state that the pre-fix destroy-then-fail rollback would
    // have eaten (tracked mutation + untracked stray).
    writeFileSync(join(h.repoPath, 'README.md'), '# DIRTY\n')
    writeFileSync(join(h.repoPath, 'stray.txt'), 'keep-me\n')

    let code: string | undefined
    try {
      await createResumeEngine(h.db, {
        appHome: h.appHome,
        schedulerDriver: createTaskExecutionTestTopology({ db: h.db, driver: 'real' })
          .schedulerDriver,
        runConfig: {
          binaryOverride: ['/usr/bin/env', 'true'],
        },
      }).resume(h.taskId)
    } catch (err) {
      code = (err as { code?: string }).code
    }
    expect(code).toBe('snapshot-lost')

    // Task escalated pending → failed with the snapshot-lost summary + detail.
    const t = (await readTaskFixtures(h.db, { id: h.taskId }))[0]!
    expect(t.status).toBe('failed')
    expect(t.errorSummary).toBe('snapshot-lost')
    expect(t.errorMessage).toContain(failedId)
    // RFC-359 AC-1（第 10 刀）改文案：`resume` 两份实现合一，收敛到**信息更全**的那一侧。
    // 退役那份只说「pre-snapshot lost」；共用那份把三件事都写进去——是哪条 node_run、
    // 丢的是哪个 sha、以及**没有动过任何仓库**（fail-closed 的关键信息，用户据此知道
    // 工作树还是原样、可以自己去救）。判据不变：任务行上必须留下「基线没了」的可诊断说明。
    expect(t.errorMessage).toContain('pre-snapshot is missing')
    expect(t.errorMessage).toContain('no repo touched')
    expect(t.failedNodeId).toBe('doc')

    // Fail-closed: the worktree was never reset/cleaned.
    expect(readFileSync(join(h.repoPath, 'README.md'), 'utf-8')).toBe('# DIRTY\n')
    expect(existsSync(join(h.repoPath, 'stray.txt'))).toBe(true)
  })

  test('held native lease requires proven child reap before manual resume', async () => {
    h = await buildHarness('failed')
    writeFileSync(join(h.repoPath, 'README.md'), '# native-session-snapshot\n')
    const realSha = await legacyStashSnapshotFixture(h.repoPath)
    const failedId = ulid()
    const { runtimeSessionLeases } = tablesOf(h.db)
    await nodeRunFixture(h.db, {
      id: failedId,
      taskId: h.taskId,
      nodeId: 'doc',
      status: 'running',
      retryIndex: 0,
      iteration: 0,
      opencodeSessionId: null,
      pid: null,
      startedAt: Date.now() - 200,
      checkpoints: [{ mountPath: '', preSnapshot: realSha }],
    })
    await claimNewRuntimeSession(createRuntimeSessionLeaseOperations(h.db), {
      protocol: 'claude-code',
      sessionId: 'resume-held-native',
      taskId: h.taskId,
      nodeId: 'doc',
      currentNodeRunId: failedId,
      leaseNonceDigest: 'a'.repeat(64),
    })
    await patchNodeRunFixture(
      h.db,
      { id: failedId },
      { status: 'failed', finishedAt: Date.now() - 100 },
    )

    await expect(
      createResumeEngine(h.db, {
        appHome: h.appHome,
        schedulerDriver: createTaskExecutionTestTopology({ db: h.db, driver: 'real' })
          .schedulerDriver,
        runConfig: {
          binaryOverride: ['/usr/bin/env', 'true'],
          killStaleRunProcessTree: async () => 'no-pid',
        },
      }).resume(h.taskId),
    ).rejects.toMatchObject({ code: 'live-child-survived' })

    expect(
      (
        await readTaskFixtures(h.db, { id: h.taskId }).then((rows) =>
          rows.map((row) => ({ status: row.status })),
        )
      )[0],
    ).toEqual({ status: 'failed' })
    expect(
      first(
        h.db
          .select({ holder: runtimeSessionLeases.leaseNodeRunId })
          .from(runtimeSessionLeases)
          .where(eq(runtimeSessionLeases.sessionId, 'resume-held-native')),
      ),
    ).toEqual({ holder: failedId })
  })
})
