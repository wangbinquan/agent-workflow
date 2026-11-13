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
import {
  isAgentNodeKind,
  inventoryReasonCode,
  InventorySnapshotCapturedSchema,
  InventorySnapshotMissingSchema,
  type InventoryReasonCode,
  type InventorySnapshot,
  normalizeInventoryRaw,
} from '@agent-workflow/shared'
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
