// RFC-075 T9/T10 — the commit&push executor against real git + a bare remote.
// Covers: happy push, skipped-empty, fallback message, auth-fail degrade
// (injected push stderr), server-hook rejection → repair → success, repair
// exhaustion, and non-fast-forward auto-merge → re-push. The framework owns
// git; the message/repair generators are injected (production wraps opencode).

import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq, sql } from 'drizzle-orm'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRuns } from '../src/db/schema'
import { runGit } from '../src/util/git'
import { runCommitPush, type CommitPushParams } from '../src/services/commitPushRunner'
import type { CommitPushMeta } from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface Fixture {
  repo: string
  remote: string
  db: DbClient
  taskId: string
  cleanup: () => void
}

async function build(opts?: { rejectUnlessOk?: boolean }): Promise<Fixture> {
  const remote = mkdtempSync(join(tmpdir(), 'aw-cpr-remote-'))
  await runGit(remote, ['init', '-q', '--bare', '-b', 'main'])
  if (opts?.rejectUnlessOk === true) {
    const hook = join(remote, 'hooks', 'pre-receive')
    writeFileSync(
      hook,
      `#!/bin/sh
while read old new ref; do
  msg=$(git log -1 --format=%s "$new" 2>/dev/null)
  case "$msg" in
    OK:*) : ;;
    *) echo "remote: rejected: commit subject must start with OK:" 1>&2; exit 1 ;;
  esac
done
exit 0
`,
    )
    chmodSync(hook, 0o755)
  }

  const repo = mkdtempSync(join(tmpdir(), 'aw-cpr-repo-'))
  await runGit(repo, ['init', '-q', '-b', 'main'])
  await runGit(repo, ['config', 'user.email', 't@t.test'])
  await runGit(repo, ['config', 'user.name', 'Test'])
  writeFileSync(join(repo, 'a.txt'), 'original\n')
  await runGit(repo, ['add', '.'])
  await runGit(repo, ['commit', '-q', '-m', 'init'])
  await runGit(repo, ['remote', 'add', 'origin', remote])
  await runGit(repo, ['push', '-q', '-u', 'origin', 'main'])
  await runGit(repo, ['checkout', '-q', '-b', 'feature/x'])

  const db = createInMemoryDb(MIGRATIONS)
  await db.run(sql`INSERT INTO workflows (id, name, definition) VALUES ('wf', 'f', '{}')`)
  const taskId = 'task-cpr'
  await db.run(sql`
    INSERT INTO tasks (id, name, workflow_id, workflow_snapshot, repo_path, worktree_path,
      base_branch, branch, status, inputs, started_at, schema_version)
    VALUES (${taskId}, 'cpr', 'wf', '{}', ${repo}, ${repo}, 'main', 'feature/x', 'running', '{}', 1, 1)
  `)
  // RFC-098 WP-10: the commit container row is born 'running' and the mint
  // factory enforces "born-running ⟹ child row" (frontier invisibility), so
  // the fixture provides the triggering agent run the way production does.
  await db.run(sql`
    INSERT INTO node_runs (id, task_id, node_id, status, retry_index, iteration, started_at)
    VALUES ('parent-agent-run', ${taskId}, 'agent-1', 'done', 0, 0, 1)
  `)

  return {
    repo,
    remote,
    db,
    taskId,
    cleanup: () => {
      rmSync(remote, { recursive: true, force: true })
      rmSync(repo, { recursive: true, force: true })
    },
  }
}

function baseParams(f: Fixture, over: Partial<CommitPushParams> = {}): CommitPushParams {
  return {
    taskId: f.taskId,
    agentNodeId: 'agent-1',
    agentName: 'fixer',
    parentNodeRunId: 'parent-agent-run',
    worktreePath: f.repo,
    repoBranch: 'feature/x',
    baseRef: 'main',
    gitUserName: 'AW Bot',
    gitUserEmail: 'bot@aw.local',
    maxRepairRetries: 3,
    diffMaxBytes: 16384,
    generateMessage: async () => ({ message: 'feat: change a' }),
    generateRepair: async () => ({ message: null }),
    ...over,
  }
}

async function remoteHasBranch(remote: string, branch: string): Promise<boolean> {
  const r = await runGit(remote, ['rev-parse', '--verify', `refs/heads/${branch}`])
  return r.exitCode === 0
}

