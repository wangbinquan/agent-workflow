// RFC-001: shared types for the /api/runtime(s)/* endpoints.
//
// These shape the response of:
//   GET /api/runtimes/status   — per-enabled-runtime live probe (RFC-135)
//   GET /api/runtime/models    — `opencode models --verbose` parsed list
//
// Backend writes them; frontend reads them. Kept in shared so both sides
// type-check against the same shape. The legacy single-runtime probe schemas
// (RuntimeOpencodeStatus / RuntimeClaudeStatus) were removed with their
// endpoints in RFC-135.

import { z } from 'zod'

export const RuntimeStatusStateSchema = z.enum([
  'not-found',
  'unlaunchable',
  'protocol-incompatible',
  'ready',
])
export type RuntimeStatusState = z.infer<typeof RuntimeStatusStateSchema>

/**
 * RFC-135: GET /api/runtimes/status — one entry per ENABLED registry runtime,
 * probed live (`--version`) against the binary a real dispatch would use.
 *
 * Deliberately carries NO `compatible` / `minVersion`: reported versions are
 * nullable telemetry. A successful lightweight process probe establishes
 * availability; the separate deep smoke test establishes protocol behavior.
 */
export const RuntimeStatusEntrySchema = z.object({
  name: z.string(),
  protocol: z.enum(['opencode', 'claude-code']),
  binary: z.string(),
  ok: z.boolean(),
  version: z.string().nullable(),
  /** RFC-227 precise diagnosis. Optional while older daemons remain readable. */
  state: RuntimeStatusStateSchema.optional(),
  /** Neutral alias that makes the no-admission semantics explicit. */
  reportedVersion: z.string().nullable().optional(),
  /** Behavior contract selected by a full Runtime Test, never a version range. */
  protocolCodec: z.string().min(1).optional(),
  isDefault: z.boolean(),
})
export type RuntimeStatusEntry = z.infer<typeof RuntimeStatusEntrySchema>

export const RuntimesStatusResponseSchema = z.object({
  runtimes: z.array(RuntimeStatusEntrySchema),
})
export type RuntimesStatusResponse = z.infer<typeof RuntimesStatusResponseSchema>

export const OpencodeModelSchema = z.object({
  id: z.string(),
  provider: z.string(),
  modelID: z.string(),
  name: z.string().optional(),
})
export type OpencodeModel = z.infer<typeof OpencodeModelSchema>

export const RuntimeModelsResponseSchema = z.object({
  binary: z.string(),
  models: z.array(OpencodeModelSchema),
  cached: z.boolean(),
})
export type RuntimeModelsResponse = z.infer<typeof RuntimeModelsResponseSchema>
