// RFC-111 PR-D — post-run capture of Claude Code SUBAGENT transcripts into
// node_run_events (the parent session's turns are already captured live by the
// stdout stream-json pump). Mirrors opencode's RFC-027 SQLite walk, but claude
// persists transcripts as JSONL files (verified hands-on, design §0.3/§6.1):
//   <configDir>/projects/<cwd-slug>/<sessionId>/subagents/agent-<id>.jsonl
// Non-fatal: any failure writes a `subagent_capture_failed` marker so SessionTab
// falls back gracefully (same contract as the opencode path).
//
// V3 dual-candidate: claude relocates `projects/` under CLAUDE_CONFIG_DIR (we
// verified this), but we also try the real ~/.claude as a fallback in case a
// future release changes that.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { DbClient } from '@/db/client'
import { nodeRunEvents } from '@/db/schema'
import type { Logger } from '@/util/log'
import { parseEvent } from './events'

export interface CaptureClaudeSessionsOpts {
  rootSessionId: string
  nodeRunId: string
  taskId: string
  db: DbClient
  log: Logger
  /** CLAUDE_CONFIG_DIR for this run (= <runRoot>/.claude). */
  configDir: string
  /** Subprocess cwd (worktree) — its `/`→`-` slug is the projects subdir. */
  worktreePath: string
}

/**
 * Best-effort guess at claude's project-dir slug: cwd with `/` replaced by `-`.
 *
 * This is a FAST PATH ONLY — it is not claude's actual rule. Evidence from a
 * real `~/.claude/projects` on this machine: the cwd
 * `/Users/…/Library/Application Support/CodexBar/ClaudeProbe` produced
 * `-Users-…-Library-Application-Support-CodexBar-ClaudeProbe`, i.e. the SPACE
 * was replaced too. claude normalises more than just separators, and the exact
 * rule is private and can change between releases.
 *
 * That matters here because task worktrees live under `~/.agent-workflow/…`,
 * whose leading dot this function keeps and claude does not — so for the
 * platform's real cwd the guess is guaranteed to miss, and subagent transcripts
 * were being dropped with no error and no marker (the only signal was
 * `captured=0` in an info log). `findSessionDirs` below is what actually locates
 * the directory; reproducing claude's private algorithm would just be a second
 * thing to keep in sync.
 *
 * See design/test-guard-audit-2026-07-21 Top-1 / gap B4-runtime-1.
 */
export function cwdSlug(cwd: string): string {
  return cwd.replace(/\//g, '-')
}

/**
 * Every `projects/<anything>` directory that holds `<rootSessionId>/subagents`.
 * Independent of how claude slugified the cwd.
 */
function findSessionDirs(projectsRoot: string, rootSessionId: string): string[] {
  if (!existsSync(projectsRoot)) return []
  let entries: string[]
  try {
    entries = readdirSync(projectsRoot)
  } catch {
    return []
  }
  return entries
    .map((entry) => join(projectsRoot, entry))
    .filter((dir) => existsSync(join(dir, rootSessionId, 'subagents')))
}

export async function captureClaudeSessions(opts: CaptureClaudeSessionsOpts): Promise<void> {
  const slug = cwdSlug(opts.worktreePath)
  const projectRoots = [join(opts.configDir, 'projects'), join(homedir(), '.claude', 'projects')]
  const candidates = [
    // Fast path: if the guess happens to be right, no directory scan at all.
    ...projectRoots.map((root) => join(root, slug)),
    // Authoritative: find the directory that actually contains this session.
    ...projectRoots.flatMap((root) => findSessionDirs(root, opts.rootSessionId)),
  ]
  try {
    let captured = 0
    let located = false
    for (const projDir of candidates) {
      const subDir = join(projDir, opts.rootSessionId, 'subagents')
      if (!existsSync(subDir)) continue
      located = true
      for (const file of readdirSync(subDir)) {
        if (!file.endsWith('.jsonl')) continue
        const subSessionId = file.replace(/\.jsonl$/, '') // agent-<id>
        const content = readFileSync(join(subDir, file), 'utf-8')
        for (const line of content.split('\n')) {
          if (line.trim().length === 0) continue
          const ev = parseEvent(line)
          if (ev === null) continue
          await opts.db.insert(nodeRunEvents).values({
            nodeRunId: opts.nodeRunId,
            ts: ev.timestamp ?? Date.now(),
            kind: ev.kind,
            payload: ev.rawLine,
            sessionId: subSessionId,
            parentSessionId: opts.rootSessionId,
          })
          captured++
        }
      }
      if (captured > 0) break // first candidate dir with data wins
    }
    opts.log.info('claude-subagent-capture', { nodeRunId: opts.nodeRunId, captured })
    if (!located) {
      // Make the silent mode of failure audible. Previously this path produced
      // `captured=0` in an info line and nothing else, so a slug/layout change
      // in claude looked exactly like "this run had no subagents" — which is
      // how the whole capture stayed broken without anyone noticing.
      opts.log.warn('claude-subagent-capture-session-dir-not-found', {
        nodeRunId: opts.nodeRunId,
        rootSessionId: opts.rootSessionId,
        slugGuess: slug,
        projectRoots,
      })
    }
  } catch (err) {
    opts.log.warn('claude-subagent-capture-failed', {
      nodeRunId: opts.nodeRunId,
      err: err instanceof Error ? err.message : String(err),
    })
    // marker row so SessionTab renders the AC-10 fallback (same kind opencode uses).
    try {
      await opts.db.insert(nodeRunEvents).values({
        nodeRunId: opts.nodeRunId,
        ts: Date.now(),
        kind: 'subagent_capture_failed',
        payload: JSON.stringify({
          rfc: 'RFC-111',
          reason: err instanceof Error ? err.message : String(err),
          rootSessionId: opts.rootSessionId,
        }),
        sessionId: opts.rootSessionId,
        parentSessionId: null,
      })
    } catch {
      // give up — the run itself already succeeded; capture is auxiliary.
    }
  }
}
