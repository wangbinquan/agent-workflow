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
import { EXECUTION_IDENTITY_FAILURE_CODES } from '../executionIdentity'

/**
 * RFC-135: GET /api/runtimes/status — one entry per ENABLED registry runtime,
 * probed live (`--version`) against the binary a real dispatch would use.
 *
 * Deliberately carries NO `compatible` / `minVersion`: RFC-226 projects
 * OpenCode's driver verdict into `ok` without exposing driver policy details.
 * For OpenCode, `ok = probe exited 0 && version is compatible`; `version`
 * remains nullable so a failed/unparseable probe can still be represented.
 * Other protocols retain their established availability semantics.
 */
export const RuntimeStatusEntrySchema = z.object({
  name: z.string(),
  protocol: z.enum(['opencode', 'claude-code']),
  binary: z.string(),
  ok: z.boolean(),
  version: z.string().nullable(),
  isDefault: z.boolean(),
  /**
   * RFC-224: stable, non-secret diagnosis for an execution-identity admission
   * failure. Optional so responses from pre-RFC-224 daemons remain parseable.
   */
  failureCode: z.enum(EXECUTION_IDENTITY_FAILURE_CODES).optional(),
})
export type RuntimeStatusEntry = z.infer<typeof RuntimeStatusEntrySchema>

/**
 * RFC-205 D6 — FS-sandbox observability block on GET /api/runtimes/status.
 * `mode` echoes the effective config.sandboxMode; `mechanism` is what the
 * boot-time probe identified for this platform (kept even when the trial run
 * failed, so the UI can name what is missing; null = unsupported platform /
 * not probed); `available` is the trial-run verdict.
 */
export const SandboxStatusSchema = z.object({
  mode: z.enum(['enforce', 'warn', 'off']),
  mechanism: z.enum(['seatbelt', 'bwrap']).nullable(),
  available: z.boolean(),
})
export type SandboxStatus = z.infer<typeof SandboxStatusSchema>

export const RuntimesStatusResponseSchema = z.object({
  runtimes: z.array(RuntimeStatusEntrySchema),
  /** RFC-205 D6 — optional so pre-sandbox daemon responses stay parseable. */
  sandbox: SandboxStatusSchema.optional(),
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
