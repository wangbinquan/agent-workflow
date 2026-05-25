// RFC-029: opencode runtime inventory snapshot.
//
// Captures what an opencode child process actually loaded — agents / skills /
// MCP servers / plugins — by way of a tiny dump-only opencode plugin that
// the framework injects via OPENCODE_CONFIG_CONTENT.plugin. The plugin writes
// a JSON file at OPENCODE_AW_INVENTORY_OUT; the framework reads it back after
// child.exited and persists it to `node_runs.inventory_snapshot_json`.
//
// This module is pure data: schemas + a normalizer + a reason-code classifier.
// All I/O lives in the backend `services/inventory.ts`.

import { z } from 'zod'

// ---------------------------------------------------------------------------
// Reason codes — used by both backend (when capture fails) and frontend (i18n).
// ---------------------------------------------------------------------------

export const InventoryReasonCodeSchema = z.enum([
  'file-missing',
  'parse-failed',
  'opencode-pure-mode',
  'plugin-load-failed',
  'dump-plugin-internal-error',
  'non-agent-kind',
  // RFC-062: read end stays NULL until the runner's post-exit step 10b lands;
  // for status='running' rows the API short-circuits this code so the UI shows
  // "inventory generating" instead of mis-blaming the plugin via 'file-missing'.
  'in-flight',
])
export type InventoryReasonCode = z.infer<typeof InventoryReasonCodeSchema>

// ---------------------------------------------------------------------------
// Per-asset schemas. Strings (mode / source / status / type) are kept as bare
// `z.string()` — opencode is on a fast iteration cadence and the framework
// preserves the original value verbatim so a UI fallback (i18n unknown class)
// can render anything new without us blocking on a schema update.
// ---------------------------------------------------------------------------

export const InventoryAgentSchema = z.object({
  name: z.string(),
  mode: z.string(),
  modelProviderId: z.string().nullable(),
  modelId: z.string().nullable(),
  readonly: z.boolean(),
  source: z.string(),
})
export type InventoryAgent = z.infer<typeof InventoryAgentSchema>

export const InventorySkillSchema = z.object({
  name: z.string(),
  source: z.string(),
  path: z.string().nullable(),
  description: z.string().nullable(),
})
export type InventorySkill = z.infer<typeof InventorySkillSchema>

export const InventoryMcpSchema = z.object({
  name: z.string(),
  type: z.string(),
  status: z.string(),
  hint: z.string().nullable(),
})
export type InventoryMcp = z.infer<typeof InventoryMcpSchema>

export const InventoryPluginSchema = z.object({
  specifier: z.string(),
  source: z.string(),
})
export type InventoryPlugin = z.infer<typeof InventoryPluginSchema>

// ---------------------------------------------------------------------------
// Snapshot — discriminated union on `captured`.
// ---------------------------------------------------------------------------

export const InventorySnapshotCapturedSchema = z.object({
  captured: z.literal(true),
  schemaVersion: z.literal(1),
  capturedAt: z.number().int(),
  agents: z.array(InventoryAgentSchema),
  skills: z.array(InventorySkillSchema),
  mcps: z.array(InventoryMcpSchema),
  plugins: z.array(InventoryPluginSchema),
})
export type InventorySnapshotCaptured = z.infer<typeof InventorySnapshotCapturedSchema>

export const InventorySnapshotMissingSchema = z.object({
  captured: z.literal(false),
  reason: InventoryReasonCodeSchema,
  message: z.string().nullable(),
})
export type InventorySnapshotMissing = z.infer<typeof InventorySnapshotMissingSchema>

export const InventorySnapshotSchema = z.discriminatedUnion('captured', [
  InventorySnapshotCapturedSchema,
  InventorySnapshotMissingSchema,
])
export type InventorySnapshot = z.infer<typeof InventorySnapshotSchema>

// ---------------------------------------------------------------------------
// Normalizer — accepts whatever the dump plugin wrote, fills defaults, sorts
// arrays. Pure: no I/O, no throw on missing fields (only on outright type
// mismatch via the zod parse at the end).
// ---------------------------------------------------------------------------

interface RawSnapshotInput {
  schemaVersion?: unknown
  capturedAt?: unknown
  agents?: unknown
  skills?: unknown
  mcps?: unknown
  plugins?: unknown
}

function asString(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value
  if (value == null) return fallback
  return String(value)
}

function asNullableString(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (value == null) return null
  return String(value)
}

function asBool(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value
  return fallback
}

