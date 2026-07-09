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
 * Derive claude's project-dir slug from a cwd. Real claude code replaces every
 * path separator (and the Windows drive `:`) with `-`, e.g. on win32
 * `C:\Users\foo\proj` -> `C--Users-foo-proj` (verified against the actual
 * `~/.claude/projects/` layout). Replacing only `/` (the old behavior) left
 * backslashes and the drive colon in the slug on Windows, so the resulting
 * `join(configDir, 'projects', slug, ...)` produced an invalid mid-path `C:`
 * and the transcript dir was never found. POSIX paths are unaffected (they
 * contain neither `\` nor `:`).
 */
export function cwdSlug(cwd: string): string {
  return cwd.replace(/[/\\:]/g, '-')
}

export async function captureClaudeSessions(opts: CaptureClaudeSessionsOpts): Promise<void> {
  const slug = cwdSlug(opts.worktreePath)
  const candidates = [
    join(opts.configDir, 'projects', slug),
    join(homedir(), '.claude', 'projects', slug),
  ]
  try {
    let captured = 0
    for (const projDir of candidates) {
      const subDir = join(projDir, opts.rootSessionId, 'subagents')
      if (!existsSync(subDir)) continue
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
