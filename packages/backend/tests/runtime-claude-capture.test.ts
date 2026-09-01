// RFC-111 PR-D — captureClaudeSessions reads claude's JSONL subagent transcripts
// (under the operator's claude config root — see the 2026-08-12 regression block
// at the bottom) into node_run_events so the task-detail SessionTab gets subagent
// visibility (parity with opencode's RFC-027 SQLite walk). Failure writes a
// `subagent_capture_failed` marker (graceful).

import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRunEvents, nodeRuns, tasks, workflows } from '../src/db/schema'
import {
  captureClaudeSessions,
  claudeUserConfigRoots,
  cwdSlug,
} from '../src/services/runtime/claudeCode/sessionCapture'
import { claudeCodeDriver } from '../src/services/runtime/claudeCode/driver'
import { createLogger, type Logger } from '../src/util/log'
import { createSqliteRuntimeSessionCapturePersistence } from '../src/modules/task-execution/infrastructure/sqliteRuntimeSessionCapturePersistence'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const capturePersistence = (db: DbClient) => createSqliteRuntimeSessionCapturePersistence(db)

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
      persistence: capturePersistence(db),
      log: createLogger('test'),
      configRoots: [configDir],
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
      persistence: capturePersistence(db),
      log: createLogger('test'),
      configRoots: [configDir],
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

  test('recurses modern workflow directories and restores depth-1/2/3 parent links', async () => {
    const { db, nodeRunId } = await seed()
    const root = mkdtempSync(join(tmpdir(), 'aw-claude-cap-nested-'))
    const worktree = join(root, 'wt')
    mkdirSync(worktree, { recursive: true })
    const configDir = join(root, '.claude')
    const rootSession = 'sess-root-nested'
    const subDir = join(configDir, 'projects', cwdSlug(worktree), rootSession, 'subagents')
    mkdirSync(subDir, { recursive: true })

    const assistantLine = (
      agentId: string,
      timestamp: string,
      content: Array<Record<string, unknown>>,
    ): string =>
      JSON.stringify({
        type: 'assistant',
        agentId,
        sessionId: rootSession,
        timestamp,
        message: { content },
      })

    writeFileSync(
      join(subDir, 'agent-parent.jsonl'),
      [
        assistantLine('parent', '2026-08-12T12:00:00.000Z', [
          { type: 'text', text: 'parent turn' },
        ]),
        assistantLine('parent', '2026-08-12T12:00:01.000Z', [
          { type: 'tool_use', name: 'Agent', id: 'toolu-spawn-child' },
        ]),
      ].join('\n'),
    )
    writeFileSync(
      join(subDir, 'agent-parent.meta.json'),
      JSON.stringify({
        agentType: 'general-purpose',
        toolUseId: 'toolu-spawn-parent',
        spawnDepth: 1,
      }),
    )

    writeFileSync(
      join(subDir, 'agent-child.jsonl'),
      [
        assistantLine('child', '2026-08-12T12:00:02.000Z', [{ type: 'text', text: 'child turn' }]),
        assistantLine('child', '2026-08-12T12:00:03.000Z', [
          { type: 'tool_use', name: 'Agent', id: 'toolu-spawn-grandchild' },
        ]),
      ].join('\n'),
    )
    writeFileSync(
      join(subDir, 'agent-child.meta.json'),
      JSON.stringify({ agentType: 'Explore', toolUseId: 'toolu-spawn-child', spawnDepth: 2 }),
    )

    writeFileSync(
      join(subDir, 'agent-grandchild.jsonl'),
      assistantLine('grandchild', '2026-08-12T12:00:04.000Z', [
        { type: 'text', text: 'grandchild turn' },
      ]),
    )
    writeFileSync(
      join(subDir, 'agent-grandchild.meta.json'),
      JSON.stringify({
        agentType: 'Explore',
        toolUseId: 'toolu-spawn-grandchild',
        spawnDepth: 3,
      }),
    )

    // Claude Code 2026.8 also stores workflow-owned agents one level deeper.
    // Their metadata has spawnDepth=1 but no toolUseId, so they belong to root.
    const workflowDir = join(subDir, 'workflows', 'wf_modern-layout')
    mkdirSync(workflowDir, { recursive: true })
    writeFileSync(
      join(workflowDir, 'agent-workflow.jsonl'),
      assistantLine('workflow', '2026-08-12T12:00:05.000Z', [
        { type: 'text', text: 'workflow turn' },
      ]),
    )
    writeFileSync(
      join(workflowDir, 'agent-workflow.meta.json'),
      JSON.stringify({ agentType: 'workflow-subagent', spawnDepth: 1 }),
    )
    writeFileSync(
      join(workflowDir, 'journal.jsonl'),
      assistantLine('journal', '2026-08-12T12:00:06.000Z', [
        { type: 'text', text: 'workflow journal is not an agent transcript' },
      ]),
    )

    await captureClaudeSessions({
      rootSessionId: rootSession,
      nodeRunId,
      taskId: 'ignored',
      persistence: capturePersistence(db),
      log: createLogger('test'),
      configRoots: [configDir],
      worktreePath: worktree,
    })

    const rows = await db.select().from(nodeRunEvents).where(eq(nodeRunEvents.nodeRunId, nodeRunId))
    const parents = new Map(rows.map((row) => [row.sessionId, row.parentSessionId]))
    expect(rows).toHaveLength(6)
    expect(parents.get('agent-parent')).toBe(rootSession)
    expect(parents.get('agent-child')).toBe('agent-parent')
    expect(parents.get('agent-grandchild')).toBe('agent-child')
    expect(parents.get('agent-workflow')).toBe(rootSession)
    expect(rows.some((row) => row.sessionId === 'journal')).toBe(false)
    rmSync(root, { recursive: true, force: true })
  })

  test('batches transcript events and retries one transient SQLITE_BUSY insert', async () => {
    const { db, nodeRunId } = await seed()
    const root = mkdtempSync(join(tmpdir(), 'aw-claude-cap-batch-'))
    const worktree = join(root, 'wt')
    mkdirSync(worktree, { recursive: true })
    const configDir = join(root, '.claude')
    const rootSession = 'sess-root-batch'
    const subDir = join(configDir, 'projects', cwdSlug(worktree), rootSession, 'subagents')
    mkdirSync(subDir, { recursive: true })
    writeFileSync(
      join(subDir, 'agent-many.jsonl'),
      Array.from({ length: 205 }, (_, index) =>
        JSON.stringify({
          type: 'assistant',
          sessionId: rootSession,
          timestamp: new Date(Date.UTC(2026, 7, 12, 12, 1, 0, index)).toISOString(),
          message: { content: [{ type: 'text', text: `turn-${index}` }] },
        }),
      ).join('\n'),
    )

    let transactionCalls = 0
    let failFirstTransaction = true
    const transientDb = new Proxy(db, {
      get(target, property) {
        if (property === 'transaction') {
          return (...args: Parameters<DbClient['transaction']>) => {
            transactionCalls++
            if (failFirstTransaction) {
              failFirstTransaction = false
              const error = new Error('database is locked') as Error & { code: string }
              error.name = 'SQLiteError'
              error.code = 'SQLITE_BUSY'
              throw error
            }
            return target.transaction(...args)
          }
        }
        const value = Reflect.get(target, property, target) as unknown
        return typeof value === 'function' ? value.bind(target) : value
      },
    }) as DbClient
    const warnings: Array<{ message: string; fields?: Record<string, unknown> }> = []
    const log: Logger = {
      debug: () => undefined,
      info: () => undefined,
      warn: (message, fields) => warnings.push({ message, fields }),
      error: () => undefined,
      child: () => log,
    }

    await captureClaudeSessions({
      rootSessionId: rootSession,
      nodeRunId,
      taskId: 'ignored',
      persistence: capturePersistence(transientDb),
      log,
      configRoots: [configDir],
      worktreePath: worktree,
    })

    const rows = db.select().from(nodeRunEvents).where(eq(nodeRunEvents.nodeRunId, nodeRunId)).all()
    expect(rows).toHaveLength(205)
    // One failed attempt + two batches (200 and 5), not 205 autocommit writes.
    expect(transactionCalls).toBe(3)
    expect(warnings).toEqual([])
    rmSync(root, { recursive: true, force: true })
  })

  test('missing transcript dir → no rows, no throw (graceful)', async () => {
    const { db, nodeRunId } = await seed()
    await captureClaudeSessions({
      rootSessionId: 'nope',
      nodeRunId,
      taskId: 't',
      persistence: capturePersistence(db),
      log: createLogger('test'),
      configRoots: [join(tmpdir(), 'does-not-exist-' + ulid())],
      worktreePath: '/w',
    })
    const rows = await db.select().from(nodeRunEvents).where(eq(nodeRunEvents.nodeRunId, nodeRunId))
    expect(rows.length).toBe(0)
  })

  test('scans every candidate root, not just the first (transcript in a later root)', async () => {
    const { db, nodeRunId } = await seed()
    const root = mkdtempSync(join(tmpdir(), 'aw-claude-cap-multi-'))
    const worktree = join(root, 'wt')
    mkdirSync(worktree, { recursive: true })
    const rootSession = 'sess-root-multi'
    // First candidate exists but holds a DIFFERENT session; the transcript is
    // under the second — capture must keep walking instead of stopping at #1.
    const decoy = join(root, 'decoy-config')
    mkdirSync(join(decoy, 'projects', cwdSlug(worktree), 'other-session', 'subagents'), {
      recursive: true,
    })
    const real = join(root, 'real-config')
    const subDir = join(real, 'projects', cwdSlug(worktree), rootSession, 'subagents')
    mkdirSync(subDir, { recursive: true })
    writeFileSync(
      join(subDir, 'agent-multi.jsonl'),
      JSON.stringify({
        type: 'assistant',
        sessionId: 'sub-multi',
        timestamp: '2026-08-12T10:00:00.000Z',
        message: { content: [{ type: 'text', text: 'found in the second root' }] },
      }),
    )

    await captureClaudeSessions({
      rootSessionId: rootSession,
      nodeRunId,
      taskId: 'ignored',
      persistence: capturePersistence(db),
      log: createLogger('test'),
      configRoots: [decoy, real],
      worktreePath: worktree,
    })

    const rows = await db.select().from(nodeRunEvents).where(eq(nodeRunEvents.nodeRunId, nodeRunId))
    expect(rows.length).toBe(1)
    expect(rows[0]?.sessionId).toBe('agent-multi')
    rmSync(root, { recursive: true, force: true })
  })
})

