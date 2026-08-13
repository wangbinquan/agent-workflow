// RFC-111 PR-D — post-run capture of Claude Code SUBAGENT transcripts into
// node_run_events (the parent session's turns are already captured live by the
// stdout stream-json pump). Mirrors opencode's RFC-027 SQLite walk, but claude
// persists transcripts as JSONL files (verified hands-on, design §0.3/§6.1):
//   <configRoot>/projects/<cwd-slug>/<sessionId>/subagents/agent-<id>.jsonl
//   <configRoot>/projects/<cwd-slug>/<sessionId>/subagents/workflows/<wf>/agent-<id>.jsonl
// Non-fatal: any failure writes a `subagent_capture_failed` marker so SessionTab
// falls back gracefully (same contract as the opencode path).
//
// WHERE <configRoot> IS (2026-08-12 fix). claude keeps `projects/` under its
// USER-level config root: `$CLAUDE_CONFIG_DIR` when the operator exported one,
// else `~/.claude`. RFC-111 wrote this capture while the platform still sealed
// every run into a private `CLAUDE_CONFIG_DIR=<runRoot>/.claude`, so it looked
// there FIRST and kept `~/.claude` only as a hardcoded "in case claude changes"
// fallback. RFC-276 removed the sealing — claudeCode/spawn.ts sets no config-dir
// env at all, the child inherits the daemon's (locked by
// tests/rfc154-runtime-config-dir.test.ts) — which turned the primary candidate
// into a directory nothing ever writes and promoted the hardcoded fallback into
// the only working path. Consequence: on any host that exports
// CLAUDE_CONFIG_DIR, or runs a fork whose config root is not `~/.claude`, every
// subagent transcript was dropped with nothing but a
// `claude-subagent-capture-session-dir-not-found` warn. Roots now come from the
// RFC-154 profile (env var name + leaf dir name) via `claudeUserConfigRoots`,
// so both surfaces are honored and the per-run path is gone.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import {
  DEFAULT_CONFIG_DIR_PROFILE,
  maskDiagnosticsText,
  type RuntimeConfigDirProfile,
} from '@agent-workflow/shared'
import type { DbClient } from '@/db/client'
import { nodeRunEvents } from '@/db/schema'
import { retrySqliteWrite, sqliteWriteDiagnostic } from '@/db/sqliteWriteRetry'
import type { Logger } from '@/util/log'
import { parseEvent } from './events'

export interface CaptureClaudeSessionsOpts {
  /** Native transcript directory key. */
  rootSessionId: string
  /** Logical SessionTree root; defaults to the native lookup key. */
  logicalRootSessionId?: string
  nodeRunId: string
  taskId: string
  db: DbClient
  log: Logger
  /** Candidate user-level config roots, priority order (`claudeUserConfigRoots`). */
  configRoots: readonly string[]
  /** Subprocess cwd (worktree) — its `/`→`-` slug is the projects subdir. */
  worktreePath: string
}

/**
 * The home directory the SPAWNED runtime resolves `~` against — the child is a
 * Node CLI, and Node's `os.homedir()` honors `$HOME` / `%USERPROFILE%` before it
 * falls back to the passwd entry. Bun's `homedir()` snapshots the env at process
 * start instead, so a daemon launched with an overridden HOME would otherwise
 * look for transcripts under a different home than the child wrote them to.
 */
function spawnHome(source: NodeJS.ProcessEnv | Record<string, string | undefined>): string {
  for (const key of ['HOME', 'USERPROFILE']) {
    const raw = source[key]
    if (typeof raw === 'string' && raw.trim().length > 0) return raw.trim()
  }
  return homedir()
}

/**
 * The user-level config roots a claude(-compatible) binary may have written its
 * transcripts to, most specific first:
 *
 *   1. the runtime row's config-dir env var, as exported to the daemon
 *   2. the protocol default env var (`CLAUDE_CONFIG_DIR`), when (1) renamed it
 *   3. `<home>/<runtime row's leaf name>`
 *   4. `<home>/.claude`, when (3) renamed it
 *
 * (2) and (4) exist because a fork may rename only the surface it discovers
 * PROJECT config through (that is what `configDir.name` selects on the claude
 * path since RFC-276) while still keeping its user config where claude does.
 * Extra candidates cost one `existsSync` each and cannot mis-capture: a
 * candidate only wins if it actually contains `projects/*<rootSessionId>/subagents`.
 *
 * Pure — env and home are injected — so root resolution is unit-testable
 * without touching the real home directory.
 */
