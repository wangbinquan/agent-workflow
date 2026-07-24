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

export const RuntimeStatusStateSchema = z.enum([
  'not-found',
  'unlaunchable',
  'available-unverified',
  'protocol-incompatible',
  'containment-blocked',
  'degraded',
  'ready',
])
export type RuntimeStatusState = z.infer<typeof RuntimeStatusStateSchema>

/**
 * RFC-135: GET /api/runtimes/status — one entry per ENABLED registry runtime,
 * probed live (`--version`) against the binary a real dispatch would use.
 *
 * Deliberately carries NO `compatible` / `minVersion`: RFC-227 makes reported
 * version nullable telemetry and selects compatibility by observed protocol
 * behavior. Other protocols retain their established availability semantics.
 */
export const RuntimeCapabilityStrengthSchema = z.enum(['strong', 'best-effort', 'absent'])

export const RuntimeContainmentReceiptSchema = z.object({
  providerId: z.string().min(1).nullable(),
  mode: z.enum(['enforce', 'warn', 'off']),
  capabilities: z.record(z.string().min(1), RuntimeCapabilityStrengthSchema),
  available: z.boolean(),
  degradedReasons: z.array(z.string().min(1)),
})

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
  containment: RuntimeContainmentReceiptSchema.optional(),
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
  // RFC-227: provider ids are extensible (for example a future Windows Job
  // Object/AppContainer provider), not a Linux/macOS closed enum.
  mechanism: z.string().min(1).nullable(),
  available: z.boolean(),
  providerId: z.string().min(1).nullable().optional(),
  capabilities: z.record(z.string().min(1), RuntimeCapabilityStrengthSchema).optional(),
  degradedReasons: z.array(z.string().min(1)).optional(),
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