// ---------------------------------------------------------------------------
// 2026-08-12 regression: claude subagent transcripts were looked up under
// `<runRoot>/<configDirName>` — the private CLAUDE_CONFIG_DIR the platform
// sealed each run into BEFORE RFC-276 — plus a hardcoded `~/.claude` fallback.
// RFC-276 stopped setting any config-dir env (claudeCode/spawn.ts), so claude
// writes into the OPERATOR's root: `$CLAUDE_CONFIG_DIR` if exported, else
// `~/.claude`. The per-run candidate therefore never existed and the hardcoded
// fallback was the only working path, silently dropping every subagent
// transcript on hosts that export CLAUDE_CONFIG_DIR or run a fork with a
// renamed root (symptom: an empty SessionTab plus one
// `claude-subagent-capture-session-dir-not-found` warn). These lock the
// RFC-154-profile-driven resolution that replaced it.
// ---------------------------------------------------------------------------

const DEFAULT_PROFILE = { env: 'CLAUDE_CONFIG_DIR', name: '.claude' }

describe('claudeUserConfigRoots (transcript root resolution)', () => {
  test('default profile, nothing exported → the operator home root', () => {
    expect(claudeUserConfigRoots(DEFAULT_PROFILE, {}, '/home/op')).toEqual(['/home/op/.claude'])
  })

  test('exported CLAUDE_CONFIG_DIR wins, home root stays as fallback', () => {
    expect(
      claudeUserConfigRoots(DEFAULT_PROFILE, { CLAUDE_CONFIG_DIR: '/opt/claude-home' }, '/home/op'),
    ).toEqual(['/opt/claude-home', '/home/op/.claude'])
  })

  test('fork profile: its own env + leaf lead, protocol defaults trail', () => {
    expect(
      claudeUserConfigRoots(
        { env: 'BAR_DIR', name: '.bar' },
        { BAR_DIR: '/srv/bar', CLAUDE_CONFIG_DIR: '/opt/claude-home' },
        '/home/op',
      ),
    ).toEqual(['/srv/bar', '/opt/claude-home', '/home/op/.bar', '/home/op/.claude'])
  })

  test('blank env values are ignored (an exported-but-empty var is not a root)', () => {
    expect(
      claudeUserConfigRoots(DEFAULT_PROFILE, { CLAUDE_CONFIG_DIR: '   ' }, '/home/op'),
    ).toEqual(['/home/op/.claude'])
  })

  test('home follows $HOME / %USERPROFILE% — the rule the spawned Node CLI uses', () => {
    expect(claudeUserConfigRoots(DEFAULT_PROFILE, { HOME: '/daemon/home' })).toEqual([
      '/daemon/home/.claude',
    ])
    expect(claudeUserConfigRoots(DEFAULT_PROFILE, { USERPROFILE: 'C:\\Users\\op' })).toEqual([
      join('C:\\Users\\op', '.claude'),
    ])
  })
})