export function claudeUserConfigRoots(
  profile: RuntimeConfigDirProfile,
  source: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
  home: string = spawnHome(source),
): string[] {
  const protocolDefault = DEFAULT_CONFIG_DIR_PROFILE['claude-code']
  const fromEnv = (key: string): string | null => {
    const raw = source[key]
    if (typeof raw !== 'string') return null
    const trimmed = raw.trim()
    return trimmed.length > 0 ? trimmed : null
  }
  const candidates = [
    fromEnv(profile.env),
    fromEnv(protocolDefault.env),
    join(home, profile.name),
    join(home, protocolDefault.name),
  ]
  const roots: string[] = []
  for (const candidate of candidates) {
    if (candidate === null || roots.includes(candidate)) continue
    roots.push(candidate)
  }
  return roots
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
  // RFC-254: also fold Windows separators + the drive colon (`C:\a\b` → `C--a-b`).
  // `:` and `\` are illegal / separator chars, so a `/`-only replace leaves an
  // un-createable path on Windows (the projects fixture mkdir'd `…\projects\C:\…`
  // and hit ENOENT). Still a best-effort fast path — findSessionDirs below is
  // authoritative. POSIX paths carry no `\`/`:`, so behaviour there is unchanged.
  return cwd.replace(/[/\\:]/g, '-')
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

const AGENT_TRANSCRIPT_RE = /^agent-.+\.jsonl$/
const CAPTURE_INSERT_BATCH_SIZE = 200

interface ClaudeAgentTranscript {
  sessionId: string
  lines: string[]
  toolUseId?: string
  spawnDepth?: number
}

/** Claude 2026.8 introduced `subagents/workflows/<wf>/agent-*.jsonl`. */
function findAgentTranscriptFiles(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...findAgentTranscriptFiles(path))
    } else if (entry.isFile() && AGENT_TRANSCRIPT_RE.test(entry.name)) {
      files.push(path)
    }
  }
  return files.sort()
}

function readAgentTranscript(path: string): ClaudeAgentTranscript {
  const transcript: ClaudeAgentTranscript = {
    sessionId: basename(path).replace(/\.jsonl$/, ''),
    lines: readFileSync(path, 'utf-8').split('\n'),
  }
  const metaPath = path.replace(/\.jsonl$/, '.meta.json')
  if (!existsSync(metaPath)) return transcript
  try {
    const meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as Record<string, unknown>
    if (typeof meta.toolUseId === 'string' && meta.toolUseId.length > 0) {
      transcript.toolUseId = meta.toolUseId
    }
    if (typeof meta.spawnDepth === 'number' && Number.isFinite(meta.spawnDepth)) {
      transcript.spawnDepth = meta.spawnDepth
    }
  } catch {
    // Transcript content is still useful. Missing/corrupt optional metadata
    // only degrades its parent link to root; it must not drop the whole agent.
  }
  return transcript
}

/** Tool-use IDs emitted by one agent; child `.meta.json.toolUseId` points here. */
function agentToolUseIds(lines: readonly string[]): string[] {
  const ids: string[] = []
  for (const line of lines) {
    if (line.trim().length === 0) continue
    try {
      const row = JSON.parse(line) as { message?: { content?: unknown } }
      if (!Array.isArray(row.message?.content)) continue
      for (const block of row.message.content) {
        if (block === null || typeof block !== 'object') continue
        const candidate = block as { type?: unknown; id?: unknown }
        if (candidate.type === 'tool_use' && typeof candidate.id === 'string') {
          ids.push(candidate.id)
        }
      }
    } catch {
      // parseEvent below has the same best-effort line contract.
    }
  }
  return ids
}