function normalizeAgent(raw: unknown): InventoryAgent {
  const r = (raw ?? {}) as Record<string, unknown>
  return {
    name: asString(r.name, '(unnamed)'),
    mode: asString(r.mode, 'unknown'),
    modelProviderId: asNullableString(r.modelProviderId),
    modelId: asNullableString(r.modelId),
    readonly: asBool(r.readonly, false),
    source: asString(r.source, 'unknown'),
  }
}

function normalizeSkill(raw: unknown): InventorySkill {
  const r = (raw ?? {}) as Record<string, unknown>
  return {
    name: asString(r.name, '(unnamed)'),
    source: asString(r.source, 'unknown'),
    path: asNullableString(r.path),
    description: asNullableString(r.description),
  }
}

function normalizeMcp(raw: unknown): InventoryMcp {
  const r = (raw ?? {}) as Record<string, unknown>
  return {
    name: asString(r.name, '(unnamed)'),
    type: asString(r.type, 'unknown'),
    status: asString(r.status, 'unknown'),
    hint: asNullableString(r.hint),
  }
}

function normalizePlugin(raw: unknown): InventoryPlugin {
  const r = (raw ?? {}) as Record<string, unknown>
  return {
    specifier: asString(r.specifier, '(unknown)'),
    source: asString(r.source, 'unknown'),
  }
}

/**
 * Coerce a raw JSON object (whatever the dump plugin wrote, possibly missing
 * or malformed fields) into a fully populated `InventorySnapshotCaptured`.
 * Pure & total: returns a valid object even for empty / partial inputs.
 *
 * Sorts arrays in a stable, user-friendly order:
 * - agents / skills / mcps / plugins all sort by `name` / `specifier`.
 */
export function normalizeInventoryRaw(raw: unknown): InventorySnapshotCaptured {
  const input = (raw ?? {}) as RawSnapshotInput
  const agents = Array.isArray(input.agents) ? input.agents.map(normalizeAgent) : []
  const skills = Array.isArray(input.skills) ? input.skills.map(normalizeSkill) : []
  const plugins = Array.isArray(input.plugins) ? input.plugins.map(normalizePlugin) : []
  let mcps: InventoryMcp[]
  if (Array.isArray(input.mcps)) {
    mcps = input.mcps.map(normalizeMcp)
  } else if (input.mcps && typeof input.mcps === 'object') {
    // Plugin may forward opencode's `mcp.status()` which is keyed by name; flatten.
    mcps = Object.entries(input.mcps as Record<string, unknown>).map(([name, value]) => {
      const v = (value ?? {}) as Record<string, unknown>
      return normalizeMcp({
        name,
        type: v.type ?? 'unknown',
        status: v.status ?? 'unknown',
        hint: v.hint ?? v.error ?? v.url ?? null,
      })
    })
  } else {
    mcps = []
  }
  agents.sort((a, b) => a.name.localeCompare(b.name))
  skills.sort((a, b) => a.name.localeCompare(b.name))
  mcps.sort((a, b) => a.name.localeCompare(b.name))
  plugins.sort((a, b) => a.specifier.localeCompare(b.specifier))
  const capturedAtRaw = input.capturedAt
  const capturedAt =
    typeof capturedAtRaw === 'number' && Number.isFinite(capturedAtRaw)
      ? Math.trunc(capturedAtRaw)
      : 0
  return {
    captured: true,
    schemaVersion: 1,
    capturedAt,
    agents,
    skills,
    mcps,
    plugins,
  }
}

// ---------------------------------------------------------------------------
// Reason code classifier — used by readSnapshotFromRunDir when read fails.
// Pure: returns one of the enum values, never throws.
// ---------------------------------------------------------------------------

export interface InventoryReasonContext {
  runDirExists: boolean
  pureMode: boolean
  /** 'agent' is the only kind that ever produces inventory; anything else short-circuits. */
  nodeKind: string
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  if (err && typeof err === 'object' && 'message' in err)
    return String((err as { message: unknown }).message)
  return ''
}

export function inventoryReasonCode(
  err: unknown,
  ctx: InventoryReasonContext,
): InventoryReasonCode {
  if (ctx.nodeKind !== 'agent') return 'non-agent-kind'
  if (ctx.pureMode) return 'opencode-pure-mode'
  if (!ctx.runDirExists) return 'plugin-load-failed'
  if (err instanceof SyntaxError) return 'parse-failed'
  const msg = errorMessage(err)
  if (/dump-plugin/i.test(msg)) return 'dump-plugin-internal-error'
  if (/ENOENT|no such file/i.test(msg)) return 'file-missing'
  return 'file-missing'
}
