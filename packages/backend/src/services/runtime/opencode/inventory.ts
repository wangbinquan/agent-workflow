// RFC-029: inventory snapshot read-side. Materializes the JSON file written
// by the framework-injected `aw-inventory-dump` opencode plugin into a
// validated `InventorySnapshot` discriminated union, with explicit
// reason-coded fallbacks so the UI can always show *something*.
//
// Pure I/O wrappers around the shared `normalizeInventoryRaw` /
// `inventoryReasonCode` so the test surface stays small.

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import {
  isAgentNodeKind,
  inventoryReasonCode,
  InventorySnapshotCapturedSchema,
  InventorySnapshotMissingSchema,
  InventorySnapshotSchema,
  type InventoryReasonCode,
  type InventorySnapshot,
  normalizeInventoryRaw,
} from '@agent-workflow/shared'
import type { DbClient } from '@/db/client'
import { nodeRuns, tasks } from '@/db/schema'
import { DomainError, NotFoundError } from '@/util/errors'
import { Paths } from '@/util/paths'

/**
 * Map a workflow `NodeKind` (`'agent-single'` / `'agent-multi'` / ...) onto
 * the binary "is this kind an agent that spawns opencode?" question the
 * inventory pipeline cares about. Centralized here so a future agent kind
 * gets one edit instead of N.
 */
// RFC-146: the agent-kind predicate moved to shared `isAgentNodeKind`
// (NODE_KIND_BEHAVIORS.isAgent) — one table row instead of five copies.

export interface ReadSnapshotOptions {
  /** Per-run dir (the framework-controlled `<runRoot>` that gets cleaned up). */
  runDir: string
  /** Filename inside `runDir` the plugin writes to. Defaults to `inventory.json`. */
  fileName?: string
  /** Workflow node kind. Non-agent kinds short-circuit to `non-agent-kind`. */
  nodeKind: string
  /** Whether opencode was launched with `--pure` (external plugins disabled). */
  pureMode: boolean
}

const DEFAULT_FILE = 'inventory.json'

/**
 * Read the inventory file written by the dump plugin, normalize it, and
 * return a validated snapshot. Total: on any failure path returns a
 * `captured: false` stub with a precise reason code (never throws).
 */
export async function readSnapshotFromRunDir(
  opts: ReadSnapshotOptions,
): Promise<InventorySnapshot> {
  // 1) Kind / pure-mode short-circuits before we even check disk.
  if (!isAgentNodeKind(opts.nodeKind)) {
    return missing('non-agent-kind', null)
  }
  if (opts.pureMode) {
    return missing('opencode-pure-mode', null)
  }

  const filePath = join(opts.runDir, opts.fileName ?? DEFAULT_FILE)

  // 2) Read file. If missing / unreadable, classify the reason via the
  // shared classifier (so the rule lives in one place and is unit-tested).
  let raw: unknown
  try {
    const buf = await readFile(filePath, 'utf-8')
    try {
      raw = JSON.parse(buf)
    } catch (parseErr) {
      const reason = inventoryReasonCode(parseErr, {
        runDirExists: existsSync(opts.runDir),
        pureMode: false,
        nodeKind: 'agent',
      })
      return missing(reason, errorMessage(parseErr))
    }
  } catch (readErr) {
    const reason = inventoryReasonCode(readErr, {
      runDirExists: existsSync(opts.runDir),
      pureMode: false,
      nodeKind: 'agent',
    })
    return missing(reason, errorMessage(readErr))
  }

  // 3) Pass-through: dump plugin itself wrote a `{captured:false, reason}`
  // stub on its own internal failure path. Preserve that reason instead of
  // overwriting it with our generic decoder.
  if (raw && typeof raw === 'object' && (raw as { captured?: unknown }).captured === false) {
    const parsed = InventorySnapshotMissingSchema.safeParse(raw)
    if (parsed.success) return parsed.data
    return missing('dump-plugin-internal-error', 'malformed captured:false stub')
  }

  // 4) Happy path: normalize then schema-parse so corrupt content surfaces
  // as `parse-failed` with the underlying zod error.
  const normalized = normalizeInventoryRaw(raw)
  const parsed = InventorySnapshotCapturedSchema.safeParse(normalized)
  if (!parsed.success) {
    return missing('parse-failed', parsed.error.message.slice(0, 200))
  }
  return parsed.data
}

function missing(reason: InventoryReasonCode, message: string | null): InventorySnapshot {
  return { captured: false, reason, message }
}

function errorMessage(err: unknown): string | null {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  return null
}

// ---------------------------------------------------------------------------
// GET /api/tasks/:taskId/node-runs/:nodeRunId/inventory — REST helper.
// ---------------------------------------------------------------------------

