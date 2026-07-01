// RFC-130 §6 — built-in merge-conflict resolver: deterministic, side-effect-free core.
//
// Everything here is pure (no DB, no git, no spawn) so it can be unit-tested in
// isolation — mirroring commitPush.ts. The git orchestration (commit-tree the
// conflicted merge, `git worktree add` the resolve-iso, runNode the agent,
// snapshot + materialize the resolution) lives in the scheduler (PR-B wiring);
// the WHEN-to-resolve / HOW-to-classify / prompt / verdict logic lives here so a
// regression in "did the agent actually resolve every conflict" is caught by a
// fast unit test, not an integration test.
//
// Design authority: design/RFC-130-node-worktree-isolation/design.md §6. The
// merge-tree output format the classifier parses was verified empirically against
// real `git merge-tree --write-tree` (git ≥ 2.38) — NOT recalled from memory.

import type { Agent } from '@agent-workflow/shared'
import { residualConflictMarkers } from '@/util/git'

/** Name of the framework-internal merge-resolver agent (never a user row). */
export const MERGE_AGENT_NAME = 'aw-merge-resolver'
/** The single output port the built-in merge agent declares (framework ignores
 *  the value — success is judged by the framework, not self-reported; D6). */
export const MERGE_RESOLUTION_PORT = 'resolution'
/** Synthetic node_id prefix marking a framework merge-resolve child run. */
export const MERGE_RESOLVE_NODE_PREFIX = '__merge_resolve__'

/**
 * RFC-130 §6.1: the framework's built-in "merge resolver" agent. Not persisted
 * to the `agents` table — constructed on the fly and handed to `runNode` so it
 * spawns an opencode session (captured under a merge-resolve child node_run) in
 * the conflicted resolve-iso worktree. It only edits files (the framework runs
 * the git snapshot + materialize); no skills / deps / mcp / plugins. `model`
 * falls back to the resolved merge runtime (resolveInternalAgentRuntime). Note:
 * NO `readonly` field — RFC-130 PR-C removed it from the Agent type entirely.
 */
export function buildMergeAgent(): Agent {
  const now = Date.now()
  return {
    id: '__merge_agent__',
    name: MERGE_AGENT_NAME,
    description: 'Framework built-in: resolve git merge conflicts (RFC-130).',
    outputs: [MERGE_RESOLUTION_PORT],
    syncOutputsOnIterate: true,
    permission: {},
    skills: [],
    dependsOn: [],
    mcp: [],
    plugins: [],
    frontmatterExtra: {},
    bodyMd:
      'You resolve git merge conflicts. The working directory contains files with ' +
      'conflict markers (<<<<<<<, =======, >>>>>>>). For every conflicted file, ' +
      'reconcile BOTH sides so the result preserves the intent of each change, then ' +
      'remove ALL conflict markers and write the complete, valid file. Some conflicts ' +
      '(deleted-vs-modified, binary, submodule) leave NO text markers — the prompt ' +
      'lists them explicitly; make a definite keep-or-delete / choose-a-side decision ' +
      'for each. Do not leave any conflict unresolved. Reply with exactly one ' +
      `<workflow-output> envelope containing a single <port name="${MERGE_RESOLUTION_PORT}"> element.`,
    schemaVersion: 1,
    createdAt: now,
    updatedAt: now,
    // No `model` — the merge runtime (incl. model) is resolved + frozen by the
    // scheduler (resolveInternalAgentRuntime → resolveFrozenRuntime), mirroring
    // the commit agent (RFC-117 single-source runtimeParams).
  }
}

/**
 * Synthetic node_id for a merge-resolve run of `conflictNodeId` at loop
 * iteration `iter` (mirrors commitPushNodeId). Keyed by node + iter so a
 * re-conflicting resume (§6.3) mints an independent child.
 */
export function mergeResolveNodeId(conflictNodeId: string, iter: number): string {
  return `${MERGE_RESOLVE_NODE_PREFIX}:${conflictNodeId}:${iter}`
}

/** True if `nodeId` is a framework merge-resolve child run id. */
export function isMergeResolveNodeId(nodeId: string): boolean {
  return nodeId === MERGE_RESOLVE_NODE_PREFIX || nodeId.startsWith(`${MERGE_RESOLVE_NODE_PREFIX}:`)
}

// ---------------------------------------------------------------------------
// Conflict manifest (design §6.2③ — 5 conflict classes)
// ---------------------------------------------------------------------------

/**
 * The five conflict classes `git merge-tree` can report. Only `content` leaves
 * `<<<<<<<` text markers in the worktree; the other four are SILENT — an agent
 * that only eyeballs the working tree cannot see them, so they MUST be surfaced
 * via the injected manifest and judged by per-path state (not marker grep).
 */