export async function captureClaudeSessions(opts: CaptureClaudeSessionsOpts): Promise<void> {
  const logicalRootSessionId = opts.logicalRootSessionId ?? opts.rootSessionId
  const slug = cwdSlug(opts.worktreePath)
  const projectRoots = opts.configRoots.map((root) => join(root, 'projects'))
  const candidates = [
    ...new Set([
      // Fast path: if the guess happens to be right, no directory scan at all.
      ...projectRoots.map((root) => join(root, slug)),
      // Authoritative: find the directory that actually contains this session.
      ...projectRoots.flatMap((root) => findSessionDirs(root, opts.rootSessionId)),
    ]),
  ]
  const persistRows = async (
    rows: Array<typeof nodeRunEvents.$inferInsert>,
    operation: string,
  ): Promise<void> => {
    if (rows.length === 0) return
    await retrySqliteWrite(() => opts.db.insert(nodeRunEvents).values(rows), {
      onRetry: (retry) => {
        opts.log.warn('sqlite-write-retry', {
          nodeRunId: opts.nodeRunId,
          runtime: 'claude-code',
          operation,
          ...retry,
        })
      },
    })
  }
  try {
    let captured = 0
    let located = false
    for (const projDir of candidates) {
      const subDir = join(projDir, opts.rootSessionId, 'subagents')
      if (!existsSync(subDir)) continue
      located = true
      const transcripts = findAgentTranscriptFiles(subDir).map(readAgentTranscript)
      const ownerByToolUseId = new Map<string, string>()
      for (const transcript of transcripts) {
        for (const toolUseId of agentToolUseIds(transcript.lines)) {
          ownerByToolUseId.set(toolUseId, transcript.sessionId)
        }
      }

      const rows: Array<typeof nodeRunEvents.$inferInsert> = []
      for (const transcript of transcripts) {
        const inferredParent =
          transcript.toolUseId === undefined
            ? undefined
            : ownerByToolUseId.get(transcript.toolUseId)
        const parentSessionId =
          inferredParent !== undefined && inferredParent !== transcript.sessionId
            ? inferredParent
            : logicalRootSessionId
        if (
          transcript.spawnDepth !== undefined &&
          transcript.spawnDepth > 1 &&
          inferredParent === undefined
        ) {
          opts.log.warn('claude-subagent-parent-unresolved', {
            nodeRunId: opts.nodeRunId,
            sessionId: transcript.sessionId,
            spawnDepth: transcript.spawnDepth,
          })
        }
        for (const line of transcript.lines) {
          if (line.trim().length === 0) continue
          const ev = parseEvent(line)
          if (ev === null) continue
          // RFC-297 T5: `startup_inventory` 是只由 `drainFinalEvents()` 铸造的
          // 合成 kind——transcript 行解析不出它，`node_run_events.kind` 也没有
          // 这个 enum 值。这条守卫把「不可能」变成编译器可核的事实。
          if (ev.kind === 'startup_inventory') continue
          rows.push({
            nodeRunId: opts.nodeRunId,
            ts: ev.timestamp ?? Date.now(),
            kind: ev.kind,
            payload: ev.rawLine,
            sessionId: transcript.sessionId,
            parentSessionId,
          })
        }
      }
      for (let offset = 0; offset < rows.length; offset += CAPTURE_INSERT_BATCH_SIZE) {
        const batch = rows.slice(offset, offset + CAPTURE_INSERT_BATCH_SIZE)
        await persistRows(batch, 'claude-subagent-event-batch')
        captured += batch.length
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
    const detail = maskDiagnosticsText(sqliteWriteDiagnostic(err)).slice(0, 2000)
    opts.log.warn('claude-subagent-capture-failed', {
      nodeRunId: opts.nodeRunId,
      err: detail,
    })
    // marker row so SessionTab renders the AC-10 fallback (same kind opencode uses).
    try {
      await persistRows(
        [
          {
            nodeRunId: opts.nodeRunId,
            ts: Date.now(),
            kind: 'subagent_capture_failed',
            payload: JSON.stringify({
              rfc: 'RFC-111',
              reason: detail,
              rootSessionId: opts.rootSessionId,
            }),
            sessionId: logicalRootSessionId,
            parentSessionId: null,
          },
        ],
        'claude-subagent-capture-failure-marker',
      )
    } catch {
      // give up — the run itself already succeeded; capture is auxiliary.
    }
  }
}
