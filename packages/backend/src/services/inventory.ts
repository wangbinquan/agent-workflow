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
import { desc, eq } from 'drizzle-orm'
import {
  inventoryReasonCode,
  InventorySnapshotCapturedSchema,
  InventorySnapshotMissingSchema,
  type InventoryReasonCode,
  type InventorySnapshot,
  normalizeInventoryRaw,
} from '@agent-workflow/shared'
import type { DbClient } from '@/db/client'
import { attempts, logicalRuns, tasks } from '@/db/schema'
import { Paths } from '@/util/paths'
import { DomainError, NotFoundError } from '@/util/errors'

/**
 * Map a workflow `NodeKind` (`'agent-single'` / `'agent-multi'` / ...) onto
 * the binary "is this kind an agent that spawns opencode?" question the
 * inventory pipeline cares about. Centralized here so a future agent kind
 * gets one edit instead of N.
 */
export function isAgentRunKind(nodeKind: string | undefined): boolean {
  // RFC-060 PR-E: agent-multi removed; agent-single is the only agent kind.
  return nodeKind === 'agent-single'
}

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
  if (!isAgentRunKind(opts.nodeKind)) {
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

// RFC-060 PR-E: agent-multi removed; agent-single is the only prompt-capable kind.
const PROMPT_CAPABLE_KINDS = new Set(['agent-single'])

/**
 * Look up an inventory snapshot for a logical_run by reading the latest
 * attempt's run dir on disk. The legacy node_runs.inventory_snapshot_json
 * column is gone — the snapshot lives in
 * `<appHome>/runs/<taskId>/<attemptId>/inventory.json`, written by the
 * framework-injected aw-inventory-dump opencode plugin. We read it via
 * readSnapshotFromRunDir so the same fallback / reason-code matrix
 * applies whether the read happens at runner exit or at REST time.
 *
 * Mirrors the route layer's error contract (404 task / node-run not
 * found, 410 non-agent kind). Returns `{captured:false, reason:
 * 'file-missing'}` for a logical_run with no attempts yet, or for any
 * attempt whose inventory.json never landed (e.g. opencode --pure).
 */
export async function getInventorySnapshot(
  db: DbClient,
  taskId: string,
  nodeRunId: string,
  opts: { appHome?: string } = {},
): Promise<InventorySnapshot> {
  const taskRows = await db
    .select({ snapshot: tasks.workflowSnapshot })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1)
  if (taskRows.length === 0) {
    throw new NotFoundError('task-not-found', `task '${taskId}' not found`)
  }
  const lrRows = await db.select().from(logicalRuns).where(eq(logicalRuns.id, nodeRunId)).limit(1)
  const lr = lrRows[0]
  if (lr === undefined || lr.taskId !== taskId) {
    throw new NotFoundError(
      'node-run-not-found',
      `node_run '${nodeRunId}' not found under task '${taskId}'`,
    )
  }

  const { nodeKind } = resolveNodeKindFromSnapshot(taskRows[0]!.snapshot, lr.nodeId)
  if (nodeKind !== null && !PROMPT_CAPABLE_KINDS.has(nodeKind)) {
    throw new DomainError(
      'node-kind-not-supported',
      `node '${lr.nodeId}' (kind=${nodeKind}) does not produce an opencode inventory`,
      410,
    )
  }

  // Pick the latest attempt for this logical_run; that's the most recent
  // dump on disk.
  const attRows = await db
    .select({ id: attempts.id })
    .from(attempts)
    .where(eq(attempts.logicalRunId, lr.id))
    .orderBy(desc(attempts.attemptSeq))
    .limit(1)
  const att = attRows[0]
  if (att === undefined) {
    return { captured: false, reason: 'file-missing', message: null }
  }

  const appHome = opts.appHome ?? Paths.root
  const runDir = join(appHome, 'runs', taskId, att.id)
  return readSnapshotFromRunDir({
    runDir,
    nodeKind: nodeKind ?? 'agent-single',
    pureMode: false,
  })
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
