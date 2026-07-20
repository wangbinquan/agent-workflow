// RFC-111 PR-D — captureClaudeSessions reads claude's JSONL subagent transcripts
// (under the per-run CLAUDE_CONFIG_DIR projects dir) into node_run_events so the
// task-detail SessionTab gets subagent visibility (parity with opencode's RFC-027
// SQLite walk). Failure writes a `subagent_capture_failed` marker (graceful).

import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRunEvents, nodeRuns, tasks, workflows } from '../src/db/schema'
import { captureClaudeSessions, cwdSlug } from '../src/services/runtime/claudeCode/sessionCapture'
import { createLogger } from '../src/util/log'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

async function seed(): Promise<{ db: DbClient; nodeRunId: string }> {
  const db = createInMemoryDb(MIGRATIONS)
  const workflowId = ulid()
  const taskId = ulid()
  await db
    .insert(workflows)
    .values({ id: workflowId, name: 'wf', definition: '{}', createdAt: 0, updatedAt: 0 })
  await db.insert(tasks).values({
    id: taskId,
    name: 't',
    workflowId,
    workflowSnapshot: '{}',
    repoPath: '/r',
    worktreePath: '/w',
    baseBranch: 'main',
    branch: 'b',
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
  })
  const nodeRunId = ulid()
  await db.insert(nodeRuns).values({ id: nodeRunId, taskId, nodeId: 'n1', status: 'running' })
  return { db, nodeRunId }
}

describe('captureClaudeSessions (RFC-111 PR-D)', () => {
  test("cwdSlug replaces / with - (fast-path guess only, NOT claude's rule)", () => {
    expect(cwdSlug('/Users/x/proj')).toBe('-Users-x-proj')
    // Evidence that this guess is not claude's actual rule: a real
    // ~/.claude/projects entry on a dev machine reads
    //   -Users-…-Library-Application-Support-CodexBar-ClaudeProbe
    // for the cwd `…/Library/Application Support/CodexBar/ClaudeProbe`, so the
    // SPACE was normalised too. The platform's own worktrees sit under
    // `~/.agent-workflow/…`, whose leading dot this guess likewise keeps, so on
    // the real path it is guaranteed to miss. Capture must therefore not depend
    // on it — see the directory-scan cases below.
    expect(cwdSlug('/Users/x/.agent-workflow/worktrees/r/t')).toBe(
      '-Users-x-.agent-workflow-worktrees-r-t',
    )
  })

  test('captures even when claude slugified the cwd differently than we guess', async () => {
    // THE regression this file previously could not catch: the original test
    // built its fixture directory with `cwdSlug(worktree)` — the very function
    // under test — so any slug algorithm was correct by construction and the
    // production mismatch was invisible. Here the directory is named the way
    // real claude names it (every non-alphanumeric run collapsed to `-`), which
    // `cwdSlug` provably does NOT produce for this path.
    const { db, nodeRunId } = await seed()
    const root = mkdtempSync(join(tmpdir(), 'aw-claude-cap-slug-'))
    const worktree = join(root, '.agent-workflow', 'worktrees', 'repo x', 'task-1')
    mkdirSync(worktree, { recursive: true })
    const configDir = join(root, '.claude')
    const rootSession = 'sess-root-slug'
    const claudeStyleSlug = worktree.replace(/[^a-zA-Z0-9]/g, '-')
    expect(claudeStyleSlug).not.toBe(cwdSlug(worktree))

    const subDir = join(configDir, 'projects', claudeStyleSlug, rootSession, 'subagents')
    mkdirSync(subDir, { recursive: true })
    writeFileSync(
      join(subDir, 'agent-slugcase.jsonl'),
      JSON.stringify({
        type: 'assistant',
        sessionId: 'sub-slug',
        timestamp: '2026-07-20T10:00:00.000Z',
        message: { content: [{ type: 'text', text: 'found despite the slug' }] },
      }),
    )

    await captureClaudeSessions({
      rootSessionId: rootSession,
      nodeRunId,
      taskId: 'ignored',
      db,
      log: createLogger('test'),
      configDir,
      worktreePath: worktree,
    })

    const rows = await db.select().from(nodeRunEvents).where(eq(nodeRunEvents.nodeRunId, nodeRunId))
    expect(rows.length).toBe(1)
    expect(rows[0]?.sessionId).toBe('agent-slugcase')
    expect(rows[0]?.parentSessionId).toBe(rootSession)
    rmSync(root, { recursive: true, force: true })
  })

  test('captures subagent JSONL turns into node_run_events under the parent session', async () => {
    const { db, nodeRunId } = await seed()
    const root = mkdtempSync(join(tmpdir(), 'aw-claude-cap-'))
    const worktree = join(root, 'wt')
    mkdirSync(worktree, { recursive: true })
    const configDir = join(root, '.claude')
    const rootSession = 'sess-root-1'
    const subDir = join(configDir, 'projects', cwdSlug(worktree), rootSession, 'subagents')
    mkdirSync(subDir, { recursive: true })
    // a subagent transcript: assistant text turn + assistant tool_use turn
    const lines = [
      JSON.stringify({
        type: 'assistant',
        sessionId: 'sub-1',
        timestamp: '2026-07-07T04:50:52.174Z',
        message: { content: [{ type: 'text', text: 'sub thinking out loud' }] },
      }),
      JSON.stringify({
        type: 'assistant',
        sessionId: 'sub-1',
        timestamp: '2026-07-07T04:50:53.500Z',
        message: { content: [{ type: 'tool_use', name: 'Read' }] },
      }),
      '', // blank line tolerated
    ].join('\n')
    writeFileSync(join(subDir, 'agent-abc123.jsonl'), lines)

    await captureClaudeSessions({
      rootSessionId: rootSession,
      nodeRunId,
      taskId: 'ignored',
      db,
      log: createLogger('test'),
      configDir,
      worktreePath: worktree,
    })

    const rows = await db.select().from(nodeRunEvents).where(eq(nodeRunEvents.nodeRunId, nodeRunId))
    expect(rows.length).toBe(2)
    // tagged under a subagent session id, parented to the root session
    expect(rows.every((r) => r.sessionId === 'agent-abc123')).toBe(true)
    expect(rows.every((r) => r.parentSessionId === rootSession)).toBe(true)
    expect(rows.some((r) => r.kind === 'text')).toBe(true)
    expect(rows.some((r) => r.kind === 'tool_use')).toBe(true)
    // rows keep the transcript's real ISO timestamps (not the capture-walk time),
    // so the SessionTab (ts, id) sort interleaves them correctly with live rows
    const tss = rows.map((r) => r.ts).sort((a, b) => a - b)
    expect(tss).toEqual([
      Date.parse('2026-07-07T04:50:52.174Z'),
      Date.parse('2026-07-07T04:50:53.500Z'),
    ])
    rmSync(root, { recursive: true, force: true })
  })

  test('missing transcript dir → no rows, no throw (graceful)', async () => {
    const { db, nodeRunId } = await seed()
    await captureClaudeSessions({
      rootSessionId: 'nope',
      nodeRunId,
      taskId: 't',
      db,
      log: createLogger('test'),
      configDir: join(tmpdir(), 'does-not-exist-' + ulid()),
      worktreePath: '/w',
    })
    const rows = await db.select().from(nodeRunEvents).where(eq(nodeRunEvents.nodeRunId, nodeRunId))
    expect(rows.length).toBe(0)
  })
})