async function readMeta(
  f: Fixture,
  nodeRunId: string,
): Promise<{ status: string; meta: CommitPushMeta }> {
  const row = (await f.db.select().from(nodeRuns).where(eq(nodeRuns.id, nodeRunId)))[0]!
  return { status: row.status, meta: JSON.parse(row.commitPushJson!) as CommitPushMeta }
}

describe('runCommitPush', () => {
  let f: Fixture
  afterEach(() => f.cleanup())

  test('happy path: stage + commit + push, remote advanced, node done', async () => {
    f = await build()
    writeFileSync(join(f.repo, 'b.txt'), 'new file\n')
    const { nodeRunId, meta } = await runCommitPush(baseParams(f), { db: f.db })
    expect(meta.pushOutcome).toBe('pushed')
    expect(meta.messageSource).toBe('llm')
    expect(meta.commitSha).toMatch(/^[a-f0-9]{40}$/)
    expect(meta.filesChanged).toBe(1)
    expect(await remoteHasBranch(f.remote, 'feature/x')).toBe(true)
    const { status } = await readMeta(f, nodeRunId)
    expect(status).toBe('done')
  })

  test('null task identity → fixed platform fallback commits (never ambient config)', async () => {
    // RFC-165 regression lock (CI incident 29104878034): a URL/scratch
    // worktree's cache-clone parent carries no local user.*, and CI hosts
    // have no global gitconfig — "inherit the ambient config" made every
    // identity-less autoCommitPush task die as commit-local-failed. The
    // runner must inject the fixed platform identity via `-c`, which also
    // OVERRIDES whatever ambient config a dev machine happens to have —
    // asserting the author string proves the fallback took effect here.
    f = await build()
    writeFileSync(join(f.repo, 'b.txt'), 'x\n')
    const { meta } = await runCommitPush(baseParams(f, { gitUserName: null, gitUserEmail: null }), {
      db: f.db,
    })
    expect(meta.pushOutcome).toBe('pushed')
    const author = await runGit(f.repo, ['log', '-1', '--format=%an <%ae>'])
    expect(author.stdout.trim()).toBe('agent-workflow <agent-workflow@localhost>')
  })

  test('no changes → skipped-empty, no commit', async () => {
    f = await build()
    const { meta } = await runCommitPush(baseParams(f), { db: f.db })
    expect(meta.pushOutcome).toBe('skipped-empty')
    expect(meta.commitSha).toBeNull()
    expect(await remoteHasBranch(f.remote, 'feature/x')).toBe(false)
  })

  test('null LLM message → deterministic fallback, still pushes', async () => {
    f = await build()
    writeFileSync(join(f.repo, 'b.txt'), 'x\n')
    const { meta } = await runCommitPush(
      baseParams(f, { generateMessage: async () => ({ message: null }) }),
      { db: f.db },
    )
    expect(meta.pushOutcome).toBe('pushed')
    expect(meta.messageSource).toBe('fallback')
  })

  test('auth failure → commit-local-auth (degraded, not retried), local commit lands', async () => {
    f = await build()
    writeFileSync(join(f.repo, 'b.txt'), 'x\n')
    // Inject a push that always reports an auth failure; everything else is real git.
    const fakeRunGit = (async (cwd: string, args: string[]) =>
      args[0] === 'push'
        ? { stdout: '', stderr: 'fatal: Authentication failed for https://host/x.git', exitCode: 1 }
        : runGit(cwd, args)) as typeof runGit

    const { nodeRunId, meta } = await runCommitPush(baseParams(f), { db: f.db, runGit: fakeRunGit })
    expect(meta.pushOutcome).toBe('commit-local-auth')
    expect(meta.repairAttempts).toBe(0)
    expect(meta.commitSha).toMatch(/^[a-f0-9]{40}$/)
    const { status } = await readMeta(f, nodeRunId)
    expect(status).toBe('done') // degraded, not failed → task continues
    // Local commit exists on feature/x even though push failed.
    const head = (await runGit(f.repo, ['log', '-1', '--format=%s'])).stdout.trim()
    expect(head).toBe('feat: change a')
  })

  test('server-hook rejection → repair → success (repairAttempts=1)', async () => {
    f = await build({ rejectUnlessOk: true })
    writeFileSync(join(f.repo, 'b.txt'), 'x\n')
    const { meta } = await runCommitPush(
      baseParams(f, {
        generateMessage: async () => ({ message: 'bad message' }),
        generateRepair: async () => ({ message: 'OK: corrected subject' }),
      }),
      { db: f.db },
    )
    expect(meta.pushOutcome).toBe('pushed')
    expect(meta.messageSource).toBe('llm-repair')
    expect(meta.repairAttempts).toBe(1)
    // The accepted commit carries the repaired message.
    const remoteMsg = (
      await runGit(f.remote, ['log', '-1', '--format=%s', 'feature/x'])
    ).stdout.trim()
    expect(remoteMsg).toBe('OK: corrected subject')
  })

  test('repair never satisfies the hook → exhausts retries → commit-local-failed', async () => {
    f = await build({ rejectUnlessOk: true })
    writeFileSync(join(f.repo, 'b.txt'), 'x\n')
    const { nodeRunId, meta } = await runCommitPush(
      baseParams(f, {
        maxRepairRetries: 2,
        generateMessage: async () => ({ message: 'still bad' }),
        generateRepair: async () => ({ message: 'also bad' }),
      }),
      { db: f.db },
    )
    expect(meta.pushOutcome).toBe('commit-local-failed')
    expect(meta.repairAttempts).toBe(2)
    const { status } = await readMeta(f, nodeRunId)
    expect(status).toBe('failed')
    // Local commit still present (work preserved) — carries the last repaired
    // subject since repair amends even though the push kept failing, and the
    // staged change is in history.
    expect((await runGit(f.repo, ['log', '-1', '--format=%s'])).stdout.trim()).toBe('also bad')
    expect((await runGit(f.repo, ['show', '--stat', 'HEAD'])).stdout).toContain('b.txt')
  })

  test('non-fast-forward → bounded fetch+merge → re-push succeeds', async () => {
    f = await build()
    // Advance feature/x on the remote from a second clone (different file → no conflict).
    const other = mkdtempSync(join(tmpdir(), 'aw-cpr-other-'))
    await runGit(other, ['clone', '-q', f.remote, '.'])
    await runGit(other, ['config', 'user.email', 'o@o.test'])
    await runGit(other, ['config', 'user.name', 'Other'])
    await runGit(other, ['checkout', '-q', '-b', 'feature/x', 'origin/main'])
    writeFileSync(join(other, 'remote-side.txt'), 'from remote\n')
    await runGit(other, ['add', '.'])
    await runGit(other, ['commit', '-q', '-m', 'remote work'])
    await runGit(other, ['push', '-q', 'origin', 'feature/x'])
    rmSync(other, { recursive: true, force: true })

    // Local commit on the stale feature/x → first push is non-FF.
    writeFileSync(join(f.repo, 'local-side.txt'), 'from local\n')
    const { meta } = await runCommitPush(baseParams(f), { db: f.db })
    expect(meta.pushOutcome).toBe('pushed')
    expect(meta.repairAttempts).toBe(1) // one non-FF merge cycle
    // Remote now has both files reachable from feature/x.
    expect(await remoteHasBranch(f.remote, 'feature/x')).toBe(true)
  })

  // RFC-076 C4 — the write lock (scheduler's writeSem) is held ONLY around the
  // `git add -A` + `git diff --cached` capture and released BEFORE the slow LLM
  // message-gen / commit / push, so a concurrent writer node (race loop) can't
  // mutate the worktree mid-stage (which would split its changes across commits)
  // yet isn't blocked for the whole commit duration.
  test('C4: write lock spans stage+diff and is released before message-gen', async () => {
    f = await build()
    writeFileSync(join(f.repo, 'b.txt'), 'new file\n')
    const events: string[] = []
    let held = false
    await runCommitPush(
      baseParams(f, {
        acquireWrite: async () => {
          held = true
          events.push('acquire')
          return () => {
            held = false
            events.push('release')
          }
        },
        generateMessage: async () => {
          events.push(`msg(held=${held})`)
          return { message: 'feat: locked capture' }
        },
      }),
      { db: f.db },
    )
    // Lock acquired, the staged snapshot captured, lock released — THEN the
    // (slow) message generator runs, with the lock no longer held.
    expect(events).toEqual(['acquire', 'release', 'msg(held=false)'])
  })

  test('C4: write lock is released even when nothing is staged (skipped-empty)', async () => {
    f = await build()
    let released = false
    const { meta } = await runCommitPush(
      baseParams(f, {
        acquireWrite: async () => () => {
          released = true
        },
      }),
      { db: f.db },
    )
    // The finally around stage+diff must release even on the early skip return.
    expect(meta.pushOutcome).toBe('skipped-empty')
    expect(released).toBe(true)
  })
})