export type MergeConflictType =
  | 'content'
  | 'modify-delete'
  | 'rename-delete'
  | 'binary'
  | 'submodule'

export interface MergeConflictEntry {
  /** Per-repo worktree dir name (multi-repo disambiguation). */
  worktreeDirName: string
  /** Conflicted path relative to that repo root. */
  path: string
  type: MergeConflictType
}

export type MergeConflictManifest = MergeConflictEntry[]

/**
 * Classify a single `CONFLICT (...)` informational line from `git merge-tree`
 * (WITHOUT `--name-only`) into a `MergeConflictType`, plus extract its path.
 * `binaryPaths` is the set of paths that had a preceding
 * `warning: Cannot merge binary files: <path>` line — git reports those as
 * `CONFLICT (content)` too, so we reclassify them to `binary`.
 *
 * Real formats (verified against git 2.x):
 *   CONFLICT (content): Merge conflict in <path>
 *   CONFLICT (modify/delete): <path> deleted in <sha> and modified in <sha>. ...
 *   CONFLICT (rename/delete): <path> renamed ... but deleted in ...
 *   CONFLICT (submodule): Merge conflict in <path>
 * Returns null for non-CONFLICT lines (Auto-merging, warnings, blanks).
 */
export function classifyConflictLine(
  line: string,
  binaryPaths: ReadonlySet<string> = new Set(),
): { path: string; type: MergeConflictType } | null {
  const m = /^CONFLICT \(([^)]+)\): (.*)$/.exec(line.trimEnd())
  if (m === null) return null
  const kind = m[1]!
  const rest = m[2]!
  // "content" / "submodule": "Merge conflict in <path>"
  const inMatch = /^Merge conflict in (.+)$/.exec(rest)
  if (inMatch !== null) {
    const path = inMatch[1]!
    if (kind === 'submodule') return { path, type: 'submodule' }
    if (binaryPaths.has(path)) return { path, type: 'binary' }
    return { path, type: 'content' }
  }
  // "modify/delete": "<path> deleted in <sha> and modified in <sha>. ..."
  const modDel = /^(.+?) deleted in .* and modified in /.exec(rest)
  if (modDel !== null) return { path: modDel[1]!, type: 'modify-delete' }
  // "rename/delete": "<path> renamed to ... but deleted in ..." / "<path> deleted ..."
  if (kind.startsWith('rename/delete')) {
    const rd = /^(.+?) (?:renamed|deleted) /.exec(rest)
    if (rd !== null) return { path: rd[1]!, type: 'rename-delete' }
  }
  return null
}

/** Extract the paths flagged by `warning: Cannot merge binary files: <path> (...)`. */
export function parseBinaryWarningPaths(stdout: string): Set<string> {
  const out = new Set<string>()
  for (const raw of stdout.split('\n')) {
    const m = /^warning: Cannot merge binary files: (.+?)(?: \([^)]*\))?$/.exec(raw.trimEnd())
    if (m !== null) out.add(m[1]!)
  }
  return out
}

/**
 * Parse the full conflict manifest for ONE repo out of raw `git merge-tree
 * --write-tree` stdout (the variant WITHOUT `--name-only`, so the informational
 * `CONFLICT (...)` messages are present). Deduplicates by (path,type).
 */
export function parseConflictManifest(
  stdout: string,
  worktreeDirName: string,
): MergeConflictEntry[] {
  const binaryPaths = parseBinaryWarningPaths(stdout)
  const seen = new Set<string>()
  const out: MergeConflictEntry[] = []
  for (const raw of stdout.split('\n')) {
    const c = classifyConflictLine(raw, binaryPaths)
    if (c === null) continue
    const key = `${c.type}\x00${c.path}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ worktreeDirName, path: c.path, type: c.type })
  }
  return out
}

// ---------------------------------------------------------------------------
// Prompt (design §6.2② — inject the manifest so silent conflicts are visible)
// ---------------------------------------------------------------------------

/**
 * Build the merge-resolve user prompt. The agent's cwd is the resolve-iso
 * worktree; content conflicts already carry markers in the files, but the
 * silent classes (modify-delete/rename-delete/binary/submodule) are invisible
 * there, so we enumerate EVERY conflicted path + its class + the required
 * decision. Pure string builder (no I/O).
 */
export function buildMergeResolvePrompt(opts: {
  manifest: MergeConflictManifest
  /** repo worktree dir name → human label (e.g. "repo" for single-repo). */
  repoLabels?: Record<string, string>
}): string {
  const { manifest, repoLabels = {} } = opts
  const lines: string[] = [
    'Resolve the following git merge conflicts in the current working directory.',
    '',
  ]
  // Group by repo for multi-repo clarity.
  const byRepo = new Map<string, MergeConflictEntry[]>()
  for (const e of manifest) {
    const arr = byRepo.get(e.worktreeDirName) ?? []
    arr.push(e)
    byRepo.set(e.worktreeDirName, arr)
  }
  for (const [dir, entries] of byRepo) {
    const label = repoLabels[dir] ?? dir
    if (byRepo.size > 1) lines.push(`## Repo: ${label}`)
    for (const e of entries) {
      lines.push(`- ${e.path} — ${conflictInstruction(e.type)}`)
    }
    lines.push('')
  }
  lines.push(
    'For content conflicts: edit the file, reconcile both sides, and remove every',
    'conflict marker (<<<<<<<, =======, >>>>>>>). For deleted-vs-modified: decide to',
    'keep the file (with the modification applied) OR delete it. For binary/submodule:',
    'choose exactly one side. Leave NO conflict unresolved.',
    '',
    `Reply with one <workflow-output><port name="${MERGE_RESOLUTION_PORT}">done</port></workflow-output>.`,
  )
  return lines.join('\n')
}