/**
 * RFC-062: per-run dir layout for the read end.
 *
 * Mirrors the runner's `join(opts.appHome, 'runs', taskId, nodeRunId)` —
 * the runner uses DI for `appHome` so tests can override; the read end uses
 * `Paths.runsDir` which honours the same `$AGENT_WORKFLOW_HOME` env. Kept a
 * named export so the in-flight fallback's grep guard can lock its callsite.
 */
export function runRootFor(taskId: string, nodeRunId: string): string {
  return join(Paths.runsDir, taskId, nodeRunId)
}

/**
 * Look up a stored inventory snapshot by node_run id. Mirrors the route
 * layer's error contract (404 task / node-run not found, 410 non-agent
 * kind). Falls back to `{captured:false, reason:'file-missing'}` when the
 * column is NULL for an agent kind row (covers legacy rows from before
 * RFC-029) so the UI doesn't need a separate "no data yet" code path.
 */
export async function getInventorySnapshot(
  db: DbClient,
  taskId: string,
  nodeRunId: string,
): Promise<InventorySnapshot> {
  const taskRows = await db
    .select({ snapshot: tasks.workflowSnapshot })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1)
  if (taskRows.length === 0) {
    throw new NotFoundError('task-not-found', `task '${taskId}' not found`)
  }
  const runRows = await db
    .select({
      id: nodeRuns.id,
      taskId: nodeRuns.taskId,
      nodeId: nodeRuns.nodeId,
      status: nodeRuns.status,
      inventorySnapshotJson: nodeRuns.inventorySnapshotJson,
    })
    .from(nodeRuns)
    .where(eq(nodeRuns.id, nodeRunId))
    .limit(1)
  const run = runRows[0]
  if (run === undefined || run.taskId !== taskId) {
    throw new NotFoundError(
      'node-run-not-found',
      `node_run '${nodeRunId}' not found under task '${taskId}'`,
    )
  }

  const { nodeKind } = resolveNodeKindFromSnapshot(taskRows[0]!.snapshot, run.nodeId)
  if (nodeKind !== null && !isAgentNodeKind(nodeKind)) {
    throw new DomainError(
      'node-kind-not-supported',
      `node '${run.nodeId}' (kind=${nodeKind}) does not produce an opencode inventory`,
      410,
    )
  }

  // NULL → legacy / not-yet-captured agent run.
  if (run.inventorySnapshotJson === null || run.inventorySnapshotJson === '') {
    // RFC-062: dump plugin writes inventory.json at opencode-boot, but the
    // runner only reads it (and fills this DB column) AFTER the child exits.
    // For a still-running run, fall back to a fresh read from runRoot so the
    // UI sees real data instead of the misleading "plugin may have failed"
    // file-missing fallback. Terminal-state rows skip this branch — even if
    // runRoot wasn't cleaned up, the DB NULL is authoritative.
    if (run.status === 'running') {
      const snap = await readSnapshotFromRunDir({
        runDir: runRootFor(taskId, nodeRunId),
        nodeKind: 'agent-single',
        pureMode: process.env.OPENCODE_PURE === '1' || process.env.OPENCODE_PURE === 'true',
      })
      if (snap.captured) return snap
      // Plugin hasn't written the file yet (queueMicrotask race at session
      // start). Upgrade file-missing → in-flight so the UI message names the
      // actual situation instead of blaming the plugin. Other reasons
      // (parse-failed, dump-plugin-internal-error, plugin-load-failed) are
      // real diagnostics — surface them as-is.
      if (snap.reason === 'file-missing') {
        return { captured: false, reason: 'in-flight', message: null }
      }
      return snap
    }
    return { captured: false, reason: 'file-missing', message: null }
  }

  // The runner serialized a validated snapshot via `readSnapshotFromRunDir`,
  // but corruption is still possible if the DB was hand-edited; degrade
  // gracefully into `parse-failed`.
  let parsedRaw: unknown
  try {
    parsedRaw = JSON.parse(run.inventorySnapshotJson)
  } catch (err) {
    return { captured: false, reason: 'parse-failed', message: errorMessage(err) }
  }
  const validated = InventorySnapshotSchema.safeParse(parsedRaw)
  if (!validated.success) {
    return {
      captured: false,
      reason: 'parse-failed',
      message: validated.error.message.slice(0, 200),
    }
  }
  return validated.data
}

interface SnapshotNode {
  id?: unknown
  kind?: unknown
}

function resolveNodeKindFromSnapshot(
  snapshotJson: string,
  nodeId: string,
): { nodeKind: string | null } {
  try {
    const snap = JSON.parse(snapshotJson) as { nodes?: SnapshotNode[] }
    const nodes = Array.isArray(snap.nodes) ? snap.nodes : []
    for (const n of nodes) {
      if (typeof n.id !== 'string' || n.id !== nodeId) continue
      const kind = typeof n.kind === 'string' ? n.kind : null
      return { nodeKind: kind }
    }
  } catch {
    // Unreadable snapshot → null, route returns 200 with whatever the row
    // carried (matches sessionView's permissive fallback).
  }
  return { nodeKind: null }
}