/** Fixture: one subagent JSONL turn under `<configRoot>/projects/<slug>/<session>`. */
function writeTranscript(configRoot: string, worktree: string, session: string, agent: string) {
  const subDir = join(configRoot, 'projects', cwdSlug(worktree), session, 'subagents')
  mkdirSync(subDir, { recursive: true })
  writeFileSync(
    join(subDir, `${agent}.jsonl`),
    JSON.stringify({
      type: 'assistant',
      sessionId: 'sub',
      timestamp: '2026-08-12T11:00:00.000Z',
      message: { content: [{ type: 'text', text: 'captured' }] },
    }),
  )
}

describe('claudeCodeDriver.captureSessions (RFC-154 profile → operator root)', () => {
  test('finds transcripts under an exported CLAUDE_CONFIG_DIR (pre-fix: dropped)', async () => {
    const { db, nodeRunId } = await seed()
    const root = mkdtempSync(join(tmpdir(), 'aw-claude-cap-env-'))
    const worktree = join(root, 'wt')
    mkdirSync(worktree, { recursive: true })
    writeTranscript(join(root, 'operator-config'), worktree, 'sess-env', 'agent-env')

    const prevEnv = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = join(root, 'operator-config')
    try {
      await claudeCodeDriver.captureSessions({
        rootSessionId: 'sess-env',
        nodeRunId,
        taskId: 'ignored',
        persistence: capturePersistence(db),
        log: createLogger('test'),
        worktreePath: worktree,
      })
    } finally {
      if (prevEnv === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = prevEnv
    }

    const rows = await db.select().from(nodeRunEvents).where(eq(nodeRunEvents.nodeRunId, nodeRunId))
    expect(rows.length).toBe(1)
    expect(rows[0]?.sessionId).toBe('agent-env')
    rmSync(root, { recursive: true, force: true })
  })

  test('fork row with a renamed leaf → `<home>/<leaf>`, not the protocol default', async () => {
    const { db, nodeRunId } = await seed()
    const root = mkdtempSync(join(tmpdir(), 'aw-claude-cap-fork-'))
    const worktree = join(root, 'wt')
    mkdirSync(worktree, { recursive: true })
    const home = join(root, 'home')
    writeTranscript(join(home, '.awfork'), worktree, 'sess-fork', 'agent-fork')

    const prevHome = process.env.HOME
    const prevEnv = process.env.CLAUDE_CONFIG_DIR
    process.env.HOME = home
    delete process.env.CLAUDE_CONFIG_DIR
    try {
      await claudeCodeDriver.captureSessions({
        rootSessionId: 'sess-fork',
        nodeRunId,
        taskId: 'ignored',
        persistence: capturePersistence(db),
        log: createLogger('test'),
        worktreePath: worktree,
        configDirEnv: 'AW_TEST_FORK_CONFIG_DIR',
        configDirName: '.awfork',
      })
    } finally {
      if (prevHome === undefined) delete process.env.HOME
      else process.env.HOME = prevHome
      if (prevEnv !== undefined) process.env.CLAUDE_CONFIG_DIR = prevEnv
    }

    const rows = await db.select().from(nodeRunEvents).where(eq(nodeRunEvents.nodeRunId, nodeRunId))
    expect(rows.length).toBe(1)
    expect(rows[0]?.sessionId).toBe('agent-fork')
    rmSync(root, { recursive: true, force: true })
  })
})