function conflictInstruction(type: MergeConflictType): string {
  switch (type) {
    case 'content':
      return 'content conflict (markers in file): reconcile both sides, remove all markers'
    case 'modify-delete':
      return 'deleted on one side, modified on the other: keep-with-modification OR delete'
    case 'rename-delete':
      return 'renamed on one side, deleted on the other: keep the rename OR delete'
    case 'binary':
      return 'binary conflict (no markers): choose exactly one side'
    case 'submodule':
      return 'submodule pointer conflict (no markers): choose exactly one commit'
  }
}

// ---------------------------------------------------------------------------
// Verdict (design §6.2③ — framework self-check, NOT agent self-report; D6)
// ---------------------------------------------------------------------------

/**
 * Per-path resolved state gathered by the scheduler from the resolve-iso
 * worktree AFTER the agent runs. The framework — not the agent — decides
 * success from these facts.
 */
export interface ResolvedPathState {
  worktreeDirName: string
  path: string
  /** File still present in the resolve-iso worktree? */
  present: boolean
  /** For present text files: raw content (used for residual-marker grep). null
   *  if absent or binary (binary has no markers → judged by `present`/decision). */
  content: string | null
}

export interface ResolutionVerdict {
  resolved: boolean
  /** Manifest entries the framework could NOT confirm resolved. */
  unresolved: MergeConflictEntry[]
}

/**
 * RFC-130 §6.2③: decide whether EVERY manifest conflict was resolved, from the
 * framework's own observation of the resolve-iso worktree (never the agent's
 * self-report; D6). Rules per class:
 *   - content:        the path must be present AND carry no residual markers.
 *   - binary/submodule: the path must be present (a definite side chosen; a
 *                       still-conflicted index would have left it absent/staged).
 *   - modify-delete / rename-delete: a decision is ALWAYS made — the agent
 *                       either kept the file (present) or removed it (absent);
 *                       both are valid resolutions. The only failure is a
 *                       leftover text marker if they kept+edited it.
 * A content path with no observed state (missing from `states`) is treated as
 * UNRESOLVED (fail-closed).
 */
export function evaluateResolution(
  manifest: MergeConflictManifest,
  states: ResolvedPathState[],
): ResolutionVerdict {
  const stateOf = new Map<string, ResolvedPathState>()
  for (const s of states) stateOf.set(`${s.worktreeDirName}\x00${s.path}`, s)
  const unresolved: MergeConflictEntry[] = []
  for (const e of manifest) {
    const s = stateOf.get(`${e.worktreeDirName}\x00${e.path}`)
    if (e.type === 'content') {
      // Must be observed, present, and marker-free.
      if (s === undefined || !s.present) {
        unresolved.push(e)
        continue
      }
      if (s.content !== null && residualConflictMarkers(s.content)) {
        unresolved.push(e)
        continue
      }
    } else if (e.type === 'binary' || e.type === 'submodule') {
      // A definite side must exist → the path is present with no markers.
      if (s === undefined || !s.present) {
        unresolved.push(e)
        continue
      }
      if (s.content !== null && residualConflictMarkers(s.content)) {
        unresolved.push(e)
        continue
      }
    } else {
      // modify-delete / rename-delete: keep-or-delete both fine; only a leftover
      // marker (they kept + edited but left markers) fails.
      if (
        s !== undefined &&
        s.present &&
        s.content !== null &&
        residualConflictMarkers(s.content)
      ) {
        unresolved.push(e)
        continue
      }
    }
  }
  return { resolved: unresolved.length === 0, unresolved }
}
